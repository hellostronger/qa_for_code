# Code QA Service

基于 Claude Code 的源码问答服务。将你的项目源码目录作为 Claude Code 的知识库，通过 HTTP API 暴露问答接口。

**核心原理：** 服务 spawn Claude Code 子进程，cwd 指向源码目录，Claude Code 自动读取分析代码后回答问题，答案通过 SSE 实时流式返回。

```
你问: "这个项目的认证逻辑在哪里？"
         ↓
服务: spawn claude -p --cwd=/your-source-code
Claude: 读取 CLAUDE.md → Grep "auth" → Read src/auth/*.ts → 生成回答
         ↓
SSE 流: "认证逻辑主要在 src/auth/ 目录。JWT token 在 authService.ts:42 生成..."
```

---

## 目录

- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [自定义 Skill（技能）](#自定义-skill技能)
- [安全：如何不暴露源码细节](#安全如何不暴露源码细节)
- [API 文档](#api-文档)
- [配置说明](#配置说明)
- [客户端示例](#客户端示例)

---

## 快速开始

### 前置条件

- Node.js 18+
- pnpm
- Claude Code CLI 已安装并登录：`npm install -g @anthropic-ai/claude-code && claude login`

### 本地开发

```bash
# 1. 安装依赖
pnpm install

# 2. 准备源码目录（你要让 Claude 分析的代码）
mkdir -p src-repo
echo '# My Project' > src-repo/CLAUDE.md
# 把你的源代码放到 src-repo/ 下

# 3. 配置环境变量（可选）
cp .env.example .env
# 编辑 .env 设置 SOURCE_REPO_PATH 等

# 4. 启动
pnpm dev

# 5. 测试
curl http://localhost:3100/api/health
```

### 配置环境变量

```bash
# .env 文件
PORT=3100
SOURCE_REPO_PATH=./src-repo    # 源码目录路径
CLAUDE_MODEL=                  # 留空使用默认模型
MAX_CONCURRENT=3               # 最大并发 Claude Code 进程数
RUN_TIMEOUT_MS=300000          # 单次运行超时 5 分钟
```

---

## Docker 部署

### 方式一：docker compose（推荐）

```bash
# 1. 克隆项目
git clone <repo-url> qa-for-code
cd qa-for-code

# 2. 把你要分析的源码放到 src-repo/ 目录下
cp -r /path/to/your/project/src-repo ./
# 或者直接修改 docker-compose.yml 中的挂载路径

# 3. 构建并启动
docker compose up -d

# 4. 验证
curl http://localhost:3100/api/health
```

### 方式二：纯 docker 命令

```bash
# 构建
docker build -t qa-for-code .

# 运行（挂载源码目录）
docker run -d \
  --name qa-for-code \
  -p 3100:3100 \
  -v /path/to/your/source/code:/src-repo:ro \
  -e SOURCE_REPO_PATH=/src-repo \
  --read-only \
  --tmpfs /tmp:exec,size=256M \
  qa-for-code
```

### 挂载代码路径说明

**关键：** 你的源码通过 Docker volume 挂载到容器内的 `/src-repo` 路径。Claude Code 以 `cwd=/src-repo` 启动，自动读取该目录下的所有文件。

| 场景 | docker run 参数 | docker-compose.yml |
|---|---|---|
| 本地源码目录 | `-v /home/user/my-project:/src-repo:ro` | `volumes: - /home/user/my-project:/src-repo:ro` |
| Git 仓库 | `-v /opt/repos/backend:/src-repo:ro` | 同上，路径指向 git clone 的目录 |
| 多个项目 | 启动多个容器实例，各自挂载不同路径 | 定义多个 service 实例 |
| 不挂载（构建进镜像） | `COPY src-repo/ /src-repo/` 在 Dockerfile 中 | 不需要 volumes |

**`ro` 表示只读挂载 — 这是安全关键配置，防止 Claude Code 修改你的源码。**

### Claude Code 认证

Claude Code 需要认证才能调用 Anthropic API。有两种方式：

#### 方式一：OAuth Token（推荐，官方认证）

先在宿主机上登录 Claude Code，然后挂载 token 到容器：

```bash
# 1. 在宿主机上登录
claude login

# 2. 挂载 .claude 目录到容器
docker run ... \
  -v ~/.claude:/home/node/.claude:ro \
  qa-for-code
```

或在 docker-compose.yml 中取消 `claude-auth` volume 的注释，然后：
```bash
docker compose run --rm qa-for-code claude login
docker compose up -d
```

#### 方式二：API Key / 第三方代理

```bash
# Anthropic 官方 API Key
docker run ... \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  qa-for-code

# 第三方代理（如 DeepSeek）
docker run ... \
  -e ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  -e ANTHROPIC_AUTH_TOKEN=your-api-key \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-chat \
  qa-for-code
```

### Claude Code 未安装时的自动安装

Dockerfile 中已包含 `npm install -g @anthropic-ai/claude-code`。如果需要在运行的容器中安装：

```bash
docker compose exec qa-for-code npm install -g @anthropic-ai/claude-code
```

---

## 自定义 Skill（技能）

支持向容器注入自定义技能（无需改镜像、无需改代码）。Claude Code 会自动发现两类 Skill：

| 类型 | 位置 | 作用域 | 注入方式 |
|---|---|---|---|
| **个人级**（推荐） | 容器内 `/home/node/.claude/skills/` | 所有 repo 生效 | 宿主机 `./skills/` 文件夹映射 |
| 项目级 | 容器内 `/src-repo/.claude/skills/` | 仅当前 repo | 放源码目录 |

### 方式一：个人级 Skill（推荐）

项目根目录 `skills/` 文件夹已通过 `docker-compose.yml` 映射到容器内 `/home/node/.claude/skills`，skill 对所有源码仓库生效：

```
skills/
└── my-skill/                 # 每个 Skill 一个目录
    ├── SKILL.md              # 必填：Skill 定义（含 frontmatter）
    └── (其他辅助文件/脚本)
```

`SKILL.md` 示例：

```markdown
---
name: my-skill
description: 当用户询问 XX 时使用，作用是 YY
---

# My Skill

针对用户问题执行以下步骤：
1. 用 Grep 搜索相关代码
2. 用 Read 读取文件
3. 返回分析结果
```

**生效方式：**
- 修改 `skills/` 下的文件后重新提问即生效（每次 run 重新 spawn claude），**无需重启容器**
- 只读挂载（`:ro`），Claude Code 只会读取 skill，不会修改
- 挂载为个人级 → 更换挂载的源码 repo 时 skill 依然生效

### 方式二：项目级 Skill（备用）

需要 skill 跟随某个特定源码仓库时，放进源码目录（会被挂载到 `/src-repo`）：

```
src-repo/.claude/skills/my-skill/SKILL.md
```

> 注意：`.dockerignore` 中排除了 `src-repo/*`，因此源码（含 Skill）**不会**打包进镜像——它始终通过运行时 volume 挂载注入。这正是"外网传 skill 进去"的可行通道。

---

## 安全：如何不暴露源码细节

这是核心安全问题。Code QA Service 的设计本质是：**用户只能看到 Claude Code 的回答，看不到原始源码**。但需要从多个层面确保安全：

### 1. 架构层面的隔离

```
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│   终端用户    │ ←SSE→  │  QA Service   │ ←spawn→ │  Claude Code │
│  (看不到源码) │        │  (不暴露源码) │        │  (可读源码)  │
└──────────────┘        └──────────────┘        └──────────────┘
                                                    │ cwd=
                                              ┌──────────────┐
                                              │  src-repo/   │
                                              │  (只读挂载)  │
                                              └──────────────┘
```

- **API 只返回 Claude 的回答** — 不返回原始文件内容、目录列表、文件树
- **无文件读取 API** — 服务不提供任何直接读取源码的接口
- SSE 事件中可能包含 Claude Code 的工具调用日志（如 `tool_use: Read src/auth.ts`），如果不想暴露文件名，可以在服务端过滤掉 `tool_use` 和 `tool_result` 事件

### 2. 内容过滤（建议实现）

`src/routes/ask.ts` 的 `onEvent` 回调中可以过滤敏感事件：

```typescript
// 安全模式：不发送 tool_use / tool_result 给客户端
// 只发送 text_delta, thinking_delta, usage, status, error
const SAFE_EVENT_TYPES = new Set([
  'text_delta', 'thinking_delta', 'usage', 'status', 'error'
]);

onEvent: (event) => {
  if (SAFE_EVENT_TYPES.has(event.type)) {
    emitter.push(event);
  }
  // tool_use / tool_result 只在服务端记录，不推送给客户端
}
```

### 3. 系统提示词中的安全规则

`src/claude/prompt.ts` 已经包含安全指令：

```
4. **Security** — never reveal API keys, passwords, tokens, or other secrets
   that may exist in the codebase in your answers.
```

这指示 Claude Code 不要在回答中泄露密钥、密码等敏感信息。

### 4. Docker 层面安全

```yaml
# docker-compose.yml 中的安全配置

# ★ 源码只读挂载 — 防止 Claude Code 修改源码
volumes:
  - ./src-repo:/src-repo:ro

# ★ 容器文件系统只读 — 防止任何文件写入
read_only: true

# ★ /tmp 最小化可写 — Claude Code 运行需要临时文件
tmpfs:
  - /tmp:exec,size=256M

# ★ 禁止权限提升
security_opt:
  - no-new-privileges:true

# ★ 非 root 用户运行
# Dockerfile: USER node
```

### 5. 网络安全

```bash
# ★ 限制监听地址（仅本地）
# 在 .env 中不暴露到公网，用反向代理（nginx/Caddy）做 TLS + 鉴权

# ★ CORS 限制
# server.ts 已配置 CORS，仅允许 localhost 和自定义域名

# ★ 前置反向代理 + API Key（推荐生产方案）
```

**推荐的生产部署架构：**

```
互联网 → nginx/Caddy (HTTPS + API Key 验证) → qa-for-code:3100 (内网)
```

nginx 配置示例：
```nginx
server {
    listen 443 ssl;
    server_name qa.example.com;

    # API Key 验证
    location /api/ {
        if ($http_x_api_key != "your-secret-key") {
            return 401;
        }
        proxy_pass http://127.0.0.1:3100;
        proxy_buffering off;           # SSE 必须关闭缓冲
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 6. 速率限制

```bash
# 通过环境变量限制并发 Claude Code 进程
MAX_CONCURRENT=3    # 最多同时处理 3 个问题
RUN_TIMEOUT_MS=300000  # 单个问题最多跑 5 分钟
```

### 7. 运行时安全总结

| 维度 | 措施 |
|---|---|
| 源码保护 | 只读挂载 (`:ro`)，无文件读取 API |
| 内容过滤 | 可选不发送 tool_use/tool_result 事件 |
| 容器隔离 | `read_only: true` + `no-new-privileges` |
| 用户权限 | `USER node` 非 root |
| 网络隔离 | CORS + 反向代理 + API Key |
| 资源限制 | `MAX_CONCURRENT` + 内存/CPU limit |
| 超时保护 | `RUN_TIMEOUT_MS` 默认 5 分钟 |
| 提示词约束 | 明确指示不泄露密钥、密码 |

---

## API 文档

### POST /api/ask — 发起问题（原生接口）

```bash
curl -X POST http://localhost:3100/api/ask \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "这个项目的入口文件是哪个？"}]}'
```

**请求体：**
```json
{
  "messages": [
    { "role": "user", "content": "这个项目入口是什么？" },
    { "role": "assistant", "content": "入口是 src/index.ts" },
    { "role": "user", "content": "那认证模块呢？" }
  ],
  "sessionId": "string (可选，不传则创建新会话)",
  "model": "string (可选，覆盖默认模型)"
}
```

- `messages` 为完整对话（OpenAI 规范），最后一条 `role` 必须为 `user`（当前问题），前面的 user/assistant 对是历史上下文
- `question` 为旧字段，缺省 `messages` 时视为单轮 `[{role:'user', content:question}]`

**响应：**
```json
{
  "runId": "abc123-def456",
  "sessionId": "sess-789"
}
```

### GET /api/ask/:runId/events — SSE 流式回答

```
GET /api/ask/abc123-def456/events
Accept: text/event-stream
```

**SSE 事件帧格式：**
```
id: 1
data: {"seq":1,"runId":"abc123","event":{"type":"text_delta","delta":"根据源码分析..."}}

id: 2
data: {"seq":2,"runId":"abc123","event":{"type":"tool_use","id":"tool1","name":"Read","input":{"file_path":"src/index.ts"}}}

id: 3
data: {"seq":3,"runId":"abc123","event":{"type":"text_delta","delta":"入口文件是 src/index.ts"}}

id: 4
data: {"seq":4,"runId":"abc123","event":{"type":"usage","inputTokens":1200,"outputTokens":200}}

id: 5
data: {"seq":5,"runId":"abc123","event":{"type":"status","label":"completed"}}
```

**StreamEvent 类型：**

| type | 说明 | 字段 |
|---|---|---|
| `text_delta` | 流式文本增量 | `delta: string` |
| `thinking_delta` | 思考过程 | `delta: string` |
| `tool_use` | Claude 调用工具 | `id, name, input` |
| `tool_result` | 工具执行结果 | `toolUseId, content, isError?` |
| `usage` | Token 用量 | `inputTokens, outputTokens, costUsd?` |
| `status` | 状态变更 | `label: running/thinking/completed/failed` |
| `error` | 错误信息 | `message` |

**断线重连：** 设置 `Last-Event-ID` header 或 `?after=N` 参数即可重放事件。

### 其他端点

```
GET    /api/health           — 健康检查
GET    /api/sessions         — 列出活跃会话
GET    /api/sessions/:id     — 获取会话详情（含消息历史）
DELETE /api/sessions/:id     — 删除会话
DELETE /api/ask/:runId       — 取消运行中的请求
```

### POST /v1/chat/completions — OpenAI 兼容端点

将本服务作为 OpenAI 兼容模型接入（OpenAI SDK / LobeChat / ChatBox / Cherry Studio 等，配置 `base_url` 指向 `http://<host>:3100/v1` 即可提问）。

```bash
# 非流式
curl -X POST http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "这个项目入口是什么？"},
      {"role": "assistant", "content": "入口是 src/index.ts"},
      {"role": "user", "content": "那认证模块呢？"}
    ]
  }'

# 流式（SSE）
curl -N -X POST http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream": true, "messages": [{"role": "user", "content": "这个项目有哪些模块？"}]}'
```

**请求体（OpenAI 规范）：**
```json
{
  "model": "string (可选，覆盖默认模型，如 claude-sonnet-4-5)",
  "messages": [
    { "role": "user", "content": "问题1" },
    { "role": "assistant", "content": "回答1" },
    { "role": "user", "content": "当前问题（最后一条必须为 user）" }
  ],
  "stream": false
}
```

**非流式响应（OpenAI 格式）：**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "claude-sonnet-4-5",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
}
```

**流式响应**为 SSE，每帧 `data: {...}` 增量 + 结尾 `data: [DONE]`（OpenAI 标准 chunk 格式）。

> 客户端接入示例（OpenAI SDK）：
> ```js
> import OpenAI from 'openai';
> const client = new OpenAI({ baseURL: 'http://localhost:3100/v1', apiKey: 'any' });
> const res = await client.chat.completions.create({
>   model: 'claude-sonnet-4-5',
>   messages: [{ role: 'user', content: '这个项目入口是什么？' }],
> });
> console.log(res.choices[0].message.content);
> ```

---

## 配置说明

所有配置通过环境变量设置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3100` | 服务端口 |
| `SOURCE_REPO_PATH` | `./src-repo` | ★ 源码目录的绝对路径 |
| `CLAUDE_MODEL` | (空) | Claude Code 模型 (如 `claude-sonnet-4-5`) |
| `CLAUDE_BIN` | (PATH 查找) | 自定义 Claude Code 二进制路径 |
| `SESSION_TTL_MS` | `1800000` | 会话过期时间 (30 分钟) |
| `RUN_TIMEOUT_MS` | `300000` | 单次运行超时 (5 分钟) |
| `MAX_CONCURRENT` | `3` | 最大并发 Claude Code 进程数 |
| `CORS_ORIGIN` | (空) | 额外的 CORS 允许域名 |

---

## 客户端示例

### cURL

```bash
# 发起问题
curl -X POST http://localhost:3100/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"这个项目有哪些模块？"}'

# 监听流式回答
curl -N http://localhost:3100/api/ask/<runId>/events
```

### JavaScript/TypeScript

```typescript
class CodeQA {
  constructor(private baseUrl = 'http://localhost:3100') {}

  async ask(question: string, sessionId?: string) {
    const res = await fetch(`${this.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sessionId }),
    });
    const { runId, sessionId: newSid } = await res.json();

    const es = new EventSource(`${this.baseUrl}/api/ask/${runId}/events`);
    return {
      sessionId: newSid,
      onText: (cb: (delta: string) => void) => {
        es.onmessage = (e) => {
          const { event } = JSON.parse(e.data);
          if (event.type === 'text_delta') cb(event.delta);
          if (event.type === 'status' && event.label === 'completed') es.close();
        };
      },
      onDone: (cb: () => void) => {
        es.addEventListener('done', cb); // 或监听 status:completed
      },
      cancel: () => fetch(`${this.baseUrl}/api/ask/${runId}`, { method: 'DELETE' }),
    };
  }
}

