// 自包含 HTTP 服务：固定间隔采集 -> 结果写入容器本地文件 + 驻留内存 -> 通过 HTTP 端点对外暴露
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

let running = false;
let lastRun = null;
let lastStatus = null;
let lastAlert = null;

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

async function tick() {
  if (running) return;
  running = true;
  try {
    const r = await collect();
    if (r.ok) {
      writeFile('latest.json', JSON.stringify(r.cur, null, 2));
      appendLog(JSON.stringify(r.entry));
      writeFile('monitor_latest.md', r.md);
      const ch = r.d && (r.d.priceUp.length || r.d.priceDown.length || r.d.newShops.length || r.d.removedShops.length || r.d.newFruits.length);
      if (r.hadPrev && ch) {
        const alertMd = `# ⚠️ 水果价格变动提醒 （${r.now}）\n\n${r.md}`;
        writeFile('ALERT.md', alertMd);
        lastAlert = { time: r.now, md: alertMd, d: r.d };
      }
      writeFile('SESSION_STATUS.json', JSON.stringify({ ok: true, lastSuccess: r.now }));
      console.log(`[${r.now}] OK 3km内 ${r.inRange.length} 家 | 涨价 ${r.d.priceUp.length} 降价 ${r.d.priceDown.length} 新店 ${r.d.newShops.length}`);
      lastRun = r.now;
      lastStatus = { ok: true, lastSuccess: r.now };
    } else {
      writeFile('SESSION_STATUS.json', JSON.stringify({ ok: false, reason: r.reason, message: r.message, lastTry: new Date().toISOString() }));
      console.log('[WARN] ' + r.reason + ': ' + r.message);
      lastStatus = { ok: false, reason: r.reason, message: r.message };
    }
  } catch (e) {
    console.error('[ERROR]', e.message);
    writeFile('SESSION_STATUS.json', JSON.stringify({ ok: false, reason: 'SCRIPT_ERROR', message: e.message, lastTry: new Date().toISOString() }));
    lastStatus = { ok: false, reason: 'SCRIPT_ERROR', message: e.message };
  } finally {
    running = false;
  }
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
