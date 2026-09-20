# 华为云 FunctionGraph 部署脚本（免费档；幂等）
# 用法（在本仓库根目录，用 venv python 跑）：
#   python deploy_huawei.py            # 建/更新函数 + 上传代码 + 配环境变量
#   python deploy_huawei.py --invoke   # 同步手动触发一次（验证华为云 IP 是否被风控）
#   python deploy_huawei.py --trigger  # 创建夜间定时器（测试通过后再跑）
#   python deploy_huawei.py --pause    # 停用定时器
# 凭证从 .env 读取：HUA_AK_ID / HUA_AK_SECRET / HUA_PROJECT_ID；GITHUB_TOKEN 从 gh CLI 取。
import base64, io, json, os, subprocess, sys, zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
REGION = 'cn-east-3'
ENDPOINT = 'https://functiongraph.cn-east-3.myhuaweicloud.com'
FUNC_NAME = 'tbmon-hw'
RUNTIME = None  # 部署时自动探测：优先 Node.js20.x
RUNTIME_CANDIDATES = ['Node.js20.15', 'Node.js20.11', 'Node.js18.15', 'Node.js16.17', 'Node.js14.18']
# TIMER 触发器（北京时间夜间 22:00~08:59，每 10 分钟；两个触发器覆盖跨午夜）
# 华为要点：schedule_type 必须驼峰 'Cron'（大写 CRON 会 400）；cron 前加 CRON_TZ=Asia/Shanghai 指定时区；
# 小时区间不要混用列表+范围（如 14-23,0 会 400），拆成两个触发器即可。
TIMER_SCHEDULES = [
    ('night-e1', 'CRON_TZ=Asia/Shanghai 0 */10 22-23 * * ?'),
    ('night-e2', 'CRON_TZ=Asia/Shanghai 0 */10 0-8 * * ?'),
]


def load_env():
    env = {}
    p = os.path.join(BASE, '.env')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    # PushPlus token 从本机采集器配置复用
    p2 = os.path.join(BASE, 'local_runtime', '.env')
    if os.path.exists(p2):
        for line in open(p2, encoding='utf-8'):
            if line.startswith('PUSHPLUS_TOKEN='):
                env['PUSHPLUS_TOKEN'] = line.split('=', 1)[1].strip()
    return env


def gh_token():
    return subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True).stdout.strip()


def build_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(BASE, 'hw_runtime', 'index.js'), 'index.js')
        z.write(os.path.join(BASE, 'fc_runtime', 'collect.js'), 'fc_runtime/collect.js')
    return base64.b64encode(buf.getvalue()).decode()


def client(env):
    from huaweicloudsdkcore.auth.credentials import BasicCredentials
    from huaweicloudsdkfunctiongraph.v2 import FunctionGraphClient
    cred = BasicCredentials(env['HUA_AK_ID'], env['HUA_AK_SECRET'], env['HUA_PROJECT_ID'])
    return FunctionGraphClient.new_builder().with_credentials(cred).with_endpoint(ENDPOINT).build()


def func_urn(env):
    return f"urn:fss:{REGION}:{env['HUA_PROJECT_ID']}:function:default:{FUNC_NAME}:latest"


