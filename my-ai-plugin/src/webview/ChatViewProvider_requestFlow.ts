import type { ApiClientConfig, AbortStreamFn } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { ensureApiKey, getModelConfig, getMaxTokens, getTemperature, getAllModels } from '../config';
import { info, error } from '../logger';
import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  ExtensionMessage,
  HistoryProcessSummary,
  WorkMode,
} from './messageTypes';
import type { RequestImageAttachment, RetryableRequestState } from './ChatViewProvider_retryRequests';
import { createRetryRequestId } from './ChatViewProvider_retryRequests';
import type { ChangeSummaryFile, WriteBackupEntry } from './fileChanges';
import {
  getDisplayPath as getDisplayPathHelper,
  buildFinalTurnChangeSummaryResponse,
} from './fileChanges';
import type { ParsedToolCall } from '../tools';
import { FileReadStateCache } from '../tools';
import {
  analyzeAssistantResponseDisplay,
  buildAssistantDisplayCompletionMessages,
  cloneHistoryProcessSummary,
  createDisplayMessageId as createDisplayMessageIdHelper,
  createHistoryProcessSummary,
  upsertAssistantDisplayHistoryMessage,
} from './ChatViewProvider_displayHistory';
import {
  prepareChatRequestExecution,
  prepareRemindedMessages,
} from './ChatViewProvider_modelAndSession';
import {
  prepareUserTurnRequest,
  beginAssistantStreamingRequest,
  startBasicAssistantStreamRequest,
  executeToolCallBatchRound,
} from './ChatViewProvider_requestExecution';
import {
  consumeRunCompletionState,
  clearPendingRegenerateState,
  getClonedActiveHistoryProcessSummary,
  resetActiveHistoryProcessSummary,
} from './ChatViewProvider_runtimeState';
import type { PendingRegenerateState } from './ChatViewProvider_regenerate';

// ==================== User Message Flow ====================

export type ExecuteUserMessageFlowOptions = {
  sessionId: string;
  userText: string;
  requestMode: WorkMode;
  images?: RequestImageAttachment[];
  chatHistory: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];

  contextFilePaths: string[];
  retryableRequests: Map<string, RetryableRequestState>;
  userContentOverride?: string;
  retryRequestId?: string;

  setSessionActiveRunIdState: (sessionId: string, runId: string | null) => void;
  setSessionAbortStream: (sessionId: string, fn: AbortStreamFn | null) => void;
  setSessionStepSequence: (sessionId: string, seq: number) => void;
  setSessionToolCallRound: (sessionId: string, round: number) => void;
  setSessionToolCallsInProgress: (sessionId: string, value: boolean) => void;
  setSessionTurnWriteFiles: (sessionId: string, files: ChangeSummaryFile[]) => void;
  setSessionTurnWriteRounds: (sessionId: string, rounds: number) => void;
  setSessionRecoverableWriteFailRounds: (sessionId: string, rounds: number) => void;
  setSessionActiveHistoryProcessSummary: (sessionId: string, summary: HistoryProcessSummary | null) => void;

  getSessionActiveRunId: (sessionId: string) => string | null;
  getSessionActiveHistoryProcessSummary: (sessionId: string) => HistoryProcessSummary | null;
  getSessionAbortStream: () => AbortStreamFn | null;

  postSessionMessage: (sessionId: string, message: ExtensionMessage) => void;
  postMessage: (message: ExtensionMessage) => void;
  tryAcquireSessionRunLock: (sessionId: string, runId: string) => string | null;
  saveChatHistory: (sessionId: string) => void;
  clearContextFiles: () => void;
  expireUndoableSummariesForWriteBackups: () => void;
  clearWriteBackups: () => void;

  handleToolCalls: (
    sessionId: string,
    fullContent: string,
    apiConfig: ApiClientConfig,
    assistantMsgId: string,
    requestMode: WorkMode,
    parsedToolCalls: ParsedToolCall[],
    retryRequestId: string,
  ) => Promise<void>;
};

