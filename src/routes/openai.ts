// ============================================================
// /v1/chat/completions — OpenAI 兼容端点
//
// 让用户可以直接把本服务当成一个 OpenAI 兼容模型接入
// （OpenAI SDK / LobeChat / ChatBox 等配置 base_url 即可）。
//
// 支持:
//   POST /v1/chat/completions
//     body: { model?, messages, stream? }
//   非流式: 返回 OpenAI 标准 chat.completion JSON
//   流式:   SSE，data: {...} 增量 + 结尾 data: [DONE]
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { runClaude, ConcurrentLimitError, getActiveRuns, runFailureMessage } from '../claude/runner.js';
import { parseMessages } from '../claude/messages.js';
import { findClaudeBinary } from '../claude/launch.js';
import { createRunFileTracker } from '../files/tracker.js';
import type { FileStore } from '../files/store.js';
import { getPublicBaseUrl } from './public-url.js';
import type { AppConfig, AskRequest, ChatMessage, FileInfo, StreamEvent } from '../types.js';

export function createOpenAIRoute(config: AppConfig, fileStore: FileStore) {
  const app = new Hono();

  // ================================================================
  // POST /v1/chat/completions
  // ================================================================
  app.post('/chat/completions', async (c: Context) => {
    // 1. 预检：claude 是否可用
    try {
      await findClaudeBinary();
    } catch (err: any) {
      return c.json(openAIError('Claude Code CLI 未安装或不可用。', err.message), 503);
    }

    // 2. 解析请求体
    let body: AskRequest & { stream?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json(openAIError('请求体必须是 JSON 格式'), 400);
    }

    // 3. 校验 messages（OpenAI 规范：必须传 messages 数组）
    const parsed = parseMessages(body);
    if ('error' in parsed) {
      return c.json(openAIError(parsed.error), 400);
    }
    const messages = parsed.messages;
    const stream = body.stream === true;
    const model = body.model || config.model;
    console.log(
      `[openai] request model=${model ?? '(config:' + (config.model ?? 'default') + ')'} ` +
        `stream=${stream} messages=${messages.length}`,
    );

    // 4. 并发检查
    if (getActiveRuns() >= config.maxConcurrentRuns) {
      return c.json(
        openAIError(`并发请求已达上限 (${config.maxConcurrentRuns})，请稍后重试`),
        429,
      );
    }

    // 5. 按 stream 分发
    if (stream) {
      return handleStreaming(c, config, messages, model, fileStore);
    }
    return handleNonStreaming(c, config, messages, model, fileStore);
  });

  return app;
}

// ========== 非流式 ==========

async function handleNonStreaming(
  c: Context,
  config: AppConfig,
  messages: ChatMessage[],
  model: string | undefined,
  fileStore: FileStore,
): Promise<Response> {
  const runId = crypto.randomUUID();
  const id = `chatcmpl-${runId}`;
  const created = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  console.log(
    `[openai] run ${runId} start stream=false ` +
      `model=${model ?? '(config:' + (config.model ?? 'default') + ')'} messages=${messages.length}`,
  );

  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // 工作区按 runId 隔离（OpenAI 端点无会话概念）
  const runDir = await fileStore.ensureRunDir(runId);
  const tracker = createRunFileTracker(fileStore, runId);

  try {
    const result = await runClaude({
      messages,
      cwd: config.sourceRepoPath,
      config,
      model,
      label: runId,
      outputDir: runDir,
      onEvent: (event: StreamEvent) => {
        if (event.type === 'text_delta') {
          content += event.delta;
        } else if (event.type === 'tool_use' && event.name === 'Write') {
          // Write 工具：把生成的文件内容并入回答文本，
          // 与流式行为保持一致（文件仍照常保存/返回 files 清单）。
          const fileContent = (event.input as { content?: unknown } | undefined)?.content;
          if (typeof fileContent === 'string' && fileContent.length > 0) {
            content += (content ? '\n\n' : '') + fileContent;
          }
        } else if (event.type === 'usage') {
          usage = {
            prompt_tokens: event.inputTokens,
            completion_tokens: event.outputTokens,
            total_tokens: event.inputTokens + event.outputTokens,
          };
        }
        tracker.handleEvent(event);
      },
    });
    console.log(
      `[openai] run ${runId} end exitCode=${result.exitCode} ` +
        `durationMs=${Date.now() - t0} killReason=${result.killReason ?? '-'}`,
    );

    // 生成文件清单
    const files = await tracker.finalize();
    const baseUrl = getPublicBaseUrl(c);
    const fileInfos: FileInfo[] = files.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      url: `${baseUrl}/api/files/${f.fileId}`,
      size: f.size,
    }));

    if (result.exitCode !== 0) {
      return c.json(openAIError(runFailureMessage(result, config.runTimeoutMs)), 500);
    }

    return c.json({
      id,
      object: 'chat.completion',
      created,
      model: model || 'claude',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage,
      files: fileInfos, // 非标准扩展字段，OpenAI 客户端会忽略
    });
  } catch (err: any) {
    if (err instanceof ConcurrentLimitError) {
      return c.json(openAIError(err.message), 429);
    }
    return c.json(openAIError(`运行失败: ${err.message}`), 500);
  }
}

