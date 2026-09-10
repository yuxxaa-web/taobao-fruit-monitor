// 阿里云函数计算「内置 Node.js 运行时」入口（runtime=nodejs20, handler=index.handler）
// 相比自定义容器：无需 3.4GB 浏览器镜像、无 ACR 存储/拉取流量、冷启动毫秒级，全部落在 FC 免费额度内。
// 由「定时触发器（Timer）」每 10 分钟调起一次：采集 + 比价 + PushPlus 微信推送。
// 实例按请求计费、执行完即释放，不常驻（零闲置成本）。
const fs = require('fs');
const path = require('path');
const https = require('https');

// FC 内置运行时只有 /tmp 可写（512MB），状态目录统一放 /tmp。
// 必须在 require('./collect') 之前写回 process.env，collect.js 才能在模块加载时读到正确路径。
const STATE_PATH = process.env.STATE_PATH || '/tmp/browser-state.json';
const STATE_DIR = process.env.STATE_DIR || '/tmp/monitor-state';
process.env.STATE_PATH = STATE_PATH;
process.env.STATE_DIR = STATE_DIR;

const STATE_URL = process.env.STATE_URL || '';
const STATE_WRITE_URL = process.env.STATE_WRITE_URL || '';
fs.mkdirSync(STATE_DIR, { recursive: true });

const { collect } = require('./collect');

// 把刷新后的登录态写回 OSS，下次冷启动能直接拉到新 token
function putStateToOSS() {
  return new Promise((resolve, reject) => {
    if (!STATE_WRITE_URL) return resolve(false);
    let buf;
    try { buf = fs.readFileSync(STATE_PATH); } catch (e) { return resolve(false); }
    const url = new URL(STATE_WRITE_URL);
    const req = https.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[oss] 已把刷新后的登录态写回 OSS (' + buf.length + 'B)');
          resolve(true);
        } else {
          console.log('[oss] 写回失败 HTTP ' + res.statusCode + ' ' + b.slice(0, 120));
          resolve(false);
        }
      });
    });
    req.on('error', e => { console.error('[oss] PUT err', e.message); resolve(false); });
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.end(buf);
  });
}

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const TICK_TIMEOUT = 55000; // 函数 timeout 60s，留 5s 余量给收尾

function bjNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function loadJson(name, def) { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch (e) { return def; } }
function saveJson(name, obj) { try { fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(obj), 'utf8'); } catch (e) {} }

// ---------------- 通知通道：PushPlus 微信推送 ----------------
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

// 启动时（冷启动）优先从 OSS 拉取最新登录态；OSS 不可用时回退到代码包内嵌入的登录态
async function bootstrapState() {
  let pulled = false;
  let fetchError = '';
  if (STATE_URL) {
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
      pulled = true;
    } catch (e) {
      fetchError = e.message;
      console.log('[bootstrap] STATE_URL 拉取失败: ' + e.message);
    }
  }
  let source = 'oss';
  if (!pulled) {
    source = 'bundled';
    // 回退：复制代码包内打包的本地登录态到 /tmp（collect.js 默认读 /tmp/browser-state.json）
    const baked = path.join(__dirname, 'browser-state.json');
    if (fs.existsSync(baked)) {
      try {
        fs.copyFileSync(baked, STATE_PATH);
        console.log('[bootstrap] 已从代码包复制登录态 ' + fs.statSync(baked).size + 'B');
      } catch (e) {
        fetchError = e.message;
        console.log('[bootstrap] 代码包内登录态复制失败: ' + e.message);
      }
    } else {
      source = 'none';
      console.log('[bootstrap] 无 STATE_URL 且代码包内无登录态');
    }
  }
  return { source, fetchOk: pulled, error: fetchError };
}

