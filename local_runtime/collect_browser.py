# -*- coding: utf-8 -*-
"""
本机浏览器采集器（最终方案）：Windows 计划任务白天 08:00-22:00 每 30 分钟调起。

2026-09-20 降风控改造（用户账号曾被风控一天）：
  - 只保留本机浏览器引擎（华为云裸协议定时器已删，GitHub Actions 已废弃）
  - 计划任务仍每 10 分钟触发，但脚本自限流：实际采集至少间隔 28 分钟（≈每 30 分钟一轮）
  - 启动随机延迟 15-90 秒（打散整点节奏，避免机械的固定间隔）
  - 夜间 22:00-07:59 脚本内直接退出（正常人不会半夜刷外卖）
  - 关键词每轮随机排序、页面停留/进店间隔全部随机化
  - 汇总推送从 29 分钟改为 2 小时一次

流程：
  1. 启动 Chromium（默认 headless，参数 --headful 可切换有头）
  2. 载入 local-state/browser-state.json 登录态，依次搜索「水果」「水果店」
  3. 拦截页面自身发出的 mtop.relationrecommend 响应（浏览器自带反爬签名，不走裸协议）
  4. 解析价格快照 → 与 prev-snap.json 比对涨跌
  5. 重点店铺（DETAIL_KEYS）从搜索结果取 scheme 进店 → 滚动加载全量商品
     （拦截 mtop.venus.shopcategoryservice.getcategorydetail）→ 与 prev-detail.json 比对
  6. PushPlus 推送（价格变动 / 2 小时汇总 / 重点店铺商品变动 / 失败告警，全部去重）
  7. 回写最新 storage_state（cookie 保活，正常情况下登录态可长期续命）
依赖：system Python 3.12 + playwright（chromium-1223 已装）
"""
import json, os, random, re, sys, time, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.abspath(os.path.join(BASE, "..", "local-state"))
STATE_PATH = os.path.join(STATE_DIR, "browser-state.json")
LOCK = os.path.join(STATE_DIR, "run.lock")
MARKER = os.path.join(STATE_DIR, "last-collect.json")  # 上次实际采集时间（脚本自限流用）
MIN_GAP = 28 * 60  # 实际采集最小间隔：计划任务仍是每10分钟触发，由脚本自限到~30分钟节奏
                   # （2026-09-20：旧任务为管理员权限创建无法改触发器，故在脚本内限流）
PUSHPLUS_TOKEN = os.environ.get("PUSHPLUS_TOKEN", "")
KW_LIST = ["水果", "水果店"]
MAX_DIST = 3000
SUMMARY_INTERVAL = 2 * 3600  # 汇总推送间隔：2 小时（2026-09-20 降频后调整）
# 重点店铺：店名含这些关键词的做进店全量商品监控（2026-09-16 用户指定）
DETAIL_KEYS = ["忘本甄果", "半斗米"]
# 兜底进店链接（搜索结果里不一定出现，store_id/ele_id 稳定不变；2026-09-16 实测提取）
DETAIL_FALLBACK = {
    "忘本甄果": "https://h5.ele.me/newretail/p/ushop/?store_id=20016597017&ele_id=E14888526228611457827&isSelfFetch=2&fetchType=0",
    "半斗米": "https://h5.ele.me/newretail/p/ushop/?store_id=239252425&ele_id=E7604067537284844159&isSelfFetch=0&fetchType=0",
}

# ---------- .env ----------
def load_env():
    global PUSHPLUS_TOKEN
    p = os.path.join(BASE, ".env")
    try:
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                if k.strip() == "PUSHPLUS_TOKEN" and not PUSHPLUS_TOKEN:
                    PUSHPLUS_TOKEN = v.strip()
    except FileNotFoundError:
        pass

def load_json(name, default):
    try:
        return json.load(open(os.path.join(STATE_DIR, name), encoding="utf-8"))
    except Exception:
        return default

