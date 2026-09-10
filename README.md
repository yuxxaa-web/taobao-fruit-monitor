# 淘宝闪购 / 饿了么 水果价格监控（免费版）

监控杭州「花屿观澜里」周边 3km 内淘宝闪购 / 饿了么水果价格，每 10 分钟采集一次，
价格变动 / 失败通过 **PushPlus** 推送到微信。

## 架构（100% 走阿里云免费档）

- **阿里云函数计算 FC**：内置 **Node.js `nodejs20` 运行时**（非自定义容器）。
  代码包仅约 7KB，冷启动毫秒级，月调用量与资源用量远低于 FC 免费额度
  （100 万次调用 + 40 万 GB-s / 月）。
- **定时器**：FC Timer 触发器 `every-10-min`，cron `0 */10 * * * *`（每 10 分钟）。
- **登录态**：本机 `refresh_session.py` 生成 `browser-state.json`（含饿了么/淘宝 cookie）。
  云端通过 OSS **内网端点** `oss-cn-hangzhou-internal.aliyuncs.com` 拉取最新登录态，
  同地域内网互通免费；本机 `upload_state.py` 上传走公网（流入免费）。
- **通知**：PushPlus 微信推送（每天免费 200 条）。

> 旧版（自定义容器 + GitHub Actions + ACR）已废弃并移出本仓库，当前仅保留免费架构代码。

## 目录结构

```
deploy_free.py        # 部署/更新到 FC（内置 nodejs20，幂等，含定时器创建）
force_cold_free.py    # 改 env 时间戳强制冷启动（重新拉登录态）
upload_state.py       # 上传本机 browser-state.json 到 OSS（生成内网 STATE_URL/WRITE_URL）
refresh_session.py    # 本机用 Playwright 重登，生成新鲜 browser-state.json
invoke_fc.py          # 手动触发一次采集（用于验证）
check_bill.py         # 查询账户余额与计费明细（确认是否免费）
fc_runtime/
  index.js            # FC handler：冷启动拉登录态 -> 采集 -> 去重推送
  collect.js          # 饿了么 mtop 协议层采集 + 签名 + 错误识别（RGV587/TOKEN_EXPIRED）
tools/                # 调试/逆向辅助（协议签名验证等，无密钥）
  capture_request.py
  _verify_sign.py
  debug_mtop.js
```

## 环境变量（务必通过环境变量注入，勿硬编码）

| 变量 | 说明 |
|---|---|
| `AK_ID` / `AK_SECRET` | 阿里云 **RAM 子账号**（仅 FC + OSS 权限），**不要用主账号 AK** |
| `PUSHPLUS_TOKEN` | PushPlus 微信推送 token |
| `OSS_BUCKET` / `OSS_ENDPOINT` | 存放 `browser-state.json` 的桶（默认内网端点免流量费） |

参考 `.env.example`。

## 使用流程

1. **首次 / 令牌过期时重登**（本机，需 system Python 3.12 + Playwright）：
   ```powershell
   cd cloud
   C:\Users\yuxxa\AppData\Local\Programs\Python\Python312\python.exe refresh_session.py
   $env:AK_ID="..."; $env:AK_SECRET="..."; $env:PUSHPLUS_TOKEN="..."
   C:\Users\yuxxa\AppData\Local\Programs\Python\Python312\python.exe upload_state.py
   ```
2. **部署 / 更新**（本机）：
   ```powershell
   $env:AK_ID="..."; $env:AK_SECRET="..."
   python deploy_free.py
   ```
3. **强制冷启动拉新登录态**（令牌已上传但想立即生效）：
   ```powershell
   python force_cold_free.py
   ```
4. **手动验证一次**：`python invoke_fc.py`

## 安全注意事项

- **`browser-state.json` 含账号登录凭证，已被 `.gitignore` 排除，切勿提交。**
- 阿里云 **主账号 AccessKey 务必在 RAM 轮换/禁用**，改为仅含 FC+OSS 权限的专用子账号。
- PushPlus token 等密钥只通过环境变量 / 密钥管理注入，不要写进代码或提交到仓库。
- `RGV587` 是速率触发的临时风控（非永久封禁），低频（每 10 分钟）采集即可自动恢复，
  不要频繁手动触发以免延长冷却。
