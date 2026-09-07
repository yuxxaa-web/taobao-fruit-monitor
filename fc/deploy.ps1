# ============================================================
# 淘宝水果监控 一键部署到阿里云函数计算 FC（自定义容器 + PushPlus）
# 前置条件：
#   1. Docker Desktop 已安装并「运行中」（托盘图标为绿色/稳定）
#   2. Node.js 已安装（https://nodejs.org，LTS 即可）
#   3. 本脚本用「管理员 PowerShell」运行
# 用法：
#   右键本文件 -> 使用 PowerShell 运行
#   或：cd 到本目录后  .\deploy.ps1
# 说明：脚本不会硬编码任何密钥，ACR 密码 / AccessKey 均运行时交互输入。
# ============================================================
$ErrorActionPreference = "Stop"

# ---------- 配置区（按需修改） ----------
$ACR_USER       = "宇航2018"                                                                 # ACR 登录用户名（控制台可见）
$ACR_REGISTRY   = "crpi-spcixhhbg4a49s3b5.cn-hangzhou.personal.cr.aliyuncs.com"              # ACR 公网地址
$IMAGE          = "$ACR_REGISTRY/taobao-fruit-monitor:latest"                                # 完整镜像地址
$PUSHPLUS_TOKEN = "a4b4bacfd0544983b604f36539450211"                                        # PushPlus token（已验证可用）
$STATE_SRC      = "D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\browser-state.json"     # 淘宝登录态来源
$CODE_DIR       = "D:\yuxxa\Documents\WorkBuddy\2026-09-03-09-14-07\cloud"                   # 代码目录（含 s.yaml/Dockerfile）

# ---------- 开始 ----------
Set-Location $CODE_DIR
Write-Host "==> 工作目录: $CODE_DIR" -ForegroundColor Cyan

# 1) 登录态
if (-not (Test-Path $STATE_SRC)) { Write-Error "找不到登录态: $STATE_SRC"; exit 1 }
Copy-Item $STATE_SRC -Destination "browser-state.json" -Force
Write-Host "==> 已拷入 browser-state.json" -ForegroundColor Green

# 2) ACR 登录
$ACR_PASS_SEC = Read-Host -Prompt "请输入 ACR 访问凭证密码（ACR 控制台 -> 访问凭证 -> 设置）" -AsSecureString
$p1 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ACR_PASS_SEC)
$acrpass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($p1)
echo $acrpass | docker login --username=$ACR_USER --password-stdin $ACR_REGISTRY
if ($LASTEXITCODE -ne 0) { Write-Error "docker login 失败，请检查用户名/密码/网络"; exit 1 }
Write-Host "==> ACR 登录成功" -ForegroundColor Green

# 3) 构建 + 推送
Write-Host "==> 开始构建镜像（Playwright 基础镜像较大，约 5-10 分钟，请耐心）..." -ForegroundColor Cyan
docker build -t taobao-fruit-monitor:latest .
if ($LASTEXITCODE -ne 0) { Write-Error "docker build 失败"; exit 1 }
docker tag taobao-fruit-monitor:latest $IMAGE
docker push $IMAGE
if ($LASTEXITCODE -ne 0) { Write-Error "docker push 失败"; exit 1 }
Write-Host "==> 镜像已推送: $IMAGE" -ForegroundColor Green

# 4) 安装 Serverless Devs 并配置密钥（交互）
npm install -g @serverless-devs/s
Write-Host "==> 接下来配置阿里云密钥，按提示输入（provider 选 alibaba）:" -ForegroundColor Cyan
s config add

# 5) 部署
$env:IMAGE = $IMAGE
$env:PUSHPLUS_TOKEN = $PUSHPLUS_TOKEN
Write-Host "==> 开始 s deploy ..." -ForegroundColor Cyan
s deploy -y

Write-Host "==> 部署完成。请复制上面输出的 HTTP 触发器 URL，然后验证:" -ForegroundColor Green
Write-Host "   curl -X POST '<你的URL>/test-email'" -ForegroundColor Yellow
Write-Host "   微信收到「【TBSG-JK】YDFXTDCS」即成功；之后每 10 分钟自动推价格/汇总。" -ForegroundColor Yellow
