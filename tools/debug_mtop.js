// 本地复现 collect.js 的 mtop 调用，打印原始响应用于诊断 NO_DATA
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const APP_KEY = '12574478';
const APP_ID = '26551';
const API_PATH = 'mtop.relationrecommend.elemetinyapprecommend.recommend';
const API_NAME = 'mtop.relationrecommend.ElemeTinyAppRecommend.recommend';
const LOC = { latitude: 30.195314, longitude: 120.260189 };

function loadCookies() {
  const j = JSON.parse(fs.readFileSync(process.argv[2] || 'browser-state.json', 'utf8'));
  const cookies = (j.cookies || []).filter(c => (c.domain || '').match(/ele\.me|taobao|alicdn|tbcdn/));
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const tkC = cookies.find(c => c.name === '_m_h5_tk');
  const token = tkC ? tkC.value.split('_')[0] : '';
  return { cookieStr, token, cookieCount: cookies.length };
}

function mtopSign(token, t, data) {
  return crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${data}`).digest('hex');
}

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

function mtop(paramsObj) {
  return new Promise((resolve, reject) => {
    const ck = loadCookies();
    const t = Date.now();
    const outerData = JSON.stringify({ type: 'originaljson', appId: APP_ID, params: JSON.stringify(paramsObj) });
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
    console.log('token =', ck.token ? ck.token.slice(0, 12) + '...' : '(empty)');
    console.log('matched cookies =', ck.cookieCount);
    const req = https.request(url, { method: 'POST', headers, timeout: 20000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf, setCookies: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

(async () => {
  const r = await mtop(buildParams('水果'));
  console.log('HTTP status =', r.status);
  console.log('set-cookie count =', r.setCookies.length);
  console.log('--- body head (1500) ---');
  console.log(r.body.slice(0, 1500));
  console.log('--- has listItems?', r.body.includes('listItems'));
  try {
    const j = JSON.parse(r.body);
    console.log('ret =', JSON.stringify(j.ret));
  } catch (e) { console.log('body not json'); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
