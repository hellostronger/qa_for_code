// ============================================================
// 二进制查找 — 四级查找 Claude Code 可执行文件
// ============================================================

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * 四级查找策略：
 *   1. CLAUDE_BIN 环境变量
 *   2. PATH 查找 (where.exe / which)
 *   3. 知名工具链目录
 *   4. 备选名 openclaude
 *
 * 若全部失败则抛出错误。
 */
export async function findClaudeBinary(): Promise<string> {
  // 1. 环境变量
  if (process.env.CLAUDE_BIN) {
    const p = process.env.CLAUDE_BIN;
    if (existsSync(p)) return p;
  }

  // 2. PATH 查找
  const fromPath = await whichCmd('claude');
  if (fromPath) return fromPath;

  // 3. 知名目录
  const wellKnown = getWellKnownDirs();
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of wellKnown) {
    const p = path.join(dir, binName);
    if (existsSync(p)) return p;
  }

  // 4. 备选名
  const openClaude = await whichCmd('openclaude');
  if (openClaude) return openClaude;

  throw new Error(
    'Claude Code CLI 未找到。请安装：\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      '或设置 CLAUDE_BIN 环境变量指向 claude 可执行文件。'
  );
}

/** 查找 Git Bash 路径（Windows 上 Claude Code 需要） */
export function findGitBash(): string {
  if (process.platform !== 'win32') return '';

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'scoop\\apps\\git\\current\\bin\\bash.exe'),
    path.join(os.homedir(), 'scoop\\apps\\git-with-openssh\\current\\bin\\bash.exe'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // 尝试从 PATH 中找 git.exe，向上推 bash.exe
  try {
    const gitExe = process.env['GIT_BASH_PATH'] || '';
    if (gitExe && existsSync(gitExe)) return gitExe;
  } catch {}

  return '';
}

// ---------- 内部工具函数 ----------

/** 模拟 which/where 查找可执行文件 */
function whichCmd(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `where.exe ${name}`
      : `which ${name}`;
    execFile(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [name],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const lines = stdout.trim().split('\n');
        // 取第一个匹配
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && existsSync(trimmed)) {
            // 优先 .exe，其次 .cmd/.bat
            if (process.platform === 'win32') {
              const exe = trimmed.replace(/\.(cmd|bat)$/i, '.exe');
              if (existsSync(exe)) {
                resolve(exe);
                return;
              }
            }
            resolve(trimmed);
            return;
          }
        }
        resolve(null);
      }
    );
  });
}

/** 返回知名工具链安装目录列表 */
function getWellKnownDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  // 通用
  dirs.push(path.join(home, '.molio', 'bin'));
  dirs.push(path.join(home, '.local', 'bin'));

  if (process.platform === 'win32') {
    dirs.push(
      path.join(home, 'AppData', 'Local', 'pnpm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'AppData', 'Local', 'Volta', 'bin'),
    );
    // nvm4w
    const nvmHome = process.env['NVM_HOME'];
    const nvmSymlink = process.env['NVM_SYMLINK'];
    if (nvmHome) dirs.push(nvmHome);
    if (nvmSymlink) dirs.push(nvmSymlink);
    dirs.push('C:\\nvm4w\\nodejs');
    // WinGet
    const wingetDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    try {
      const { readdirSync } = require('node:fs');
      if (existsSync(wingetDir)) {
        for (const d of readdirSync(wingetDir)) {
          dirs.push(path.join(wingetDir, d));
        }
      }
    } catch {}
  } else {
    dirs.push(
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.cargo', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    );
  }

  return dirs;
}