def save_json(name, obj):
    try:
        json.dump(obj, open(os.path.join(STATE_DIR, name), "w", encoding="utf-8"), ensure_ascii=False)
    except Exception as e:
        print("[save]", name, e)

def to_txt(md, limit=650):
    """markdown 转纯文本（微信客服文本消息上限约 2048 字节≈650 汉字）"""
    lines = []
    for ln in md.splitlines():
        ln = ln.replace("**", "").replace("`", "")
        ln = re.sub(r"^#+\s*", "", ln)
        ln = re.sub(r"^\s*-\s+", "· ", ln)
        if ln.strip():
            lines.append(ln.rstrip())
    txt = "\n".join(lines)
    if len(txt) > limit:
        txt = txt[:limit] + "\n…(内容过长已截断)"
    return txt

def pushplus(title, content):
    if not PUSHPLUS_TOKEN:
        return False
    try:
        # 2026-09-16：改用 txt 纯文本模板，内容直接显示在微信会话里，
        # 不再跳 H5 网页（此前 markdown 模板点开常"跳转失败"）
        data = json.dumps({"token": PUSHPLUS_TOKEN, "title": title,
                           "content": to_txt(content), "template": "txt"}).encode()
        req = urllib.request.Request("https://www.pushplus.plus/send", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read().decode())
            print("[pushplus]", j)
            return j.get("code") == 200
    except Exception as e:
        print("[pushplus] error", e)
        return False

# ---------- 快照解析（与 collect.js buildSnapshot 同构） ----------
def build_snapshot(bodies):
    shops = {}
    for txt in bodies:
        try:
            j = json.loads(txt)
        except Exception:
            continue
        for res in ((j.get("data") or {}).get("result") or []):
            for it in (res.get("listItems") or []):
                info = it.get("info") or {}
                r = info.get("restaurant") or {}
                if not r.get("name"):
                    continue
                sid = r.get("id") or r["name"]
                s = shops.setdefault(sid, {"name": r["name"], "id": sid, "distance": r.get("distance"),
                                           "rating": r.get("rating"), "foods": []})
                if r.get("distance") is not None and (s["distance"] is None or r["distance"] < s["distance"]):
                    s["distance"] = r["distance"]
                for fo in (info.get("foods") or []):
                    name = fo.get("name")
                    if not name:
                        continue
                    price = fo.get("sellPriceStr")
                    if price is None and fo.get("sellPrice") is not None:
                        price = str(fo["sellPrice"])
                    if price is None and fo.get("predictPrice") is not None:
                        price = str(fo["predictPrice"])
                    if all(f["name"] != name for f in s["foods"]):
                        s["foods"].append({"name": name, "price": price})
    return sorted(shops.values(), key=lambda s: s["distance"] or 0)

def num(p):
    try:
        return float("".join(ch for ch in str(p) if ch.isdigit() or ch == "."))
    except Exception:
        return None

# ---------- 重点店铺全量商品 ----------
def parse_shop_items(bodies):
    """解析 getcategorydetail 响应 → {itemId: {t: 标题, p: 价格文本}}"""
    items = {}
    for txt in bodies:
        try:
            j = json.loads(txt)
        except Exception:
            continue
        d = (j.get("data") or {}).get("data")
        if isinstance(d, dict):
            d = [d]
        for block in (d or []):
            for f in (block.get("foods") or []):
                it = f.get("item") or {}
                iid = it.get("itemId")
                if not iid:
                    continue
                price = (it.get("currentPrice") or {}).get("priceText")
                items[iid] = {"t": it.get("title") or ("商品%s" % iid), "p": price}
    return items

def diff_items(prev, cur):
    d = {"up": [], "down": [], "new": [], "removed": []}
    for iid, c in cur.items():
        p = prev.get(iid)
        if not p:
            d["new"].append("%s ¥%s" % (c["t"], c["p"] if c["p"] else "?"))
            continue
        a, b = num(p["p"]), num(c["p"])
        if a is not None and b is not None:
            if b > a:
                d["up"].append("%s ¥%s→¥%s" % (c["t"], p["p"], c["p"]))
            elif b < a:
                d["down"].append("%s ¥%s→¥%s" % (c["t"], p["p"], c["p"]))
    for iid, p in prev.items():
        if iid not in cur:
            d["removed"].append(p["t"])
    return d

