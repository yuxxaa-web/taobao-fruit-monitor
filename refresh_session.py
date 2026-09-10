#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地辅助脚本：重新登录饿了么，导出 Playwright storage state（含新鲜 _m_h5_tk）。

用途
----
云端 FC 函数里的饿了么登录态过期（返回 TOKEN_EXPIRED）后，在本机【有图形界面】环境运行本脚本，
登录后把最新 storageState 导出到 cloud/browser-state.json；随后再跑 upload_state.py 上传到 OSS，
云端下次冷启动自动拉取，无需重建镜像。

关键修正（v2）
-----------
- 旧版用 tracker_id / ut_user 等「页面加载即下发」的追踪 cookie 判定登录态，会误判、提前保存，
  导致导出的是未真正登录 / token 已过期的状态。
- 本版：① 仅用严格鉴权 cookie 判定登录；② 保存前强制校验 _m_h5_tk 真实存在且签发时间
  在最近 10 分钟内（用本机真实时钟）；③ 登录后跳转搜索页，真正触发 mtop 刷新 token 后再保存。

前置
----
  pip install playwright && playwright install chromium
  （必须在能看到浏览器窗口的机器上运行，不能在无图形界面的沙箱跑）

运行
----
  python refresh_session.py            # 默认导出到 ./browser-state.json
  python refresh_session.py out.json   # 指定输出路径
"""
import sys, json, time, threading

OUT = sys.argv[1] if len(sys.argv) > 1 else "browser-state.json"
LOGIN_URL = "https://h5.ele.me/?"
SEARCH_URL = "https://h5.ele.me/minisearch/result?keyword=%E6%B0%B4%E6%9E%9C"

# 严格鉴权 cookie：必须命中其一才视为「真正登录」（排除 tracker_id/ut_user 等追踪 cookie）
STRICT_AUTH_COOKIES = {"SID", "eleme_key", "USERID", "snsInfo", "ALIAUTH", "taobao_token"}
# token 最大允许年龄（秒）。饿了么 _m_h5_tk 通常 ~2h 有效期，这里要求导出时不超过 10 分钟，确保到云端仍有效。
MAX_TOKEN_AGE_S = 600

_save_now = False

def _input_watchdog():
    global _save_now
    try:
        input()            # 阻塞直到用户回车
        _save_now = True
    except Exception:
        pass

def is_logged_in(storage):
    names = {c["name"] for c in storage.get("cookies", [])}
    return bool(names & STRICT_AUTH_COOKIES)

def token_info(storage):
    """返回 (是否存在, 签发距今秒数或 None)。token 值形如 xxx_<毫秒时间戳>。"""
    for c in storage.get("cookies", []):
        if c["name"] == "_m_h5_tk":
            val = c.get("value", "")
            ts = val.split("_")[-1]
            if ts.isdigit():
                age = time.time() - int(ts) / 1000.0
                return True, age
            return True, None
    return False, None

def main():
    from playwright.sync_api import sync_playwright

    watcher = threading.Thread(target=_input_watchdog, daemon=True)
    watcher.start()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                        "Mobile/15E148 Safari/604.1"),
            viewport={"width": 414, "height": 896}, locale="zh-CN",
            permissions=["geolocation"],
            geolocation={"latitude": 30.195314, "longitude": 120.260189},
        )
        page = ctx.new_page()
        print(">>> 正在打开饿了么首页 ...")
        page.goto(LOGIN_URL, wait_until="domcontentloaded")

        print(">>> 请在浏览器窗口中完成登录（扫码 / 手机号+验证码）。")
        print(">>> 登录成功判定：出现 SID / eleme_key / USERID / ALIAUTH 等鉴权 cookie。")
        print(">>> 也可在登录并跳转后直接按【回车】强制保存当前状态。")
        print(">>> （10 分钟内未检测到真正登录则自动退出）")

        # 1) 等待真正登录
        deadline = time.time() + 600
        while time.time() < deadline:
            storage = ctx.storage_state()
            if is_logged_in(storage) or _save_now:
                break
            time.sleep(3)
        else:
            print(">>> 超时未检测到真正登录。请重新运行并在登录后再试。")
            browser.close()
            return

        print(">>> 已检测到登录态，正在跳转到搜索页以刷新 _m_h5_tk ...")
        try:
            page.goto(SEARCH_URL, wait_until="networkidle", timeout=60000)
        except Exception as e:
            print(">>> 搜索页加载超时（忽略，继续）:", str(e)[:80])

        # 2) 轮询直到 _m_h5_tk 新鲜（最近 10 分钟内签发）再保存
        dl2 = time.time() + 150
        last_age = None
        while time.time() < dl2:
            storage = ctx.storage_state()
            present, age = token_info(storage)
            last_age = age
            if present and age is not None and age < MAX_TOKEN_AGE_S:
                with open(OUT, "w", encoding="utf-8") as f:
                    json.dump(storage, f, ensure_ascii=False, indent=2)
                n = len(storage.get("cookies", []))
                print(f">>> 已写入 {OUT}（cookie 数: {n}，_m_h5_tk 新鲜，{age:.0f}s 前签发）。可关闭浏览器窗口。")
                browser.close()
                return
            # 还没拿到新鲜 token：刷新搜索页再等
            try:
                page.reload(wait_until="networkidle")
            except Exception:
                pass
            time.sleep(4)

        # 3) 超时仍未拿到新鲜 token：保存当前状态但明确告警
        storage = ctx.storage_state()
        present, age = token_info(storage)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(storage, f, ensure_ascii=False, indent=2)
        n = len(storage.get("cookies", []))
        if present:
            print(f">>> [警告] 已写入 {OUT}（{n} cookie），但 _m_h5_tk 签发于 {age:.0f}s 前"
                  f"（> {MAX_TOKEN_AGE_S}s）。很可能仍是过期 token，请重新登录后重试。")
        else:
            print(f">>> [警告] 已写入 {OUT}（{n} cookie），但未找到 _m_h5_tk。请重新登录后重试。")
        browser.close()

if __name__ == "__main__":
    main()
