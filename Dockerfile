FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# 复用基础镜像自带的 Chromium，避免重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=8080

# 构建期可选注入：把登录态经构建参数烘焙进镜像（不进 git 仓库）
ARG BROWSER_STATE_B64=""

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 若提供了构建参数，则把 base64 登录态解码写入镜像（仅构建时可见，不入库）
RUN if [ -n "$BROWSER_STATE_B64" ]; then echo "$BROWSER_STATE_B64" | base64 -d > /app/browser-state.json; fi

RUN chmod +x /app/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