// 通知决策：失败告警 / 价格变动 / 定期汇总，均做去重避免刷屏
// 返回本次实际推送条数，便于在函数返回值里确认推送是否真的发出
async function notify(r, st) {
  let sent = 0;
  if (!PUSHPLUS_TOKEN) return sent;
  if (!r) r = { ok: false, reason: 'SCRIPT_ERROR', message: 'collect returned null' };
  const nowMs = Date.now();
  try {
    if (r.ok === false) {
      const sig = 'E:' + r.reason;
      if (sig !== st.lastEmrgSig) {
        let title, guide;
        if (r.reason === 'TOKEN_EXPIRED') {
          title = '【TBSG-JK】登录态过期，需重新登录';
          guide = '请在本地依次执行：\n  python refresh_session.py\n  python upload_state.py\n（云端会自动从 OSS 拉取最新登录态，无需重新部署）';
        } else if (r.reason === 'RGV587' || r.reason === 'USER_VALIDATE') {
          title = '【TBSG-JK】账号临时风控（RGV587），冷却中';
          guide = '饿了么对高频/异常请求触发了临时验证码风控，通常 10~60 分钟自动恢复。\n请勿手动频繁触发，让每 10 分钟定时器低频重试即可；\n若持续超过 1 小时仍 RGV587，再在本机重登并重新部署。';
        } else {
          title = '【TBSG-JK】云端采集失败：' + r.reason;
          guide = '请在本地运行 refresh_session.py 重新登录并重新部署。';
        }
        if (await pushPlus(title,
          '云端采集失败，原因=' + r.reason + (r.message ? '\n详情：' + r.message : '') + '\n\n' + guide)) sent++;
        st.lastEmrgSig = sig;
      }
      return sent;
    }
    st.lastEmrgSig = null;
    if (r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length)) {
      const sig = 'P:' + JSON.stringify({ u: r.d.priceUp, d: r.d.priceDown });
      if (sig !== st.lastPriceSig) {
        if (await pushPlus('【TBSG-JK】HYGLL·SGJGBD', r.md)) sent++;
        st.lastPriceSig = sig;
      }
    } else {
      st.lastPriceSig = null;
    }
    // 每 ~30 分钟一次汇总（10 分钟触发一次，故取 29 分钟阈值 ≈ 每 3 次一封）
    if (nowMs - (st.lastSummaryTs || 0) >= 29 * 60 * 1000) {
      if (await pushPlus('【TBSG-JK】HYGLL·BXSSGHZ（' + r.now + '）', r.md)) sent++;
      st.lastSummaryTs = nowMs;
    }
  } catch (e) {
    console.error('[notify] err: ' + e.message);
  }
  return sent;
}

let bootstrapped = false;

exports.handler = async function (event, context) {
  // 冷启动首次调用时拉取登录态；热实例复用已拉取的文件
  let boot = { source: 'unknown', fetchOk: false };
  if (!bootstrapped) { boot = await bootstrapState(); bootstrapped = true; }

  const st = loadJson('notify-state.json', { lastSummaryTs: 0, lastPriceSig: null, lastEmrgSig: null });
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('TICK_TIMEOUT')), TICK_TIMEOUT));
  let r;
  try {
    r = await Promise.race([collect(), guard]);
  } catch (e) {
    r = { ok: false, reason: 'SCRIPT_ERROR', message: e.message };
    console.error('[ERROR]', e.message);
  }

  // 若 mtop 返回了新 token，把刷新后的状态持久化回 OSS
  if (r && r.ok && r.newToken) {
    try { await putStateToOSS(); } catch (e) { console.error('[oss] outer err', e.message); }
  }

  const out = { time: bjNow() };
  out.diag = { stateSource: boot.source, stateFetchOk: boot.fetchOk };
  if (r && r.ok) {
    out.ok = true;
    out.shops = r.cur.length;
    out.inRange = r.inRange.length;
    out.changed = !!(r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length || r.d.newShops.length));
    console.log(`[${r.now}] OK 3km内 ${r.inRange.length} 家 | 涨价 ${r.d.priceUp.length} 降价 ${r.d.priceDown.length} 新店 ${r.d.newShops.length}`);
  } else {
    out.ok = false;
    out.reason = r && r.reason;
    out.message = r && r.message;
    console.log('[WARN] ' + (r && r.reason) + ': ' + (r && r.message));
  }

  try {
    out.pushSent = await notify(r, st);
    out.pushplus = !!PUSHPLUS_TOKEN;
  } catch (e) { console.error('[notify] outer err', e.message); }
  saveJson('notify-state.json', st);
  return JSON.stringify(out);
};
