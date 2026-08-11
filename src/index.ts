// ============================================================
// 入口 — 启动 HTTP 服务
// ============================================================

import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './server.js';

const config = loadConfig();

console.log('╔══════════════════════════════════════════════╗');
console.log('║       Code QA Service — Claude Code Wrapper  ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');
console.log(`  Source repo: ${config.sourceRepoPath}`);
console.log(`  Model:       ${config.model || '(default)'}`);
console.log(`  Port:        ${config.port}`);
console.log(`  Concurrency: ${config.maxConcurrentRuns}`);
console.log(`  Timeout:     ${config.runTimeoutMs / 1000}s`);
console.log(`  Claude bin:  ${config.claudeBinary || '(PATH lookup)'}`);
console.log('');
console.log('  Claude env:');
console.log(`    ANTHROPIC_BASE_URL        = ${process.env.ANTHROPIC_BASE_URL || '(unset)'}`);
console.log(`    ANTHROPIC_AUTH_TOKEN      = ${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset'}`);
console.log(`    ANTHROPIC_API_KEY         = ${process.env.ANTHROPIC_API_KEY ? 'set' : 'unset'}`);
console.log(`    ANTHROPIC_MODEL           = ${process.env.ANTHROPIC_MODEL || '(unset)'}`);
console.log(`    ANTHROPIC_DEFAULT_SONNET_MODEL = ${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '(unset)'}`);
console.log(`    CLAUDE_BIN                = ${process.env.CLAUDE_BIN || '(unset)'}`);
console.log(`    CLAUDE_CODE_GIT_BASH_PATH = ${process.env.CLAUDE_CODE_GIT_BASH_PATH || '(unset)'}`);
console.log('');

const { app, sessions, files } = createApp(config);

const server = serve({
  fetch: app.fetch,
  port: config.port,
}, (info) => {
  console.log(`  ✓ Server running at http://localhost:${info.port}`);
  console.log(`  ✓ Health:     http://localhost:${info.port}/api/health`);
  console.log(`  ✓ API:        http://localhost:${info.port}/api/ask`);
  console.log('');
});

// ========== Graceful shutdown ==========

function shutdown(signal: string) {
  console.log(`\n  ⏳ Received ${signal}, shutting down...`);
  server.close();
  sessions.destroy();
  files.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
