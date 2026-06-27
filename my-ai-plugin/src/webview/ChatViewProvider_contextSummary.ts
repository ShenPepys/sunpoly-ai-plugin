/**
 * 上下文历史摘要模块
 *
 * 当聊天历史超出上下文窗口时，将被裁剪的早期消息通过 API 压缩为一段简短摘要，
 * 作为历史第一条消息注入，避免模型完全丢失早期上下文。
 *
 * 方案 A：固定长度摘要（~300 字），摘要作为历史首条 system 消息。
 * 摘要结果按指纹缓存，同一轮对话中的 follow-up 请求不会重复摘要。
 */
import { sendChatRequest } from '../api/client';
import type { ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { info } from '../logger';

/** 摘要缓存：fingerprint → summaryText */
const summaryCache = new Map<string, string>();

/** 清除摘要缓存（供测试或会话清理时调用） */
export function clearSummaryCache(): void {
  summaryCache.clear();
}

/**
 * 为被丢弃的消息集合生成指纹，用于缓存摘要。
 * 指纹基于：消息数量 + 首条消息内容前 100 字符 + 末条消息内容前 100 字符
 */
function fingerprintDroppedMessages(messages: ChatMessageParam[]): string {
  if (messages.length === 0) {
    return '';
  }

  const firstContent = typeof messages[0].content === 'string'
    ? messages[0].content.slice(0, 100)
    : '';
  const lastContent = typeof messages[messages.length - 1].content === 'string'
    ? messages[messages.length - 1].content.slice(0, 100)
    : '';

  return `${messages.length}|${messages[0].role}|${firstContent}|${messages[messages.length - 1].role}|${lastContent}`;
}

/** 摘要 prompt */
const SUMMARIZE_SYSTEM_PROMPT = '你是一个对话摘要助手。请用简洁的中文概括以下对话的关键信息，包括：讨论的主题、达成的结论、完成的操作、重要的上下文。摘要不超过 300 字。只输出摘要内容，不要添加前缀或解释。';

/**
 * 对被裁剪的早期消息生成固定长度摘要。
 * 结果按指纹缓存，相同丢弃消息集不会重复调用 API。
 *
 * @param droppedMessages 被裁剪掉的历史消息
 * @param apiConfig API 配置（apiKey、baseUrl、modelId 等）
 * @returns 摘要文本，如果 API 调用失败则返回降级纯文本摘要
 */
export async function summarizeDroppedMessages(
  droppedMessages: ChatMessageParam[],
  apiConfig: ApiClientConfig,
): Promise<string> {
  if (droppedMessages.length === 0) {
    return '';
  }

  const fingerprint = fingerprintDroppedMessages(droppedMessages);
  const cached = summaryCache.get(fingerprint);
  if (cached) {
    info(`上下文摘要命中缓存（${droppedMessages.length} 条消息）`);
    return cached;
  }

  // 将丢弃的消息压缩为文本（限制总长度，避免摘要请求本身超限）
  const MAX_SUMMARIZE_INPUT_CHARS = 8000;
  const contentParts: string[] = [];
  let totalChars = 0;

  for (const msg of droppedMessages) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) {
      continue;
    }
    const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
    const line = `[${msg.role}]: ${truncated}`;
    if (totalChars + line.length > MAX_SUMMARIZE_INPUT_CHARS) {
      contentParts.push(`...(剩余 ${droppedMessages.length - contentParts.length} 条消息已省略)`);
      break;
    }
    contentParts.push(line);
    totalChars += line.length;
  }

  const messages: ChatMessageParam[] = [
    { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
    { role: 'user', content: contentParts.join('\n\n') },
  ];

  try {
    const summaryConfig: ApiClientConfig = {
      ...apiConfig,
      maxTokens: 500,
      temperature: 0.3,
    };

    info(`正在为 ${droppedMessages.length} 条早期消息生成上下文摘要...`);
    const summary = await sendChatRequest(summaryConfig, messages);

    summaryCache.set(fingerprint, summary);
    info(`上下文摘要已生成（${summary.length} 字符）`);
    return summary;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    info(`上下文摘要 API 调用失败，使用降级纯文本摘要: ${errMsg}`);

    // 降级：不做 AI 摘要，只保留基本信息
    const fallbackSummary = `[系统提示：之前有 ${droppedMessages.length} 条对话消息因上下文窗口限制被裁剪，摘要生成失败。请根据后续对话内容推断上下文。]`;
    summaryCache.set(fingerprint, fallbackSummary);
    return fallbackSummary;
  }
}
