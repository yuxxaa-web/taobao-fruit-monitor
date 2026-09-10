# 验证 mtop 老版 sign 算法：用捕获请求的 t / data / appKey + state 里的 token，
# 复算 md5(token&t&appKey&data)，与捕获到的 sign 比对。一致即证明协议已完整逆向。
import json, hashlib, urllib.parse

CAP = r"D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\cloud\_captured_request.json"
STATE = r"D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\cloud\browser-state.json"

d = json.load(open(CAP, encoding="utf-8"))
q = d["query"]
t = q["t"]
cap_sign = q["sign"]
appKey = q["appKey"]

# 从 POST body 取出 data（urlencoded）
body = d.get("post_data") or ""
data_str = urllib.parse.unquote_plus(body.split("data=", 1)[1]) if "data=" in body else ""

# token
st = json.load(open(STATE, encoding="utf-8"))
tk = next((c for c in st.get("cookies", []) if c.get("name") == "_m_h5_tk"), None)
token = tk["value"].split("_")[0] if tk else ""

calc = hashlib.md5((token + "&" + t + "&" + appKey + "&" + data_str).encode()).hexdigest()
print("t        :", t)
print("appKey   :", appKey)
print("token    :", token[:14] + "...")
print("data len :", len(data_str))
print("captured :", cap_sign)
print("calculated:", calc)
print()
print("[VERDICT]", "✅ sign 算法完全一致（协议逆向成功）" if calc == cap_sign else "❌ 不一致，sign 输入不同")
