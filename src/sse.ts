// ============================================================
// SSE 流工具 — 将事件队列转为 SSE ReadableStream
//
// 参考 Molio apps/daemon/src/sse.ts
// ============================================================

import type { SSEEnvelope } from './types.js';

/**
 * SSE 事件发射器。
 * 每个 run 创建一个实例，负责收集事件并通过 SSE 推送给客户端。
 */
export class SSEEmitter {
  private events: SSEEnvelope[] = [];
  private seq = 0;
  private listeners: Array<(env: SSEEnvelope) => void> = [];
  private resolved = false;
  private resolvePromise!: () => void;
  private donePromise: Promise<void>;

  constructor(private runId: string) {
    this.donePromise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  /** 推送一个事件 */
  push(event: SSEEnvelope['event']): void {
    if (this.resolved) return;
    const envelope: SSEEnvelope = {
      seq: this.seq++,
      runId: this.runId,
      event,
    };
    // 限制内存中最多保留 2000 条事件（FIFO）
    if (this.events.length >= 2000) {
      this.events.shift();
    }
    this.events.push(envelope);
    // 通知所有 SSE 连接
    for (const listener of this.listeners) {
      try { listener(envelope); } catch {}
    }
  }

  /** 标记流结束 */
  close(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolvePromise();
  }

  /** 订阅实时事件（用于 SSE 连接） */
  subscribe(callback: (env: SSEEnvelope) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** 获取指定 seq 之后的所有历史事件（断线重连用） */
  replay(afterSeq: number): SSEEnvelope[] {
    return this.events.filter((e) => e.seq > afterSeq);
  }

  /** 检查流是否已结束 */
  isClosed(): boolean {
    return this.resolved;
  }

  /** 等待流结束 */
  waitForDone(): Promise<void> {
    return this.donePromise;
  }
}

// ========== SSE ReadableStream 工厂 ==========

/**
 * 创建一个 Hono 可用的 SSE ReadableStream。
 *
 * 流程：
 *   1. 先 replay 已缓存的事件（断线重连）
 *   2. 订阅实时事件
 *   3. 15 秒 keepalive ping
 *   4. run 结束后关闭流
 */
export function createSSEResponse(
  emitter: SSEEmitter,
  lastEventId: string | null,
  signal: AbortSignal,
): Response {
  const afterSeq = lastEventId ? parseInt(lastEventId, 10) || 0 : -1;

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Phase 1 — Replay 历史事件
      const history = emitter.replay(afterSeq);
      for (const env of history) {
        controller.enqueue(encoder.encode(
          `id: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`
        ));
      }

      // Phase 2 — 如果已结束，直接关闭
      if (emitter.isClosed()) {
        controller.close();
        return;
      }

      // Phase 3 — 订阅实时事件
      unsubscribe = emitter.subscribe((env) => {
        try {
          controller.enqueue(encoder.encode(
            `id: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`
          ));
          // 收到 completed/failed 后关闭流
          if (
            env.event.type === 'status' &&
            (env.event.label === 'completed' || env.event.label === 'failed')
          ) {
            controller.close();
          }
        } catch {
          // 连接已断开
        }
      });

      // Phase 4 — Keepalive ping（每 15 秒）
      pingTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':ping\n\n'));
        } catch {
          // 连接已断开
        }
      }, 15000);

      // 等待 run 完成（兜底关闭）
      emitter.waitForDone().then(() => {
        try { controller.close(); } catch {}
      });
    },

    cancel() {
      if (pingTimer) clearInterval(pingTimer);
      if (unsubscribe) unsubscribe();
    },
  });

  // AbortSignal 清理
  signal.addEventListener('abort', () => {
    if (pingTimer) clearInterval(pingTimer);
    if (unsubscribe) unsubscribe();
  }, { once: true });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
    },
  });
}
