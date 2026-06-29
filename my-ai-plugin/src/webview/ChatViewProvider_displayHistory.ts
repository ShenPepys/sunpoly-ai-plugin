import { hasToolCalls, parseToolCalls, stripToolCalls } from '../tools/toolParser';
import type { ParsedToolCall } from '../tools/toolParser';
import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  ExtensionMessage,
  HistoryProcessSummary,
  ShowHistoryProcessSummaryResponse,
  UpdateMessageResponse,
} from './messageTypes';

type LegacyCommandType = 'explain' | 'fix' | 'optimize' | 'complete' | 'test';

export type DisplayMessageIdFactory = (role: 'user' | 'assistant', timestamp?: number) => string;

type BuildDisplayHistoryOptions = {
  createDisplayMessageId: DisplayMessageIdFactory;
  toChangedFileDisplayPath: (filePath: string) => string;
};

type AppendDisplayHistoryUserMessageOptions = {
  content: unknown;
  timestamp?: number;
  explicitDisplayContent?: unknown;
  createDisplayMessageId: DisplayMessageIdFactory;
};

type UpsertAssistantDisplayHistoryMessageOptions = {
  content: unknown;
  timestamp?: number;
  processSummary?: HistoryProcessSummary;
  messageId?: string;
  createDisplayMessageId: DisplayMessageIdFactory;
};

type BuildAssistantToolCallTransitionMessagesOptions = {
  messageId: string;
  displayContent: string;
  thinkingElapsed?: number;
  streamDoneBeforeUpdate?: boolean;
};

type BuildAssistantDisplayCompletionMessagesOptions = {
  messageId: string;
  displayContent: string;
  processSummary?: HistoryProcessSummary;
  includeUpdateMessage?: boolean;
  errorMessage?: string;
  retryRequestId?: string;
  streamDoneBeforeUpdate?: boolean;
};

type ApplyAssistantResponseDisplayOptions = {
  displayHistory: ChatSessionDisplayMessage[];
  content: string;
  timestamp: number;
  messageId: string;
  createDisplayMessageId: DisplayMessageIdFactory;
  processSummary?: HistoryProcessSummary;
  retryRequestId?: string;
  thinkingElapsed?: number;
  toolCallTransitionStreamDoneBeforeUpdate?: boolean;
  completionStreamDoneBeforeUpdate?: boolean;
};

export type AppliedAssistantResponseDisplay =
  | {
    kind: 'tool-calls';
    displayContent: string;
    parsedToolCalls: ParsedToolCall[];
    messages: ExtensionMessage[];
  }
  | {
    kind: 'invalid-tool-call' | 'plain';
    displayContent: string;
    messages: ExtensionMessage[];
  };

export function isToolFeedbackMessage(message: { role: string; content: unknown }): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith('以下是工具执行结果');
}

function inferLegacyCommandDisplayContent(content: string): string | null {
  const normalizedContent = content.trim();
  const fileMatch = normalizedContent.match(/- 文件：([^\n\r]+)/);
  const rangeMatch = normalizedContent.match(/- 行号：第\s*(\d+)\s*行\s*~\s*第\s*(\d+)\s*行/);
  const cursorMatch = normalizedContent.match(/- 光标位置：第\s*(\d+)\s*行/);
  const fileName = fileMatch?.[1]?.trim();

  const commandConfigs: Array<{ prefix: string; type: LegacyCommandType; label: string }> = [
    { prefix: '请解释以下代码的功能和逻辑。', type: 'explain', label: '解释代码' },
    { prefix: '请分析以下代码中的问题并提供修复方案。', type: 'fix', label: '修复代码' },
    { prefix: '请从以下三个维度审查代码，并给出优化建议。', type: 'optimize', label: '优化代码' },
    { prefix: '请根据上下文续写代码。', type: 'complete', label: '续写代码' },
    { prefix: '请为以下代码生成单元测试。', type: 'test', label: '生成单测' },
  ];

  const matchedConfig = commandConfigs.find(config => normalizedContent.startsWith(config.prefix));
  if (!matchedConfig || !normalizedContent.includes('## 代码信息')) {
    return null;
  }

  if (fileName && rangeMatch) {
    return `/${matchedConfig.type} — ${matchedConfig.label}\n\n选中代码：\`${fileName}\` 第 ${rangeMatch[1]}~${rangeMatch[2]} 行`;
  }

  if (fileName && cursorMatch) {
    return `/${matchedConfig.type} — ${matchedConfig.label}\n\n光标位置：\`${fileName}\` 第 ${cursorMatch[1]} 行`;
  }

  if (fileName) {
    return `/${matchedConfig.type} — ${matchedConfig.label}\n\n文件：\`${fileName}\``;
  }

  return `/${matchedConfig.type} — ${matchedConfig.label}`;
}

