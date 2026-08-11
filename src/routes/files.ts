// ============================================================
// /api/files — 生成文件下载端点
//
// 安全：
// - 记录查不到 → 404
// - realpath 检查目标文件仍位于工作区目录内（防符号链接逃逸）
// - Content-Disposition filename 清洗 + filename* UTF-8 变体
// ============================================================

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FileStore } from '../files/store.js';

/** 清洗文件名，去掉会破坏 header 的字符 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    .slice(0, 255);
}

export function createFilesRoute(fileStore: FileStore) {
  const app = new Hono();

  // GET /api/files/:id — 下载生成文件
  app.get('/:id', async (c: Context) => {
    const id = c.req.param('id')!;
    const record = fileStore.get(id);
    if (!record) {
      return c.json({ error: '文件不存在或已过期' }, 404);
    }

    const runDir = fileStore.runDir(record.runId);
    const targetPath = path.resolve(runDir, record.relativePath);

    // 防符号链接逃逸：realpath 后必须仍位于 runDir 内
    try {
      const real = await fs.realpath(targetPath);
      const realRunDir = await fs.realpath(runDir);
      if (!real.startsWith(realRunDir + path.sep)) {
        return c.json({ error: '文件无效' }, 403);
      }
    } catch {
      return c.json({ error: '文件不存在或已过期' }, 404);
    }

    const safeName = sanitizeFilename(record.name);
    const encodedName = encodeURIComponent(record.name);

    return new Response(
      new ReadableStream({
        async start(controller) {
          const stream = createReadStream(targetPath);
          stream.on('data', (chunk) => controller.enqueue(chunk));
          stream.on('end', () => controller.close());
          stream.on('error', () => {
            try { controller.error(); } catch {}
          });
        },
        cancel() {},
      }),
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(record.size),
          'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
          'Cache-Control': 'private, max-age=0',
        },
      },
    );
  });

  return app;
}
