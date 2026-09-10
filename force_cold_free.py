# -*- coding: utf-8 -*-
"""
强制冷启动：通过变更环境变量触发实例重建，使函数重新从 STATE_URL 拉取最新登录态。
（内置运行时无镜像，冷启动仅需毫秒级）
"""
import os, time

from alibabacloud_fc_open20210406.client import Client
from alibabacloud_fc_open20210406 import models as fm
from alibabacloud_tea_openapi import models as oa

AK = os.environ.get("AK_ID")
SK = os.environ.get("AK_SECRET")
SERVICE, FUNCTION = "tbmon-svc", "tbmon-fn"

c = Client(oa.Config(access_key_id=AK, access_key_secret=SK,
                     region_id="cn-hangzhou", endpoint="fc.cn-hangzhou.aliyuncs.com"))

cur = c.get_function(SERVICE, FUNCTION, fm.GetFunctionRequest()).body
env = dict(cur.environment_variables or {})
env["DEPLOY_REVISION"] = str(int(time.time()))  # 变更 env -> 强制新实例
c.update_function(SERVICE, FUNCTION, fm.UpdateFunctionRequest(environment_variables=env))
print("[OK] 已更新 DEPLOY_REVISION =", env["DEPLOY_REVISION"], "（下次调用将冷启动并重新拉取 STATE_URL）")