export async function executeUserMessageFlow(options: ExecuteUserMessageFlowOptions): Promise<void> {
  const {
    sessionId,
    userText,
    requestMode,
    images,
    chatHistory: sessionChatHistory,
    displayHistory: sessionDisplayHistory,
  } = options;

  const assistantMsgId = `assistant-${Date.now()}`;
  const retryRequestId = options.retryRequestId || createRetryRequestId();

  options.setSessionStepSequence(sessionId, 0);
  options.setSessionToolCallRound(sessionId, 0);
  options.setSessionActiveHistoryProcessSummary(sessionId, resetActiveHistoryProcessSummary());
  options.setSessionTurnWriteFiles(sessionId, []);
  options.setSessionTurnWriteRounds(sessionId, 0);
  options.setSessionRecoverableWriteFailRounds(sessionId, 0);

  options.postSessionMessage(sessionId, { type: 'setLoading', loading: true });

  const runLockError = options.tryAcquireSessionRunLock(sessionId, assistantMsgId);
  if (runLockError) {
    options.postSessionMessage(sessionId, { type: 'showError', message: runLockError });
    return;
  }

  try {
    const apiKey = await ensureApiKey();
    if (!apiKey) {
      options.setSessionActiveRunIdState(sessionId, null);
      options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      options.postSessionMessage(sessionId, {
        type: 'showError',
        message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey',
        retryRequestId,
      });
      return;
    }

    const modelConfig = getModelConfig();

    const preparedUserTurn = prepareUserTurnRequest({
      text: userText,
      retryRequestId,
      requestMode,
      activeSessionId: sessionId,
      images,
      userContentOverride: options.userContentOverride,
      contextFilePaths: options.contextFilePaths,
      chatHistory: sessionChatHistory,
      displayHistory: sessionDisplayHistory,
      retryableRequests: options.retryableRequests,
      modelConfig,
      allModels: getAllModels(),
      createDisplayMessageId: createDisplayMessageIdHelper,
    });

    if (options.contextFilePaths.length > 0) {
      options.clearContextFiles();
    }

    options.saveChatHistory(sessionId);

    if (preparedUserTurn.visionWarning) {
      options.postSessionMessage(sessionId, preparedUserTurn.visionWarning);
    }
    const finalUserContent = preparedUserTurn.finalUserContent;

    options.postSessionMessage(sessionId, { type: 'clearImageAttachments' });

    const requestExecution = await prepareChatRequestExecution({
      modelConfig,
      requestMode,
      remindedMessages: await prepareRemindedMessages({
        history: sessionChatHistory as ChatMessageParam[],
        requestMode,
        contextWindow: modelConfig.contextWindow,
        maxTokens: getMaxTokens(),
        excludeLastMessage: true,
        modelConfig,
        apiKey,
        temperature: getTemperature(),
      }),
      apiKey,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
      userContent: finalUserContent,
      appendUserContentMode: 'always',
      includeProjectContext: true,
    });
    info('首轮系统提示词模式', {
      requestMode,
      systemPromptModePreview: requestExecution.systemPrompt.slice(0, 120),
    });
    const messages = requestExecution.messages;
    const apiConfig: ApiClientConfig = requestExecution.apiConfig;

    beginAssistantStreamingRequest({
      abortStream: options.getSessionAbortStream(),
      runId: assistantMsgId,
      runtime: {
        setAbortStream: abortStream => options.setSessionAbortStream(sessionId, abortStream),
        setToolCallsInProgress: toolCallsInProgress => options.setSessionToolCallsInProgress(sessionId, toolCallsInProgress),
        setActiveRunId: activeRunId => options.setSessionActiveRunIdState(sessionId, activeRunId),
        setStepSequence: stepSequence => options.setSessionStepSequence(sessionId, stepSequence),
        setToolCallRound: toolCallRound => options.setSessionToolCallRound(sessionId, toolCallRound),
      },
      clearWriteBackups: () => {
        options.expireUndoableSummariesForWriteBackups();
        options.clearWriteBackups();
      },
    });

    options.setSessionAbortStream(
      sessionId,
      startBasicAssistantStreamRequest({
        apiConfig,
        messages,
        messageId: assistantMsgId,
        chatHistory: sessionChatHistory,
        displayHistory: sessionDisplayHistory,
        runtime: {
          getActiveRunId: () => options.getSessionActiveRunId(sessionId),
          getActiveHistoryProcessSummary: () => options.getSessionActiveHistoryProcessSummary(sessionId),
          setAbortStream: abortStream => options.setSessionAbortStream(sessionId, abortStream),
          setActiveRunId: activeRunId => options.setSessionActiveRunIdState(sessionId, activeRunId),
          setStepSequence: stepSequence => options.setSessionStepSequence(sessionId, stepSequence),
          setActiveHistoryProcessSummary: summary => options.setSessionActiveHistoryProcessSummary(sessionId, summary),
        },
        postMessage: message => options.postSessionMessage(sessionId, message),
        saveChatHistory: () => options.saveChatHistory(sessionId),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        onToolCalls: ({ fullContent, parsedToolCalls }) => {
          options.handleToolCalls(sessionId, fullContent, apiConfig, assistantMsgId, requestMode, parsedToolCalls, retryRequestId)
            .catch(err => error('工具调用处理异常:', err instanceof Error ? err.message : String(err)));
        },
        onDoneLog: (fullContent, thinkingElapsed) => {
          info(`AI 回复完成，长度: ${fullContent.length}，耗时: ${thinkingElapsed}ms`);
        },
        onErrorLog: rawErrorMessage => {
          error('AI API 调用失败:', rawErrorMessage);
        },
      }),
    );

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    error('启动用户消息请求失败:', errMsg);
    options.setSessionActiveRunIdState(sessionId, null);
    options.setSessionAbortStream(sessionId, null);
    options.setSessionToolCallsInProgress(sessionId, false);
    options.setSessionStepSequence(sessionId, 0);
    options.setSessionToolCallRound(sessionId, 0);
    options.setSessionActiveHistoryProcessSummary(sessionId, null);
    options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
    options.postSessionMessage(sessionId, {
      type: 'showError',
      message: `请求启动失败：${errMsg}`,
      retryRequestId,
    });
  }
}

