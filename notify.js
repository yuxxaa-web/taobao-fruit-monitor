// 通知模块：PushPlus 微信推送（主通道）+ SMTP 邮件（可选回退）+ 跨运行去重状态
// 供 run-once.js（GitHub Actions 单次运行 / 手动执行）使用。
// 去重状态持久化到 STATE_DIR/notify-state.json，使无状态环境（每次全新进程）也能正确去重。
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

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

const NOTIFY_STATE_PATH = path.join(STATE_DIR, 'notify-state.json');
function loadNotifyState() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_STATE_PATH, 'utf8')); }
  catch { return { lastSummaryTs: 0, lastPriceSig: null, lastEmrgSig: null }; }
}
function saveNotifyState(s) { fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s)); }

// 依据采集结果 r 与持久化去重状态，决定本次要发送的通知（不负责实际发送）
// 返回 [{title, body}]
function decideNotify(r) {
  const s = loadNotifyState();
  const msgs = [];
  if (!r) r = { ok: false, reason: 'SCRIPT_ERROR', message: 'collect returned null' };

  if (r.ok === false) {
    const sig = 'E:' + r.reason;
    if (sig !== s.lastEmrgSig) {
      msgs.push({
        title: '【TBSG-JK】YDDTSX，需重新登录',
        body: '采集失败，原因=' + r.reason + (r.message ? '\n详情: ' + r.message : '') +
          '\n\n请重新登录 TBSG，把新的 browser-state.json 重新生成 base64，更新 GitHub 仓库 Secrets 中的 BROWSER_STATE_B64 后重新运行。'
      });
      s.lastEmrgSig = sig;
    }
    saveNotifyState(s);
    return msgs; // 失败不再发其他
  }

  s.lastEmrgSig = null; // 恢复后清零，下次失效再发

  // 价格涨跌提醒（仅真实价格变动才发，避免店铺排名波动刷屏）
  if (r.hadPrev && r.d && (r.d.priceUp.length || r.d.priceDown.length)) {
    const sig = 'P:' + JSON.stringify({ u: r.d.priceUp, d: r.d.priceDown });
    if (sig !== s.lastPriceSig) {
      msgs.push({ title: '【TBSG-JK】HYGLL·SGJGBD', body: r.md });
      s.lastPriceSig = sig;
    }
  } else {
    s.lastPriceSig = null; // 价格无变动清零，下次有涨跌必发
  }

  // 半小時汇总（每 ~30 分钟一封，无论有无变动）
  const nowMs = Date.now();
  if (nowMs - s.lastSummaryTs >= 29 * 60 * 1000) {
    msgs.push({ title: '【TBSG-JK】HYGLL·BXSSGHZ（' + r.now + '）', body: r.md });
    s.lastSummaryTs = nowMs;
  }

  saveNotifyState(s);
  return msgs;
}

module.exports = { pushPlus, sendEmail, decideNotify, loadNotifyState, saveNotifyState, PUSHPLUS_TOKEN, STATE_DIR };
