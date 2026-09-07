// 单次运行入口：供 GitHub Actions / 手动执行。
// 读取持久化上一轮快照 → collect(prev) → 写回快照 → decideNotify → 逐条发送(PushPlus)。
// 与常驻 server.js 不同，本进程跑完即退出，因此所有"跨轮"状态都靠 STATE_DIR 下的文件持久化。
const fs = require('fs');
const path = require('path');
const { collect } = require('./collect');
const { sendEmail, decideNotify } = require('./notify');

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const PREV_PATH = path.join(STATE_DIR, 'prev-snap.json');

function loadPrev() {
  try { return JSON.parse(fs.readFileSync(PREV_PATH, 'utf8')); } catch { return undefined; }
}
function savePrev(cur) { fs.writeFileSync(PREV_PATH, JSON.stringify(cur)); }

(async () => {
  console.log('[run-once] start, STATE_DIR=' + STATE_DIR);
  const prev = loadPrev();
  let r;
  try {
    r = await collect(prev);
  } catch (e) {
    r = { ok: false, reason: 'SCRIPT_ERROR', message: e.message };
    console.error('[run-once] collect threw:', e.message);
  }
  if (r.ok) savePrev(r.cur); // 仅成功时更新基线，失败保留上轮快照
  const msgs = decideNotify(r);
  for (const m of msgs) {
    const ok = await sendEmail(m.title, m.body); // 内部优先 PushPlus
    console.log((ok ? '[OK]' : '[FAIL]') + ' send: ' + m.title);
  }
  console.log(`[run-once] done. ok=${r.ok} reason=${r.reason || '-'} msgs=${msgs.length}`);
  process.exit(0);
})().catch(e => { console.error('[run-once] FATAL', e); process.exit(1); });