def find_schemes(bodies):
    """从搜索响应里提取重点店铺的进店链接 scheme"""
    schemes = {}
    for txt in bodies:
        try:
            j = json.loads(txt)
        except Exception:
            continue
        for res in ((j.get("data") or {}).get("result") or []):
            for it in (res.get("listItems") or []):
                r = (it.get("info") or {}).get("restaurant") or {}
                nm = r.get("name") or ""
                sc = r.get("scheme")
                if not sc:
                    continue
                for key in DETAIL_KEYS:
                    # 精确匹配（忘本甄果 不要误匹配 永恒甄果；半斗米 不要误匹配分店）
                    if key in nm and key not in schemes:
                        schemes[key] = (nm, sc)
    return schemes

def collect_shop_detail(page, surl):
    """打开店铺页并滚动加载全量商品，返回 items dict（失败返回 None）"""
    detail_bodies = []
    def on_detail(resp):
        if "getcategorydetail" in resp.url:
            try:
                detail_bodies.append(resp.text())
            except Exception:
                pass
    page.on("response", on_detail)
    try:
        page.goto(surl, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(10000)
        prev_n, stall = -1, 0
        for _ in range(24):
            page.mouse.wheel(0, random.randint(2000, 3000))
            page.wait_for_timeout(random.randint(2200, 3200))
            if len(detail_bodies) == prev_n:
                stall += 1
                if stall >= 4:
                    break
            else:
                stall = 0
            prev_n = len(detail_bodies)
        return parse_shop_items(detail_bodies)
    except Exception as e:
        print("[detail] err:", str(e)[:100])
        return None
    finally:
        try:
            page.remove_listener("response", on_detail)
        except Exception:
            pass

def build_detail_md(det):
    """重点店铺变动详情 markdown（变动或首基线时推送）"""
    md = "# %s · 商品变动 %s\n\n" % (det["name"], det["now"])
    d = det["diff"]
    md += "共 %d 个商品在售\n\n" % det["count"]
    if det["first"]:
        md += "（首次采集，建立基线，全量清单如下）\n\n"
        for iid, it in sorted(det["items"].items(), key=lambda x: num(x[1]["p"]) or 0):
            md += "- %s%s\n" % (it["t"], (" ¥" + str(it["p"])) if it["p"] else "")
    else:
        md += ("- 🔺 涨价（%d）：%s\n" % (len(d["up"]), "；".join("`%s`" % x for x in d["up"]))) if d["up"] else "- 🔺 涨价：无\n"
        md += ("- 🔻 降价（%d）：%s\n" % (len(d["down"]), "；".join("`%s`" % x for x in d["down"]))) if d["down"] else "- 🔻 降价：无\n"
        md += ("- ➕ 新上架（%d）：%s\n" % (len(d["new"]), "；".join("`%s`" % x for x in d["new"][:30]) + (" …" if len(d["new"]) > 30 else ""))) if d["new"] else "- ➕ 新上架：无\n"
        md += ("- ❌ 下架（%d）：%s\n" % (len(d["removed"]), "；".join("`%s`" % x for x in d["removed"][:30]) + (" …" if len(d["removed"]) > 30 else ""))) if d["removed"] else "- ❌ 下架：无\n"
    return md


def diff(prev, cur):
    pm = {s["id"]: s for s in (prev or [])}
    cm = {s["id"]: s for s in cur}
    d = {"newShops": [], "removedShops": [], "priceUp": [], "priceDown": [], "newFruits": [], "removedFruits": []}
    for cs in cur:
        ps = pm.get(cs["id"])
        if not ps:
            d["newShops"].append(cs["name"])
            continue
        pf = {f["name"]: f["price"] for f in ps["foods"]}
        for f in cs["foods"]:
            if f["name"] not in pf:
                d["newFruits"].append(cs["name"] + " / " + f["name"] + (" ¥" + f["price"] if f["price"] else ""))
                continue
            a, b = num(pf[f["name"]]), num(f["price"])
            if a is not None and b is not None and b > a:
                d["priceUp"].append(cs["name"] + " / " + f["name"] + " ¥" + str(pf[f["name"]]) + "→¥" + str(f["price"]))
            if a is not None and b is not None and b < a:
                d["priceDown"].append(cs["name"] + " / " + f["name"] + " ¥" + str(pf[f["name"]]) + "→¥" + str(f["price"]))
        for name in pf:
            if name not in {f["name"] for f in cs["foods"]}:
                d["removedFruits"].append(cs["name"] + " / " + name)
    for pid, ps in pm.items():
        if pid not in cm:
            d["removedShops"].append(ps["name"])
    return d

def fmt_dist(x):
    if x is None:
        return "?"
    return ("%.2fkm" % (x / 1000)) if x >= 1000 else "%dm" % x

def build_md(now, cur, in_range, d, had_prev):
    md = "# JKKB %s\n\n" % now
    md += "- 总计店铺：%d 家（3km 内 %d 家）\n" % (len(cur), len(in_range))
    if had_prev:
        md += "## 较上次变动\n"
        md += ("- 🔺 涨价（%d）：%s\n" % (len(d["priceUp"]), "；".join("`%s`" % x for x in d["priceUp"]))) if d["priceUp"] else "- 🔺 涨价：无\n"
        md += ("- 🔻 降价（%d）：%s\n" % (len(d["priceDown"]), "；".join("`%s`" % x for x in d["priceDown"]))) if d["priceDown"] else "- 🔻 降价：无\n"
        md += ("- 🆕 新店：%s\n" % "、".join(d["newShops"])) if d["newShops"] else "- 🆕 新店：无\n"
        md += ("- ❌ 消失店铺：%s\n" % "、".join(d["removedShops"])) if d["removedShops"] else "- ❌ 消失店铺：无\n"
        md += ("- ➕ 新增水果（%d）：%s\n" % (len(d["newFruits"]), "；".join(d["newFruits"][:20]) + (" …" if len(d["newFruits"]) > 20 else ""))) if d["newFruits"] else "- ➕ 新增水果：无\n"
    else:
        md += "\n（首次采集，已建立基线，下次开始对比涨跌）\n"
    md += "\n## 当前 3km 内店铺\n"
    for i, s in enumerate(in_range):
        md += "%d. **%s** · %s%s · 水果 %d 个\n" % (i + 1, s["name"], fmt_dist(s["distance"]),
                                                    (" · ⭐%s" % s["rating"]) if s.get("rating") else "", len(s["foods"]))
        for f in s["foods"][:6]:
            md += "   - %s%s\n" % (f["name"], (" ¥" + str(f["price"])) if f["price"] else "")
    return md

# ---------- 通知（与 run_local.js 同构的去重逻辑） ----------
def notify(result, st):
    sent = 0
    if not PUSHPLUS_TOKEN:
        return sent
    now_ms = time.time() * 1000
    try:
        if not result.get("ok"):
            sig = "E:" + str(result.get("reason"))
            if sig != st.get("lastEmrgSig"):
                reason = result.get("reason")
                if reason == "NO_STATE":
                    title = "【TBSG-JK】本机监控缺少登录态"
                    guide = "请在 github-src 目录执行 python refresh_session.py，然后把 browser-state.json 拷到 local-state/。"
                elif reason == "LOGIN_REQUIRED":
                    title = "【TBSG-JK】登录态过期，需重新登录"
                    guide = "基础 cookie 已失效。请执行：\n  cd github-src\n  python refresh_session.py\n完成后把生成文件拷到 local-state/（或告诉我）。"
                elif reason == "RGV587":
                    title = "【TBSG-JK】浏览器也被风控（RGV587）"
                    guide = "请在正常浏览器里打开 h5.ele.me 搜索一次水果（如弹出验证码请完成），之后自动恢复。"
                else:
                    title = "【TBSG-JK】本机采集失败：" + str(reason)
                    guide = "详情见日志；持续失败请重新登录。"
                if pushplus(title, "本机采集失败，原因=%s\n详情：%s\n\n%s" % (reason, result.get("message", ""), guide)):
                    sent += 1
                st["lastEmrgSig"] = sig
            return sent
        st["lastEmrgSig"] = None
        d = result["d"]
        if result["hadPrev"] and (d["priceUp"] or d["priceDown"]):
            sig = "P:" + json.dumps({"u": d["priceUp"], "d": d["priceDown"]}, ensure_ascii=False)
            if sig != st.get("lastPriceSig"):
                if pushplus("【TBSG-JK】HYGLL·SGJGBD", result["md"]):
                    sent += 1
                st["lastPriceSig"] = sig
        else:
            st["lastPriceSig"] = None
        if now_ms - st.get("lastSummaryTs", 0) >= SUMMARY_INTERVAL * 1000:
            if pushplus("【TBSG-JK】HYGLL·BXSSGHZ（%s）" % result["now"], result["md"]):
                sent += 1
            st["lastSummaryTs"] = now_ms

        # 重点店铺全量商品推送（变动才推 / 首基线推全量清单）
        for key, det in (result.get("detail") or {}).items():
            dd = det["diff"]
            changed = bool(dd["up"] or dd["down"] or dd["new"] or dd["removed"])
            sig_key = "lastDetailSig_" + key
            if det["first"]:
                if pushplus("【TBSG-JK】%s·全量商品基线（%d个）" % (det["name"], det["count"]), build_detail_md(det)):
                    sent += 1
                st[sig_key] = "BASELINE"
            elif changed:
                sig = "D:" + json.dumps(dd, ensure_ascii=False)
                if sig != st.get(sig_key):
                    if pushplus("【TBSG-JK】%s·商品变动" % det["name"], build_detail_md(det)):
                        sent += 1
                    st[sig_key] = sig
            else:
                st[sig_key] = None
    except Exception as e:
        print("[notify]", e)
    return sent

# ---------- 采集主流程 ----------
def collect_once():
    if not os.path.exists(STATE_PATH):
        return {"ok": False, "reason": "NO_STATE", "message": "缺少 browser-state.json"}
    from playwright.sync_api import sync_playwright

    headful = "--headful" in sys.argv
    captured = []          # 拦截到的 listItems 响应体
    mtop_fail = ""         # mtop 响应里的错误 ret（RGV587 等）
    login_needed = False   # session check 报需要登录

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headful)
        ctx = browser.new_context(
            storage_state=STATE_PATH,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                        "Mobile/15E148 Safari/604.1"),
            viewport={"width": 414, "height": 896}, locale="zh-CN",
            permissions=["geolocation"],
            geolocation={"latitude": 30.195314, "longitude": 120.260189},
        )
        page = ctx.new_page()

        def on_response(resp):
            nonlocal mtop_fail, login_needed
            url = resp.url
            try:
                if "relationrecommend" in url:
                    body = resp.text()
                    if "listItems" in body:
                        captured.append(body)
                    else:
                        try:
                            ret = " | ".join(json.loads(body).get("ret") or [])
                        except Exception:
                            ret = body[:120]
                        if ret:
                            mtop_fail = ret
                elif "session.ele.check" in url:
                    try:
                        j = json.loads(resp.text())
                        if (j.get("data") or {}).get("errorCode") == "000502":
                            login_needed = True
                    except Exception:
                        pass
            except Exception:
                pass

        page.on("response", on_response)

        # 关键词每轮随机排序（避免固定顺序的机械特征）
        kws = KW_LIST[:]
        random.shuffle(kws)
        for i, kw in enumerate(kws):
            if i > 0:
                page.wait_for_timeout(random.randint(3000, 7000))  # 换词前随机停留
            url = "https://h5.ele.me/minisearch/result?keyword=" + urllib.request.quote(kw)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
            except Exception as e:
                print("[goto]", str(e)[:100])
            # 最多等 22 秒拿数据；拿到就提前继续
            deadline = time.time() + 22
            while time.time() < deadline and not captured:
                page.wait_for_timeout(1000)
            if "登录" in (page.title() or ""):
                login_needed = True
            if login_needed:
                break

        # ---------- 重点店铺进店采集（全量商品） ----------
        detail_out = {}
        if captured and not login_needed:
            # 进店顺序每轮随机
            keys = DETAIL_KEYS[:]
            random.shuffle(keys)
            schemes = find_schemes(captured)
            first_visit = True
            for key in keys:
                if key in schemes:
                    nm, surl = schemes[key]
                elif key in DETAIL_FALLBACK:
                    nm, surl = key, DETAIL_FALLBACK[key]  # 搜索没出现，用固定链接进店
                    print("[detail] 搜索结果未出现，使用固定链接:", key)
                else:
                    print("[detail] 搜索结果未找到且无兜底链接:", key)
                    continue
                # 拟人停留：第一家前等 3-8 秒，之后每家间隔 8-20 秒
                page.wait_for_timeout(random.randint(3000, 8000) if first_visit else random.randint(8000, 20000))
                first_visit = False
                print("[detail] 进店:", nm)
                items = collect_shop_detail(page, surl)
                if not items:
                    print("[detail] 未抓到商品:", nm)
                    continue
                detail_out[key] = {"name": nm, "items": items}

        # 回写 cookie（登录态保活核心：每次访问后浏览器会刷新 cookie 有效期）
        try:
            if not login_needed:
                state = ctx.storage_state()
                tmp = STATE_PATH + ".tmp"
                json.dump(state, open(tmp, "w", encoding="utf-8"))
                os.replace(tmp, STATE_PATH)
                print("[state] 登录态已回写保活")
        except Exception as e:
            print("[state] 回写失败", e)

        browser.close()

    if login_needed and not captured:
        return {"ok": False, "reason": "LOGIN_REQUIRED", "message": "基础 cookie 失效，页面跳转登录"}
    if not captured:
        if "RGV587" in mtop_fail:
            return {"ok": False, "reason": "RGV587", "message": mtop_fail}
        return {"ok": False, "reason": "NO_DATA", "message": "未拦截到商品数据；mtop ret=" + mtop_fail[:200]}

    cur = build_snapshot(captured)
    in_range = [s for s in cur if s["distance"] is None or s["distance"] <= MAX_DIST]
    prev = load_json("prev-snap.json", None)
    d = diff(prev, cur)
    save_json("prev-snap.json", cur)
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600))
    md = build_md(now, cur, in_range, d, prev is not None)

    # ---------- 重点店铺全量商品 diff ----------
    detail = {}
    if detail_out:
        prev_detail = load_json("prev-detail.json", {})
        for key, curd in detail_out.items():
            pv = (prev_detail.get(key) or {}).get("items") or {}
            # 加载不全守卫：本轮商品数明显少于上轮（滚动中断等）→ 跳过比对且不覆盖基线，
            # 否则会把没加载出来的商品误报成"下架"（2026-09-16 实测 83→62 误报 22 个下架）
            if pv and len(curd["items"]) < len(pv) * 0.75:
                print("[detail] %s 本轮 %d/%d 疑似加载不全，跳过比对" % (key, len(curd["items"]), len(pv)))
                detail[key] = {"name": curd["name"], "count": len(curd["items"]),
                               "items": curd["items"], "diff": {"up": [], "down": [], "new": [], "removed": []},
                               "first": False, "now": now, "short": True}
                continue
            dd = diff_items(pv, curd["items"])
            detail[key] = {"name": curd["name"], "count": len(curd["items"]),
                           "items": curd["items"], "diff": dd, "first": not pv,
                           "now": now}
            prev_detail[key] = {"name": curd["name"], "items": curd["items"]}
        save_json("prev-detail.json", prev_detail)
        # 汇总 md 追加重点店铺小节
        md += "\n## 重点店铺（全量监控）\n"
        for key in DETAIL_KEYS:
            det = detail.get(key)
            if not det:
                md += "- %s：本轮未采集到\n" % key
                continue
            if det.get("short"):
                md += "- **%s**：本轮抓取不全（%d 个），未比对\n" % (det["name"], det["count"])
                continue
            dd = det["diff"]
            chg = len(dd["up"]) + len(dd["down"]) + len(dd["new"]) + len(dd["removed"])
            md += "- **%s**：%d 个商品在售" % (det["name"], det["count"])
            if det["first"]:
                md += "（首基线）\n"
            elif chg:
                md += "，变动 %d 处（涨 %d 跌 %d 新 %d 下架 %d）\n" % (chg, len(dd["up"]), len(dd["down"]), len(dd["new"]), len(dd["removed"]))
            else:
                md += "，无变动\n"

    return {"ok": True, "now": now, "cur": cur, "in_range": in_range, "d": d, "md": md,
            "hadPrev": prev is not None, "detail": detail}

