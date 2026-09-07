// 采集逻辑：复用本地 monitor.js 的 mtop 接口捕获 + 解析方式。
// 自包含版本：登录态从 STATE_PATH 读取（镜像内置或运行时经 BROWSER_STATE_B64 注入），prev 比价快照驻留进程内存。
const { chromium } = require('playwright');
const fs = require('fs');

const LOC = { latitude: 30.195314, longitude: 120.260189 };
const KWS = ['水果', '水果店'];
const MAX_DIST = 3000;
const STATE_PATH = process.env.STATE_PATH || '/app/browser-state.json';

const urlFor = kw => 'https://h5.ele.me/minisearch/result?keyword=' + encodeURIComponent(kw) +
  '&longitude=' + LOC.longitude + '&latitude=' + LOC.latitude + '&geohash=wtmeb8fu3w82&entry_code=0';

// 跨 tick 的上一帧快照（进程内存，重启后丢失 → 下一帧当作基线）
let prevSnap = null;

function beijingNow() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function buildSnapshot(captures) {
  const shops = new Map();
  captures.forEach(txt => {
    let j; try { j = JSON.parse(txt); } catch (e) { return; }
    const results = (j.data && j.data.result) || [];
    results.forEach(res => (res.listItems || []).forEach(it => {
      const info = it.info || {}; const r = info.restaurant;
      if (!r || !r.name) return;
      const id = r.id || r.name;
      const foods = (info.foods || []).map(fo => ({
        name: fo.name,
        price: fo.sellPriceStr != null ? String(fo.sellPriceStr) : (fo.sellPrice != null ? String(fo.sellPrice) : (fo.predictPrice != null ? String(fo.predictPrice) : null)),
      })).filter(x => x.name);
      if (!shops.has(id)) shops.set(id, { name: r.name, id, distance: r.distance, rating: r.rating, foods: [] });
      const s = shops.get(id);
      if (r.distance != null && (s.distance == null || r.distance < s.distance)) s.distance = r.distance;
      foods.forEach(nf => { if (!s.foods.some(x => x.name === nf.name)) s.foods.push(nf); });
    }));
  });
  return Array.from(shops.values()).sort((a, b) => (a.distance || 0) - (b.distance || 0));
}

function num(p) { const v = parseFloat(String(p).replace(/[^\d.]/g, '')); return isNaN(v) ? null : v; }

function diff(prev, cur) {
  const pMap = new Map((prev || []).map(s => [s.id, s]));
  const cMap = new Map(cur.map(s => [s.id, s]));
  const newShops = [], removedShops = [], priceUp = [], priceDown = [], newFruits = [], removedFruits = [];
  cur.forEach(cs => {
    const ps = pMap.get(cs.id);
    if (!ps) { newShops.push(cs.name); return; }
    const pf = new Map(ps.foods.map(f => [f.name, f.price]));
    const cf = new Map(cs.foods.map(f => [f.name, f.price]));
    cs.foods.forEach(f => {
      if (!pf.has(f.name)) { newFruits.push(cs.name + ' / ' + f.name + (f.price ? ' ¥' + f.price : '')); return; }
      const a = num(pf.get(f.name)), b = num(f.price);
      if (a != null && b != null && b > a) priceUp.push(cs.name + ' / ' + f.name + ' ¥' + pf.get(f.name) + '→¥' + f.price);
      if (a != null && b != null && b < a) priceDown.push(cs.name + ' / ' + f.name + ' ¥' + pf.get(f.name) + '→¥' + f.price);
    });
    pf.forEach((_, name) => { if (!cf.has(name)) removedFruits.push(cs.name + ' / ' + name); });
  });
  pMap.forEach((ps, id) => { if (!cMap.has(id)) removedShops.push(ps.name); });
  return { newShops, removedShops, priceUp, priceDown, newFruits, removedFruits };
}

async function collect(prevSnapArg) {
  if (!fs.existsSync(STATE_PATH)) {
    return { ok: false, reason: 'NO_STATE', message: '容器内缺少 browser-state.json（请通过 BROWSER_STATE_B64 注入或重新构建镜像）' };
  }

  const captures = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    storageState: STATE_PATH,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, locale: 'zh-CN',
    geolocation: LOC, permissions: ['geolocation'],
  });
  try {
    for (const kw of KWS) {
      const page = await ctx.newPage();
      page.on('response', async (res) => {
        if (!/relationrecommend|mtop\./i.test(res.url())) return;
        let t = ''; try { t = await res.text(); } catch (e) { return; }
        if (!t.includes('listItems')) return;
        captures.push(t);
      });
      await page.goto(urlFor(kw), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(13000);
      for (let s = 0; s < 8; s++) {
        await page.evaluate(() => { window.scrollBy(0, 1200); document.querySelectorAll('*').forEach(el => { if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) el.scrollTop += 1200; }); });
        await page.waitForTimeout(2000);
      }
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (captures.length === 0) {
    return { ok: false, reason: 'SESSION_EXPIRED', message: '未捕获到数据，登录态可能已失效，请重新注入登录态并重新部署' };
  }

  const cur = buildSnapshot(captures);
  const inRange = cur.filter(s => s.distance <= MAX_DIST);
  // 兼容常驻进程（内存 prevSnap）与单次运行（外部注入 prevSnapArg，如 GitHub Actions 无状态环境）
  const prev = (prevSnapArg !== undefined) ? prevSnapArg : prevSnap;
  const d = diff(prev, cur);
  prevSnap = cur; // 更新内存基线，供下次比价（常驻模式）

  const now = beijingNow();
  const entry = { time: now, total: cur.length, inRange: inRange.length, shops: cur };

  const fmtDist = x => x >= 1000 ? (x / 1000).toFixed(2) + 'km' : x + 'm';
  let md = `# JKKB ${now}\n\n`;
  md += `- 总计店铺：${cur.length} 家（3km 内 ${inRange.length} 家）\n`;
  if (prev) {
    md += `## 较上次变动\n`;
    md += d.priceUp.length ? `- 🔺 涨价（${d.priceUp.length}）：${d.priceUp.map(x => '`' + x + '`').join('；')}\n` : '- 🔺 涨价：无\n';
    md += d.priceDown.length ? `- 🔻 降价（${d.priceDown.length}）：${d.priceDown.map(x => '`' + x + '`').join('；')}\n` : '- 🔻 降价：无\n';
    md += d.newShops.length ? `- 🆕 新店：${d.newShops.join('、')}\n` : '- 🆕 新店：无\n';
    md += d.removedShops.length ? `- ❌ 消失店铺：${d.removedShops.join('、')}\n` : '- ❌ 消失店铺：无\n';
    md += d.newFruits.length ? `- ➕ 新增水果（${d.newFruits.length}）：${d.newFruits.slice(0, 20).join('；')}${d.newFruits.length > 20 ? ' …' : ''}\n` : '- ➕ 新增水果：无\n';
  } else {
    md += `\n（首次采集，已建立基线，下次开始对比涨跌）\n`;
  }
  md += `\n## 当前 3km 内店铺\n`;
  inRange.forEach((s, i) => {
    md += `${i + 1}. **${s.name}** · ${fmtDist(s.distance)}${s.rating ? ' · ⭐' + s.rating : ''} · 水果 ${s.foods.length} 个\n`;
    s.foods.slice(0, 6).forEach(f => md += `   - ${f.name}${f.price ? ' ¥' + f.price : ''}\n`);
  });

  return { ok: true, now, cur, inRange, d, entry, md, hadPrev: !!prev };
}

module.exports = { collect, buildSnapshot, diff, num };
