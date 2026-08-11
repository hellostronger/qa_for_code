// ============================================================
// 配置加载 — 从环境变量读取所有配置
// ============================================================

import path from 'node:path';
import type { AppConfig } from './types.js';

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3100', 10),
    sourceRepoPath: process.env.SOURCE_REPO_PATH || path.resolve('src-repo'),
    workspaceDir: process.env.WORKSPACE_DIR || path.resolve('workspace'),
    model: process.env.CLAUDE_MODEL || undefined,
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '1800000', 10),
    runTimeoutMs: parseInt(process.env.RUN_TIMEOUT_MS || '300000', 10),
    maxConcurrentRuns: parseInt(process.env.MAX_CONCURRENT || '3', 10),
    claudeBinary: process.env.CLAUDE_BIN || undefined,
  };
}
