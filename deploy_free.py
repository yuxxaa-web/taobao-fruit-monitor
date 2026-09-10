# -*- coding: utf-8 -*-
"""
免费路线部署：把函数从「自定义容器(custom-container)」切换为「内置 Node.js 运行时(nodejs20)」。

为什么要换：
  - 自定义容器每次冷启动要拉取 3.4GB 的 Playwright 镜像 -> 镜像存储费 + 公网拉取流量费 + 数十秒冷启动计费
  - 内置运行时只需上传 ~10KB 代码包，冷启动毫秒级，全部落在 FC 每月免费额度内

同时降配以进一步压低成本：
  memory 1024MB -> 256MB（GB-s 降为 1/4）
  timeout 300s  -> 60s
  disk  512MB（最低档）
  无 VPC / 无 NAS / 无 SLS 日志投递 / 无预留实例 —— 全部不产生费用

用法：
  set AK_ID=... && set AK_SECRET=... && python deploy_free.py
"""
import os, sys, io, json, zipfile, base64

from alibabacloud_fc_open20210406.client import Client
from alibabacloud_fc_open20210406 import models as fm
from alibabacloud_tea_openapi import models as oa

AK = os.environ.get("AK_ID")
SK = os.environ.get("AK_SECRET")
REGION = "cn-hangzhou"
ENDPOINT = f"fc.{REGION}.aliyuncs.com"
SERVICE = "tbmon-svc"
FUNCTION = "tbmon-fn"
RUNTIME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fc_runtime")

# 免费档配置
# 注意：FC 要求 Memory(GB)/CPU(core) 比例在 1~4 之间，且必须显式给 cpu。
# 512MB(0.5GB) / 0.35核 = 1.43 ✅ —— 相比原 1024MB 省一半计费，冷启动也够快。
MEMORY = 512          # MB
CPU = 0.35            # 核
TIMEOUT = 60          # 秒
DISK = 512            # MB（最低档，10GB 档更贵）
CONCURRENCY = 1
RUNTIME = "nodejs20"
HANDLER = "index.handler"


