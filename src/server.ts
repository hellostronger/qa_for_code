// ============================================================
// Hono 服务组装 — 中间件 + 路由注册
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppConfig } from './types.js';
import { SessionManager } from './sessions/manager.js';
import { createAskRoute } from './routes/ask.js';
import { createSessionsRoute } from './routes/sessions.js';
import { createOpenAIRoute } from './routes/openai.js';

export function createApp(config: AppConfig) {
  const app = new Hono();

  // ========== 中间件 ==========

  // CORS — 允许本地开发 + 部署后的域名
  app.use('*', cors({
    origin: (origin) => {
      // 允许 localhost、无 origin（curl/SSE）、自定义域名
      if (!origin) return '*';
      const allowed = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      ];
      if (process.env.CORS_ORIGIN) {
        allowed.push(new RegExp(process.env.CORS_ORIGIN));
      }
      for (const pattern of allowed) {
        if (pattern.test(origin)) return origin;
      }
      return null;
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Last-Event-ID'],
    exposeHeaders: ['Content-Type', 'Cache-Control'],
  }));

  // 请求日志
  app.use('*', logger());

  // ========== 服务实例 ==========

  const sessions = new SessionManager(config.sessionTtlMs);

  // ========== 路由 ==========

  // 健康检查
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      version: '1.0.0',
      sourceRepo: config.sourceRepoPath,
      uptime: process.uptime(),
    });
  });

  // /api/ask — 提问 + SSE
  app.route('/api/ask', createAskRoute(config, sessions));

  // /api/sessions — 会话管理
  app.route('/api/sessions', createSessionsRoute(sessions));

  // /v1 — OpenAI 兼容端点
  app.route('/v1', createOpenAIRoute(config));

  // 404 兜底
  app.notFound((c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  // 全局错误处理
  app.onError((err, c) => {
    console.error('[server error]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return { app, sessions };
}
