// ============================================================
// 类型定义 — 所有模块共享的核心类型
// ============================================================

// ========== HTTP 请求/响应 ==========

/** OpenAI 规范的对话消息 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** POST /api/ask 请求体 */
export interface AskRequest {
  messages?: ChatMessage[]; // OpenAI 规范：完整对话（含当前问题，最后一条为 user）
  question?: string; // 旧字段，缺 messages 时作为单轮兜底
  sessionId?: string; // 不传则创建新会话
  model?: string; // 覆盖默认模型
}

/** POST /api/ask 响应 */
export interface AskResponse {
  runId: string;
  sessionId: string;
}

// ========== 流事件（从 Claude stream-json 解析得到） ==========

/** Claude Code stdout 解析后发出的所有事件 */
export type StreamEvent =
  | { type: 'status'; label: 'running' | 'thinking' | 'completed' | 'failed' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'error'; message: string }
  | { type: 'file'; fileId: string; name: string; url: string; size: number };

// ========== 生成文件 ==========

/** 推送给客户端/返回给 OpenAI 客户端的文件信息 */
export interface FileInfo {
  fileId: string;
  name: string;
  url: string;
  size: number;
}

/** 文件存储中的一条记录 */
export interface FileRecord {
  fileId: string;
  runId: string; // 工作区 key（sessionId 或 runId）
  sessionId?: string;
  name: string;
  relativePath: string; // posix，相对 runDir
  size: number;
  createdAt: number;
}

// ========== SSE 传输封装 ==========

/** 通过 SSE 推送到客户端的每一帧 */
export interface SSEEnvelope {
  seq: number;
  runId: string;
  event: StreamEvent;
}

// ========== 会话 ==========

/** 一个对话会话 */
export interface Session {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

/** 会话中的一条消息 */
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  files?: FileInfo[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  timestamp: number;
}

/** 工具调用记录 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

// ========== 应用配置 ==========

/** 应用配置 */
export interface AppConfig {
  port: number;
  sourceRepoPath: string;
  workspaceDir: string;
  model?: string;
  sessionTtlMs: number;
  runTimeoutMs: number;
  maxConcurrentRuns: number;
  claudeBinary?: string;
}

// ========== Claude stream-json 原始类型 ==========

/** Claude stream-json 输出的顶层类型 */
export type ClaudeLine =
  | { type: 'system' | 'init'; model?: string }
  | { type: 'stream_event'; event: ClaudeStreamEvent }
  | { type: 'assistant'; message: ClaudeAssistantMessage }
  | { type: 'user'; message: ClaudeUserMessage }
  | { type: 'result'; subtype: string; is_error?: boolean; usage?: ClaudeUsage; error?: { message: string } };

export interface ClaudeStreamEvent {
  type: string;
  content_block?: ClaudeContentBlock;
  delta?: ClaudeDelta;
  message?: { model?: string };
}

export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  id?: string;
  name?: string;
  /** text 块的内容（assistant 消息中字段名为 text） */
  text?: string;
  /** thinking 块的内容（assistant 消息中字段名为 thinking） */
  thinking?: string;
  /** tool_use 块的参数（字段名为 input） */
  input?: unknown;
}

export interface ClaudeDelta {
  type: 'text_delta' | 'thinking_delta' | 'input_json_delta';
  text?: string;
  thinking?: string;
  partial_json?: string;
}

export interface ClaudeAssistantMessage {
  id?: string;
  model?: string;
  content: ClaudeContentBlock[];
  stop_reason?: string;
  usage?: ClaudeUsage;
}

export interface ClaudeUserMessage {
  content: ClaudeToolResult[];
}

export interface ClaudeToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}
