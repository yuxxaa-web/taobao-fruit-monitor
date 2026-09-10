# -*- coding: utf-8 -*-
"""
把本地最新的 browser-state.json 上传到 OSS，供云端函数冷启动时拉取。

用法（在本机执行）：
  set AK_ID=... && set AK_SECRET=... && python upload_state.py [本地路径]

默认本地路径：../cloud/browser-state.json（refresh_session.py 导出位置）
"""
import os, sys, json, time

import oss2
from alibabacloud_fc_open20210406.client import Client as FcClient
from alibabacloud_fc_open20210406 import models as fm
from alibabacloud_tea_openapi import models as oa

AK = os.environ.get("AK_ID")
SK = os.environ.get("AK_SECRET")
BUCKET = "tbmon-ele-state-1494835331304265"
ENDPOINT = "oss-cn-hangzhou.aliyuncs.com"             # 本机上传用（公网）
INTERNAL_ENDPOINT = "oss-cn-hangzhou-internal.aliyuncs.com"  # 云端 FC 同地域内网，免流量费
OBJECT = "browser-state.json"
SERVICE = "tbmon-svc"
FUNCTION = "tbmon-fn"

DEFAULT_LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser-state.json")


def main():
    local = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LOCAL
    if not os.path.exists(local):
        sys.exit(f"[ERR] 本地文件不存在: {local}")

    # 上传前先自检：确认含 _m_h5_tk（否则云端必然 TOKEN_EXPIRED）
    try:
        j = json.loads(open(local, encoding="utf-8").read())
        cookies = j.get("cookies", [])
        tk = next((c for c in cookies if c.get("name") == "_m_h5_tk"), None)
        print(f"[自检] 文件大小={os.path.getsize(local)}B, cookie={len(cookies)} 个")
        if not tk:
            print("[WARN] 未找到 _m_h5_tk，该会话可能无效！")
        else:
            ts = tk["value"].split("_")[-1]
            age_h = (int(time.time() * 1000) - int(ts)) / 1000 / 3600 if ts.isdigit() else None
            print(f"[自检] _m_h5_tk 已存在，签发距今约 {age_h:.1f} 小时" if age_h is not None else "[自检] _m_h5_tk 已存在")
    except Exception as e:
        print(f"[WARN] 自检失败: {e}")

    auth = oss2.Auth(AK, SK)
    b = oss2.Bucket(auth, ENDPOINT, BUCKET)              # 公网：本机上传
    b_int = oss2.Bucket(auth, INTERNAL_ENDPOINT, BUCKET)  # 内网：生成云端 FC 用的签名 URL
    b.put_object_from_file(OBJECT, local)
    print(f"[OK] 已上传 {local} -> oss://{BUCKET}/{OBJECT}")

    # 回读确认
    body = b.get_object(OBJECT).read()
    print(f"[OK] 回读校验 {len(body)}B")

    # 生成长期签名 URL（云端 FC 拉取/写回均走内网，免流量费）
    read_url = b_int.sign_url("GET", OBJECT, 10 * 365 * 24 * 3600).replace("http://", "https://", 1)
    write_url = b_int.sign_url("PUT", OBJECT, 10 * 365 * 24 * 3600).replace("http://", "https://", 1)
    print(f"[OK] STATE_URL / STATE_WRITE_URL 已生成（内网端点，有效期 10 年）")

    # 同步到 FC 函数环境变量，使函数能自动把刷新后的 token 写回 OSS
    try:
        fc = FcClient(oa.Config(access_key_id=AK, access_key_secret=SK, region_id="cn-hangzhou", endpoint="fc.cn-hangzhou.aliyuncs.com"))
        f = fc.get_function(SERVICE, FUNCTION, fm.GetFunctionRequest()).body
        env = dict(f.environment_variables or {})
        env["STATE_URL"] = read_url
        env["STATE_WRITE_URL"] = write_url
        # 更新函数时 CPU 必须和 memory 成比例；保持原值
        fc.update_function(
            SERVICE, FUNCTION,
            fm.UpdateFunctionRequest(
                runtime=f.runtime,
                handler=f.handler,
                memory_size=f.memory_size,
                cpu=f.cpu,
                timeout=f.timeout,
                disk_size=f.disk_size,
                instance_concurrency=f.instance_concurrency,
                environment_variables=env,
            ),
        )
        print("[OK] 已为 FC 函数绑定 STATE_URL / STATE_WRITE_URL（内网端点）")
    except Exception as e:
        print(f"[WARN] 同步 STATE_WRITE_URL 到 FC 失败（函数仍可运行，只是无法自动续期 token）：{str(e)[:180]}")


if __name__ == "__main__":
    main()
