import type { ChatMessageParam } from '../api/types';
import type { UpdateTokenCountResponse } from './messageTypes';

export type HistoryWindowSnapshot = {
  contextWindow: number;
  historyTokenBudget: number;
  retainedHistory: ChatMessageParam[];
  skippedCount: number;
};

export type ContextUsageSnapshot = {
  tokenCount: number;
  contextWindow: number;
  usagePercentage: number;
};

export type TrimmedHistoryResult = HistoryWindowSnapshot & {
  retainedCount: number;
};

function estimateTextTokenCount(text: string): number {
  return Math.max(0, Math.round(text.length / 3));
}

export function estimateMessageTokenCount(message: ChatMessageParam): number {
  if (typeof message.content === 'string') {
    return estimateTextTokenCount(message.content);
  }

  if (!Array.isArray(message.content)) {
    return 0;
  }

  let charCount = 0;
  for (const part of message.content) {
    const textPart = part as { type?: string; text?: string };
    if (textPart.type === 'text' && typeof textPart.text === 'string') {
      charCount += textPart.text.length;
    }
  }

  return Math.max(0, Math.round(charCount / 3));
}

export function estimateMessagesTokenCount(messages: ChatMessageParam[]): number {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateMessageTokenCount(message);
  }

  return totalTokens;
}

function estimateHistoryTokenCount(history: ChatMessageParam[]): number {
  return estimateMessagesTokenCount(history);
}

function getHistoryTokenBudget(contextWindow: number, maxTokens: number): number {
  const normalizedContextWindow = Math.max(contextWindow, 1);
  const responseReserveTokens = Math.min(
    maxTokens,
    Math.max(1024, Math.floor(normalizedContextWindow * 0.25)),
  );
  const systemReserveTokens = Math.min(
    2000,
    Math.max(256, Math.floor(normalizedContextWindow * 0.1)),
  );
  const rawBudget = normalizedContextWindow - responseReserveTokens - systemReserveTokens;

  return Math.min(normalizedContextWindow, Math.max(256, rawBudget));
}

export function buildHistoryWindowSnapshot(
  history: ChatMessageParam[],
  options: { contextWindow: number; maxTokens: number },
): HistoryWindowSnapshot {
  const contextWindow = Math.max(options.contextWindow, 1);
  const historyTokenBudget = getHistoryTokenBudget(contextWindow, options.maxTokens);
  let totalTokens = 0;
  let startIndex = history.length;

  for (let i = history.length - 1; i >= 0; i--) {
    totalTokens += estimateMessageTokenCount(history[i]);
    if (totalTokens > historyTokenBudget) {
      startIndex = i + 1;
      break;
    }

    startIndex = i;
  }

  return {
    contextWindow,
    historyTokenBudget,
    retainedHistory: history.slice(startIndex),
    skippedCount: startIndex,
  };
}

export function buildContextUsageSnapshot(
  history: ChatMessageParam[],
  options: { contextWindow: number; maxTokens: number },
): ContextUsageSnapshot {
  const historyWindow = buildHistoryWindowSnapshot(history, options);
  const tokenCount = estimateHistoryTokenCount(historyWindow.retainedHistory);
  const usagePercentage = Math.min(100, Math.round((tokenCount / historyWindow.contextWindow) * 100));

  return {
    tokenCount,
    contextWindow: historyWindow.contextWindow,
    usagePercentage,
  };
}

export function trimHistoryToFitContextWindow(
  history: ChatMessageParam[],
  options: { contextWindow: number; maxTokens: number },
): TrimmedHistoryResult {
  const historyWindow = buildHistoryWindowSnapshot(history, options);
  return {
    ...historyWindow,
    retainedCount: history.length - historyWindow.skippedCount,
  };
}

export function buildUpdateTokenCountResponse(contextUsage: ContextUsageSnapshot): UpdateTokenCountResponse {
  return {
    type: 'updateTokenCount',
    tokenCount: contextUsage.tokenCount,
    contextWindow: contextUsage.contextWindow,
    usagePercentage: contextUsage.usagePercentage,
  };
}
