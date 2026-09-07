// 自包含 HTTP 服务：被「自定义容器」平台的定时触发器（阿里云 FC / CloudRun 等）以 HTTP 请求调起时，
// 执行单次采集+推送。设计为「缩容到 0 + 定时触发」形态（不常驻 setInterval），平时实例为 0 不耗资源，
// 定时每 10 分钟由定时器唤醒 -> 发 HTTP 请求 -> 跑一次采集+PushPlus -> idle 后自动缩容。
// 监听端口默认 9000（阿里云 FC 自定义容器默认端口）。任意非 /health 路径均触发一次采集，
// 因此对定时触发器实际使用的路径鲁棒（根路径 / /collect 都可）。
// prevSnap 与去重状态持久化到 /app/state，热实例（两次调用间未被回收）内可恢复；冷启动当基线。
// 主通知通道 PushPlus 微信推送；SMTP 邮件可选回退。
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { collect } = require('./collect');

const PORT = parseInt(process.env.PORT || '9000', 10); // 阿里云 FC 自定义容器默认 9000
const INTERVAL = (parseInt(process.env.INTERVAL_MIN || '10', 10)) * 60 * 1000; // 仅用于 /status 展示与说明
const STATE_PATH = process.env.STATE_PATH || '/app/browser-state.json';
const STATE_URL = process.env.STATE_URL || ''; // 可选：启动时从 URL 拉取最新登录态覆盖镜像内置
const DATA_DIR = process.env.DATA_DIR || '/app/.data';
const STATE_DIR = process.env.STATE_DIR || '/app/state'; // 持久化 prevSnap + 去重状态（冷启动可恢复）
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

// 北京时间（UTC+8）格式化，统一对外展示，避免容器 UTC 时间造成困惑
function bjNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
// 简单 JSON 文件持久化：实例生命周期内有效；若要跨冷启动 100% 可靠，部署时接 CloudBase Storage（需 envId+apikey）
function loadJson(name, def) { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch (e) { return def; } }
function saveJson(name, obj) { try { fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(obj), 'utf8'); } catch (e) {} }

let running = false;
let lastRun = null;
let lastStatus = null;
let lastAlert = null;

// ---------------- 通知通道 ----------------
// 主通道：PushPlus 微信推送（HTTP，无需 SMTP）；备通道：SMTP 邮件（可选，配置 SMTP_PASS 才发）
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const SMTP = {
  host: process.env.SMTP_HOST || 'smtp.qq.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: process.env.SMTP_SECURE !== 'false',
  user: process.env.SMTP_USER || '1478363@qq.com',
  pass: process.env.SMTP_PASS || '',
  to: process.env.TO_EMAIL || process.env.SMTP_USER || '1478363@qq.com'
};
let transporter = null;
if (SMTP.pass) {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.secure, auth: { user: SMTP.user, pass: SMTP.pass } });
  console.log('[mail] SMTP transporter ready -> ' + SMTP.to);
} else {
  console.log('[mail] 未配置 SMTP_PASS，仅用 PushPlus 通道');
}
if (PUSHPLUS_TOKEN) console.log('[pushplus] token 已配置，作为主通知通道');
else console.log('[pushplus] 未配置 PUSHPLUS_TOKEN，通知将不可用（请设置环境变量）');

// PushPlus 微信推送：https://www.pushplus.plus/  content 支持 markdown 模板
async function pushPlus(title, contentMd) {
  if (!PUSHPLUS_TOKEN) return false;
  try {
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: PUSHPLUS_TOKEN, title, content: contentMd, template: 'markdown' })
    });
    const j = await res.json().catch(() => null);
    console.log('[pushplus] ' + (j ? JSON.stringify(j) : ('HTTP ' + res.status)));
    return !!(j && j.code === 200);
  } catch (e) {
    console.error('[pushplus] error: ' + e.message);
    return false;
  }
}

