// ============================================================
// 测试：流解析器 + 会话管理 + prompt
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createClaudeParser } from '../src/claude/parser.js';
import { buildSystemPrompt } from '../src/claude/prompt.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { StreamEvent } from '../src/types.js';

// ========== Parser 测试 ==========

describe('ClaudeParser', () => {
  it('解析 stream_event text_delta', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello world' },
      },
    }) + '\n');
    parser.flush();

    const textEvents = events.filter((e) => e.type === 'text_delta');
    assert.ok(textEvents.length > 0, '应有 text_delta 事件');
    assert.equal(textEvents[0].delta, 'Hello world');
    assert.ok(events.some((e) => e.type === 'status' && e.label === 'completed'));
  });

  it('解析 stream_event thinking_delta', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
    }) + '\n');
    parser.flush();

    const thinkingEvents = events.filter((e) => e.type === 'thinking_delta');
    assert.ok(thinkingEvents.length > 0);
    assert.equal(thinkingEvents[0].delta, 'Let me think...');
  });

  it('解析 tool_use（含 input_json_delta 合并）', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    // content_block_start
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool_1', name: 'Read' },
      },
    }) + '\n');

    // input_json_delta（流式 JSON 片段）
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"file' },
      },
    }) + '\n');

    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '_path":"src/index.ts"}' },
      },
    }) + '\n');

    // content_block_stop
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }) + '\n');
    parser.flush();

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    assert.equal(toolEvents.length, 1, '应有 1 个 tool_use 事件');
    assert.equal(toolEvents[0].id, 'tool_1');
    assert.equal(toolEvents[0].name, 'Read');
    assert.deepEqual(toolEvents[0].input, { file_path: 'src/index.ts' });
  });

  it('解析 result 中的 usage', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1500, output_tokens: 300 },
    }) + '\n');
    parser.flush();

    const usageEvent = events.find((e) => e.type === 'usage');
    assert.ok(usageEvent, '应有 usage 事件');
    if (usageEvent && usageEvent.type === 'usage') {
      assert.equal(usageEvent.inputTokens, 1500);
      assert.equal(usageEvent.outputTokens, 300);
    }
  });

  it('解析 result is_error', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: { message: 'Something went wrong' },
    }) + '\n');
    parser.flush();

    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    if (errorEvent && errorEvent.type === 'error') {
      assert.ok(errorEvent.message.includes('wrong'));
    }
  });

  it('处理不完整的行（跨越 chunk 边界）', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    // 将一个 event 拆成两个 chunk
    const full = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'split message' },
      },
    }) + '\n';

    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    parser.feed(full.slice(mid));
    parser.flush();

    const textEvents = events.filter((e) => e.type === 'text_delta');
    assert.ok(textEvents.length > 0);
  });

  it('忽略 JSON parse 失败的行', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    // 这不是有效的 JSON
    parser.feed('this is not JSON\n');
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'valid' },
      },
    }) + '\n');
    parser.flush();

    // 有效的那个应该被解析
    const textEvents = events.filter((e) => e.type === 'text_delta');
    assert.equal(textEvents.length, 1);
  });

  it('assistant 消息不会重复 emit 已在 stream_event 中发送的 text', () => {
    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    // 先发 stream_event text_delta
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }) + '\n');

    // 再发 assistant（含相同 text block）
    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', input: 'Hello' }],
      },
    }) + '\n');
    parser.flush();

    // 'Hello' 只应出现一次
    const textEvents = events.filter((e) => e.type === 'text_delta');
    const hellos = textEvents.filter((e) => e.type === 'text_delta' && e.delta === 'Hello');
    assert.equal(hellos.length, 1, 'text_delta="Hello" 不应重复');
  });
});

// ========== Prompt 测试 ==========

describe('SystemPrompt', () => {
  it('生成包含安全规则的提示词', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('<system>'));
    assert.ok(prompt.includes('Read before answering'));
    assert.ok(prompt.includes('never reveal'));
  });
});

// ========== SessionManager 测试 ==========

describe('SessionManager', () => {
  it('创建和获取会话', () => {
    const sm = new SessionManager(60000);
    const session = sm.create();
    assert.ok(session.id);
    assert.equal(session.messages.length, 0);

    const retrieved = sm.get(session.id);
    assert.ok(retrieved);
    assert.equal(retrieved!.id, session.id);
    sm.destroy();
  });

  it('添加消息到会话', () => {
    const sm = new SessionManager(60000);
    const session = sm.create();
    sm.addMessage(session.id, {
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });
    const s = sm.get(session.id)!;
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].content, 'hello');
    sm.destroy();
  });

  it('提取历史时只返回 user/assistant 消息', () => {
    const sm = new SessionManager(60000);
    const session = sm.create();
    sm.addMessage(session.id, { id: '1', role: 'user', content: 'q', timestamp: 1 });
    sm.addMessage(session.id, { id: '2', role: 'assistant', content: 'a', timestamp: 2 });

    const history = sm.getHistory(session.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');
    sm.destroy();
  });

  it('会话列表按 updatedAt 倒序', () => {
    const sm = new SessionManager(60000);
    const s1 = sm.create();
    const s2 = sm.create();
    // s1 加条消息使其 updatedAt > s2
    sm.addMessage(s1.id, { id: 'm', role: 'user', content: 'x', timestamp: Date.now() });

    const list = sm.list();
    assert.equal(list[0].id, s1.id); // s1 应该排在前面
    sm.destroy();
  });

  it('按时过期（TTL 测试）', async () => {
    const sm = new SessionManager(100); // 100ms TTL
    const session = sm.create();
    assert.ok(sm.get(session.id));

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 200));
    sm['deleteExpired'](); // 手动触发清理

    assert.equal(sm.get(session.id), undefined);
    sm.destroy();
  });
});
