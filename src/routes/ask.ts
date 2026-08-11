// ============================================================
// /api/ask 路由 — 发起问题 + SSE 事件流
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { runClaude, ConcurrentLimitError, runFailureMessage } from '../claude/runner.js';
import { parseMessages } from '../claude/messages.js';
import { findClaudeBinary } from '../claude/launch.js';
import { SSEEmitter, createSSEResponse } from '../sse.js';
import { SessionManager } from '../sessions/manager.js';
import { createRunFileTracker } from '../files/tracker.js';
import type { FileStore } from '../files/store.js';
import { getPublicBaseUrl } from './public-url.js';
import type { AppConfig, AskRequest, AskResponse, ChatMessage, FileInfo, Message, StreamEvent } from '../types.js';

// ========== 运行中的 run 追踪 ==========

interface ActiveRun {
  emitter: SSEEmitter;
  abort: AbortController;
}

export function createAskRoute(config: AppConfig, sessions: SessionManager, fileStore: FileStore) {
  const app = new Hono();

  // 活跃的 runs
  const activeRuns = new Map<string, ActiveRun>();

  // ================================================================
  // POST /api/ask — 发起问题
  // ================================================================
  app.post('/', async (c: Context) => {
    // 1. 预检：claude 是否可用
    try {
      await findClaudeBinary();
    } catch (err: any) {
      return c.json({ error: 'Claude Code CLI 未安装或不可用。', detail: err.message }, 503);
    }

    // 2. 解析请求
    let body: AskRequest;
    try {
      body = await c.req.json<AskRequest>();
    } catch {
      return c.json({ error: '请求体必须是 JSON 格式' }, 400);
    }

    // 3. 校验并组装 messages（OpenAI 规范）
    const messagesResult = parseMessages(body);
    if ('error' in messagesResult) {
      return c.json({ error: messagesResult.error }, 400);
    }
    const messages = messagesResult.messages;

    // 4. 获取或创建会话
    let session = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (body.sessionId && !session) {
      return c.json({ error: '会话不存在或已过期' }, 404);
    }
    if (!session) {
      session = sessions.create();
    }

    // 5. 创建 run
    const runId = crypto.randomUUID();
    const emitter = new SSEEmitter(runId);
    const abort = new AbortController();

    activeRuns.set(runId, { emitter, abort });

    // 6. 记录用户消息（最后一条 = 当前问题）
    const lastUserMsg = messages[messages.length - 1];
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: lastUserMsg.content,
      timestamp: Date.now(),
    };
    sessions.addMessage(session.id, userMsg);

    // 7. 异步启动 Claude Code
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      thinking: '',
      tools: [],
      timestamp: Date.now(),
    };
    sessions.addMessage(session.id, assistantMsg);

    // 不 await — 让 SSE 流独立运行
    runInBackground(runId, messages, session.id, assistantMsg.id, config, sessions, fileStore, emitter, abort.signal, getPublicBaseUrl(c));

    // 8. 返回 runId + sessionId
    const response: AskResponse = { runId, sessionId: session.id };
    return c.json(response);
  });

  // ================================================================
  // GET /api/ask/:runId/events — SSE 事件流
  // ================================================================
  app.get('/:runId/events', (c: Context) => {
    const runId = c.req.param('runId')!;
    const run = activeRuns.get(runId);

    if (!run) {
      return c.json({ error: 'Run 不存在或已结束' }, 404);
    }

    // 支持 Last-Event-ID header（断线重连）
    const lastEventId = c.req.header('Last-Event-ID') || c.req.query('after') || null;

    return createSSEResponse(run.emitter, lastEventId, c.req.raw.signal);
  });

  // ================================================================
  // DELETE /api/ask/:runId — 取消运行
  // ================================================================
  app.delete('/:runId', (c: Context) => {
    const runId = c.req.param('runId')!;
    const run = activeRuns.get(runId);

    if (!run) {
      return c.json({ error: 'Run 不存在' }, 404);
    }

    run.abort.abort();
    run.emitter.push({ type: 'status', label: 'failed' });
    run.emitter.push({ type: 'error', message: '用户取消了请求' });
    run.emitter.close();

    // 延迟清理（等待 SSE 连接感知关闭）
    setTimeout(() => activeRuns.delete(runId), 10000);

    return c.json({ ok: true });
  });

  return app;
}

