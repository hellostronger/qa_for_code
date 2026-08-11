// ============================================================
// RunFileTracker — 一次 claude run 的生成文件追踪
//
// ask.ts 与 openai.ts 复用：
// - handleEvent: 内联捕获 Write tool_use（先把内容落盘，保证即使
//   Claude 自己的磁盘写入失败，文件也存在）
// - finalize: 等待挂起写入完成 → 扫描目录（磁盘为唯一事实源，
//   覆盖 Edit/MultiEdit/Bash 产物的最终态）→ 注册 FileRecord
// ============================================================

import type { FileRecord, StreamEvent } from '../types.js';
import type { FileStore } from './store.js';
import { captureWriteFile, scanRunDir } from './capture.js';

export interface RunFileTracker {
  handleEvent(event: StreamEvent): void;
  finalize(): Promise<FileRecord[]>;
}

export function createRunFileTracker(
  store: FileStore,
  runKey: string, // 工作区 key（sessionId 或 runId）
  sessionId?: string,
): RunFileTracker {
  const pendingWrites: Promise<boolean>[] = [];

  return {
    handleEvent(event: StreamEvent): void {
      if (event.type !== 'tool_use' || event.name !== 'Write') return;
      const input = event.input as { file_path?: unknown; content?: unknown } | undefined;
      if (!input) return;
      // 触发捕获（异步落盘，结果在 finalize 里 await）
      pendingWrites.push(captureWriteFile(input, store.runDir(runKey)));
    },

    async finalize(): Promise<FileRecord[]> {
      // 1. 等待所有内联捕获完成，保证落盘
      await Promise.all(pendingWrites);
      pendingWrites.length = 0;

      // 2. 扫描目录（磁盘为唯一事实源）
      const files = await scanRunDir(store.runDir(runKey));

      // 3. 注册记录（createFile 幂等去重）
      return files.map((f) =>
        store.createFile({
          runId: runKey,
          sessionId,
          name: basename(f.relativePath),
          relativePath: f.relativePath,
          size: f.size,
        })
      );
    },
  };
}

/** 从相对路径取文件名（用于下载的 Content-Disposition） */
function basename(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx >= 0 ? relativePath.slice(idx + 1) : relativePath;
}