// 统一出口：优先 PushPlus；若 PushPlus 未配置或失败且 SMTP 可用，回退邮件
async function sendEmail(subject, text) {
  let ok = false;
  if (PUSHPLUS_TOKEN) ok = await pushPlus(subject, text);
  if (!ok && transporter) {
    try {
      await transporter.sendMail({ from: SMTP.user, to: SMTP.to, subject, text });
      console.log('[mail] sent(fallback): ' + subject);
      ok = true;
    } catch (e) {
      console.error('[mail] send fail: ' + subject + ' :: ' + e.message);
    }
  }
  return ok;
}

// 去重状态从文件加载（跨冷启动保留：半小時汇总去重 / 价格变动去重 / 紧急失效去重）
async function emailNotify(r, st) {
  if (!transporter && !PUSHPLUS_TOKEN) return;
  if (!r) r = { ok: false, reason: 'SCRIPT_ERROR', message: 'collect returned null' };
  const nowMs = Date.now();
  try {
    if (r.ok === false) {
      const sig = 'E:' + r.reason;
      if (sig !== st.lastEmrgSig) {
        await sendEmail('【TBSG-JK】YDDTSX，需重新登录',
          '云端采集失败，原因=' + r.reason + (r.message ? '\n详情: ' + r.message : '') +
          '\n\n请在本地用 WorkBuddy 重新登录 TBSG，把新的 browser-state.json 重新烘焙进容器镜像后重新部署（阿里云 FC：更新 ACR 镜像并执行 s deploy；或挂载 NAS 持久化登录态）。');
        st.lastEmrgSig = sig;
      }
      return;
    }
    st.lastEmrgSig = null; // 恢复后清零，下次失效再发
    // 价格涨跌提醒（真实价格变动才发，避免店铺排名波动刷屏）
    if (r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length)) {
      const sig = 'P:' + JSON.stringify({ u: r.d.priceUp, d: r.d.priceDown });
      if (sig !== st.lastPriceSig) {
        await sendEmail('【TBSG-JK】HYGLL·SGJGBD', r.md);
        st.lastPriceSig = sig;
      }
    } else {
      st.lastPriceSig = null; // 价格无变动清零，下次有涨跌必发
    }
    // 半小時汇总（每 ~30 分钟一封，无论有无变动）
    if (nowMs - (st.lastSummaryTs || 0) >= 29 * 60 * 1000) {
      await sendEmail('【TBSG-JK】HYGLL·BXSSGHZ（' + r.now + '）', r.md);
      st.lastSummaryTs = nowMs;
    }
  } catch (e) {
    console.error('[mail] notify err: ' + e.message);
  }
}

function writeFile(name, content) {
  try { fs.writeFileSync(path.join(DATA_DIR, name), content, 'utf8'); } catch (e) { console.error('[write fail]', name, e.message); }
}
function appendLog(line) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'log.jsonl'), line + '\n', 'utf8'); } catch (e) {}
}

// 启动时可选地从外部 URL 拉取登录态（更新路径，无需重新构建镜像）
async function bootstrapState() {
  if (!STATE_URL) return;
  try {
    const buf = await new Promise((resolve, reject) => {
      const req = https.get(STATE_URL, res => {
        if (res.statusCode !== 200) return reject(new Error('STATE_URL HTTP ' + res.statusCode));
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('STATE_URL timeout')));
    });
    fs.writeFileSync(STATE_PATH, buf);
    console.log('[bootstrap] 已从 STATE_URL 拉取登录态 ' + buf.length + 'B');
  } catch (e) {
    console.log('[bootstrap] STATE_URL 拉取失败，使用镜像内置登录态: ' + e.message);
  }
}