def build_zip():
    """把 index.js + collect.js + 本地最新登录态打成代码包（FC 要求入口在包根）"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("index.js", "collect.js"):
            p = os.path.join(RUNTIME_DIR, name)
            if not os.path.exists(p):
                sys.exit(f"[ERR] 缺少 {p}")
            z.write(p, name)
        # OSS 公网端点偶发 502 时，云端函数仍能从代码包内读取本地最新登录态
        state_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser-state.json")
        if os.path.exists(state_local):
            z.write(state_local, "browser-state.json")
            print(f"[zip] 已嵌入本地登录态 {os.path.getsize(state_local)}B")
        else:
            print("[warn] 未找到本地 browser-state.json，本次部署不含登录态")
    data = buf.getvalue()
    print(f"[zip] 代码包 {len(data)} 字节（含 index.js / collect.js / browser-state.json）")
    return base64.b64encode(data).decode("utf-8")


def main():
    c = Client(oa.Config(access_key_id=AK, access_key_secret=SK,
                         region_id=REGION, endpoint=ENDPOINT))

    # 1) 读取现有环境变量，保留 PUSHPLUS_TOKEN / STATE_URL
    try:
        cur = c.get_function(SERVICE, FUNCTION, fm.GetFunctionRequest()).body
        env = dict(cur.environment_variables or {})
        print(f"[env] 继承现有环境变量: {sorted(env.keys())}")
    except Exception as e:
        print(f"[warn] 读取现有函数失败({str(e)[:80]})，使用空 env")
        env = {}

    for k, v in [("PUSHPLUS_TOKEN", ""), ("STATE_WRITE_URL", "")]:
        env.setdefault(k, v)
    # 状态目录指向 /tmp（内置运行时唯一可写区）
    env["STATE_DIR"] = "/tmp/monitor-state"
    env["STATE_PATH"] = "/tmp/browser-state.json"
    env["DEPLOY_MODE"] = "free-nodejs20"
    # 保留现有 STATE_URL（云端自动从 OSS 拉取最新登录态）；若为空则改用内网端点生成，
    # 不再清空，避免破坏「自动拉取」配置（2026-09-10 修正）。
    if not env.get("STATE_URL"):
        try:
            import oss2 as _oss
            _auth = _oss.Auth(AK, SK)
            _b = _oss.Bucket(_auth, "oss-cn-hangzhou-internal.aliyuncs.com", "tbmon-ele-state-1494835331304265")
            env["STATE_URL"] = _b.sign_url("GET", "browser-state.json", 10 * 365 * 24 * 3600).replace("http://", "https://", 1)
            print("[env] 已用内网端点生成 STATE_URL")
        except Exception as _e:
            print(f"[warn] 生成 STATE_URL 失败，保持空: {str(_e)[:80]}")

    zip_b64 = build_zip()

    # 2) 尝试直接更新（runtime 从 custom-container -> nodejs20）
    req = fm.UpdateFunctionRequest(
        runtime=RUNTIME,
        handler=HANDLER,
        code=fm.Code(zip_file=zip_b64),
        memory_size=MEMORY,
        cpu=CPU,
        timeout=TIMEOUT,
        disk_size=DISK,
        instance_concurrency=CONCURRENCY,
        environment_variables=env,
        custom_container_config=None,  # 清除容器配置
        ca_port=None,
    )
    try:
        c.update_function(SERVICE, FUNCTION, req)
        print(f"[OK] 已更新函数为 {RUNTIME}（内存 {MEMORY}MB / 超时 {TIMEOUT}s / 磁盘 {DISK}MB）")
    except Exception as e:
        msg = str(e)
        print(f"[info] update 失败: {msg[:200]}")
        print("[info] 改为删除后重建（触发器已清空，可安全重建）")
        try:
            c.delete_function(SERVICE, FUNCTION, fm.DeleteFunctionRequest())
            print("[OK] 旧函数已删除")
        except Exception as de:
            print(f"[warn] 删除失败（可能不存在）: {str(de)[:100]}")
        creq = fm.CreateFunctionRequest(
            function_name=FUNCTION,
            runtime=RUNTIME,
            handler=HANDLER,
            code=fm.Code(zip_file=zip_b64),
            memory_size=MEMORY,
            cpu=CPU,
            timeout=TIMEOUT,
            disk_size=DISK,
            instance_concurrency=CONCURRENCY,
            environment_variables=env,
        )
        c.create_function(SERVICE, creq)
        print(f"[OK] 已重建函数为 {RUNTIME}")

    # 3) 定时触发器：每 10 分钟（触发本身免费，重复部署时幂等跳过）
    TRIG_NAME = "every-10-min"
    try:
        exist = c.list_triggers(SERVICE, FUNCTION, fm.ListTriggersRequest()).body.triggers or []
    except Exception:
        exist = []
    names = [t.trigger_name for t in exist] if exist else []
    if TRIG_NAME in names:
        print(f"[trig] 触发器 {TRIG_NAME} 已存在，跳过创建（幂等）")
    else:
        trig = fm.CreateTriggerRequest(
            trigger_type="timer",
            trigger_name=TRIG_NAME,
            trigger_config=json.dumps({
                "cronExpression": "0 */10 * * * *",   # 每 10 分钟
                "enable": True,
            }),
        )
        try:
            c.create_trigger(SERVICE, FUNCTION, trig)
            print(f"[OK] 已创建定时触发器 {TRIG_NAME}（每 10 分钟）")
        except Exception as e:
            print(f"[ERR] 创建触发器失败: {str(e)[:200]}")

    # 4) 回读确认
    r = c.get_function(SERVICE, FUNCTION, fm.GetFunctionRequest()).body
    print("\n=== 部署后确认 ===")
    print("  runtime        =", r.runtime)
    print("  handler        =", r.handler)
    print("  memory/timeout =", f"{r.memory_size}MB / {r.timeout}s")
    print("  disk           =", r.disk_size, "MB")
    print("  container      =", r.custom_container_config)
    print("  STATE_URL 已绑 =", bool((r.environment_variables or {}).get("STATE_URL")))
    ts = c.list_triggers(SERVICE, FUNCTION, fm.ListTriggersRequest()).body.triggers or []
    print("  triggers       =", [t.trigger_name for t in ts])


if __name__ == "__main__":
    main()
