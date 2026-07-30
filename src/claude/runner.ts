// ============================================================
// Claude Runner — 核心 spawn 逻辑
//
// spawn claude 子进程，cwd 指向源码目录，stdin 写 prompt，
// stdout 解析为 StreamEvent，通过回调推送。
//
// 参考 Molio apps/daemon/src/core/RunManager.ts createRun()
// ============================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { createClaudeParser } from './parser.js';
import { buildSystemPrompt } from './prompt.js';
import { findClaudeBinary, findGitBash } from './launch.js';
import type { StreamEvent, AppConfig } from '../types.js';

// ========== 类型 ==========

export interface RunOptions {
  question: string;
  cwd: string;
  config: AppConfig;
  history?: { role: string; content: string }[];
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
}

// ========== 并发控制 ==========

let activeRuns = 0;

export function getActiveRuns(): number {
  return activeRuns;
}

// ========== 核心函数 ==========

/**
 * 启动一次 Claude Code 运行。
 *
 * 流程：
 *   1. 查找 claude 二进制
 *   2. 构建 CLI 参数
 *   3. spawn 子进程（cwd = 源码目录）
 *   4. 写 prompt 到 stdin
 *   5. 解析 stdout stream-json → StreamEvent
 *   6. 等待进程结束
 *
 * stdin 保持打开（stream-json 模式），当前版本一次 run 只处理一个问题。
 * 后续可扩展为 sendMessage() 重用同一个进程。
 */
export async function runClaude(options: RunOptions): Promise<RunResult> {
  const { question, cwd, config, history, onEvent, signal } = options;

  // ── 并发检查 ──
  if (activeRuns >= config.maxConcurrentRuns) {
    throw new ConcurrentLimitError(config.maxConcurrentRuns);
  }
  activeRuns++;

  let child: ChildProcess | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeRuns--;
  };

  try {
    // ── 1. 查找 claude 二进制 ──
    const binary = config.claudeBinary || (await findClaudeBinary());
    console.log('[runner] Resolved binary:', binary);

    // ── 2. 构建 CLI 参数 ──
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (config.model && config.model !== 'default') {
      args.push('--model', config.model);
    }

    // ── 3. 构建环境变量 ──
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    // Windows: 自动检测 Git Bash 路径
    if (process.platform === 'win32' && !env['CLAUDE_CODE_GIT_BASH_PATH']) {
      const gitBash = findGitBash();
      if (gitBash) env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
    }

    // ── 4. spawn ──
    const isCmd = binary.endsWith('.cmd') || binary.endsWith('.bat');
    child = spawn(binary, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isCmd || undefined,
      windowsVerbatimArguments: process.platform === 'win32' && !isCmd,
    });

    // ── 5. 超时 ──
    const timer = setTimeout(() => {
      if (child && !child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child && !child.killed) child.kill('SIGKILL');
        }, 5000);
      }
    }, config.runTimeoutMs);

    // ── 6. 取消信号 ──
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
      } else {
        signal.addEventListener('abort', () => {
          if (child && !child.killed) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child && !child.killed) child.kill('SIGKILL');
            }, 5000);
          }
        }, { once: true });
      }
    }

    // ── 7. 流解析器 ──
    const parser = createClaudeParser((event) => {
      onEvent(event);
    });

    // ── 8. stdout ──
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      parser.feed(chunk);
    });

    // ── 9. stderr — 转发为 error 事件 ──
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text && !isDiagnosticNoise(text)) {
        onEvent({ type: 'error', message: text });
      }
    });

    // ── 10. 构建并写入 prompt ──
    const systemPrompt = buildSystemPrompt();
    const stdinPayload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: `${systemPrompt}\n\n<question>\n${question}\n</question>`,
      },
    });
    child.stdin?.write(stdinPayload + '\n');
    // stdin 保持打开以支持后续 sendMessage（当前版本不需要）

    // ── 11. stdin 错误处理 ──
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      onEvent({ type: 'error', message: `stdin write error: ${err.message}` });
    });

    // ── 12. 等待进程结束 ──
    return new Promise<RunResult>((resolve) => {
      child!.on('close', (code) => {
        clearTimeout(timer);
        parser.flush();
        cleanup();
        resolve({ exitCode: code ?? 1 });
      });

      child!.on('error', (err) => {
        clearTimeout(timer);
        onEvent({ type: 'error', message: `进程错误: ${err.message}` });
        cleanup();
        resolve({ exitCode: 1 });
      });
    });
  } catch (err) {
    cleanup();
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    throw err;
  }
}

// ========== 错误类型 ==========

export class ConcurrentLimitError extends Error {
  constructor(limit: number) {
    super(`并发请求已达上限 (${limit})，请稍后重试`);
    this.name = 'ConcurrentLimitError';
  }
}

// ========== 工具函数 ==========

/** Claude Code 输出的一些诊断噪音不应作为错误事件发送 */
function isDiagnosticNoise(text: string): boolean {
  const noisePatterns = [
    /^\[.*\]\s*$/,                // [timestamp]
    /Application invoked/,         // Codex leftover
    /^$/,
  ];
  return noisePatterns.some((p) => p.test(text));
}
