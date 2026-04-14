import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  HistoryProcessSummary,
} from './messageTypes';
import { getAssistantDisplayContent } from './ChatViewProvider_c_displayHistory';

export type PendingRegenerateState = {
  runId: string;
  messageId: string;
  history: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  restoreContent: string;
  restoreProcessSummary?: HistoryProcessSummary;
};

export type PrepareRegenerateRequestOptions = {
  history: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  targetAssistantMessageId: string;
  isToolFeedbackMessage: (message: { role: string; content: unknown }) => boolean;
  getDisplayHistoryMessageById: (
    displayHistory: ChatSessionDisplayMessage[],
    messageId: string,
  ) => ChatSessionDisplayMessage | undefined;
  getLastAssistantDisplayHistoryMessage: (
    displayHistory: ChatSessionDisplayMessage[],
  ) => ChatSessionDisplayMessage | undefined;
  cloneDisplayHistoryMessages: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];
  cloneHistoryProcessSummary: (summary: HistoryProcessSummary) => HistoryProcessSummary;
};

export type PrepareRegenerateRequestResult =
  | {
    ok: true;
    userText: string;
    trimmedHistory: ChatSessionHistoryMessage[];
    pendingState: PendingRegenerateState;
  }
  | {
    ok: false;
    errorMessage: string;
  };

export function prepareRegenerateRequest(
  options: PrepareRegenerateRequestOptions,
): PrepareRegenerateRequestResult {
  if (!options.targetAssistantMessageId) {
    return {
      ok: false,
      errorMessage: '找不到对应的 AI 消息',
    };
  }

  let lastAssistantIndex = -1;
  for (let i = options.history.length - 1; i >= 0; i--) {
    if (options.history[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    return {
      ok: false,
      errorMessage: '没有可以重新生成的回复',
    };
  }

  let lastUserIndex = -1;
  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    const message = options.history[i];
    if (message.role === 'user' && !options.isToolFeedbackMessage(message)) {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    return {
      ok: false,
      errorMessage: '找不到对应的用户消息',
    };
  }

  const displayHistoryBackup = options.cloneDisplayHistoryMessages(options.displayHistory);
  const targetAssistantDisplay = options.getDisplayHistoryMessageById(
    displayHistoryBackup,
    options.targetAssistantMessageId,
  );
  if (!targetAssistantDisplay) {
    return {
      ok: false,
      errorMessage: '找不到对应的 AI 消息',
    };
  }

  const lastAssistantDisplay = options.getLastAssistantDisplayHistoryMessage(displayHistoryBackup);
  if (!lastAssistantDisplay || lastAssistantDisplay.messageId !== options.targetAssistantMessageId) {
    return {
      ok: false,
      errorMessage: '当前仅支持重做最后一条 AI 回复',
    };
  }

  const userContent = options.history[lastUserIndex].content;
  const userText = typeof userContent === 'string' ? userContent : '';

  return {
    ok: true,
    userText,
    trimmedHistory: options.history.slice(0, lastUserIndex + 1),
    pendingState: {
      runId: options.targetAssistantMessageId,
      messageId: options.targetAssistantMessageId,
      history: options.history.slice(),
      displayHistory: displayHistoryBackup,
      restoreContent: targetAssistantDisplay.content ?? getAssistantDisplayContent(options.history[lastAssistantIndex].content),
      restoreProcessSummary: targetAssistantDisplay.processSummary
        ? options.cloneHistoryProcessSummary(targetAssistantDisplay.processSummary)
        : undefined,
    },
  };
}
