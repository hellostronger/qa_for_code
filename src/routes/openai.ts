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
import { runClaude, ConcurrentLimitError, getActiveRuns } from '../claude/runner.js';
import { parseMessages } from '../claude/messages.js';
import { findClaudeBinary } from '../claude/launch.js';
import type { AppConfig, AskRequest, ChatMessage, StreamEvent } from '../types.js';

export function createOpenAIRoute(config: AppConfig) {
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

    // 4. 并发检查
    if (getActiveRuns() >= config.maxConcurrentRuns) {
      return c.json(
        openAIError(`并发请求已达上限 (${config.maxConcurrentRuns})，请稍后重试`),
        429,
      );
    }

    // 5. 按 stream 分发
    if (stream) {
      return handleStreaming(c, config, messages, model);
    }
    return handleNonStreaming(c, config, messages, model);
  });

  return app;
}

// ========== 非流式 ==========

async function handleNonStreaming(
  c: Context,
  config: AppConfig,
  messages: ChatMessage[],
  model: string | undefined,
): Promise<Response> {
  const runId = crypto.randomUUID();
  const id = `chatcmpl-${runId}`;
  const created = Math.floor(Date.now() / 1000);

  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  try {
    const result = await runClaude({
      messages,
      cwd: config.sourceRepoPath,
      config,
      model,
      onEvent: (event: StreamEvent) => {
        if (event.type === 'text_delta') {
          content += event.delta;
        } else if (event.type === 'usage') {
          usage = {
            prompt_tokens: event.inputTokens,
            completion_tokens: event.outputTokens,
            total_tokens: event.inputTokens + event.outputTokens,
          };
        }
      },
    });

    if (result.exitCode !== 0) {
      return c.json(openAIError(`Claude Code 异常退出 (exit code: ${result.exitCode})`), 500);
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
): Promise<Response> {
  const runId = crypto.randomUUID();
  const id = `chatcmpl-${runId}`;
  const created = Math.floor(Date.now() / 1000);
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

      try {
        const result = await runClaude({
          messages,
          cwd: config.sourceRepoPath,
          config,
          model,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'text_delta' && event.delta) {
              chunk({ content: event.delta }, null);
            } else if (event.type === 'error') {
              chunk({}, null);
            }
          },
        });

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
