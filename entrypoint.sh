#!/bin/sh
# 启动脚本：把登录态注入容器，再启动采集服务。
# 优先级：镜像内置 /app/browser-state.json  >  运行时环境变量 BROWSER_STATE_B64
set -e

APP_STATE=/app/browser-state.json
TMP_STATE=/tmp/browser-state.json

if [ -s "$APP_STATE" ]; then
  # 构建期已烘焙（或本地 docker build 时上下文带了该文件）
  export STATE_PATH="$APP_STATE"
  echo "[entrypoint] 使用镜像内置登录态: $(wc -c < "$APP_STATE")B"
elif [ -n "$BROWSER_STATE_B64" ]; then
  # 运行时经环境变量注入（推荐用于 GitHub 自动部署，登录态不落盘于仓库）
  echo "$BROWSER_STATE_B64" | base64 -d > "$TMP_STATE"
  export STATE_PATH="$TMP_STATE"
  echo "[entrypoint] 已从 BROWSER_STATE_B64 注入登录态: $(wc -c < "$TMP_STATE")B"
else
  echo "[entrypoint] 警告：未找到登录态（/app/browser-state.json 不存在且无 BROWSER_STATE_B64），采集将失败"
fi

exec node /app/server.js
