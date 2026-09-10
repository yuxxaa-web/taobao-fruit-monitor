// GitHub Actions 运行入口：脱离阿里云 FC，用 GitHub 的服务器定时跑「协议层采集 + 比价 + PushPlus 推送」。
// 复用 fc_runtime/collect.js 的饿了么 mtop 直连逻辑；登录态与比价快照通过 GitHub Artifact 持久化（STATE_DIR）。
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', 'state');
const STATE_PATH = process.env.STATE_PATH || path.join(STATE_DIR, 'browser-state.json');
process.env.STATE_DIR = STATE_DIR;
process.env.STATE_PATH = STATE_PATH;
fs.mkdirSync(STATE_DIR, { recursive: true });

const { collect } = require('../fc_runtime/collect');

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const GITHUB = !!process.env.GITHUB_ACTIONS;

function bjNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function loadJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch (e) { return def; }
}
function saveJson(name, obj) {
  try { fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(obj), 'utf8'); } catch (e) {}
}

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
  } catch (e) { console.error('[pushplus] error', e.message); return false; }
}

// 通知决策：失败告警 / 价格变动 / 定期汇总，均做去重避免刷屏
async function notify(r, st) {
  let sent = 0;
  if (!PUSHPLUS_TOKEN) return sent;
  const nowMs = Date.now();
  try {
    if (!r) r = { ok: false, reason: 'SCRIPT_ERROR', message: 'collect returned null' };
    if (r.ok === false) {
      const sig = 'E:' + r.reason;
      if (sig !== st.lastEmrgSig) {
        let title, guide;
        if (r.reason === 'NO_STATE') {
          title = '【TBSG-JK】GitHub 监控缺少登录态';
          guide = '请在本地执行：\n  python refresh_session.py\n  python upload_state_github.py\n（把新鲜 browser-state.json 上传到 GitHub 仓库的 state 产物，云端会自动拉取）';
        } else if (r.reason === 'TOKEN_EXPIRED') {
          title = '【TBSG-JK】登录态过期，需重新登录';
          guide = '请在本地执行：\n  python refresh_session.py\n  python upload_state_github.py';
        } else if (r.reason === 'RGV587' || r.reason === 'USER_VALIDATE') {
          title = '【TBSG-JK】账号临时风控（RGV587），冷却中';
          guide = '饿了么对高频/异常请求触发了临时验证码风控，通常 10~60 分钟自动恢复。\n请勿频繁手动触发；若持续超过 1 小时仍 RGV587，再在本机重登并 upload_state_github.py。';
        } else {
          title = '【TBSG-JK】GitHub 采集失败：' + r.reason;
          guide = '在本地运行 refresh_session.py 重新登录，再 upload_state_github.py。';
        }
        if (await pushPlus(title, 'GitHub Actions 采集失败，原因=' + r.reason + (r.message ? '\n详情：' + r.message : '') + '\n\n' + guide)) sent++;
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
    } else { st.lastPriceSig = null; }
    if (nowMs - (st.lastSummaryTs || 0) >= 29 * 60 * 1000) {
      if (await pushPlus('【TBSG-JK】HYGLL·BXSSGHZ（' + r.now + '）', r.md)) sent++;
      st.lastSummaryTs = nowMs;
    }
  } catch (e) { console.error('[notify] err', e.message); }
  return sent;
}

(async () => {
  const st = loadJson('notify-state.json', { lastSummaryTs: 0, lastPriceSig: null, lastEmrgSig: null });
  let r;
  if (!fs.existsSync(STATE_PATH)) {
    r = { ok: false, reason: 'NO_STATE', message: '缺少 browser-state.json（请从 GitHub Artifact 上传）' };
  } else {
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('TICK_TIMEOUT')), 50 * 1000));
    try { r = await Promise.race([collect(), guard]); }
    catch (e) { r = { ok: false, reason: 'SCRIPT_ERROR', message: e.message }; console.error('[ERROR]', e.message); }
  }
  const out = { time: bjNow(), github: GITHUB };
  if (r && r.ok) {
    out.ok = true; out.shops = r.cur.length; out.inRange = r.inRange.length;
    out.changed = !!(r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length || r.d.newShops.length));
    console.log(`[${r.now}] OK 3km内 ${r.inRange.length} 家 | 涨价 ${r.d.priceUp.length} 降价 ${r.d.priceDown.length} 新店 ${r.d.newShops.length}`);
  } else {
    out.ok = false; out.reason = r && r.reason; out.message = r && r.message;
    console.log('[WARN] ' + (r && r.reason) + ': ' + (r && r.message));
  }
  try { out.pushSent = await notify(r, st); out.pushplus = !!PUSHPLUS_TOKEN; }
  catch (e) { console.error('[notify] outer err', e.message); }
  saveJson('notify-state.json', st);
  console.log(JSON.stringify(out));
})();
