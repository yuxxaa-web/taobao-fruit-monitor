// 协议层直连采集（脱离浏览器自动化，绕过 RGV587 的 x-mini-wua 设备签名层）
// 用 Node https 直接调饿了么 mtop.relationrecommend，自己算老版 sign。
// 已验证：纯协议层请求不触发 RGV587，只需有效 _m_h5_tk(token) + 正确 sign。
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOC = { latitude: 30.195314, longitude: 120.260189 };
const KWS = ['水果', '水果店'];
const MAX_DIST = 3000;
const STATE_PATH = process.env.STATE_PATH || '/tmp/browser-state.json';
// 以下为「真实浏览器请求」捕获得到的 ground truth（capture_request.py），sign 算法已验证一致。
// 三个易错点：①路径小写、api 参数驼峰 ②type=originaljson ③data 需 {type,appId,params} 包裹且走 POST
const APP_KEY = '12574478';      // mtop appKey
const APP_ID = '26551';          // data 内 appId（缺失会报 valid appId([0]) Failed）
const API_PATH = 'mtop.relationrecommend.elemetinyapprecommend.recommend';  // 路径：小写
const API_NAME = 'mtop.relationrecommend.ElemeTinyAppRecommend.recommend';  // api 参数：驼峰

// 上一帧比价快照（冷启动从文件恢复，避免每次当基线）
const STATE_DIR = process.env.STATE_DIR || '/app/state';
const PREV_SNAP_FILE = path.join(STATE_DIR, 'prev-snap.json');
let prevSnap = (() => { try { return JSON.parse(fs.readFileSync(PREV_SNAP_FILE, 'utf8')); } catch (e) { return null; } })();
function savePrevSnap(snap) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(PREV_SNAP_FILE, JSON.stringify(snap), 'utf8'); } catch (e) {} }

function loadCookies() {
  const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const cookies = (j.cookies || []).filter(c => (c.domain || '').match(/ele\.me|taobao|alicdn|tbcdn/));
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const tkC = cookies.find(c => c.name === '_m_h5_tk');
  const token = tkC ? tkC.value.split('_')[0] : '';
  return { cookieStr, token };
}

