# Docker 镜像构建与部署方案

## 镜像说明

镜像内置了 Claude Code（通过 `npm install -g @anthropic-ai/claude-code`），开箱即用。

**镜像大小：** 约 500-600MB（Node.js ~250MB + Claude Code ~250MB + 应用 ~10MB）

**支持架构：** `linux/amd64`、`linux/arm64`

---

## 快速构建 & 运行

### 1. 准备工作

```bash
# 确保目录结构正确
cd qa-for-code
ls src-repo/      # 你的源码目录
ls Dockerfile     # Dockerfile 存在
```

### 2. 构建镜像

```bash
# 本地构建
docker build -t qa-for-code .

# 或使用构建脚本
bash scripts/docker-build.sh

# 指定版本号
bash scripts/docker-build.sh --tag=v1.0.0

# 多架构构建 + 推送
bash scripts/docker-build.sh --multi --push --tag=v1.0.0
```

### 3. 运行

#### 方式 A：API Key（推荐）

```bash
docker run -d \
  --name qa-for-code \
  -p 3100:3100 \
  -e ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx \
  -v /你的项目源码路径:/src-repo:ro \
  --read-only \
  --tmpfs /tmp:exec,size=256M \
  qa-for-code
```

#### 方式 B：OAuth Token（需要先在宿主机登录）

```bash
# 1. 先在宿主机登录 Claude Code
claude login

# 2. 挂载认证目录启动
docker run -d \
  --name qa-for-code \
  -p 3100:3100 \
  -v ~/.claude:/home/node/.claude:ro \
  -v /你的项目源码路径:/src-repo:ro \
  --read-only \
  --tmpfs /tmp:exec,size=256M \
  qa-for-code
```

#### 方式 C：docker compose（最简单）

```bash
# 1. 复制并编辑环境变量
cp .env.example .env
# 编辑 .env: 填写 ANTHROPIC_API_KEY

# 2. 把源码放到 src-repo/（或修改 docker-compose.yml 的挂载路径）

# 3. 启动
docker compose up -d

# 4. 验证
curl http://localhost:3100/api/health
```

---

## Claude Code 认证详解

Claude Code 在容器内需要认证才能调用 Anthropic API。支持三种方式：

### 方式 1：API Key（环境变量）

```bash
docker run ... -e ANTHROPIC_API_KEY=sk-ant-xxx ...
```

- ✅ 最简单，一条命令搞定
- ✅ 适合 CI/CD、自动化部署
- ❌ API Key 明文传输（建议用 Docker secrets）

### 方式 2：OAuth Token（挂载登录状态）

```bash
# 在宿主机执行一次
claude login

# 挂载到容器
docker run ... -v ~/.claude:/home/node/.claude:ro ...
```

- ✅ 不需要暴露 API Key
- ❌ 需要先交互式登录
- ❌ Token 有过期时间，需要定期刷新

### 方式 3：第三方 API 代理

```bash
docker run ... \
  -e ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  -e ANTHROPIC_AUTH_TOKEN=sk-your-key \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-chat \
  ...
```

---

## 挂载源码目录

源码目录在运行时通过 volume 挂载，不打包进镜像：

```bash
# 挂载本地目录（只读）
-v /home/user/my-project:/src-repo:ro

# 或挂载到 docker-compose.yml
volumes:
  - ./src-repo:/src-repo:ro
```

`ro` = 只读挂载 — **关键安全配置**，防止 Claude Code 修改你的源码。

### 也可以把源码打包进镜像

适合源码不需要频繁更新的场景：

```dockerfile
# 在 Dockerfile 最后添加
COPY ./src-repo /src-repo
```

---

## 构建多架构镜像

Claude Code 的 npm 包会根据平台自动下载对应的 native binary，所以同一个 Dockerfile 可以构建 `amd64` 和 `arm64` 镜像：

```bash
# 需要 Docker Buildx
docker buildx create --use --name multiarch

# 构建并推送多架构镜像
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/qa-for-code:latest \
  --push \
  .
```

---

## 生产部署建议

### 1. 使用 Docker Secrets（Swarm / K8s）

```yaml
# docker-compose.yml (Swarm)
secrets:
  anthropic_key:
    external: true

services:
  qa-for-code:
    secrets:
      - anthropic_key
    environment:
      - ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_key
```

### 2. 前置反向代理

```nginx
# nginx.conf
server {
    listen 443 ssl;
    server_name qa.example.com;

    # API Key 鉴权
    location /api/ {
        if ($http_x_api_key != "your-secret") {
            return 401;
        }
        proxy_pass http://qa-for-code:3100;
        proxy_buffering off;              # SSE 必须
        proxy_read_timeout 3600s;         # 长连接
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 3. 资源限制

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      memory: 2G      # Claude Code 峰值 ~1.5GB
      cpus: '2'
    reservations:
      memory: 512M    # 基础运行 ~300MB
      cpus: '0.5'
```

### 4. 监控与日志

```bash
# 查看日志
docker logs -f qa-for-code

# 健康检查
curl http://localhost:3100/api/health
# → {"status":"ok","version":"1.0.0","sourceRepo":"/src-repo","uptime":3600}

# 查看资源使用
docker stats qa-for-code
```

---

## 镜像大小优化（可选）

如果需要进一步减小镜像：

```dockerfile
# 1. 使用 alpine 基础镜像（减小 100MB+，但可能需要额外配置）
FROM node:20-alpine

# 2. 清理 npm 缓存
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# 3. 多阶段构建中只复制必要的 native binary
# 但 Claude Code 的 npm 包结构复杂，不推荐手动操作
```

**当前镜像大小约 500-600MB，对大多数场景可接受。**

---

## 完整工作流

```bash
# =========================================
# 从零到上线
# =========================================

# 1. 克隆代码
git clone <repo-url>
cd qa-for-code

# 2. 构建镜像
docker build -t qa-for-code .

# 3. 准备源码（你的项目代码）
mkdir -p src-repo
cp -r /path/to/your/source-code/* src-repo/
# 确保有 CLAUDE.md
echo "# My Project" > src-repo/CLAUDE.md

# 4. 配置环境
cp .env.example .env
# 编辑 .env 填写 ANTHROPIC_API_KEY

# 5. 启动
docker compose up -d

# 6. 验证
curl -X POST http://localhost:3100/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"这个项目的入口文件是什么？"}'

# 7. 查看流式回答
curl -N http://localhost:3100/api/ask/<runId>/events
```

---

## 故障排查

| 问题 | 原因 | 解决 |
|---|---|---|
| `Claude Code CLI 未找到` | 镜像构建时 npm install 失败 | 检查网络，重试 `docker build --no-cache` |
| `spawn ENOENT` | claude 二进制不被识别 | 进入容器 `docker exec -it qa-for-code which claude` |
| `ANTHROPIC_API_KEY 未设置` | 环境变量没传进去 | 检查 `docker run -e` 或 `.env` 文件 |
| SSE 连接断开 | nginx 缓冲了 SSE | 添加 `proxy_buffering off` |
| 容器 OOM | 内存不足 | 增加 `--memory=4g` |
