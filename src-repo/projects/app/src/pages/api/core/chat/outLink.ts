/**
 * 外部对话 API — 无需登录即可与 AI 应用对话
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { authOutLink } from '@fastgpt/service/support/permission/auth/outLink';
import { pushChatLog } from '@fastgpt/service/core/chat/log';
import { getAppById } from '@fastgpt/service/core/app/controller';
import { ChatRoleEnum, ChatSourceEnum } from '@fastgpt/global/core/chat/constants';
import { sseResponse } from '@fastgpt/service/common/response';
import { dispatchFlow } from '@/service/core/workflow/dispatch';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { chatId, outLinkUid, messages } = req.body;

  // 1. 验证外部链接权限
  const { uid, appId } = await authOutLink({ shareId: outLinkUid, ip: req.headers['x-forwarded-for'] as string });

  // 2. 获取应用配置
  const app = await getAppById(appId);

  // 3. 构建上下文
  const context = {
    chatId,
    appId,
    uid,
    model: app.chatConfig.model,
    temperature: app.chatConfig.temperature,
    systemPrompt: app.chatConfig.systemPrompt || '',
    kbIds: app.kbIds,
  };

  // 4. SSE 流式响应
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { stream } = await dispatchFlow({
      messages,
      context,
      onToken: (token: string) => {
        res.write(`data: ${JSON.stringify({ type: 'answer', text: token })}\n\n`);
      },
    });

    await stream;

    // 5. 记录对话日志
    await pushChatLog({
      chatId,
      appId,
      uid,
      source: ChatSourceEnum.outLink,
      messages,
    });

    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`);
    res.end();
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};