// 淘宝 H5 老版 mtop sign
function mtopSign(token, t, data) {
  return crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${data}`).digest('hex');
}

// 解析 response set-cookie，用于自动刷新 _m_h5_tk
function parseSetCookie(arr) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (const sc of arr) {
    const part = String(sc).split(';')[0].trim();
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

// 业务参数（字段与真实浏览器发送的一致）
function buildParams(keyword) {
  return {
    _input_charset: 'UTF-8', _output_charset: 'UTF-8',
    gatewayApiType: 'mtop', mtop_api_version: '1.0', appId: APP_ID,
    'x-ele-scene': 'search', channelCode: '0', platform: '999',
    alipayChannel: 1, sversion: '15.0', limit: 5, n: 5, page: 1,
    locationSource: 'taobao',
    latitude: String(LOC.latitude), longitude: String(LOC.longitude),
    keyword, refer: '直接搜索', searchEntryCode: '0',
    fixSearch: '1', storeParams: '{}', searchMode: 1,
  };
}

// POST 直连 mtop：data 用 {type,appId,params} 包裹后放 body（form-urlencoded）
function mtop(paramsObj) {
  return new Promise((resolve, reject) => {
    let ck;
    try { ck = loadCookies(); } catch (e) { return reject(e); }
    const t = Date.now();
    const outerData = JSON.stringify({
      type: 'originaljson', appId: APP_ID, params: JSON.stringify(paramsObj),
    });
    const sign = mtopSign(ck.token, t, outerData);
    const qs = new URLSearchParams({
      jsv: '2.7.5', appKey: APP_KEY, t: String(t), sign,
      api: API_NAME, v: '1.0', type: 'originaljson',
      dataType: 'json', timeout: '6000',
      mainDomain: 'ele.me', subDomain: 'waimai-guide',
      H5Request: 'true', ttid: 'h5@safari_ios_604.1', SV: '5.0',
      EtRequest: 'true', syncCookieMode: 'true', pageDomain: 'ele.me',
    }).toString();
    const url = `https://waimai-guide.ele.me/h5/${API_PATH}/1.0/5.0/?${qs}`;
    const body = 'data=' + encodeURIComponent(outerData);
    const headers = {
      'Cookie': ck.cookieStr,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://h5.ele.me/minisearch/result?keyword=%E6%B0%B4%E6%9E%9C',
    };
    const req = https.request(url, { method: 'POST', headers, timeout: 20000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ body: buf, setCookies: parseSetCookie(res.headers['set-cookie']) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

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

async function collect() {
  if (!fs.existsSync(STATE_PATH)) {
    return { ok: false, reason: 'NO_STATE', message: '容器内缺少 browser-state.json（请重新登录并上传）' };
  }
  const captures = [];
  let refreshedToken = null;
  let lastBody = '';
  for (const kw of KWS) {
    let mres;
    try {
      mres = await mtop(buildParams(kw));
    } catch (e) {
      return { ok: false, reason: 'NET_ERR', message: '网络错误: ' + e.message };
    }
    const body = mres.body;
    lastBody = body;

    // 错误码识别（必须先于 token 刷新：避免把风控响应里下发的 token 误当有效）
    // 注意：错误码可能分散在 ret 数组多个元素里（如 ret[0]=FAIL_SYS_USER_VALIDATE,
    // ret[1]=RGV587_ERROR::...），必须拼接整个 ret 数组一起匹配，否则会漏判成 NO_DATA。
    let errRet = null;
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j.ret) && j.ret.length) {
        const retStr = j.ret.join(' | ');
        if (/RGV587/.test(retStr)) errRet = { ok: false, reason: 'RGV587', message: '反爬拦截(风控冷却中): ' + retStr };
        else if (/TOKEN_|EXPIRED|EXOIRED|LOGIN/i.test(retStr)) errRet = { ok: false, reason: 'TOKEN_EXPIRED', message: '登录态令牌过期，请重新登录: ' + retStr };
        else if (/FAIL_SYS_USER_VALIDATE/i.test(retStr)) errRet = { ok: false, reason: 'USER_VALIDATE', message: '账号校验失败(可能风控): ' + retStr };
      }
    } catch (e) {}
    if (errRet) return errRet;

    // 仅在成功响应时刷新 _m_h5_tk：mtop 正常响应经常在 set-cookie 里下发新 token
    const setCookies = mres.setCookies || new Map();
    if (setCookies.has('_m_h5_tk')) {
      const newVal = setCookies.get('_m_h5_tk');
      try {
        const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        const cookies = j.cookies || [];
        const idx = cookies.findIndex(c => c.name === '_m_h5_tk' && ((c.domain || '').includes('ele.me') || (c.domain || '').includes('taobao')));
        const oldVal = idx >= 0 ? cookies[idx].value : '';
        if (newVal && newVal !== oldVal) {
          if (idx >= 0) cookies[idx].value = newVal;
          else cookies.push({ name: '_m_h5_tk', value: newVal, domain: '.ele.me', path: '/' });
          fs.writeFileSync(STATE_PATH, JSON.stringify(j), 'utf8');
          refreshedToken = newVal;
          console.log('[token] mtop 返回新 _m_h5_tk，已自动刷新本地 STATE_PATH');
        }
      } catch (e) { console.error('[token] 刷新失败', e.message); }
    }

    if (body.includes('listItems')) captures.push(body);
  }

  if (captures.length === 0) {
    return { ok: false, reason: 'NO_DATA', message: '未捕获到商品数据（接口变化或无 listItems）；最近一次原始响应: ' + lastBody.slice(0, 220) };
  }

  const cur = buildSnapshot(captures);
  // distance 可能缺失（接口偶发不返回）。缺失时不应把店铺排除掉——
  // 否则同一批数据会因字段缺失而忽多忽少（曾出现 5 家只显示 3 家）。
  const inRange = cur.filter(s => s.distance == null || s.distance <= MAX_DIST);
  const prev = prevSnap;
  const d = diff(prev, cur);
  prevSnap = cur;
  savePrevSnap(cur);

  const now = beijingNow();
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

  return { ok: true, now, cur, inRange, d, md, hadPrev: !!prev, newToken: !!refreshedToken };
}

module.exports = { collect, buildSnapshot, diff, num };