// 使用
const qa = new CodeQA();
const { sessionId, onText } = await qa.ask('这个项目的认证逻辑在哪里？');
onText((delta) => process.stdout.write(delta));
```

### Python

```python
import requests
import json
import sseclient

def ask_question(question: str, base_url="http://localhost:3100"):
    # 发起问题
    resp = requests.post(f"{base_url}/api/ask", json={"question": question})
    data = resp.json()
    run_id = data["runId"]

    # 监听 SSE 流
    sse_resp = requests.get(
        f"{base_url}/api/ask/{run_id}/events",
        stream=True
    )
    client = sseclient.SSEClient(sse_resp)
    for event in client.events():
        data = json.loads(event.data)
        ev = data["event"]
        if ev["type"] == "text_delta":
            print(ev["delta"], end="", flush=True)
        elif ev["type"] == "status" and ev["label"] == "completed":
            break
```

---

## 项目结构

```
qa-for-code/
├── src/
│   ├── index.ts              # 入口：启动 HTTP
│   ├── server.ts             # Hono app + 路由 + 中间件
│   ├── config.ts             # 配置加载
│   ├── types.ts              # 类型定义
│   ├── sse.ts                # SSE 发射器 + ReadableStream
│   ├── claude/
│   │   ├── runner.ts         # ★ spawn claude + 流管理
│   │   ├── parser.ts         # stream-json → StreamEvent
│   │   ├── launch.ts         # 二进制查找 (PATH/知名目录)
│   │   └── prompt.ts         # 系统提示词
│   ├── routes/
│   │   ├── ask.ts            # POST /api/ask + SSE events
│   │   └── sessions.ts       # 会话 CRUD
│   └── sessions/
│       └── manager.ts        # 会话存储 (内存 Map)
├── src-repo/                 # ★ 源码目录 (Claude 分析目标)
│   └── CLAUDE.md             # 项目说明给 Claude
├── test/
│   └── qa.test.ts            # 单元测试
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
└── README.md                 # 本文件
```

---

## 开发命令

```bash
pnpm install      # 安装依赖
pnpm dev          # 开发模式 (tsx watch)
pnpm build        # 编译 TypeScript
pnpm start        # 生产模式
pnpm test         # 运行测试
pnpm typecheck    # 类型检查
```
