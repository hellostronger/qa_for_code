// ============================================================
// FileStore — 生成文件的注册、查询与 TTL 清理
//
// 记录不存 absolutePath — 下载时用 runDir(key) + relativePath 重建，
// 避免存储绝对路径带来的可移植问题。
//
// TTL 清理与 SessionManager 对齐（sessionTtlMs），5 分钟一次扫描。
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanRunDir, toPosix } from './capture.js';
import type { FileRecord } from '../types.js';

export class FileStore {
  private records = new Map<string, FileRecord>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private baseDir: string,
    private ttlMs: number,
  ) {}

  /** 工作区根目录 */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** 某个 run/session 的工作区目录 */
  runDir(key: string): string {
    return path.join(this.baseDir, key);
  }

  /** 确保工作区目录存在（幂等），返回其路径 */
  async ensureRunDir(key: string): Promise<string> {
    const dir = this.runDir(key);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * 注册一个文件记录。
   * 幂等：同一 session + relativePath + size 已存在时，返回已存在的记录
   * （避免多轮对话中重复上报未变化的旧文件）。
   */
  createFile(rec: {
    runId: string;
    sessionId?: string;
    name: string;
    relativePath: string;
    size: number;
  }): FileRecord {
    const rel = toPosix(rec.relativePath);
    // 查重
    for (const existing of this.records.values()) {
      if (
        existing.runId === rec.runId &&
        existing.relativePath === rel &&
        existing.size === rec.size
      ) {
        return existing;
      }
    }
    const record: FileRecord = {
      fileId: crypto.randomUUID(),
      runId: rec.runId,
      sessionId: rec.sessionId,
      name: rec.name,
      relativePath: rel,
      size: rec.size,
      createdAt: Date.now(),
    };
    this.records.set(record.fileId, record);
    return record;
  }

  /** 按 fileId 查记录 */
  get(id: string): FileRecord | undefined {
    return this.records.get(id);
  }

  /** 某个 run 的全部记录 */
  listByRun(runId: string): FileRecord[] {
    return Array.from(this.records.values()).filter((r) => r.runId === runId);
  }

  /** 删除一条记录（不删磁盘文件） */
  delete(id: string): boolean {
    return this.records.delete(id);
  }

  /** 删除某个 run 的记录 + 工作区目录 */
  async deleteRun(runId: string): Promise<void> {
    for (const [id, rec] of this.records) {
      if (rec.runId === runId) this.records.delete(id);
    }
    const dir = this.runDir(runId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {}
  }

  /** 删除某个 session 的记录 + 工作区目录（级联清理） */
  async deleteSession(sessionId: string): Promise<void> {
    const runIds = new Set<string>();
    for (const [id, rec] of this.records) {
      if (rec.sessionId === sessionId) {
        runIds.add(rec.runId);
        this.records.delete(id);
      }
    }
    for (const runId of runIds) {
      try {
        await fs.rm(this.runDir(runId), { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * 清理过期数据：
   * - 超过 TTL 的记录
   * - 无记录、目录 mtime 超过 TTL 的孤儿工作区目录（覆盖被中断/未 finalize 的 run）
   */
  async deleteExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, rec] of this.records) {
      if (now - rec.createdAt > this.ttlMs) this.records.delete(id);
    }

    // 孤儿目录清理
    let entries;
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = entry.name;
      const dir = path.join(this.baseDir, key);
      // 有记录的目录交给记录 TTL；无记录的按目录 mtime
      const hasRecord = Array.from(this.records.values()).some((r) => r.runId === key);
      if (hasRecord) continue;
      try {
        const stat = await fs.stat(dir);
        if (now - stat.mtimeMs > this.ttlMs) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  /** 启动定期清理（5 分钟） */
  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.deleteExpired().catch(() => {});
    }, 5 * 60 * 1000);
  }

  /** 停止清理（优雅关闭） */
  destroy(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}
