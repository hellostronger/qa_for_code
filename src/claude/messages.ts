// ============================================================
// 消息校验与组装 — 供 /api/ask 与 /v1/chat/completions 共用
// ============================================================

import type { AskRequest, ChatMessage } from '../types.js';

/**
 * 从请求体解析并校验 messages。
 *
 * OpenAI 规范：messages 数组承载完整对话（历史 + 当前问题，最后一条为 user）。
 * 兼容旧调用：未传 messages 但传了 question 时，视为单轮。
 *
 * 返回 { messages } 或 { error }。
 */
export function parseMessages(body: AskRequest): { messages: ChatMessage[] } | { error: string } {
  // 优先取 messages
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return { error: 'messages 必须是非空数组' };
    }
    const messages: ChatMessage[] = [];
    for (const msg of body.messages) {
      if (typeof msg !== 'object' || msg === null) {
        return { error: 'messages 中每条消息必须是对象' };
      }
      const role = (msg as any).role;
      const content = (msg as any).content;
      if (role !== 'user' && role !== 'assistant') {
        return { error: 'messages 中每条消息的 role 必须是 user 或 assistant' };
      }
      if (typeof content !== 'string' || !content.trim()) {
        return { error: 'messages 中每条消息的 content 必须是非空字符串' };
      }
      messages.push({ role, content });
    }
    // 最后一条必须是 user（当前问题）
    const last = messages[messages.length - 1];
    if (last.role !== 'user') {
      return { error: 'messages 最后一条消息的 role 必须为 user（当前问题）' };
    }
    return { messages };
  }

  // 兜底：旧字段 question（单轮）
  if (!body.question || typeof body.question !== 'string' || !body.question.trim()) {
    return { error: 'question 字段不能为空，或传入 messages 数组' };
  }
  return { messages: [{ role: 'user', content: body.question }] };
}
