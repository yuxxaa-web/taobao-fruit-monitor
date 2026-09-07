FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# 复用基础镜像自带的 Chromium，避免重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=9000 \
    STATE_PATH=/app/browser-state.json

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 登录态直接烘焙进镜像，容器运行时零外部依赖
COPY browser-state.json /app/browser-state.json

EXPOSE 9000
CMD ["node", "server.js"]