// ==================== Tool Calls Flow ====================

export type ExecuteToolCallsFlowOptions = {
  sessionId: string;
  aiResponse: string;
  apiConfig: ApiClientConfig;
  reuseMsgId: string;
  requestMode: WorkMode;
  parsedToolCalls?: ParsedToolCall[];
  retryRequestId?: string;

  chatHistory: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];

  getSessionActiveRunId: (sessionId: string) => string | null;
  getSessionActiveHistoryProcessSummary: (sessionId: string) => HistoryProcessSummary | null;
  getSessionToolCallsInProgress: (sessionId: string) => boolean;
  getSessionToolCallRound: (sessionId: string) => number;
  getSessionStepSequence: (sessionId: string) => number;
  getSessionTurnWriteFiles: (sessionId: string) => ChangeSummaryFile[];
  getSessionTurnWriteRounds: (sessionId: string) => number;
  getSessionRecoverableWriteFailRounds: (sessionId: string) => number;
  getSessionPendingRegenerateState: (sessionId: string) => PendingRegenerateState | null;
  getSessionAbortStream: (sessionId: string) => AbortStreamFn | null;

  setSessionActiveRunIdState: (sessionId: string, runId: string | null) => void;
  setSessionStepSequence: (sessionId: string, seq: number) => void;
  setSessionToolCallRound: (sessionId: string, round: number) => void;
  setSessionToolCallsInProgress: (sessionId: string, value: boolean) => void;
  setSessionActiveHistoryProcessSummary: (sessionId: string, summary: HistoryProcessSummary | null) => void;
  setSessionAbortStream: (sessionId: string, fn: AbortStreamFn | null) => void;
  setSessionTurnWriteRounds: (sessionId: string, rounds: number) => void;
  setSessionRecoverableWriteFailRounds: (sessionId: string, rounds: number) => void;
  setSessionPendingRegenerateState: (sessionId: string, state: PendingRegenerateState | null) => void;
  setSessionCurrentMode: (sessionId: string, mode: WorkMode) => void;

  postSessionMessage: (sessionId: string, message: ExtensionMessage) => void;
  postMessage: (message: ExtensionMessage) => void;
  saveChatHistory: (sessionId: string) => void;
  isActiveSession: (sessionId: string) => boolean;
  rollbackPendingRegenerateState: (runId: string, sessionId: string) => boolean;
  expireUndoableSummariesForWriteBackups: () => void;
  clearWriteBackups: () => void;

  getWriteBackups: (sessionId: string) => Map<string, WriteBackupEntry>;
  fileReadStateCache: FileReadStateCache;

  handleToolCalls: (
    sessionId: string,
    fullContent: string,
    apiConfig: ApiClientConfig,
    reuseMsgId: string,
    requestMode: WorkMode,
    parsedToolCalls: ParsedToolCall[],
    retryRequestId: string,
  ) => Promise<void>;
};