export function getUserDisplayContent(content: unknown, explicitDisplayContent?: unknown): string {
  if (typeof explicitDisplayContent === 'string' && explicitDisplayContent.trim()) {
    return explicitDisplayContent;
  }

  if (typeof content !== 'string') {
    return '';
  }

  const legacyCommandDisplayContent = inferLegacyCommandDisplayContent(content);
  if (legacyCommandDisplayContent) {
    return legacyCommandDisplayContent;
  }

  const cutIndex = content.indexOf('\n\n## ');
  if (cutIndex > 0) {
    return content.substring(0, cutIndex);
  }

  return content;
}

export function normalizeHistoryMessages(history: ChatSessionHistoryMessage[]): ChatSessionHistoryMessage[] {
  let hasChanges = false;
  const normalizedHistory = history.map(message => {
    if (message.role !== 'user' || isToolFeedbackMessage(message)) {
      return message;
    }

    const displayContent = getUserDisplayContent(message.content, message.displayContent);
    if (!displayContent || message.displayContent === displayContent) {
      return message;
    }

    hasChanges = true;
    return {
      ...message,
      displayContent,
    };
  });

  return hasChanges ? normalizedHistory : history;
}

export function getAssistantDisplayContent(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }

  if (!hasToolCalls(content)) {
    return content;
  }

  return stripToolCalls(content);
}

export type AssistantResponseDisplayAnalysis =
  | {
    kind: 'tool-calls';
    displayContent: string;
    parsedToolCalls: ParsedToolCall[];
  }
  | {
    kind: 'invalid-tool-call';
    displayContent: string;
  }
  | {
    kind: 'plain';
    displayContent: string;
  };

export function analyzeAssistantResponseDisplay(content: string): AssistantResponseDisplayAnalysis {
  const parsedToolCalls = parseToolCalls(content);
  if (parsedToolCalls.length > 0) {
    return {
      kind: 'tool-calls',
      displayContent: getAssistantDisplayContent(content),
      parsedToolCalls,
    };
  }

  if (hasToolCalls(content)) {
    const fallbackContent = stripToolCalls(content).trim() || '⚠️ 检测到无效工具调用，未执行任何工具。';
    return {
      kind: 'invalid-tool-call',
      displayContent: fallbackContent,
    };
  }

  return {
    kind: 'plain',
    displayContent: content,
  };
}

export function buildUpdateMessageResponse(messageId: string, content: string): UpdateMessageResponse {
  return {
    type: 'updateMessage',
    messageId,
    content,
  };
}

export function buildShowHistoryProcessSummaryResponse(
  messageId: string,
  summary: HistoryProcessSummary,
): ShowHistoryProcessSummaryResponse {
  return {
    type: 'showHistoryProcessSummary',
    messageId,
    summary,
  };
}

export function buildAssistantToolCallTransitionMessages(
  options: BuildAssistantToolCallTransitionMessagesOptions,
): ExtensionMessage[] {
  const updateMessage = buildUpdateMessageResponse(options.messageId, options.displayContent);
  const streamDoneMessage: ExtensionMessage = {
    type: 'streamDone',
    messageId: options.messageId,
  };
  const messages: ExtensionMessage[] = options.streamDoneBeforeUpdate
    ? [streamDoneMessage, updateMessage]
    : [updateMessage, streamDoneMessage];

  if (typeof options.thinkingElapsed === 'number' && options.thinkingElapsed > 1000) {
    messages.push({
      type: 'thinkingComplete',
      messageId: options.messageId,
      elapsed: options.thinkingElapsed,
      isExecutionMessage: true,
    });
  }

  messages.push({ type: 'setLoading', loading: true, text: 'AI 正在思考...' });
  return messages;
}

