// ============================================================
// Claude stream-json 解析器
//
// Claude Code 以 --output-format stream-json 运行时，stdout 每行
// 是一个 JSON 对象。本解析器将其映射为统一的 StreamEvent。
//
// 参考 Molio apps/daemon/src/core/streams/claude-stream.ts
// ============================================================

import type {
  StreamEvent,
  ClaudeLine,
  ClaudeStreamEvent,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
} from '../types.js';

// ========== 内部状态 ==========

interface BlockState {
  type: 'text' | 'tool_use' | 'thinking';
  id?: string;
  name?: string;
  jsonBuffer: string; // 累积 input_json_delta 片段
}

interface ParseState {
  currentBlock: BlockState | null;
  ttftMs: number | null;
  startTime: number;
  // 去重：assistant 消息可能与 stream_event 重复
  seenToolUseIds: Set<string>;
  hasEmittedText: boolean;       // 本 run 中是否已 emit 过 text
  hasEmittedThinking: boolean;   // 本 run 中是否已 emit 过 thinking
}

// ========== 入口 ==========

export function createClaudeParser(onEvent: (ev: StreamEvent) => void) {
  let buffer = '';
  const state: ParseState = {
    currentBlock: null,
    ttftMs: null,
    startTime: Date.now(),
    seenToolUseIds: new Set(),
    hasEmittedText: false,
    hasEmittedThinking: false,
  };

  return {
    /** 喂入一个 stdout chunk */
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后不完整的行留在缓冲区

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const obj: ClaudeLine = JSON.parse(trimmed);
          handleLine(obj, state, onEvent);
        } catch {
          // JSON parse 失败 — 静默跳过，可能是非 JSON 诊断输出
        }
      }
    },

    /** 流结束时调用，清空缓冲区 */
    flush() {
      if (buffer.trim()) {
        try {
          const obj: ClaudeLine = JSON.parse(buffer.trim());
          handleLine(obj, state, onEvent);
        } catch {}
      }
      // 确保始终发送 completed
      onEvent({ type: 'status', label: 'completed' });
    },
  };
}

// ========== 顶层分发 ==========

function handleLine(
  obj: ClaudeLine,
  state: ParseState,
  emit: (ev: StreamEvent) => void,
): void {
  switch (obj.type) {
    case 'system':
    case 'init':
      // 忽略初始化消息
      break;

    case 'stream_event':
      handleStreamEvent(obj.event, state, emit);
      break;

    case 'assistant':
      handleAssistantMessage(obj.message, state, emit);
      break;

    case 'user':
      handleUserMessage(obj.message, state, emit);
      break;

    case 'result':
      handleResult(obj, state, emit);
      break;
  }
}

// ========== stream_event 处理 ==========

function handleStreamEvent(
  event: ClaudeStreamEvent,
  state: ParseState,
  emit: (ev: StreamEvent) => void,
): void {
  switch (event.type) {
    // -------------------------------------------------------
    // message_start / message_stop
    // -------------------------------------------------------
    case 'message_start': {
      state.ttftMs = Date.now() - state.startTime;
      emit({ type: 'status', label: 'running' });
      break;
    }

    case 'message_stop': {
      state.currentBlock = null;
      break;
    }

    // -------------------------------------------------------
    // content_block_start — 记录 block 类型和 id
    // -------------------------------------------------------
    case 'content_block_start': {
      const block = event.content_block;
      if (!block) break;

      if (block.type === 'tool_use') {
        state.currentBlock = {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          jsonBuffer: '',
        };
      } else if (block.type === 'text') {
        state.currentBlock = {
          type: 'text',
          jsonBuffer: '',
        };
      } else if (block.type === 'thinking') {
        state.currentBlock = {
          type: 'thinking',
          jsonBuffer: '',
        };
      }
      break;
    }

    // -------------------------------------------------------
    // content_block_delta — 流式增量
    // -------------------------------------------------------
    case 'content_block_delta': {
      const delta = event.delta;
      if (!delta) break;

      if (delta.type === 'text_delta' && delta.text) {
        emit({ type: 'text_delta', delta: delta.text });
        state.hasEmittedText = true;
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        emit({ type: 'thinking_delta', delta: delta.thinking });
        state.hasEmittedThinking = true;
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        // 累积 tool_use 的 input JSON 片段
        if (state.currentBlock?.type === 'tool_use') {
          state.currentBlock.jsonBuffer += delta.partial_json;
        }
      }
      break;
    }

    // -------------------------------------------------------
    // content_block_stop — block 结束
    // -------------------------------------------------------
    case 'content_block_stop': {
      if (!state.currentBlock) break;

      if (state.currentBlock.type === 'tool_use') {
        // 合并 input_json_delta 片段成完整的 input
        let input: unknown = {};
        try {
          if (state.currentBlock.jsonBuffer.trim()) {
            input = JSON.parse(state.currentBlock.jsonBuffer);
          }
        } catch {
          input = { _raw: state.currentBlock.jsonBuffer };
        }

        const toolId = state.currentBlock.id;
        if (toolId) {
          state.seenToolUseIds.add(toolId);
          emit({
            type: 'tool_use',
            id: toolId,
            name: state.currentBlock.name || 'unknown',
            input,
          });
        }
      }

      state.currentBlock = null;
      break;
    }
  }
}

// ========== assistant 消息 — 完整结果，与 stream_event 去重 ==========

function handleAssistantMessage(
  message: ClaudeAssistantMessage,
  state: ParseState,
  emit: (ev: StreamEvent) => void,
): void {
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.input === 'string') {
      // 仅在 stream_event 中未发过的才 emit
      if (!state.hasEmittedText) {
        emit({ type: 'text_delta', delta: block.input });
        state.hasEmittedText = true;
      }
    } else if (block.type === 'tool_use' && block.id) {
      // 仅在 stream_event 中未发过的才 emit
      if (!state.seenToolUseIds.has(block.id)) {
        state.seenToolUseIds.add(block.id);
        emit({
          type: 'tool_use',
          id: block.id,
          name: block.name || 'unknown',
          input: block.input,
        });
      }
    } else if (block.type === 'thinking' && typeof block.input === 'string') {
      if (!state.hasEmittedThinking) {
        emit({ type: 'thinking_delta', delta: block.input });
        state.hasEmittedThinking = true;
      }
    }
  }
}

// ========== user 消息 — 工具执行结果 ==========

function handleUserMessage(
  message: ClaudeUserMessage,
  _state: ParseState,
  emit: (ev: StreamEvent) => void,
): void {
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      emit({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: String(block.content),
        isError: block.is_error,
      });
    }
  }
}

// ========== result 消息 — 最终结果 ==========

function handleResult(
  obj: { subtype: string; is_error?: boolean; usage?: { input_tokens: number; output_tokens: number }; error?: { message: string } },
  _state: ParseState,
  emit: (ev: StreamEvent) => void,
): void {
  if (obj.is_error) {
    emit({ type: 'error', message: obj.error?.message || 'Unknown error' });
    return;
  }

  if (obj.usage) {
    emit({
      type: 'usage',
      inputTokens: obj.usage.input_tokens,
      outputTokens: obj.usage.output_tokens,
    });
  }
}