def ensure_function(c, env):
    from huaweicloudsdkfunctiongraph.v2 import (CreateFunctionRequest, CreateFunctionRequestBody,
        UpdateFunctionCodeRequest, UpdateFunctionCodeRequestBody, FuncCode,
        ListFunctionsRequest, UpdateFunctionConfigRequest, UpdateFunctionConfigRequestBody)
    zip_b64 = build_zip()
    exists = False
    try:
        resp = c.list_functions(ListFunctionsRequest(marker=0, maxitems=400))
        exists = any(f.func_name == FUNC_NAME for f in (resp.functions or []))
    except Exception as e:
        print('list warn:', e)
    if not exists:
        # 逐个尝试可用的 Node 运行时
        last_err = None
        for rt in RUNTIME_CANDIDATES:
            try:
                body = CreateFunctionRequestBody(
                    func_name=FUNC_NAME, handler='index.handler', runtime=rt,
                    memory_size=512, timeout=60, code_type='zip',
                    func_code=FuncCode(file=zip_b64), package='default',
                    description='水果价格监控（华为云夜间补充，GitHub 存登录态）')
                c.create_function(CreateFunctionRequest(body=body))
                global RUNTIME
                RUNTIME = rt
                print('函数已创建:', FUNC_NAME, '| runtime:', rt)
                break
            except Exception as e:
                last_err = e
                if 'Invalid runtime' in str(e):
                    print('runtime 不可用:', rt)
                    continue
                raise
        else:
            raise last_err
    else:
        # 已存在则沿用现有 runtime 配置，只更新代码
        try:
            resp = c.list_functions(ListFunctionsRequest(marker=0, maxitems=400))
            for f in (resp.functions or []):
                if f.func_name == FUNC_NAME:
                    globals()['RUNTIME'] = f.runtime
                    break
        except Exception:
            pass
        body = UpdateFunctionCodeRequestBody(code_type='zip', func_code=FuncCode(file=zip_b64))
        try:
            c.update_function_code(UpdateFunctionCodeRequest(function_urn=func_urn(env), body=body))
            print('函数代码已更新:', FUNC_NAME)
        except Exception as e:
            if 'same code' in str(e):
                print('代码无变化，跳过上传:', FUNC_NAME)
            else:
                raise
    rt = globals().get('RUNTIME') or RUNTIME_CANDIDATES[0]
    # 环境变量
    cfg = UpdateFunctionConfigRequestBody(
        func_name=FUNC_NAME, handler='index.handler', runtime=rt,
        memory_size=512, timeout=60,
        user_data=json.dumps({
            'GITHUB_TOKEN': gh_token(),
            'PUSHPLUS_TOKEN': env.get('PUSHPLUS_TOKEN', ''),
            'GITHUB_REPO': 'yuxxaa-web/taobao-fruit-monitor',
        }))
    c.update_function_config(UpdateFunctionConfigRequest(function_urn=func_urn(env), body=cfg))
    print('环境变量已配置（GITHUB_TOKEN/PUSHPLUS_TOKEN/GITHUB_REPO）')
    print('URN:', func_urn(env))


def invoke(c, env):
    from huaweicloudsdkfunctiongraph.v2 import InvokeFunctionRequest
    resp = c.invoke_function(InvokeFunctionRequest(function_urn=func_urn(env), body={}))
    # 该 SDK 版本不解析返回体，result 恒为 None；真实结果在 raw_content
    raw = getattr(resp, 'raw_content', b'')
    if isinstance(raw, bytes):
        raw = raw.decode('utf-8', 'replace')
    print('--- result (raw) ---')
    print(raw[:2000] if raw else '(空)')


def manage_trigger(c, env, action):
    from huaweicloudsdkfunctiongraph.v2 import (CreateFunctionTriggerRequest, CreateFunctionTriggerRequestBody,
        ListFunctionTriggersRequest, DeleteFunctionTriggerRequest, TriggerEventDataRequestBody)
    urn = func_urn(env)
    triggers = c.list_function_triggers(ListFunctionTriggersRequest(function_urn=urn)).body or []
    existing = {t.trigger_id: t for t in triggers}
    if action == 'create':
        for nm, sch in TIMER_SCHEDULES:
            dup = any(t.event_data and getattr(t.event_data, 'name', None) == nm for t in existing.values())
            if dup:
                print('定时器已存在，跳过:', nm); continue
            ed = TriggerEventDataRequestBody(name=nm, schedule_type='Cron', schedule=sch)
            c.create_function_trigger(CreateFunctionTriggerRequest(
                function_urn=urn,
                body=CreateFunctionTriggerRequestBody(trigger_type_code='TIMER', trigger_status='ACTIVE', event_data=ed)))
            print('定时器已创建:', nm, sch)
    elif action == 'pause':
        n = 0
        for t in triggers:
            # SDK 3.1.214 删触发器需同时带 trigger_type_code（TIMER）与 trigger_id
            c.delete_function_trigger(DeleteFunctionTriggerRequest(
                function_urn=urn, trigger_type_code='TIMER', trigger_id=t.trigger_id))
            n += 1
        print('已删除定时器 x', n)


def main():
    env = load_env()
    for k in ('HUA_AK_ID', 'HUA_AK_SECRET', 'HUA_PROJECT_ID'):
        if not env.get(k):
            print('缺少 .env 配置:', k); sys.exit(1)
    c = client(env)
    args = sys.argv[1:]
    if '--invoke' in args:
        invoke(c, env)
    elif '--trigger' in args:
        manage_trigger(c, env, 'create')
    elif '--pause' in args:
        manage_trigger(c, env, 'pause')
    else:
        ensure_function(c, env)


if __name__ == '__main__':
    main()
