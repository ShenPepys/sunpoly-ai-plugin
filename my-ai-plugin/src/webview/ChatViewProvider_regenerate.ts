import type { ApiClientConfig, AbortStreamFn } from '../api/client';
import { getModelConfig, getMaxTokens, getTemperature } from '../config';
import { info, error } from '../logger';
import type { ChatMessageParam } from '../api/types';
import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  ExtensionMessage,
  HistoryProcessSummary,
  PersistedUiEntry,
  WorkMode,
} from './messageTypes';
import type { ParsedToolCall } from '../tools';
import { ensureApiKey } from '../config';
import {
  createHistoryProcessSummary,
  cloneDisplayHistoryMessages,
  cloneHistoryProcessSummary,
  buildAssistantDisplayCompletionMessages,
} from './ChatViewProvider_displayHistory';
import { getAssistantDisplayContent } from './ChatViewProvider_displayHistory';
import {
  prepareChatRequestExecution,
  prepareRemindedMessages,
} from './ChatViewProvider_modelAndSession';
import {
  beginAssistantStreamingRequest,
  startBasicAssistantStreamRequest,
} from './ChatViewProvider_requestExecution';
import {
  consumeRunCompletionState,
  clearPendingRegenerateState,
  rollbackPendingRegenerateState,
  getClonedActiveHistoryProcessSummary,
  resetActiveHistoryProcessSummary,
} from './ChatViewProvider_runtimeState';
import { createRetryRequestId } from './ChatViewProvider_retryRequests';

export type PendingRegenerateState = {
  runId: string;
  messageId: string;
  history: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  uiTranscript: PersistedUiEntry[];
  restoreContent: string;
  restoreProcessSummary?: HistoryProcessSummary;
};

export type PrepareRegenerateRequestOptions = {
  history: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  uiTranscript: PersistedUiEntry[];
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
  cloneUiTranscript: (uiTranscript: PersistedUiEntry[]) => PersistedUiEntry[];
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
      uiTranscript: options.cloneUiTranscript(options.uiTranscript),
      restoreContent: targetAssistantDisplay.content ?? getAssistantDisplayContent(options.history[lastAssistantIndex].content),
      restoreProcessSummary: targetAssistantDisplay.processSummary
        ? options.cloneHistoryProcessSummary(targetAssistantDisplay.processSummary)
        : undefined,
    },
  };
}

export type ExecuteRegenerateFlowOptions = {
  sessionId: string;
  userText: string;
  requestMode: WorkMode;
  reuseMessageId?: string;
  chatHistory: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  postSessionMessage: (sessionId: string, message: ExtensionMessage) => void;
  tryAcquireSessionRunLock: (sessionId: string, runId: string) => string | null;
  setSessionActiveRunIdState: (sessionId: string, runId: string | null) => void;
  getSessionActiveRunId: (sessionId: string) => string | null;
  getSessionActiveHistoryProcessSummary: (sessionId: string) => HistoryProcessSummary | null;
  setSessionAbortStream: (sessionId: string, fn: AbortStreamFn | null) => void;
  setSessionStepSequence: (sessionId: string, seq: number) => void;
  setSessionToolCallRound: (sessionId: string, round: number) => void;
  setSessionActiveHistoryProcessSummary: (sessionId: string, summary: HistoryProcessSummary | null) => void;
  getAbortStream: () => AbortStreamFn | null;
  getToolCallsInProgress: () => boolean;
  expireUndoableSummariesForWriteBackups: () => void;
  clearWriteBackups: () => void;
  getPendingRegenerateState: () => PendingRegenerateState | null;
  setPendingRegenerateState: (state: PendingRegenerateState | null) => void;
  setChatHistoryForSession: (sessionId: string, history: ChatMessageParam[]) => void;
  setDisplayHistoryForSession: (sessionId: string, history: ChatSessionDisplayMessage[]) => void;
  setUiTranscriptForSession: (sessionId: string, transcript: PersistedUiEntry[]) => void;
  resetUiRuntimeState: () => void;
  rebuildUiMessageIndexes: () => void;
  saveChatHistory: (sessionId: string) => void;
  isActiveSession: (sessionId: string) => boolean;
  handleToolCalls: (
    sessionId: string,
    fullContent: string,
    apiConfig: ApiClientConfig,
    regenMsgId: string,
    requestMode: WorkMode,
    parsedToolCalls: ParsedToolCall[],
    retryRequestId: string,
  ) => Promise<void>;
};