// ========== 后台异步执行 Claude Code ==========

async function runInBackground(
  runId: string,
  messages: ChatMessage[],
  sessionId: string,
  assistantMsgId: string,
  config: AppConfig,
  sessions: SessionManager,
  fileStore: FileStore,
  emitter: SSEEmitter,
  signal: AbortSignal,
  publicBaseUrl: string,
): Promise<void> {
  // 会话级工作区（多轮共享，Claude 可继续修改上轮文件）
  const runDir = await fileStore.ensureRunDir(sessionId);
  const tracker = createRunFileTracker(fileStore, sessionId, sessionId);
  const t0 = Date.now();
  console.log(
    `[ask] run ${runId} start session=${sessionId} ` +
      `messages=${messages.length} model=${config.model ?? 'default'}`,
  );

  try {
    const result = await runClaude({
      messages,
      cwd: config.sourceRepoPath,
      config,
      label: runId,
      outputDir: runDir,
      onEvent: (event: StreamEvent) => {
        // SSE 顺序修复：parser 的 flush() 会无条件发 completed（sse.ts 收到即关流，
        // 且它早于 runClaude resolve），这里抑制它，真正的终态在 file 事件之后推。
        if (event.type === 'status' && event.label === 'completed') return;
        emitter.push(event);
        // 实时更新 assistant 消息到 session
        updateAssistantMessage(sessions, sessionId, assistantMsgId, event);
        // 捕获 Write 工具产物
        tracker.handleEvent(event);
      },
      signal,
    });
    console.log(
      `[ask] run ${runId} end exitCode=${result.exitCode} ` +
        `durationMs=${Date.now() - t0} killReason=${result.killReason ?? '-'}`,
    );

    // 生成文件：等待挂起写入 + 扫描目录 → 注册记录 → 推送 file 事件
    if (!emitter.isClosed()) {
      const files = await tracker.finalize();
      const fileInfos: FileInfo[] = files.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        url: `${publicBaseUrl}/api/files/${f.fileId}`,
        size: f.size,
      }));
      for (const info of fileInfos) {
        emitter.push({ type: 'file', ...info });
      }
      // 把文件信息写入 assistant 消息
      if (fileInfos.length > 0) {
        const session = sessions.get(sessionId);
        const msg = session?.messages.find((m) => m.id === assistantMsgId);
        if (msg) msg.files = fileInfos;
      }
    }

    if (result.exitCode !== 0) {
      emitter.push({ type: 'error', message: runFailureMessage(result, config.runTimeoutMs) });
    }
    emitter.push({ type: 'status', label: result.exitCode === 0 ? 'completed' : 'failed' });
  } catch (err: any) {
    if (err instanceof ConcurrentLimitError) {
      emitter.push({ type: 'error', message: err.message });
    } else {
      emitter.push({ type: 'error', message: `运行失败: ${err.message}` });
    }
    emitter.push({ type: 'status', label: 'failed' });
  } finally {
    emitter.close();
  }
}

// ========== 实时更新 assistant 消息到 session ==========

function updateAssistantMessage(
  sessions: SessionManager,
  sessionId: string,
  msgId: string,
  event: StreamEvent,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const msg = session.messages.find((m) => m.id === msgId);
  if (!msg) return;

  switch (event.type) {
    case 'text_delta':
      msg.content += event.delta;
      break;
    case 'thinking_delta':
      msg.thinking = (msg.thinking || '') + event.delta;
      break;
    case 'tool_use': {
      if (!msg.tools) msg.tools = [];
      // 避免重复添加同一个 tool_use
      if (!msg.tools.some((t) => t.id === event.id)) {
        msg.tools.push({
          id: event.id,
          name: event.name,
          input: event.input,
          result: undefined,
          isError: false,
        });
      }
      break;
    }
    case 'tool_result': {
      if (!msg.tools) msg.tools = [];
      const tool = msg.tools.find((t) => t.id === event.toolUseId);
      if (tool) {
        tool.result = event.content;
        tool.isError = event.isError;
      }
      break;
    }
    case 'usage':
      msg.usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd,
      };
      break;
  }
}
