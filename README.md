# taobao-fruit-monitor（GitHub 版）

淘宝闪购 · 杭州花屿观澜里小区（萧山建设一路 88 号）3km 内水果店价格 **7×24 云端监控**。

- 每 10 分钟用 headless Chromium 抓取饿了么/淘宝闪购接口，提取附近水果店与水果价格；
- 跨轮比价，检测**涨价 / 降价 / 新店上架 / 下架**；
- 结果通过 HTTP 端点暴露（`/report.md`、`/latest.json`、`/status`、`/alert`）；
- 通知播报由**容器自身经 PushPlus 微信推送**（价格涨跌即时提醒 + 每 30 分钟汇总 + 登录态失效紧急），不依赖 WorkBuddy 在线，完全 7×24 自治；SMTP 邮件作为可选回退。

> 本仓库是「GitHub 版」源码。**登录态（淘宝会话 Cookie）绝不入库**，运行时经环境变量注入。

---

## 架构

```
GitHub 私有仓库 (本仓库)
        │  git push (main)
        ▼
CloudBase 云托管 (CloudRun)  ──自动构建 Dockerfile──▶  常驻容器 (MinNum=1)
        │                                               │ 每 10 分钟
        │                                               ▼
        │                                        headless Chromium 抓淘宝
        │                                               │
        ▼                                               ▼
  容器自身经 PushPlus 推送  ──▶  微信(PushPlus) / SMTP 邮件(可选)  结果写 /app/.data
```

容器自包含：登录态在启动时注入后即可运行，**运行时零外部依赖**（不依赖对象存储、不需要 CDN 拉取，邮件也由容器内 nodemailer 直发）。

---

## 目录

```
Dockerfile          基于 playwright 镜像，构建参数可注入登录态
entrypoint.sh       启动时把 BROWSER_STATE_B64 解码为 /tmp/browser-state.json 后启动服务
collect.js          采集 + 比价逻辑（复用 mtop 接口捕获）
server.js           HTTP 服务：定时采集 + 暴露结果端点 + 经 PushPlus 推送（SMTP 可选）
package.json        依赖 playwright（采集）+ nodemailer（发信）
.gitignore          忽略 browser-state.json / .data / node_modules
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 服务端口 |
| `INTERVAL_MIN` | `10` | 采集间隔（分钟） |
| `STATE_PATH` | `/app/browser-state.json` | 登录态文件路径（一般由 entrypoint 自动设置） |
| `BROWSER_STATE_B64` | 空 | **登录态 base64**（推荐注入方式，见下） |
| `STATE_URL` | 空 | 可选：启动时从此 URL 拉取最新登录态覆盖（不推荐，作为兜底） |
| `PUSHPLUS_TOKEN` | 空 | **PushPlus 微信推送 token（主通知通道，必填）**；关注 PushPlus 公众号获取，官网 https://www.pushplus.plus/ |
| `SMTP_HOST` | `smtp.qq.com` | SMTP 服务器（QQ 邮箱），**可选** |
| `SMTP_PORT` | `465` | SMTP 端口（SSL），可选 |
| `SMTP_SECURE` | `true` | 是否 SSL，可选 |
| `SMTP_USER` | `1478363@qq.com` | 发件人邮箱，可选（仅 SMTP 回退时用） |
| `SMTP_PASS` | 空 | QQ 邮箱 SMTP 授权码（非登录密码），**可选**，未配 PushPlus 时作回退 |
| `TO_EMAIL` | 同 `SMTP_USER` | 收件人邮箱，可选 |

---

## 登录态注入（三种方式，任选其一）

登录态 = 你的淘宝/饿了么会话 `browser-state.json`（含 Cookie，敏感）。**本仓库不含该文件。**

### 方式 A：运行时环境变量（推荐，用于 CloudBase 自动部署）
把 `browser-state.json` 编码为 base64，作为环境变量 `BROWSER_STATE_B64` 传给容器，entrypoint 会解码写入 `/tmp/browser-state.json`。

生成 base64：
- Windows (PowerShell)：
  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("browser-state.json"))
  ```
- macOS / Linux：
  ```bash
  base64 -i browser-state.json
  ```

### 方式 B：构建参数（烘焙进镜像）
`docker build --build-arg BROWSER_STATE_B64=<base64> .` —— 登录态仅存在于构建产物，不进 git。

### 方式 C：本地开发
把你的 `browser-state.json` 放到仓库根目录（已被 `.gitignore` 忽略），直接 `node server.js` 或 `docker build .` 即可（构建参数留空时走镜像内置文件）。

---

## 自动部署（CloudBase 控制台连接 GitHub）

1. 登录 [CloudBase 控制台](https://console.cloud.tencent.com/tcb) → **云托管** → 服务；
2. **新建服务 / 从代码仓库导入** → 选择 **GitHub** → 授权并选中本仓库 `taobao-fruit-monitor`；
3. 确认构建方式 = **Docker**（自动识别根目录 `Dockerfile`）；
4. 在「环境变量 / 构建参数」中设置：
   - `BROWSER_STATE_B64` = 上述 base64（**方式 A**）；
   - `INTERVAL_MIN` = `10`；
   - `PUSHPLUS_TOKEN` = `<PushPlus 官网获取的 token>`（**主通知通道，必填**；关注 PushPlus 公众号后获取）；
   - `SMTP_USER` / `SMTP_PASS` / `TO_EMAIL` = 可选，仅在你还想额外收邮件时填写；
   - `PORT` = `8080`、`NODE_ENV` = `production`；
5. 保存并部署。之后 **`git push` 到 main 即自动重新构建并部署**，无需手动上传。

> 若平台对超大环境变量有限制，改用「方式 B 构建参数」或在控制台把 `BROWSER_STATE_B64` 设为构建参数。

---

## 登录态过期怎么办

淘宝登录态通常几天~几周失效。失效后 `/status` 返回 `ok:false, reason:SESSION_EXPIRED`，**容器自身**会经 PushPlus 推送「需重新登录」紧急提醒（若也配置了 SMTP 则同时发邮件），无需 WorkBuddy 在线。

更新步骤：
1. 本地用 WorkBuddy / 浏览器重新登录淘宝闪购，导出新的 `browser-state.json`；
2. 重新生成 base64；
3. 在 CloudBase 控制台更新 `BROWSER_STATE_B64` 环境变量 → **重新部署**（或 `git push` 一次触发自动部署）。

---

## 本地验证（可选）

```bash
# 需要本地有 playwright 的 Chromium
npm install
BROWSER_STATE_B64=$(base64 -i ../browser-state.json) node server.js
# 另开终端
curl http://localhost:8080/health
curl http://localhost:8080/report.md
```

---

## 与现有 CloudRun 版的关系

当前已有一个从本地上传部署、正常运行的 CloudRun 服务（同 env `yuxxaa-d8gs9k0373fd8f5f5`）。本仓库是它的**源码化 / GitHub 化版本**：代码一致，区别仅在于登录态改为经环境变量注入。迁移到 GitHub 自动部署后，可将原本地上传版停用，统一由 `git push` 管理。