export function buildAssistantDisplayCompletionMessages(
  options: BuildAssistantDisplayCompletionMessagesOptions,
): ExtensionMessage[] {
  const messages: ExtensionMessage[] = [];
  const streamDoneMessage: ExtensionMessage = {
    type: 'streamDone',
    messageId: options.messageId,
  };

  if (options.streamDoneBeforeUpdate) {
    messages.push(streamDoneMessage);
  }

  if (options.includeUpdateMessage) {
    messages.push(buildUpdateMessageResponse(options.messageId, options.displayContent));
  }

  if (!options.streamDoneBeforeUpdate && options.errorMessage) {
    messages.push({
      type: 'showError',
      message: options.errorMessage,
      retryRequestId: options.retryRequestId,
    });
  }

  if (!options.streamDoneBeforeUpdate) {
    messages.push(streamDoneMessage);
  }

  if (options.processSummary) {
    messages.push(buildShowHistoryProcessSummaryResponse(options.messageId, options.processSummary));
  }

  messages.push({ type: 'setLoading', loading: false });

  if (options.streamDoneBeforeUpdate && options.errorMessage) {
    messages.push({
      type: 'showError',
      message: options.errorMessage,
      retryRequestId: options.retryRequestId,
    });
  }

  return messages;
}

export function applyAssistantResponseDisplay(
  options: ApplyAssistantResponseDisplayOptions,
): AppliedAssistantResponseDisplay {
  const analysis = analyzeAssistantResponseDisplay(options.content);

  if (analysis.kind === 'tool-calls') {
    upsertAssistantDisplayHistoryMessage(options.displayHistory, {
      content: analysis.displayContent,
      timestamp: options.timestamp,
      messageId: options.messageId,
      createDisplayMessageId: options.createDisplayMessageId,
    });

    return {
      kind: 'tool-calls',
      displayContent: analysis.displayContent,
      parsedToolCalls: analysis.parsedToolCalls,
      messages: buildAssistantToolCallTransitionMessages({
        messageId: options.messageId,
        displayContent: analysis.displayContent,
        thinkingElapsed: options.thinkingElapsed,
        streamDoneBeforeUpdate: options.toolCallTransitionStreamDoneBeforeUpdate,
      }),
    };
  }

  upsertAssistantDisplayHistoryMessage(options.displayHistory, {
    content: analysis.displayContent,
    timestamp: options.timestamp,
    processSummary: options.processSummary,
    messageId: options.messageId,
    createDisplayMessageId: options.createDisplayMessageId,
  });

  return {
    kind: analysis.kind,
    displayContent: analysis.displayContent,
    messages: buildAssistantDisplayCompletionMessages({
      messageId: options.messageId,
      displayContent: analysis.displayContent,
      processSummary: options.processSummary,
      includeUpdateMessage: analysis.kind === 'invalid-tool-call' || !!options.processSummary,
      errorMessage: analysis.kind === 'invalid-tool-call'
        ? '检测到无效的工具调用格式，已忽略本次工具执行'
        : undefined,
      retryRequestId: options.retryRequestId,
      streamDoneBeforeUpdate: options.completionStreamDoneBeforeUpdate,
    }),
  };
}

export function createHistoryProcessSummary(): HistoryProcessSummary {
  return {
    thinkingElapsedMs: undefined,
    totalSteps: 0,
    readCount: 0,
    listCount: 0,
    modifyCount: 0,
    createCount: 0,
    failedCount: 0,
    changedFiles: [],
  };
}

export function cloneHistoryProcessSummary(summary: HistoryProcessSummary): HistoryProcessSummary {
  return {
    thinkingElapsedMs: summary.thinkingElapsedMs,
    totalSteps: summary.totalSteps,
    readCount: summary.readCount,
    listCount: summary.listCount,
    modifyCount: summary.modifyCount,
    createCount: summary.createCount,
    failedCount: summary.failedCount,
    changedFiles: [...summary.changedFiles],
  };
}

