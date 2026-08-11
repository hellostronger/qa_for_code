// ============================================================
// 公开 URL 构造 — 让文件链接带上完整前缀（协议 + host）
// ============================================================

import type { Context } from 'hono';

/**
 * 根据请求方视角构造公开 Base URL。
 * 优先用反向代理头（X-Forwarded-Proto/Host，nginx/TLS 场景），
 * 否则用请求自身的 Host 头。
 *
 * 效果：客户端用什么地址调 API，文件链接就是什么地址——
 *   本地 curl → http://localhost:3100
 *   公网 IP  → http://101.43.25.101:3100
 *   域名+HTTPS 反代 → https://your.domain
 */
export function getPublicBaseUrl(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || '';
  return `${proto}://${host}`;
}