export async function executeToolCallsFlow(options: ExecuteToolCallsFlowOptions): Promise<void> {
  const {
    sessionId,
    aiResponse,
    apiConfig,
    reuseMsgId,
    requestMode,
    parsedToolCalls,
    retryRequestId,
    chatHistory: sessionChatHistory,
    displayHistory: sessionDisplayHistory,
  } = options;

  const toolCallAnalysis = parsedToolCalls
    ? { kind: 'tool-calls' as const, parsedToolCalls }
    : analyzeAssistantResponseDisplay(aiResponse);
  const toolCalls = toolCallAnalysis.kind === 'tool-calls'
    ? toolCallAnalysis.parsedToolCalls
    : [];

  if (toolCalls.length === 0) {
    if (options.getSessionActiveRunId(sessionId) === reuseMsgId) {
      options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      const completionState = consumeRunCompletionState({
        activeHistoryProcessSummary: options.getSessionActiveHistoryProcessSummary(sessionId),
        resetActiveHistoryProcessSummary: false,
      });
      options.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
      options.setSessionStepSequence(sessionId, completionState.nextStepSequence);
      options.setSessionActiveHistoryProcessSummary(sessionId, completionState.nextActiveHistoryProcessSummary);
    }
    return;
  }

  if (options.getSessionActiveRunId(sessionId) !== reuseMsgId) {
    if (options.getSessionActiveRunId(sessionId) === null) {
      options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      const completionState = consumeRunCompletionState({
        activeHistoryProcessSummary: options.getSessionActiveHistoryProcessSummary(sessionId),
      });
      options.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
      options.setSessionStepSequence(sessionId, completionState.nextStepSequence);
      options.setSessionActiveHistoryProcessSummary(sessionId, completionState.nextActiveHistoryProcessSummary);
    }
    return;
  }

  if (options.getSessionToolCallsInProgress(sessionId)) {
    info('handleToolCalls 已在执行中，跳过重复调用');
    return;
  }

  options.setSessionToolCallsInProgress(sessionId, true);
  options.setSessionToolCallRound(sessionId, options.getSessionToolCallRound(sessionId) + 1);
  options.setSessionCurrentMode(sessionId, requestMode);
  if (options.isActiveSession(sessionId)) {
    options.postMessage({ type: 'updateMode', mode: requestMode });
  }
  info('handleToolCalls 模式快照', {
    reuseMsgId,
    requestMode,
    currentMode: requestMode,
    toolCallRound: options.getSessionToolCallRound(sessionId),
  });

  try {
    info(`检测到 ${toolCalls.length} 个工具调用，立即执行，当前轮次: ${options.getSessionToolCallRound(sessionId)}`);

    const batchRound = await executeToolCallBatchRound({
      toolCalls,
      requestMode,
      messageId: reuseMsgId,
      apiConfig,
      stepSequenceStart: options.getSessionStepSequence(sessionId),
      writeBackups: options.getWriteBackups(sessionId),
      turnWriteFiles: options.getSessionTurnWriteFiles(sessionId),
      turnWriteRounds: options.getSessionTurnWriteRounds(sessionId),
      recoverableWriteFailRounds: options.getSessionRecoverableWriteFailRounds(sessionId),
      activeHistoryProcessSummary: options.getSessionActiveHistoryProcessSummary(sessionId),
      chatHistory: sessionChatHistory,
      historyForFollowUp: sessionChatHistory as ChatMessageParam[],
      postMessage: message => options.postSessionMessage(sessionId, message),
      canContinue: () => options.getSessionActiveRunId(sessionId) === reuseMsgId,
      getActiveRunId: () => options.getSessionActiveRunId(sessionId),
      saveChatHistory: () => options.saveChatHistory(sessionId),
      createHistoryProcessSummary,
      toDisplayPath: getDisplayPathHelper,
      fileReadStateCache: options.fileReadStateCache,
    });

    options.setSessionStepSequence(sessionId, batchRound.nextStepSequence);
    options.setSessionTurnWriteRounds(sessionId, batchRound.nextTurnWriteRounds);
    options.setSessionRecoverableWriteFailRounds(sessionId, batchRound.nextRecoverableWriteFailRounds);
    options.setSessionActiveHistoryProcessSummary(sessionId, batchRound.nextActiveHistoryProcessSummary);

    if (batchRound.kind === 'halted') {
      if (batchRound.shouldFinalizeStoppedRun) {
        options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
        const completionState = consumeRunCompletionState({
          activeHistoryProcessSummary: options.getSessionActiveHistoryProcessSummary(sessionId),
        });
        options.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
        options.setSessionStepSequence(sessionId, completionState.nextStepSequence);
        options.setSessionActiveHistoryProcessSummary(sessionId, completionState.nextActiveHistoryProcessSummary);
      }
      return;
    }

    info('续轮系统提示词模式', {
      requestMode,
      systemPromptModePreview: batchRound.followUpSystemPrompt.slice(0, 120),
    });

    options.setSessionAbortStream(
      sessionId,
      startBasicAssistantStreamRequest({
        apiConfig: batchRound.followUpApiConfig,
        messages: batchRound.followUpMessages,
        messageId: reuseMsgId,
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
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        emitEmptyChunkOnFirstChunk: true,
        toolCallTransitionStreamDoneBeforeUpdate: true,
        processSummaryResolver: () => getClonedActiveHistoryProcessSummary(
          options.getSessionActiveHistoryProcessSummary(sessionId),
          cloneHistoryProcessSummary,
        ),
        onToolCalls: ({ fullContent, parsedToolCalls: nextParsedToolCalls, displayContent, assistantTimestamp }) => {
          if (options.getSessionToolCallRound(sessionId) < 200) {
            options.handleToolCalls(sessionId, fullContent, batchRound.followUpApiConfig, reuseMsgId, requestMode, nextParsedToolCalls, retryRequestId!)
              .catch(err => error('续轮工具调用处理异常:', err instanceof Error ? err.message : String(err)));
            return;
          }

          const finalProcessSummary = getClonedActiveHistoryProcessSummary(
            options.getSessionActiveHistoryProcessSummary(sessionId),
            cloneHistoryProcessSummary,
          );
          const rolledBack = options.rollbackPendingRegenerateState(reuseMsgId, sessionId);
          if (!rolledBack) {
            upsertAssistantDisplayHistoryMessage(sessionDisplayHistory, {
              content: displayContent,
              timestamp: assistantTimestamp,
              processSummary: finalProcessSummary,
              messageId: reuseMsgId,
              createDisplayMessageId: createDisplayMessageIdHelper,
            });
            options.saveChatHistory(sessionId);
            for (const message of buildAssistantDisplayCompletionMessages({
              messageId: reuseMsgId,
              displayContent,
              processSummary: finalProcessSummary,
            })) {
              options.postSessionMessage(sessionId, message);
            }
          }

          options.postSessionMessage(sessionId, {
            type: 'showError',
            message: '工具调用轮次已达上限（200 轮），已自动停止。请缩小任务范围后重试。',
            retryRequestId,
          });
          options.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
          const completionState = consumeRunCompletionState({
            activeHistoryProcessSummary: options.getSessionActiveHistoryProcessSummary(sessionId),
          });
          options.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
          options.setSessionStepSequence(sessionId, completionState.nextStepSequence);
          options.setSessionActiveHistoryProcessSummary(sessionId, completionState.nextActiveHistoryProcessSummary);
        },
        onPlainCompleted: () => {
          if (options.getSessionTurnWriteRounds(sessionId) >= 2) {
            options.postSessionMessage(sessionId, buildFinalTurnChangeSummaryResponse(reuseMsgId, options.getSessionTurnWriteFiles(sessionId)));
          }
          options.setSessionPendingRegenerateState(
            sessionId,
            clearPendingRegenerateState(options.getSessionPendingRegenerateState(sessionId), reuseMsgId),
          );
        },
        onErrorBeforeNotify: () => {
          const rolledBack = options.rollbackPendingRegenerateState(reuseMsgId, sessionId);
          const finalProcessSummary = getClonedActiveHistoryProcessSummary(
            options.getSessionActiveHistoryProcessSummary(sessionId),
            cloneHistoryProcessSummary,
          );
          if (rolledBack) {
            return;
          }

          upsertAssistantDisplayHistoryMessage(sessionDisplayHistory, {
            content: '⚠️ 工具执行出错，请重试。',
            timestamp: Date.now(),
            processSummary: finalProcessSummary,
            messageId: reuseMsgId,
            createDisplayMessageId: createDisplayMessageIdHelper,
          });
          options.saveChatHistory(sessionId);
          for (const message of buildAssistantDisplayCompletionMessages({
            messageId: reuseMsgId,
            displayContent: '⚠️ 工具执行出错，请重试。',
            processSummary: finalProcessSummary,
            includeUpdateMessage: true,
          })) {
            options.postSessionMessage(sessionId, message);
          }
        },
        onDoneLog: fullContent => {
          info(`续轮回复完成，长度: ${fullContent.length}`);
        },
        onErrorLog: errorMessage => {
          error('续轮 AI 调用失败:', errorMessage);
        },
      }),
    );

  } finally {
    options.setSessionToolCallsInProgress(sessionId, false);
  }
}