function getToolResultSuccessStates(content: unknown): boolean[] {
  if (typeof content !== 'string') {
    return [];
  }

  return Array.from(content.matchAll(/\*\*(✅ 成功|❌ 失败)\*\*/g), match => match[1] === '✅ 成功');
}

function addChangedFileToHistorySummary(
  summary: HistoryProcessSummary,
  filePath: string,
  toChangedFileDisplayPath: (filePath: string) => string,
): void {
  const displayPath = toChangedFileDisplayPath(filePath);
  if (!summary.changedFiles.includes(displayPath)) {
    summary.changedFiles.push(displayPath);
  }
}

function addToolRoundToHistorySummary(
  summary: HistoryProcessSummary,
  assistantContent: unknown,
  toChangedFileDisplayPath: (filePath: string) => string,
  toolFeedbackContent?: unknown,
): void {
  if (typeof assistantContent !== 'string') {
    return;
  }

  const toolCalls = parseToolCalls(assistantContent);
  if (toolCalls.length === 0) {
    return;
  }

  summary.totalSteps += toolCalls.length;

  for (const toolCall of toolCalls) {
    switch (toolCall.type) {
      case 'read_file':
        summary.readCount += 1;
        break;
      case 'list_dir':
        summary.listCount += 1;
        break;
      case 'edit_file':
        summary.modifyCount += 1;
        break;
      case 'write_file':
        summary.createCount += 1;
        break;
      default:
        break;
    }
  }

  const successStates = getToolResultSuccessStates(toolFeedbackContent);
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const isSuccess = successStates[i];

    if (isSuccess === false) {
      summary.failedCount += 1;
    }

    if (isSuccess === true && (toolCall.type === 'write_file' || toolCall.type === 'edit_file')) {
      addChangedFileToHistorySummary(summary, toolCall.path!, toChangedFileDisplayPath);
    }
  }
}

export function cloneDisplayHistoryMessages(displayHistory: ChatSessionDisplayMessage[]): ChatSessionDisplayMessage[] {
  return displayHistory.map(message => ({
    ...message,
    processSummary: message.processSummary
      ? cloneHistoryProcessSummary(message.processSummary)
      : undefined,
  }));
}

