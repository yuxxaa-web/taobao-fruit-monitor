# 手动触发一次 FC 函数（Sync 调用），验证容器能拉起采集并通过 PushPlus 推送
import os, sys, json
from alibabacloud_fc_open20210406.client import Client
from alibabacloud_fc_open20210406 import models
from alibabacloud_tea_openapi import models as open_api_models

REGION = "cn-hangzhou"
ENDPOINT = "fc.cn-hangzhou.aliyuncs.com"
SERVICE = "tbmon-svc"
FUNCTION = "tbmon-fn"

cfg = open_api_models.Config(
    access_key_id=os.environ["AK_ID"],
    access_key_secret=os.environ["AK_SECRET"],
    region_id=REGION, endpoint=ENDPOINT,
    read_timeout=300000, connect_timeout=15000)
c = Client(cfg)

req = models.InvokeFunctionRequest(body=b"")
import time
last = None
for attempt in range(1, 5):
    try:
        print(f">>> 第 {attempt} 次调用函数（冷启动+采集预计 60~150s）...")
        resp = c.invoke_function(SERVICE, FUNCTION, req)
        body = resp.body
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", "replace")
        print("status_code:", getattr(resp, "status_code", None))
        print("=== 函数返回 ===")
        print(body)
        break
    except Exception as e:
        last = e
        msg = str(e)
        print(f"[重试 {attempt}] 调用异常: {msg[:160]}")
        if "503" in msg or "ServiceUnavailable" in msg or "timed out" in msg:
            time.sleep(10)
            continue
        raise
else:
    print(">>> 多次重试仍失败:", str(last)[:300])