const TICK_TIMEOUT = 240000; // 4 分钟硬超时：防止 collect() 挂起使 running 永久为 true、调度卡死
async function tick() {
  if (running) return;
  running = true;
  const st = loadJson('notify-state.json', { lastSummaryTs: 0, lastPriceSig: null, lastEmrgSig: null });
  let r = null; // 提到 try 外：否则块外 emailNotify(r) 访问的是 undefined -> 自动发信全部静默失败
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('TICK_TIMEOUT')), TICK_TIMEOUT));
  try {
    r = await Promise.race([collect(), guard]); // 成功/业务失败都返回对象，此处不抛
  } catch (e) {
    r = { ok: false, reason: 'SCRIPT_ERROR', message: e.message }; // 超时或意外异常 -> 紧急邮件
    console.error('[ERROR]', e.message);
  } finally {
    running = false;
  }
  if (r) {
    if (r.ok) {
      writeFile('latest.json', JSON.stringify(r.cur, null, 2));
      appendLog(JSON.stringify(r.entry));
      writeFile('monitor_latest.md', r.md);
      const ch = r.d && (r.d.priceUp.length || r.d.priceDown.length || r.d.newShops.length || r.d.removedShops.length || r.d.newFruits.length);
      if (r.hadPrev && ch) {
        const alertMd = `# ⚠️ SGJGBD TX （${r.now}）\n\n${r.md}`;
        writeFile('ALERT.md', alertMd);
        lastAlert = { time: r.now, md: alertMd, d: r.d };
      }
      writeFile('SESSION_STATUS.json', JSON.stringify({ ok: true, lastSuccess: r.now }));
      console.log(`[${r.now}] OK 3km内 ${r.inRange.length} 家 | 涨价 ${r.d.priceUp.length} 降价 ${r.d.priceDown.length} 新店 ${r.d.newShops.length}`);
      lastRun = r.now;
      lastStatus = { ok: true, lastSuccess: r.now };
    } else {
      writeFile('SESSION_STATUS.json', JSON.stringify({ ok: false, reason: r.reason, message: r.message, lastTry: bjNow() + ' (BJ)' }));
      console.log('[WARN] ' + r.reason + ': ' + r.message);
      lastStatus = { ok: false, reason: r.reason, message: r.message };
    }
  }
  // 发信（无论 ok 与否；内部已去重 + 异常隔离）。r 在外层作用域，可正确访问
  try { await emailNotify(r, st); } catch (e) { console.error('[mail] outer err', e.message); }
  saveJson('notify-state.json', st); // 持久化去重状态
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const sendText = (code, txt, type) => { res.writeHead(code, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' }); res.end(txt); };
  const u = req.url.split('?')[0];
  try {
    // 健康检查端点（供平台存活探针调用，不触发采集）
    if (u === '/health') return send(200, { ok: true, lastRun, status: lastStatus, running });

    // 通知通道自检（仍保留，手动 POST 即可发一条测试推送）
    if (u === '/test-email' && req.method === 'POST') {
      (async () => {
        const channel = PUSHPLUS_TOKEN ? 'pushplus' : (transporter ? 'smtp' : 'none');
        const ok = await sendEmail('【TBSG-JK】YDFXTDCS',
          '这是一条来自云端容器的 **PushPlus 通知测试**。\n若你收到，说明通知通道已打通。\n\n当前状态: ' + JSON.stringify(lastStatus || {}) + '\n时间(BJ): ' + bjNow());
        return send(ok ? 200 : 500, { sent: ok, channel, hasPushplus: !!PUSHPLUS_TOKEN, hasTransporter: !!transporter });
      })();
      return;
    }

    // 其余所有路径（含 /、/collect，以及定时触发器实际使用的任意路径）-> 单次采集+推送。
    // 这样无论平台定时触发器以何种路径调起，都能正确触发采集。
    tick().then(() => send(200, { triggered: true, lastRun, status: lastStatus }))
          .catch(e => send(500, { error: e.message }));
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, async () => {
  console.log(`taobao-fruit-monitor listening on :${PORT}`);
  await bootstrapState();
  // 不再常驻 setInterval：由平台的定时触发器（Timer）以 HTTP 请求调起本服务驱动单次运行，
  // 配合「缩容到 0」，平时不占资源，唤醒即采即推，idle 后自动缩容。
});
