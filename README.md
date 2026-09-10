# 淘宝闪购 / 饿了么 水果价格监控（免费版）

监控杭州「花屿观澜里」周边 3km 内淘宝闪购 / 饿了么水果价格，每 10 分钟采集一次，
价格变动 / 失败通过 **PushPlus** 推送到微信。

## 架构（免费双引擎）

监控本身只在**一台调度器**上跑，二选一即可：

- **方案 A · GitHub Actions（推荐，脱离阿里云）**
  - `monitor.yml` 定时（cron 每 10 分钟）在 GitHub 服务器上跑 `github_runtime/run.js`：
    复用 `fc_runtime/collect.js` 做协议层采集 → PushPlus 推送。
  - 登录态 `browser-state.json` 与比价快照通过 **GitHub Artifact**（`state` 产物）持久化，
    每次运行自动下载最新态、并把 mtop 刷新的新 token 回写产物，**无需阿里云、无需本机常开**。
  - `refresh.yml` 为手动兜底：在 GitHub 上用 Playwright headless 重登（若 Ele.me 不弹验证码即可自行续期）。
  - 完全免费（GitHub Actions 公有库 50,000 分钟/月、私有库 2,000 分钟/月，本任务用量极小）。
- **方案 B · 阿里云函数计算 FC（可选备份）**
  - 内置 **Node.js `nodejs20` 运行时**（非自定义容器），代码包约 7KB，冷启动毫秒级，
    月用量远低于 FC 免费额度（100 万次调用 + 40 万 GB-s / 月）。
  - 定时器 `every-10-min`，cron `0 */10 * * * *`。
  - 登录态经 OSS 内网端点 `oss-cn-hangzhou-internal.aliyuncs.com` 拉取（同地域免费）。

> 两套都依赖同一份 `fc_runtime/collect.js`，逻辑一致。登录态过期时都需本机重登一次。

## 目录结构

```
github_runtime/
  run.js              # GitHub Actions 运行入口：采集 -> 去重推送
  fetch_state.py      # 下载登录态(release 资产) + 快照(artifact)
deploy_free.py        # 方案B：部署/更新到 FC（内置 nodejs20，含定时器）
force_cold_free.py    # 方案B：强制冷启动拉新登录态
upload_state.py       # 方案B：上传 browser-state.json 到 OSS（内网端点）
upload_state_github.py# 方案A：本机把新鲜登录态推入 GitHub state 产物
refresh_session.py    # 本机用 Playwright 重登，生成新鲜 browser-state.json
invoke_fc.py          # 方案B：手动触发一次 FC 采集（验证用）
check_bill.py         # 查询账户余额与计费明细
fc_runtime/
  index.js            # 方案B：FC handler：拉登录态 -> 采集 -> 去重推送
  collect.js          # 饿了么 mtop 协议层采集 + 签名 + 错误识别（RGV587/TOKEN_EXPIRED）
.github/workflows/
  monitor.yml         # 方案A：定时采集+推送
  refresh.yml         # 方案A：手动 headless 重登兜底
tools/                # 调试/逆向辅助（无密钥）
  capture_request.py  _verify_sign.py  debug_mtop.js
```

## 环境变量 / 密钥（务必通过密钥注入，勿硬编码）

| 变量 / 密钥 | 适用方案 | 说明 |
|---|---|---|
| `PUSHPLUS_TOKEN`（GitHub Secret） | A | 在仓库 `Settings → Secrets` 配置，**不要写进代码** |
| `AK_ID` / `AK_SECRET` | B | 阿里云 **RAM 子账号**（仅 FC + OSS 权限），**不要用主账号 AK** |
| `OSS_BUCKET` / `OSS_ENDPOINT` | B | 存放 `browser-state.json` 的桶（默认内网端点免流量费） |

参考 `.env.example`（仅方案 B 需要 AK/OSS 变量）。

## 使用流程

> 仓库脚本均位于**仓库根目录**（无 `cloud/` 子目录）。以下命令请在仓库根目录执行。

### 方案 A · GitHub Actions（默认，脱离阿里云）

1. **开启推送**：在本仓库 `Settings → Secrets and variables → Actions` 新增仓库密钥
   `PUSHPLUS_TOKEN`，值为你的 PushPlus token。**无需阿里云 AK**。
2. **首次种入登录态**（本机，一次性）：
   ```powershell
   cd <仓库根目录>
   # 1) 重登（需 Playwright + 浏览器；若 browser-state.json 已有效可跳过）
   C:\Users\yuxxa\AppData\Local\Programs\Python\Python312\python.exe refresh_session.py
   # 2) 把新鲜登录态推入 GitHub state 产物（需 gh CLI 已登录）
   C:\Users\yuxxa\AppData\Local\Programs\Python\Python312\python.exe upload_state_github.py
   ```
   之后 `monitor.yml` 每 10 分钟自动运行，无需本机常开。mtop 刷新的新 token 会自动回写产物。
3. **令牌/登录过期时**（微信会收到"缺少登录态"告警）：重复第 2 步两步即可。
4. **手动触发一次**：仓库 `Actions → monitor → Run workflow`。

### 方案 B · 阿里云函数计算 FC（备份）

1. **安装依赖**：
   ```powershell
   pip install -r requirements.txt
   # 若使用本机重登，还需下载浏览器：
   playwright install chromium
   ```
2. **首次 / 令牌过期时重登**（本机，需 Playwright + 浏览器）：
   ```powershell
   $env:AK_ID="..."; $env:AK_SECRET="..."; $env:PUSHPLUS_TOKEN="..."
   python refresh_session.py
   python upload_state.py
   ```
3. **部署 / 更新**：
   ```powershell
   $env:AK_ID="..."; $env:AK_SECRET="..."
   python deploy_free.py
   ```
4. **强制冷启动拉新登录态**（令牌已上传但想立即生效）：
   ```powershell
   python force_cold_free.py
   ```
5. **手动验证一次**：`python invoke_fc.py`

## 安全注意事项

- **`browser-state.json` 含账号登录凭证，已被 `.gitignore` 排除，切勿提交。**
- 该文件在 GitHub Actions 中以 **Artifact** 形式存储。**强烈建议仓库设为 Private**
  （Settings → Change visibility）；公开仓库下登录态产物与 PushPlus token 历史均有泄露风险。
- 阿里云 **主账号 AccessKey 务必在 RAM 轮换/禁用**，改为仅含 FC+OSS 权限的专用子账号（仅方案 B）。
- PushPlus token 只通过 GitHub Secret / 环境变量注入，不要写进代码或提交到仓库。
- `RGV587` 是速率触发的临时风控（非永久封禁），低频（每 10 分钟）采集即可自动恢复，
  不要频繁手动触发以免延长冷却。注意：GitHub Actions 的出口 IP 多为微软/Azure 段，
  相比阿里云杭州机房 IP **可能更易触发 RGV587**；若频繁出现，可回退到方案 B（FC）。
