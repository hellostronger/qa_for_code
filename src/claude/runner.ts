// ============================================================
// Claude Runner — 核心 spawn 逻辑
//
// spawn claude 子进程，cwd 指向源码目录，stdin 写 prompt，
// stdout 解析为 StreamEvent，通过回调推送。
//
// 参考 Molio apps/daemon/src/core/RunManager.ts createRun()
//
// 日志约定：所有 runner 日志带 [runner] 前缀，并尽量带上
// 调用方传入的 label（runId 前 8 位），便于按请求关联日志。
// 原生 stdout/stderr 会进入环形缓冲，超时/异常退出时 dump，
// 用于定位"挂起"发生在哪一步。
// ============================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { createClaudeParser } from './parser.js';
import { buildSystemPrompt } from './prompt.js';
import { findClaudeBinary, findGitBash } from './launch.js';
import type { StreamEvent, AppConfig, ChatMessage } from '../types.js';

// ========== 类型 ==========

export interface RunOptions {
  messages: ChatMessage[]; // OpenAI 规范：完整对话（含当前问题）
  cwd: string;
  config: AppConfig;
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
  model?: string; // 可选：覆盖 config.model（如 OpenAI 请求体中的 model 字段）
  outputDir?: string; // 可选：生成文件的工作区目录（注入 OUTPUT_DIR env）
  label?: string; // 可选：日志前缀（传 runId 便于按请求关联）
}

export interface RunResult {
  exitCode: number;
  /** 进程是被服务端主动终止的（超时或取消），而非自然退出 */
  killed?: boolean;
  /** 主动终止的原因（killed 为 true 时才有意义） */
  killReason?: 'timeout' | 'abort';
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
  const { messages, cwd, config, onEvent, signal, model, outputDir, label } = options;

  // ── 并发检查 ──
  if (activeRuns >= config.maxConcurrentRuns) {
    console.log(`[runner] 并发上限 (${config.maxConcurrentRuns})，拒绝新 run`);
    throw new ConcurrentLimitError(config.maxConcurrentRuns);
  }
  activeRuns++;

  const tag = `[runner${label ? ':' + label.slice(0, 8) : ''}]`;
  const log = (...args: unknown[]) => console.log(tag, ...args);
  const warn = (...args: unknown[]) => console.warn(tag, ...args);

  const startedAt = Date.now();

  let child: ChildProcess | null = null;
  let cleaned = false;
  let killedBy: 'timeout' | 'abort' | null = null;

  // 原生 stdout/stderr 环形缓冲：定位挂起时看最后输出到哪一行
  const stdoutTail: string[] = [];
  const stderrTail: string[] = [];
  const MAX_TAIL = 30;
  const MAX_LINE = 600;

