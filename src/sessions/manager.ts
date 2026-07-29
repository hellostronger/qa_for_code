// ============================================================
// 会话管理 — 内存存储 + TTL 自动过期
//
// 生产环境可替换为 SQLite 持久化。
// ============================================================

import type { Session, Message } from '../types.js';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // 每 5 分钟清理过期会话
    this.cleanupTimer = setInterval(() => this.deleteExpired(), 5 * 60 * 1000);
  }

  /** 创建新会话 */
  create(): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** 获取会话（返回时会续期 updatedAt） */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) {
      s.updatedAt = Date.now();
    }
    return s;
  }

  /** 添加消息到会话 */
  addMessage(sessionId: string, msg: Message): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.messages.push(msg);
    s.updatedAt = Date.now();
  }

  /** 获取会话列表（摘要，不含完整消息内容） */
  list(): Array<{ id: string; messageCount: number; createdAt: number; updatedAt: number }> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
  }

  /** 提取会话的消息历史（仅 user/assistant，用于传给 Claude stdin） */
  getHistory(sessionId: string): { role: string; content: string }[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        // 截断过长的历史消息，避免 token 浪费
        const maxLen = 4000;
        const content = m.content.length > maxLen
          ? m.content.slice(0, maxLen) + '...'
          : m.content;
        return { role: m.role, content };
      });
  }

  /** 删除会话 */
  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** 清理过期会话 */
  private deleteExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.updatedAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }

  /** 销毁（停止定时器） */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
