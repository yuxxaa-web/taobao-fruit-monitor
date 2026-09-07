# 部署到阿里云函数计算 FC（免费 · 大陆 IP · 不依赖 CloudBase）

> 目标：把淘宝/饿了么水果监控完全跑在阿里云 FC 上，每 10 分钟自动采集，结果经 **PushPlus 微信推送**。
> 优势：国内 IP（能抓淘宝数据）、自定义容器可跑 Playwright+Chromium、缩容到 0 平时零成本、免费额度内基本不花钱。

---

## 0. 前置条件

- 阿里云账号（**新用户免费额度更大**：每月 100 万次调用 + 40 万 CU·秒，外加 3 个月每月 15 万 CU 试用）。
- 本机已装 **Docker Desktop**（用来把镜像推到阿里云容器镜像服务 ACR）。
- 已装 **Serverless Devs**：`npm install -g @serverless-devs/s`
- 已准备好 **PushPlus token**（微信关注「PushPlus 推送加」→ 登录 pushplus.plus 复制）。
- 一份**有效的淘宝登录态** `browser-state.json`（见第 1 步）。

---

## 1. 准备登录态文件 `browser-state.json`

把导出的淘宝登录态放到本目录（与 Dockerfile 同级），构建时会烘焙进镜像：

```
# 假设你本地已有导出文件，拷到 cloud/ 目录：
copy "D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\browser-state.json"  cloud\browser-state.json
```

> ⚠️ 登录态通常几天~数周失效。失效后微信会收到「【TBSG-JK】YDDTSX，需重新登录」，
> 届时重新导出一份覆盖本文件、重新构建镜像并 `s deploy` 即可。
> （进阶：把登录态放 **NAS 文件存储** 挂载到 `/app`，可免重新构建；新手先走镜像烘焙最简单。）

---

## 2. 构建镜像并推送到 ACR（同地域 cn-hangzhou）

1. 阿里云控制台开通 **容器镜像服务 ACR**（个人版即可），在 **cn-hangzhou** 建一个命名空间 + 仓库，例如：
   - 命名空间：`tbmon`
   - 仓库：`taobao-fruit-monitor`
   - 镜像地址：`registry.cn-hangzhou.aliyuncs.com/tbmon/taobao-fruit-monitor:latest`

2. 本机登录 ACR 并构建推送（在 `cloud/` 目录下）：

```bash
# 登录（密码在 ACR 控制台「访问凭证」设置）
docker login --username=<你的阿里云账号> registry.cn-hangzhou.aliyuncs.com

# 构建（playwright 基础镜像较大，约几分钟）
docker build -t taobao-fruit-monitor:latest .

# 打标签并推送
docker tag taobao-fruit-monitor:latest registry.cn-hangzhou.aliyuncs.com/tbmon/taobao-fruit-monitor:latest
docker push registry.cn-hangzhou.aliyuncs.com/tbmon/taobao-fruit-monitor:latest
```

---

## 3. 部署到 FC

```bash
# 1) 配置阿里云密钥（AccessKey ID / Secret），alias 用 default
s config add

# 2) 设置环境变量（镜像地址 + PushPlus token）
export IMAGE=registry.cn-hangzhou.aliyuncs.com/tbmon/taobao-fruit-monitor:latest
export PUSHPLUS_TOKEN=你的pushplus_token

# 3) 一键部署
s deploy -y
```

部署完成后，控制台「触发器」里会看到：
- `httpTrigger`：手动测试用 URL（公网可访问）
- `timerTrigger`：每 10 分钟定时触发

> 不想用 CLI 也可纯控制台操作：先在第 2 步把镜像推到 ACR，
> 再到 FC 控制台「创建函数 → 使用容器镜像 → 选 ACR 镜像 → 监听端口 9000」，
> 然后「触发器」里加一个**定时触发器**（cron：`0 0/10 * * * *`），再加一个 HTTP 触发器方便测试。

---

## 4. 验证

```bash
# 用 httpTrigger 的 URL 手动触发一次采集（任意路径都会触发，这里用根路径）
curl -X POST https://<你的函数>.cn-hangzhou.fcapp.run/

# 发一条 PushPlus 测试推送，确认微信能收到
curl -X POST https://<你的函数>.cn-hangzhou.fcapp.run/test-email
```

- 微信收到「【TBSG-JK】YDFXTDCS」测试推送 → 通道打通。
- 之后每 10 分钟，微信会收到价格涨跌/半小時汇总；首次只建基线。

---

## 5. 免费额度与成本控制

| 项目 | 每月用量（预估） | 免费额度 |
|---|---|---|
| 函数调用 | ~4320 次（10 分钟一次） | 100 万次 ✅ 充裕 |
| 算力(CU) | 1GB×~90s×4320 ≈ 在免费边缘 | 40 万 CU·秒/月；**建议把 `memorySize` 压到 1024、单次尽量 <60s** 更稳 |

> 若担心超额：把 `s.yaml` 里 `memorySize` 设 1024、`timeout` 300 即可；采集单次若超 150s 再上调。

---

## 6. 已知限制（非阻塞）

- **比价快照跨冷启动**：`prev-snap.json` 存在实例本地盘，热实例（两次调用间未被回收）内可恢复；
  极少数冷启动会当基线、该次不发涨跌提醒。10 分钟间隔下通常实例保持温热，影响很小。
  追求 100% 可靠可挂 **NAS/OSS** 持久化（进阶，新手可先不管）。
- **登录态过期**：见第 1 步，重新烘焙镜像即可。

---

## 7. 与之前方案的关系

- 本目录 `cloud/` 即为 FC 部署包（已改造为：监听 9000、任意路径触发采集、PushPlus 主通道）。
- 早期 CloudBase 版已废弃（资源超额被隔离）；GitHub Actions 版（`github-src/` 根）因需本机 runner 也被你排除。
- 三者代码逻辑同源，本 FC 版是当前推荐落地的唯一形态。