  const pushTail = (tail: string[], text: string) => {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const short = trimmed.length > MAX_LINE ? trimmed.slice(0, MAX_LINE) + '…' : trimmed;
      tail.push(short);
      if (tail.length > MAX_TAIL) tail.shift();
    }
  };

  const dumpTails = (reason: string) => {
    warn(`claude 输出 dump (${reason}):`);
    warn(`  --- stdout tail (${stdoutTail.length}) ---`);
    if (stdoutTail.length === 0) warn('  (none)');
    for (const line of stdoutTail) warn('  >', line);
    warn(`  --- stderr tail (${stderrTail.length}) ---`);
    if (stderrTail.length === 0) warn('  (none)');
    for (const line of stderrTail) warn('  !', line);
  };

  // 心跳：长时间运行时周期报告进度 + 最后一条 stdout，方便判断是否卡住
  const heartbeat = setInterval(() => {
    const last = stdoutTail[stdoutTail.length - 1];
    log(
      `still running after ${((Date.now() - startedAt) / 1000).toFixed(0)}s, ` +
        `last stdout: ${last ? last.slice(0, 160) : '(none)'}`,
    );
  }, 30000);
  heartbeat.unref();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeRuns--;
  };

  try {
    // ── 1. 查找 claude 二进制 ──
    const binary = config.claudeBinary || (await findClaudeBinary());
    log('resolved binary:', binary);

    // ── 2. 构建 CLI 参数 ──
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    const effectiveModel = model || config.model;
    if (effectiveModel && effectiveModel !== 'default') {
      args.push('--model', effectiveModel);
    }
    if (!effectiveModel || effectiveModel === 'default') {
      warn(
        '未指定模型，将使用 Claude Code 默认模型。若请求挂起直至超时，' +
          '多半是默认模型在当前网关/API 配置下不可用——请设置 CLAUDE_MODEL 或在请求体传 model 字段。',
      );
    }

    // ── 3. 构建环境变量 ──
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    // Windows: 自动检测 Git Bash 路径
    if (process.platform === 'win32' && !env['CLAUDE_CODE_GIT_BASH_PATH']) {
      const gitBash = findGitBash();
      if (gitBash) env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
    }
    // 生成文件的工作区目录（claude 子进程可见）
    if (outputDir) env['OUTPUT_DIR'] = outputDir;

    // ── 4. spawn ──
    const isCmd = binary.endsWith('.cmd') || binary.endsWith('.bat');
    child = spawn(binary, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isCmd || undefined,
      windowsVerbatimArguments: process.platform === 'win32' && !isCmd,
    });

    log(`spawn pid=${child.pid} binary=${binary} cwd=${cwd}`);
    log(`  args: ${args.join(' ')}`);
    log(
      '  env: ' +
        `CLAUDE_MODEL=${effectiveModel ?? '(unset)'} ` +
        `OUTPUT_DIR=${outputDir ?? '(unset)'} ` +
        `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? '(unset)'} ` +
        `ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset'} ` +
        `ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL ?? '(unset)'} ` +
        `ANTHROPIC_DEFAULT_SONNET_MODEL=${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '(unset)'}`,
    );

    // ── 5. 超时 ──
    const timer = setTimeout(() => {
      if (child && !child.killed) {
        killedBy = 'timeout';
        warn(`运行超时 (${config.runTimeoutMs}ms)，终止 claude (SIGTERM)`);
        dumpTails('timeout');
        child.kill('SIGTERM');
        // 注意: child.killed 在 kill() 调用后立即为 true，不代表进程已退出。
        // 用 exitCode === null（进程仍在运行）判断是否需要 SIGKILL 兜底。
        setTimeout(() => {
          if (child && child.exitCode === null) child.kill('SIGKILL');
        }, 5000);
      }
    }, config.runTimeoutMs);

    // ── 6. 取消信号 ──
    if (signal) {
      if (signal.aborted) {
        killedBy = 'abort';
        child.kill('SIGTERM');
      } else {
        signal.addEventListener('abort', () => {
          if (child && !child.killed) {
            killedBy = 'abort';
            warn('收到取消信号，终止 claude (SIGTERM)');
            dumpTails('abort');
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child && child.exitCode === null) child.kill('SIGKILL');
            }, 5000);
          }
        }, { once: true });
      }
    }

    // ── 7. 流解析器 ──
    const parser = createClaudeParser((event) => {
      onEvent(event);
    }, {
      // 非 JSON 的诊断输出是重要的排错线索，记录下来
      onNonJsonLine: (line) => log('stdout(non-json):', line.slice(0, 400)),
    });

    // ── 8. stdout ──
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pushTail(stdoutTail, chunk);
      parser.feed(chunk);
    });

    // ── 9. stderr — 转发为 error 事件 ──
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      pushTail(stderrTail, text);
      const trimmed = text.trim();
      if (trimmed && !isDiagnosticNoise(trimmed)) {
        onEvent({ type: 'error', message: trimmed.slice(0, 1000) });
      }
    });

    // ── 10. 构建并写入 prompt ──
    const systemPrompt = buildSystemPrompt(outputDir);
    const stdinPayload = buildStdinPayload(messages, systemPrompt);
    log(`stdin payload (${stdinPayload.length} bytes):`);
    log(stdinPayload.length > 1200 ? stdinPayload.slice(0, 1200) + '\n…(truncated)' : stdinPayload);
    child.stdin?.write(stdinPayload);
    // 写完立即关闭 stdin — claude 靠 stdin EOF 感知输入结束才会退出，
    // 否则进程挂起，close 事件永不触发（runClaude 永不 resolve）。
    // 当前版本每次 run 一条消息，无需保持 stdin 打开。
    child.stdin?.end();

    // ── 11. stdin 错误处理 ──
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      onEvent({ type: 'error', message: `stdin write error: ${err.message}` });
    });

    // ── 12. 等待进程结束 ──
    return new Promise<RunResult>((resolve) => {
      child!.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        parser.flush();
        cleanup();
        const durationMs = Date.now() - startedAt;
        log(`finished exitCode=${code ?? 1} durationMs=${durationMs} killedBy=${killedBy ?? '-'}`);
        if (killedBy || (code ?? 1) !== 0) {
          dumpTails(`exit=${code ?? 1}${killedBy ? ` killedBy=${killedBy}` : ''}`);
        }
        resolve({
          exitCode: code ?? 1,
          ...(killedBy ? { killed: true, killReason: killedBy } : {}),
        });
      });

      child!.on('error', (err) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        warn('child process error:', err.message);
        onEvent({ type: 'error', message: `进程错误: ${err.message}` });
        cleanup();
        resolve({ exitCode: 1 });
      });
    });
  } catch (err) {
    clearInterval(heartbeat);
    cleanup();
    if (child && !child.killed) {
      warn('runClaude 在进程结束前抛错，终止 claude:', err instanceof Error ? err.message : err);
      dumpTails('setup-error');
      child.kill('SIGTERM');
    }
    throw err;
  }
}

