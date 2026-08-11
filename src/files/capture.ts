// ============================================================
// 文件捕获与扫描 — 纯 fs 工具
//
// 用于捕获 Claude Code 生成的 Write 工具产物，并扫描工作区
// 目录生成最终文件清单。
//
// 安全要点：
// - isPathInside: 拒绝路径穿越（../../、绝对路径指向工作区外）
// - scanRunDir: 跳过符号链接，防止逃逸
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 工作区内的一个文件 */
export interface WorkspaceFile {
  relativePath: string; // posix，相对 runDir
  absolutePath: string;
  size: number;
}

/**
 * 判断 target 是否严格位于 baseDir 内部。
 * 拒绝：target === baseDir、../ 逃逸、指向 baseDir 外的绝对路径。
 */
export function isPathInside(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !path.isAbsolute(rel)
  );
}

/**
 * 捕获一次 Write 工具调用，把内容写入 runDir 内。
 *
 * - file_path 为绝对路径：normalize 后校验必须仍在 runDir 内
 * - file_path 为相对路径：resolve(runDir, file_path) 后校验
 * - 越界路径直接拒绝（返回 false），不落盘
 * - 自动创建父目录
 */
export async function captureWriteFile(
  input: { file_path?: unknown; content?: unknown },
  runDir: string,
): Promise<boolean> {
  const filePath = input.file_path;
  const content = input.content;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (typeof content !== 'string') return false;

  // 解析目标路径
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(runDir, filePath);

  // 路径穿越守卫
  if (!isPathInside(runDir, resolved)) return false;

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归扫描 runDir，返回其中所有普通文件。
 * 跳过符号链接（防逃逸）和目录。
 */
export async function scanRunDir(runDir: string): Promise<WorkspaceFile[]> {
  const results: WorkspaceFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限 — 视为空
    }

    for (const entry of entries) {
      // 跳过符号链接，防止指向工作区外
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        results.push({
          absolutePath: abs,
          relativePath: toPosix(path.relative(runDir, abs)),
          size: stat.size,
        });
      }
    }
  }

  await walk(runDir);
  return results;
}

/** 把 Windows 反斜杠路径转为 posix（用于相对路径存储/下载 URL） */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
