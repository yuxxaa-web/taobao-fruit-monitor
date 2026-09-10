# 捕获真实页面发出的 relationrecommend 请求（URL + 完整参数 + headers），
# 作为协议层直连的 ground truth：拿到真实 appKey 与 data 字段，解决
# FAIL_BIZ_PARAM_ERR(appId=0) 与 FAIL_SYS_PARAMINVALID_ERROR。
# 注意：即使响应被 RGV587 拦截，"请求本身"仍携带真实的 appKey/params，足够我们复现。
import time, json, re, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

STATE = r"D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\cloud\browser-state.json"
OUT = r"D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\cloud\_captured_request.json"
LAT, LON = 30.195314, 120.260189
KW = "水果"

TARGET = "relationrecommend"

url = (f"https://h5.ele.me/minisearch/result?keyword={KW}"
       f"&longitude={LON}&latitude={LAT}&geohash=wtmeb8fu3w82&entry_code=0")

captured = []

with sync_playwright() as p:
    # headless=True 也能触发真实的 mtop 请求（此前 RGV587 即在此模式下观察到）
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
    ctx = browser.new_context(
        storage_state=STATE,
        user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                    "Mobile/15E148 Safari/604.1"),
        viewport={"width": 414, "height": 896}, device_scale_factor=2,
        is_mobile=True, has_touch=True, locale="zh-CN",
        geolocation={"latitude": LAT, "longitude": LON}, permissions=["geolocation"],
    )
    page = ctx.new_page()

    def on_request(req):
        if TARGET in req.url:
            try:
                pd = req.post_data
            except Exception:
                pd = None
            captured.append({"url": req.url, "method": req.method,
                             "headers": dict(req.headers), "post_data": pd})
    page.on("request", on_request)

    print(">>> 打开搜索页，捕获 relationrecommend 请求 ...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        print("goto err:", e)
    for attempt in range(1, 5):
        time.sleep(15)
        if captured:
            break
        print(f">>> 第 {attempt} 次未捕获，刷新重试 ...")
        try:
            page.reload(wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print("reload err:", e)
    browser.close()

print(f"捕获到 {len(captured)} 条 {TARGET} 请求")
if not captured:
    print("未捕获（页面可能未发出该请求），本次无法提取 ground truth")
    sys.exit(1)

# 解析第一条：提取 appKey / data / 其它 query 参数
first = captured[0]
u = first["url"]
qs = parse_qs(urlparse(u).query)
info = {
    "host": urlparse(u).netloc,
    "path": urlparse(u).path,
    "query": {k: v[0] for k, v in qs.items()},
    "headers": first["headers"],
    "method": first["method"],
    "post_data": first.get("post_data"),
    "raw_url": u,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(info, f, ensure_ascii=False, indent=2)
print("已写入", OUT)

q = info["query"]
print("\n=== 关键信息 ===")
print("host  :", info["host"])
print("appKey:", q.get("appKey"))
print("api   :", q.get("api"))
print("v     :", q.get("v"), "| type:", q.get("type"), "| jsv:", q.get("jsv"))
data = q.get("data", "")
if not data and first.get("post_data"):
    import urllib.parse as up
    m = re.search(r'(?:^|&)data=([^&]+)', first["post_data"])
    if m:
        data = up.unquote(m.group(1))
print("method:", first["method"])
print("data  :", data[:900])
try:
    print("\n=== data 字段解析 ===")
    print(json.dumps(json.loads(data), ensure_ascii=False, indent=2))
except Exception as e:
    print("(data 非 JSON 或解析失败)", e)
print("\n=== 关键 header ===")
for k in ("cookie", "x-mini-wua", "x-sign", "x-umt", "user-agent", "referer", "origin", "content-type", "x-sid"):
    v = info["headers"].get(k)
    if v is not None:
        print(f"  {k}: {str(v)[:120]}")