// ========== 错误描述 ==========

/**
 * 把 run 结果转成用户可见的错误描述。
 * 区分三种情况：超时被终止 / 被取消 / 异常退出。
 */
export function runFailureMessage(result: RunResult, runTimeoutMs: number): string {
  if (result.killReason === 'timeout') {
    return `Claude Code 运行超时 (超过 ${Math.round(runTimeoutMs / 1000)} 秒)`;
  }
  if (result.killReason === 'abort') {
    return 'Claude Code 已被取消';
  }
  return `Claude Code 异常退出 (exit code: ${result.exitCode})`;
}

// ========== 错误类型 ==========

export class ConcurrentLimitError extends Error {
  constructor(limit: number) {
    super(`并发请求已达上限 (${limit})，请稍后重试`);
    this.name = 'ConcurrentLimitError';
  }
}

// ========== 工具函数 ==========

/** 单条历史消息的最大长度（避免 token 浪费） */
const MAX_HISTORY_LEN = 4000;

/**
 * 构造写入 claude stdin 的 stream-json payload。
 *
 * 多轮遵循 OpenAI 规范：messages 数组承载完整对话，逐条输出为
 * stream-json 的 user/assistant 消息。系统提示词注入最后一条
 * user 消息（当前问题），与旧版单轮行为保持一致。
 */
export function buildStdinPayload(
  messages: ChatMessage[],
  systemPrompt: string,
): string {
  const lines: string[] = [];
  messages.forEach((msg, i) => {
    const isLast = i === messages.length - 1;
    // 系统提示词随最后一条 user 消息注入（保持现状行为）
    const content = isLast
      ? `${systemPrompt}\n\n<question>\n${msg.content}\n</question>`
      : truncate(msg.content);
    lines.push(JSON.stringify({
      type: msg.role === 'assistant' ? 'assistant' : 'user',
      message: { role: msg.role, content },
    }));
  });
  return lines.join('\n') + '\n';
}

/** 截断过长的历史消息 */
function truncate(content: string): string {
  return content.length > MAX_HISTORY_LEN
    ? content.slice(0, MAX_HISTORY_LEN) + '...'
    : content;
}

/** Claude Code 输出的一些诊断噪音不应作为错误事件发送 */
function isDiagnosticNoise(text: string): boolean {
  const noisePatterns = [
    /^\[.*\]\s*$/,                // [timestamp]
    /Application invoked/,         // Codex leftover
    /^$/,
  ];
  return noisePatterns.some((p) => p.test(text));
}