// ========== 流式 ==========

async function handleStreaming(
  c: Context,
  config: AppConfig,
  messages: ChatMessage[],
  model: string | undefined,
  fileStore: FileStore,
): Promise<Response> {
  const runId = crypto.randomUUID();
  const id = `chatcmpl-${runId}`;
  const created = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  console.log(
    `[openai] run ${runId} start stream=true ` +
      `model=${model ?? '(config:' + (config.model ?? 'default') + ')'} messages=${messages.length}`,
  );
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 连接已断开
        }
      };
      const done = () => {
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {}
      };

      const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
        send({
          id, object: 'chat.completion.chunk', created, model: model || 'claude',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });

      // 首帧：声明角色
      chunk({ role: 'assistant', content: '' }, null);

      // 工作区按 runId 隔离（OpenAI 端点无会话概念）
      const runDir = await fileStore.ensureRunDir(runId);
      const tracker = createRunFileTracker(fileStore, runId);

      try {
        const result = await runClaude({
          messages,
          cwd: config.sourceRepoPath,
          config,
          model,
          label: runId,
          outputDir: runDir,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'text_delta' && event.delta) {
              chunk({ content: event.delta }, null);
            } else if (event.type === 'tool_use' && event.name === 'Write') {
              // Write 工具：把要写入的文件内容作为流式文本推给客户端，
              // 避免生成大文件时客户端长时间无输出、看起来像卡住。
              const fileContent = (event.input as { content?: unknown } | undefined)?.content;
              if (typeof fileContent === 'string' && fileContent.length > 0) {
                chunk({ content: fileContent }, null);
              }
            } else if (event.type === 'error') {
              chunk({}, null);
            }
            tracker.handleEvent(event);
          },
        });
        console.log(
          `[openai] run ${runId} end exitCode=${result.exitCode} ` +
            `durationMs=${Date.now() - t0} killReason=${result.killReason ?? '-'}`,
        );

        // 非零退出（含超时被终止）：以 text delta 形式把原因告诉客户端，
        // 避免静默返回空内容
        if (result.exitCode !== 0) {
          chunk({ content: `\n\n[${runFailureMessage(result, config.runTimeoutMs)}]` }, null);
        }

        // 生成文件：结尾追加一条 text delta（不发独立 event:file 帧，
        // 严格 OpenAI SDK 解析器会尝试把每个 data: 都解析成 chunk 而抛错）
        const files = await tracker.finalize();
        if (files.length > 0) {
          const baseUrl = getPublicBaseUrl(c);
          const summary = files
            .map((f) => `${f.name} -> ${baseUrl}/api/files/${f.fileId}`)
            .join('; ');
          chunk({ content: `\n\n[Generated files: ${summary}]` }, null);
        }

        // 收尾帧
        chunk({}, 'stop');
      } catch (err: any) {
        if (!(err instanceof ConcurrentLimitError)) {
          chunk({}, 'stop');
        }
      } finally {
        done();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ========== 工具函数 ==========

/** OpenAI 风格错误响应 */
function openAIError(message: string, detail?: string): { error: { message: string; type: string } } {
  return {
    error: {
      message: detail ? `${message} ${detail}` : message,
      type: 'invalid_request_error',
    },
  };
}