export async function executeRegenerateFlow(options: ExecuteRegenerateFlowOptions): Promise<void> {
  const {
    sessionId,
    userText,
    requestMode,
    reuseMessageId,
    chatHistory: sessionChatHistory,
    displayHistory: sessionDisplayHistory,
  } = options;

  // Reset turn-level state
  options.setSessionStepSequence(sessionId, 0);
  options.setSessionToolCallRound(sessionId, 0);
  options.setSessionActiveHistoryProcessSummary(sessionId, resetActiveHistoryProcessSummary());
  options.postSessionMessage(sessionId, { type: 'setLoading', loading: true, text: 'AI 正在思考...' });

  const regenMsgId = reuseMessageId || `ai-regen-${Date.now()}`;
  const retryRequestId = createRetryRequestId();

  const performRollback = () => {
    const rollbackResult = rollbackPendingRegenerateState({
      pendingState: options.getPendingRegenerateState(),
      runId: regenMsgId,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: (t: PersistedUiEntry[]) => [...t],
      cloneHistoryProcessSummary,
    });
    options.setPendingRegenerateState(rollbackResult.nextPendingState);
    if (!rollbackResult.rolledBack) {
      return;
    }
    options.setChatHistoryForSession(sessionId, rollbackResult.restoredHistory as ChatMessageParam[]);
    options.setDisplayHistoryForSession(sessionId, rollbackResult.restoredDisplayHistory);
    options.setUiTranscriptForSession(sessionId, rollbackResult.restoredUiTranscript);
    options.rebuildUiMessageIndexes();
    options.saveChatHistory(sessionId);
    if (rollbackResult.restoredUiTranscript.length > 0) {
      if (options.isActiveSession(sessionId)) {
        options.postSessionMessage(sessionId, { type: 'clearChat' });
      }
    } else if (options.isActiveSession(sessionId)) {
      options.postSessionMessage(sessionId, { type: 'resetMessageState', messageId: rollbackResult.messageId });
      for (const message of buildAssistantDisplayCompletionMessages({
        messageId: rollbackResult.messageId,
        displayContent: rollbackResult.restoreContent,
        processSummary: rollbackResult.restoreProcessSummary,
        includeUpdateMessage: true,
      })) {
        options.postSessionMessage(sessionId, message);
      }
    }
  };

  // Acquire run lock
  const runLockError = options.tryAcquireSessionRunLock(sessionId, regenMsgId);
  if (runLockError) {
    performRollback();
    options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
    options.postSessionMessage(sessionId, { type: 'showError', message: runLockError, retryRequestId });
    return;
  }

  try {
    const apiKey = await ensureApiKey();
    if (!apiKey) {
      options.setSessionActiveRunIdState(sessionId, null);
      options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      performRollback();
      options.postSessionMessage(sessionId, {
        type: 'showError',
        message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey',
        retryRequestId,
      });
      return;
    }

    const modelConfig = getModelConfig();
    const requestExecution = await prepareChatRequestExecution({
      modelConfig,
      requestMode,
      remindedMessages: await prepareRemindedMessages({
        history: sessionChatHistory as ChatMessageParam[],
        requestMode,
        contextWindow: modelConfig.contextWindow,
        maxTokens: getMaxTokens(),
        modelConfig,
        apiKey,
        temperature: getTemperature(),
      }),
      apiKey,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
      userContent: userText,
      appendUserContentMode: 'ifMissingLastUser',
      includeProjectContext: true,
    });
    const messages = requestExecution.messages;
    const apiConfig: ApiClientConfig = requestExecution.apiConfig;

    beginAssistantStreamingRequest({
      abortStream: options.getAbortStream(),
      runId: regenMsgId,
      runtime: {
        setAbortStream: abortStream => options.setSessionAbortStream(sessionId, abortStream),
        setToolCallsInProgress: _ => {},
        setActiveRunId: activeRunId => options.setSessionActiveRunIdState(sessionId, activeRunId),
        setStepSequence: stepSequence => options.setSessionStepSequence(sessionId, stepSequence),
        setToolCallRound: _ => {},
      },
      clearWriteBackups: () => {
        options.expireUndoableSummariesForWriteBackups();
        options.clearWriteBackups();
      },
    });

    if (reuseMessageId) {
      options.postSessionMessage(sessionId, { type: 'resetMessageState', messageId: regenMsgId });
    } else {
      options.postSessionMessage(sessionId, { type: 'addMessage', role: 'assistant', content: '', messageId: regenMsgId });
    }

    const abortStream = startBasicAssistantStreamRequest({
      apiConfig,
      messages,
      messageId: regenMsgId,
      chatHistory: sessionChatHistory,
      displayHistory: sessionDisplayHistory,
      runtime: {
        getActiveRunId: () => options.getSessionActiveRunId(sessionId),
        getActiveHistoryProcessSummary: () => options.getSessionActiveHistoryProcessSummary(sessionId),
        setAbortStream: fn => options.setSessionAbortStream(sessionId, fn),
        setActiveRunId: activeRunId => options.setSessionActiveRunIdState(sessionId, activeRunId),
        setStepSequence: stepSequence => options.setSessionStepSequence(sessionId, stepSequence),
        setActiveHistoryProcessSummary: summary => options.setSessionActiveHistoryProcessSummary(sessionId, summary),
      },
      postMessage: message => options.postSessionMessage(sessionId, message),
      saveChatHistory: () => options.saveChatHistory(sessionId),
      createDisplayMessageId: () => `display-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createHistoryProcessSummary,
      retryRequestId,
      onToolCalls: ({ fullContent, parsedToolCalls }) => {
        options.handleToolCalls(sessionId, fullContent, apiConfig, regenMsgId, requestMode, parsedToolCalls, retryRequestId)
          .catch(err => error('重生成工具调用处理异常:', err instanceof Error ? err.message : String(err)));
      },
      onPlainCompleted: () => {
        options.setPendingRegenerateState(
          clearPendingRegenerateState(options.getPendingRegenerateState(), regenMsgId),
        );
      },
      onErrorBeforeNotify: () => {
        performRollback();
      },
      onDoneLog: fullContent => {
        info('重新生成完成，长度:', fullContent.length);
      },
    });
    options.setSessionAbortStream(sessionId, abortStream);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    options.setSessionActiveRunIdState(sessionId, null);
    options.setSessionAbortStream(sessionId, null);
    options.setSessionStepSequence(sessionId, 0);
    options.setSessionToolCallRound(sessionId, 0);
    options.setSessionActiveHistoryProcessSummary(sessionId, null);
    performRollback();
    options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
    options.postSessionMessage(sessionId, {
      type: 'showError',
      message: `重新生成启动失败：${errMsg}`,
      retryRequestId,
    });
  }
}
