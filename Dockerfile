# ============================================================
# Code QA Service — Docker 镜像（内置 Claude Code）
# ============================================================
#
# 构建:
#   docker build -t qa-for-code .
#
# 运行（API Key 方式）:
#   docker run -d -p 3100:3100 \
#     -e ANTHROPIC_API_KEY=sk-ant-xxx \
#     -v /你的源码路径:/src-repo:ro \
#     qa-for-code
#
# 运行（OAuth Token 方式）:
#   先在宿主机 claude login，然后:
#   docker run -d -p 3100:3100 \
#     -v ~/.claude:/home/node/.claude:ro \
#     -v /你的源码路径:/src-repo:ro \
#     qa-for-code
#
# ============================================================

# ========================================
# Stage 1: 构建 TypeScript
# ========================================
FROM node:20-slim AS builder

WORKDIR /app

# pnpm
RUN npm install -g pnpm@9

# 依赖
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 源码 + 编译
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ========================================
# Stage 2: 生产镜像
# ========================================
FROM node:20-slim

# ---------- 系统依赖 ----------
# Claude Code 运行时需要的系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    # Claude Code on Windows via Docker 不需要这些，但在 Linux 容器中需要
    && rm -rf /var/lib/apt/lists/*

# ---------- 安装 Claude Code ----------
# 从 npm 全局安装，自动下载对应平台的 native binary
# 锁定版本避免意外升级:
ENV CLAUDE_CODE_VERSION=2.1.179
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version \
    && echo "Claude Code installed: $(claude --version)"

# ---------- 应用 ----------
WORKDIR /app

# pnpm + 生产依赖
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# 构建产物
COPY --from=builder /app/dist/ ./dist/

# ---------- 目录 ----------
# 源码挂载点（运行时 volume 挂载到这里）
RUN mkdir -p /src-repo
# Claude Code 需要可写的 home 目录（缓存、配置）
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
# 生成文件的工作区（运行时 volume 挂载，Claude 生成的文件落盘于此）
RUN mkdir -p /workspace && chown -R node:node /workspace

# ---------- 安全 ----------
# 非 root 运行
USER node

# 默认环境变量
ENV SOURCE_REPO_PATH=/src-repo
ENV WORKSPACE_DIR=/workspace
ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100

# 健康检查 — 每 30s 探测一次
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/api/health').then(r=>r.ok?process.exit(0):process.exit(1))"

CMD ["node", "dist/index.js"]
