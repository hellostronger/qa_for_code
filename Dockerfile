# ============================================================
# Code QA Service — Docker
# ============================================================
# 构建: docker build -t qa-for-code .
# 运行: 见 docker-compose.yml 或下方说明
# ============================================================

FROM node:20-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ============================================================
# 生产阶段
# ============================================================
FROM node:20-slim

# 安装 Claude Code（官方 npm 包）
# 如需指定版本: @anthropic-ai/claude-code@2.1.179
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 复制生产依赖
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

# 复制构建产物
COPY --from=builder /app/dist/ ./dist/

# 源码目录 — 运行时通过 volume 挂载
# 默认路径，可通过 SOURCE_REPO_PATH 环境变量覆盖
RUN mkdir -p /src-repo

EXPOSE 3100

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/api/health').then(r=>r.ok?process.exit(0):process.exit(1))"

# 以非 root 用户运行
USER node

CMD ["node", "dist/index.js"]