def main():
    load_env()
    # 夜间停跑（2026-09-20 降风控）：08:00 前与 22:00 后直接退出，不产生任何请求
    hour = time.gmtime(time.time() + 8 * 3600).tm_hour
    if hour < 8 or hour >= 22:
        print("[night] 夜间时段（%d 点），本轮跳过" % hour)
        return
    # 启动随机延迟 15-90 秒：打散整点节奏（须配合计划任务 5 分钟时限，不能太长）
    if "--no-jitter" not in sys.argv:
        time.sleep(random.randint(15, 90))
    # 脚本自限流：距上次实际采集不足 28 分钟直接退出（每次触发只空转，不开浏览器）
    try:
        last_ts = (load_json("last-collect.json", {}) or {}).get("ts", 0)
    except Exception:
        last_ts = 0
    if time.time() - last_ts < MIN_GAP:
        print("[throttle] 距上次采集 %.0f 分钟，本轮空转跳过" % ((time.time() - last_ts) / 60))
        return
    # 简单防重叠锁：4.5 分钟内的锁直接退出
    if os.path.exists(LOCK) and time.time() - os.path.getmtime(LOCK) < 270:
        print("[lock] 上一次还在跑，跳过")
        return
    open(LOCK, "w").write(str(time.time()))
    save_json("last-collect.json", {"ts": time.time()})
    try:
        st = load_json("notify-state.json", {"lastSummaryTs": 0, "lastPriceSig": None, "lastEmrgSig": None})
        r = collect_once()
        out = {"time": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600)), "local": True}
        if r.get("ok"):
            out.update(ok=True, shops=len(r["cur"]), inRange=len(r["in_range"]),
                       changed=bool(r["hadPrev"] and (r["d"]["priceUp"] or r["d"]["priceDown"] or r["d"]["newShops"])))
            print("[%s] OK 3km内 %d 家 | 涨 %d 跌 %d 新店 %d" % (r["now"], len(r["in_range"]),
                  len(r["d"]["priceUp"]), len(r["d"]["priceDown"]), len(r["d"]["newShops"])))
        else:
            out.update(ok=False, reason=r.get("reason"), message=(r.get("message") or "")[:200])
            print("[WARN]", r.get("reason"), (r.get("message") or "")[:150])
        out["pushSent"] = notify(r, st)
        out["pushplus"] = bool(PUSHPLUS_TOKEN)
        save_json("notify-state.json", st)
        save_json("last-run.json", out)  # 无窗口运行（pythonw）后也能查最近一次结果
        print(json.dumps(out, ensure_ascii=False))
    finally:
        try:
            os.remove(LOCK)
        except Exception:
            pass

if __name__ == "__main__":
    main()
