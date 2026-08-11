// ============================================================
// /api/sessions 路由 — 会话管理 CRUD
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { SessionManager } from '../sessions/manager.js';
import type { FileStore } from '../files/store.js';

export function createSessionsRoute(sessions: SessionManager, fileStore: FileStore) {
  const app = new Hono();

  // GET /api/sessions — 列出活跃会话
  app.get('/', (c: Context) => {
    return c.json(sessions.list());
  });

  // GET /api/sessions/:id — 获取会话详情（含完整消息）
  app.get('/:id', (c: Context) => {
    const id = c.req.param('id')!;
    const session = sessions.get(id);
    if (!session) {
      return c.json({ error: '会话不存在或已过期' }, 404);
    }
    return c.json(session);
  });

  // DELETE /api/sessions/:id — 删除会话
  app.delete('/:id', async (c: Context) => {
    const id = c.req.param('id')!;
    const existed = sessions.delete(id);
    if (!existed) {
      return c.json({ error: '会话不存在' }, 404);
    }
    // 级联清理该会话的生成文件 + 工作区目录
    await fileStore.deleteSession(id);
    return c.json({ ok: true });
  });

  return app;
}
