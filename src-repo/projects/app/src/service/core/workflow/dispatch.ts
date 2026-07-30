/**
 * 工作流调度引擎 — 插件图执行器
 */
import { PluginRuntime, PluginNode, PluginEdge } from '@fastgpt/plugins/runtime';

export interface WorkflowContext {
  chatId: string;
  appId: string;
  uid: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  kbIds: string[];
}

interface DispatchOptions {
  messages: Array<{ role: string; content: string }>;
  context: WorkflowContext;
  onToken: (token: string) => void;
}

export async function dispatchFlow(options: DispatchOptions) {
  const { messages, context, onToken } = options;

  // 获取应用的工作流配置
  const runtime = new PluginRuntime();

  // 注册内置插件节点
  runtime.registerNode('llm-chat', {
    async execute(inputs, ctx) {
      const { model, temperature, systemPrompt } = ctx;
      const lastMessage = inputs.messages[inputs.messages.length - 1];
      // 调用 LLM ...（实际调用 Anthropic/OpenAI API）
      return { response: `Answer based on: model=${model}, temp=${temperature}` };
    },
  });

  runtime.registerNode('kb-search', {
    async execute(inputs, ctx) {
      const { kbIds, query } = inputs;
      // 搜索知识库 ...（实际调用向量数据库）
      return { chunks: [] };
    },
  });

  runtime.registerNode('history-context', {
    async execute(inputs) {
      // 提取对话历史上下文
      const recentMessages = inputs.messages.slice(-10);
      return { history: recentMessages };
    },
  });

  // 执行工作流图
  const result = await runtime.execute({
    nodes: [] as PluginNode[],
    edges: [] as PluginEdge[],
    inputs: { messages, ...context },
    onToken,
  });

  return result;
}
