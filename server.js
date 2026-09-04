// 自包含 HTTP 服务：固定间隔采集 -> 结果写入容器本地文件 + 驻留内存 -> 通过 HTTP 端点对外暴露
// 同时内置邮件播报：价格涨跌提醒 / 半小時汇总 / 登录态失效紧急（经 SMTP 直发，不依赖 WorkBuddy）
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { collect } = require('./collect');

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERVAL = (parseInt(process.env.INTERVAL_MIN || '10', 10)) * 60 * 1000;
const STATE_PATH = process.env.STATE_PATH || '/app/browser-state.json';
const STATE_URL = process.env.STATE_URL || ''; // 可选：启动时从 URL 拉取最新登录态覆盖镜像内置
const DATA_DIR = process.env.DATA_DIR || '/app/.data';
fs.mkdirSync(DATA_DIR, { recursive: true });

// 北京时间（UTC+8）格式化，统一对外展示，避免容器 UTC 时间造成困惑
function bjNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

let running = false;
let lastRun = null;
let lastStatus = null;
let lastAlert = null;

// ---------------- 邮件播报（SMTP 直发） ----------------
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
  console.log('[mail] 未配置 SMTP_PASS，跳过发信（仅采集）');
}

async function sendEmail(subject, text) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({ from: SMTP.user, to: SMTP.to, subject, text });
    console.log('[mail] sent: ' + subject);
    return true;
  } catch (e) {
    console.error('[mail] send fail: ' + subject + ' :: ' + e.message);
    return false;
  }
}

// 内存去重：容器重启后清零（罕见，可接受）
let lastSummaryTs = 0;
let lastPriceSig = null;
let lastEmrgSig = null;
async function emailNotify(r) {
  if (!transporter) return;
  if (!r) r = { ok: false, reason: 'SCRIPT_ERROR', message: 'collect returned null' };
  const nowMs = Date.now();
  try {
    if (r.ok === false) {
      const sig = 'E:' + r.reason;
      if (sig !== lastEmrgSig) {
        await sendEmail('【TBSG-JK】YDDTSX，需重新登录',
          '云端采集失败，原因=' + r.reason + (r.message ? '\n详情: ' + r.message : '') +
          '\n\n请在本地用 WorkBuddy 重新登录 TBSG，并把新的 browser-state.json 重新烘焙进 CloudRun 镜像后部署（GitHub 版则更新 BROWSER_STATE_B64 环境变量）。');
        lastEmrgSig = sig;
      }
      return;
    }
    lastEmrgSig = null; // 恢复后清零，下次失效再发
    // 价格涨跌提醒（真实价格变动才发，避免店铺排名波动刷屏）
    if (r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length)) {
      const sig = 'P:' + JSON.stringify({ u: r.d.priceUp, d: r.d.priceDown });
      if (sig !== lastPriceSig) {
        await sendEmail('【TBSG-JK】HYGLL·SGJGBD', r.md);
        lastPriceSig = sig;
      }
    } else {
      lastPriceSig = null; // 价格无变动清零，下次有涨跌必发
    }
    // 半小時汇总（每 ~30 分钟一封，无论有无变动）
    if (nowMs - lastSummaryTs >= 29 * 60 * 1000) {
      await sendEmail('【TBSG-JK】HYGLL·BXSSGHZ（' + r.now + '）', r.md);
      lastSummaryTs = nowMs;
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
  try { await emailNotify(r); } catch (e) { console.error('[mail] outer err', e.message); }
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const sendText = (code, txt, type) => { res.writeHead(code, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' }); res.end(txt); };
  const u = req.url.split('?')[0];
  try {
    if (u === '/health') return send(200, { ok: true, lastRun, status: lastStatus });
    if (u === '/status') return send(200, lastStatus || { ok: null });
    if (u === '/alert') return send(200, lastAlert || { alert: false });
    if (u === '/latest.json') return sendText(200, fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf8'), 'application/json');
    if (u === '/report.md') return sendText(200, fs.readFileSync(path.join(DATA_DIR, 'monitor_latest.md'), 'utf8'), 'text/markdown');
    if (u === '/collect' && req.method === 'POST') {
      tick().then(() => send(200, { triggered: true, lastRun, status: lastStatus })).catch(e => send(500, { error: e.message }));
      return;
    }
    if (u === '/test-email' && req.method === 'POST') {
      (async () => {
        const ok = await sendEmail('【TBSG-JK】YDFXTDCS',
          '这是一封来自云端 CloudRun 容器的 SMTP 测试邮件。\n若你收到，说明容器发信通道已打通。\n\n当前状态: ' + JSON.stringify(lastStatus || {}) + '\n时间(BJ): ' + bjNow());
        return send(ok ? 200 : 500, { mailSent: ok, hasTransporter: !!transporter });
      })();
      return;
    }
    send(200, { service: 'taobao-fruit-monitor', lastRun, status: lastStatus, running });
  } catch (e) {
    if (e.code === 'ENOENT') return send(404, { error: 'no data yet' });
    send(500, { error: e.message });
  }
});

server.listen(PORT, async () => {
  console.log(`taobao-fruit-monitor listening on :${PORT}`);
  await bootstrapState();
  tick();
  setInterval(tick, INTERVAL);
});