export function createDisplayMessageId(role: 'user' | 'assistant', timestamp?: number): string {
  const safeTimestamp = typeof timestamp === 'number' ? timestamp : Date.now();
  return `${role}-${safeTimestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getLastAssistantDisplayHistoryMessage(
  displayHistory: ChatSessionDisplayMessage[],
): ChatSessionDisplayMessage | undefined {
  for (let i = displayHistory.length - 1; i >= 0; i--) {
    if (displayHistory[i].role === 'assistant') {
      return displayHistory[i];
    }
  }

  return undefined;
}

export function sanitizeDisplayHistory(
  displayHistory: ChatSessionDisplayMessage[],
  createMessageId: DisplayMessageIdFactory,
): ChatSessionDisplayMessage[] {
  let hasChanges = false;
  const normalizedHistory = displayHistory.map(message => {
    let normalizedMessage = message;
    if (!message.messageId) {
      normalizedMessage = {
        ...normalizedMessage,
        messageId: createMessageId(message.role, message.timestamp),
      };
      hasChanges = true;
    }

    if (!normalizedMessage.processSummary || normalizedMessage.processSummary.totalSteps > 0) {
      return normalizedMessage;
    }

    hasChanges = true;
    return {
      ...normalizedMessage,
      processSummary: undefined,
    };
  });

  return hasChanges ? normalizedHistory : displayHistory;
}

export function appendDisplayHistoryUserMessage(
  displayHistory: ChatSessionDisplayMessage[],
  options: AppendDisplayHistoryUserMessageOptions,
): void {
  const displayContent = getUserDisplayContent(options.content, options.explicitDisplayContent);
  if (!displayContent.trim()) {
    return;
  }

  displayHistory.push({
    role: 'user',
    content: displayContent,
    timestamp: options.timestamp,
    messageId: options.createDisplayMessageId('user', options.timestamp),
  });
}

export function upsertAssistantDisplayHistoryMessage(
  displayHistory: ChatSessionDisplayMessage[],
  options: UpsertAssistantDisplayHistoryMessageOptions,
): void {
  const displayContent = getAssistantDisplayContent(options.content);
  if (!displayContent.trim()) {
    return;
  }

  const summaryCopy = options.processSummary ? cloneHistoryProcessSummary(options.processSummary) : undefined;
  const lastMessage = displayHistory[displayHistory.length - 1];

  if (lastMessage && lastMessage.role === 'assistant') {
    lastMessage.content = displayContent;
    lastMessage.timestamp = options.timestamp ?? lastMessage.timestamp;
    lastMessage.messageId = options.messageId ?? lastMessage.messageId ?? options.createDisplayMessageId('assistant', options.timestamp);
    if (summaryCopy) {
      lastMessage.processSummary = summaryCopy;
    } else {
      delete lastMessage.processSummary;
    }
    return;
  }

  displayHistory.push({
    role: 'assistant',
    content: displayContent,
    timestamp: options.timestamp,
    messageId: options.messageId ?? options.createDisplayMessageId('assistant', options.timestamp),
    processSummary: summaryCopy,
  });
}

export function getDisplayHistoryMessageById(
  displayHistory: ChatSessionDisplayMessage[],
  messageId: string,
): ChatSessionDisplayMessage | undefined {
  if (!messageId) {
    return undefined;
  }

  return displayHistory.find(message => message.messageId === messageId);
}

export function buildDisplayHistoryFromRawHistory(
  rawHistory: ChatSessionHistoryMessage[],
  options: BuildDisplayHistoryOptions,
): ChatSessionDisplayMessage[] {
  const displayHistory: ChatSessionDisplayMessage[] = [];

  for (let i = 0; i < rawHistory.length; i++) {
    const currentMessage = rawHistory[i];

    if (isToolFeedbackMessage(currentMessage)) {
      continue;
    }

    if (currentMessage.role === 'user') {
      const userContent = getUserDisplayContent(currentMessage.content, currentMessage.displayContent);
      if (userContent.trim()) {
        displayHistory.push({
          role: 'user',
          content: userContent,
          timestamp: currentMessage.timestamp,
          messageId: options.createDisplayMessageId('user', currentMessage.timestamp),
        });
      }
      continue;
    }

    if (currentMessage.role !== 'assistant') {
      continue;
    }

    const processSummary = createHistoryProcessSummary();
    let finalAssistantMessage = currentMessage;
    let roundAssistantMessage = currentMessage;
    let cursor = i;

    while (true) {
      const nextMessage = rawHistory[cursor + 1];
      const followUpAssistant = rawHistory[cursor + 2];

      if (!nextMessage || !followUpAssistant || !isToolFeedbackMessage(nextMessage) || followUpAssistant.role !== 'assistant') {
        addToolRoundToHistorySummary(
          processSummary,
          roundAssistantMessage.content,
          options.toChangedFileDisplayPath,
        );
        break;
      }

      addToolRoundToHistorySummary(
        processSummary,
        roundAssistantMessage.content,
        options.toChangedFileDisplayPath,
        nextMessage.content,
      );
      finalAssistantMessage = followUpAssistant;
      roundAssistantMessage = followUpAssistant;
      cursor += 2;
    }

    i = cursor;

    const assistantContent = getAssistantDisplayContent(finalAssistantMessage.content);
    if (assistantContent.trim()) {
      displayHistory.push({
        role: 'assistant',
        content: assistantContent,
        timestamp: finalAssistantMessage.timestamp,
        messageId: options.createDisplayMessageId('assistant', finalAssistantMessage.timestamp),
        processSummary: processSummary.totalSteps > 0 ? cloneHistoryProcessSummary(processSummary) : undefined,
      });
    }
  }

  return displayHistory;
}
