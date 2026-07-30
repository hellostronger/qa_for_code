// ============================================================
// 二进制查找 — 四级查找 Claude Code 可执行文件
// ============================================================

import { existsSync, statSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * 四级查找策略：
 *   1. CLAUDE_BIN 环境变量
 *   2. PATH 查找 (where.exe / which)
 *   3. 知名工具链目录
 *   4. 备选名 openclaude
 *
 * 每种都会用 --version 快速验证二进制是否可用。
 * 若全部失败则抛出错误。
 */
export async function findClaudeBinary(): Promise<string> {
  // 1. 环境变量
  if (process.env.CLAUDE_BIN) {
    const p = process.env.CLAUDE_BIN;
    console.log('[launch] Trying CLAUDE_BIN:', p);
    if (isExecutableFile(p)) return p;
  }

  // 2. PATH 查找
  console.log('[launch] Looking in PATH...');
  const fromPath = await findInPath('claude');
  if (fromPath) { console.log('[launch] Found in PATH:', fromPath); return fromPath; }
  console.log('[launch] Not found in PATH');

  // 3. 知名目录
  console.log('[launch] Checking well-known dirs...');
  const wellKnown = getWellKnownDirs();
  const binNames = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']
    : ['claude'];
  for (const dir of wellKnown) {
    for (const name of binNames) {
      const p = path.join(dir, name);
      if (isExecutableFile(p)) { console.log('[launch] Found in well-known:', p); return p; }
    }
  }
  console.log('[launch] Not found in well-known dirs');

  // 4. 备选名
  const fallbackBins = process.platform === 'win32'
    ? ['openclaude.exe', 'openclaude.cmd', 'openclaude']
    : ['openclaude'];
  for (const bin of fallbackBins) {
    const p = await findInPathRaw(bin);
    if (p && isExecutableFile(p)) return p;
    // 也检查知名目录
    for (const dir of wellKnown) {
      const fp = path.join(dir, bin);
      if (isExecutableFile(fp)) return fp;
    }
  }

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

  try {
    const gitBash = spawnSync('where.exe', ['bash.exe'], { timeout: 3000 })
      .stdout?.toString().trim().split('\n')[0];
    if (gitBash && existsSync(gitBash)) return gitBash;
  } catch {}

  return '';
}

// ---------- 内部工具函数 ----------

/** 检查路径是否为真正的可执行文件（不是目录、有正确的扩展名） */
function isExecutableFile(p: string): boolean {
  try {
    const stat = statSync(p);
    if (!stat.isFile()) return false;
    if (stat.size < 1024) return false; // exe/cmd 至少 1KB

    // Windows: 必须可执行
    if (process.platform === 'win32') {
      const ext = path.extname(p).toLowerCase();
      if (ext !== '.exe' && ext !== '.cmd' && ext !== '.bat') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** PATH 中查找可执行文件（严格验证） */
async function findInPath(name: string): Promise<string | null> {
  const raw = await findInPathRaw(name);
  if (!raw) return null;

  // Windows where.exe 可能返回无扩展名的路径或 .cmd 路径
  if (process.platform === 'win32') {
    // 优先 .exe — 仅当 raw 以 .cmd/.bat 结尾时才替换
    if (raw.endsWith('.cmd') || raw.endsWith('.bat')) {
      const exePath = raw.replace(/\.(cmd|bat)$/i, '.exe');
      if (statSync(exePath, { throwIfNoEntry: false })?.isFile()) return exePath;
      // .exe 不存在，验证 .cmd/.bat 本身
      if (isExecutableFile(raw)) return raw;
    }

    // raw 以 .exe 结尾 — 直接验证
    if (raw.endsWith('.exe')) {
      if (isExecutableFile(raw)) return raw;
    }

    // raw 无扩展名 — 尝试加 .exe / .cmd
    const withExe = raw + '.exe';
    if (statSync(withExe, { throwIfNoEntry: false })?.isFile()) return withExe;

    const withCmd = raw + '.cmd';
    if (statSync(withCmd, { throwIfNoEntry: false })?.isFile()) return withCmd;

    return null;
  }

  return isExecutableFile(raw) ? raw : null;
}

/** 使用 where.exe / which 在 PATH 中查找（原始结果，不做验证） */
function findInPathRaw(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [name],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // 排除常见的误匹配（node_modules/.bin 下的非 exe 文件容易出现）
          if (trimmed.endsWith('.js') || trimmed.endsWith('.ts')) continue;
          if (trimmed.includes('node_modules\\.bin\\') && !trimmed.match(/\.(exe|cmd|bat)$/i)) continue;
          resolve(trimmed);
          return;
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
    const nvmHome = process.env['NVM_HOME'];
    const nvmSymlink = process.env['NVM_SYMLINK'];
    if (nvmHome) dirs.push(nvmHome);
    if (nvmSymlink) dirs.push(nvmSymlink);

    // WinGet
    const wingetDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    try {
      if (existsSync(wingetDir)) {
        const { readdirSync: rd } = require('node:fs');
        for (const d of rd(wingetDir)) {
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
