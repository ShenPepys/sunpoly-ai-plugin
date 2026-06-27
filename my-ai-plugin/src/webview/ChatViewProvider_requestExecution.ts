import { getMaxTokens, getModelConfig } from '../config';
import { sendStreamRequest } from '../api/client';
import type { AbortStreamFn, ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { info } from '../logger';
import type { ModelConfig } from '../prompts/types';
import type { ParsedToolCall, FileReadStateCache } from '../tools';
import {
  applyAssistantResponseDisplay,
  appendDisplayHistoryUserMessage,
  getUserDisplayContent,
} from './ChatViewProvider_displayHistory';
import type { DisplayMessageIdFactory } from './ChatViewProvider_displayHistory';
import {
  buildAppliedChangeSummaryResponses,
  executeToolCallBatch,
  upsertChangeSummaryFile,
} from './fileChanges';
import type { ChangeSummaryFile } from './fileChanges';
import type { WriteBackupEntry } from './fileChanges';
import { buildUserContentWithContext } from './ChatViewProvider_workspaceContext';
import {
  cloneRequestImages,
  rememberRetryableRequest,
} from './ChatViewProvider_retryRequests';
import type {
  RequestImageAttachment,
  RetryableRequestState,
} from './ChatViewProvider_retryRequests';
import {
  beginStreamingRun,
  consumeRunCompletionState,
  consumeStreamingRunCompletionState,
  recordThinkingElapsedInActiveHistorySummary,
  recordToolStepInActiveHistorySummary,
} from './ChatViewProvider_runtimeState';
import {
  buildUserRequestContent,
  prepareChatRequestExecution,
  prepareRemindedMessages,
} from './ChatViewProvider_modelAndSession';
import {
  buildToolFeedback,
  resolveWriteFailureFollowUpState,
  MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS,
} from './ChatViewProvider_toolFeedback';
import type {
  WriteFailureFollowUpState,
} from './ChatViewProvider_toolFeedback';
import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  ExtensionMessage,
  HistoryProcessSummary,
  VisionNotSupportedResponse,
  WorkMode,
} from './messageTypes';

export type PrepareUserTurnRequestOptions = {
  text: string;
  retryRequestId: string;
  requestMode: WorkMode;
  activeSessionId: string;
  images?: RequestImageAttachment[];
  userContentOverride?: string;
  contextFilePaths: string[];
  chatHistory: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  retryableRequests: Map<string, RetryableRequestState>;
  modelConfig: ModelConfig;
  allModels: Array<{ name: string; modelId: string; supportsVision?: boolean }>;
  createDisplayMessageId: DisplayMessageIdFactory;
};

export type PreparedUserTurnRequest = {
  clonedImages: RequestImageAttachment[];
  userContent: string;
  finalUserContent: ChatMessageParam['content'];
  visionWarning?: VisionNotSupportedResponse;
};

export function prepareUserTurnRequest(options: PrepareUserTurnRequestOptions): PreparedUserTurnRequest {
  const clonedImages = cloneRequestImages(options.images);
  let userContent = options.userContentOverride ?? options.text;

  if (!options.userContentOverride) {
    userContent = buildUserContentWithContext(userContent, options.contextFilePaths);
  }

  rememberRetryableRequest(options.retryableRequests, {
    requestId: options.retryRequestId,
    sessionId: options.activeSessionId,
    text: options.text,
    userContent,
    images: clonedImages,
    requestMode: options.requestMode,
  });

  const userDisplayContent = getUserDisplayContent(userContent, options.text || userContent);
  const userTimestamp = Date.now();
  options.chatHistory.push({
    role: 'user',
    content: userContent,
    timestamp: userTimestamp,
    displayContent: userDisplayContent || undefined,
  });
  appendDisplayHistoryUserMessage(options.displayHistory, {
    content: userContent,
    timestamp: userTimestamp,
    explicitDisplayContent: userDisplayContent,
    createDisplayMessageId: options.createDisplayMessageId,
  });

  const userRequestContent = buildUserRequestContent({
    userContent,
    images: clonedImages,
    modelConfig: options.modelConfig,
    allModels: options.allModels,
  });

  return {
    clonedImages,
    userContent,
    finalUserContent: userRequestContent.content,
    visionWarning: userRequestContent.visionWarning,
  };
}

export type BasicAssistantStreamRuntimeAccess = {
  getActiveRunId: () => string | null;
  getActiveHistoryProcessSummary: () => HistoryProcessSummary | null;
  setAbortStream: (abortStream: AbortStreamFn | null) => void;
  setToolCallsInProgress: (value: boolean) => void;
  setActiveRunId: (runId: string | null) => void;
  setStepSequence: (stepSequence: number) => void;
  setToolCallRound: (toolCallRound: number) => void;
  setActiveHistoryProcessSummary: (summary: HistoryProcessSummary | null) => void;
};

export type ExecuteToolCallBatchRoundOptions = {
  toolCalls: ParsedToolCall[];
  requestMode: WorkMode;
  messageId: string;
  apiConfig: ApiClientConfig;
  stepSequenceStart: number;
  writeBackups: Map<string, WriteBackupEntry>;
  turnWriteFiles: ChangeSummaryFile[];
  turnWriteRounds: number;
  activeHistoryProcessSummary: HistoryProcessSummary | null;
  chatHistory: ChatSessionHistoryMessage[];
  historyForFollowUp: ChatMessageParam[];
  postMessage: (message: ExtensionMessage) => void;
  canContinue: () => boolean;
  getActiveRunId: () => string | null;
  saveChatHistory: () => void;
  createHistoryProcessSummary: () => HistoryProcessSummary;
  toDisplayPath: (filePath: string) => string;
  /** 文件读取状态缓存，传递给 executeToolCallBatch */
  fileReadStateCache?: FileReadStateCache;
  /** 可恢复写失败续轮计数 */
  recoverableWriteFailRounds: number;
};

export type ExecuteToolCallBatchRoundResult =
  | {
    kind: 'halted';
    nextStepSequence: number;
    nextTurnWriteRounds: number;
    nextActiveHistoryProcessSummary: HistoryProcessSummary | null;
    shouldFinalizeStoppedRun: boolean;
    nextRecoverableWriteFailRounds: number;
  }
  | {
    kind: 'follow-up';
    nextStepSequence: number;
    nextTurnWriteRounds: number;
    nextActiveHistoryProcessSummary: HistoryProcessSummary | null;
    followUpSystemPrompt: string;
    followUpMessages: ChatMessageParam[];
    followUpApiConfig: ApiClientConfig;
    nextRecoverableWriteFailRounds: number;
  };

export async function executeToolCallBatchRound(
  options: ExecuteToolCallBatchRoundOptions,
): Promise<ExecuteToolCallBatchRoundResult> {
  const summaryId = `summary-${options.messageId}-${Date.now()}-${options.stepSequenceStart}`;
  const batchExecution = await executeToolCallBatch({
    toolCalls: options.toolCalls,
    requestMode: options.requestMode,
    messageId: options.messageId,
    summaryId,
    stepSequenceStart: options.stepSequenceStart,
    writeBackups: options.writeBackups,
    postMessage: options.postMessage,
    canContinue: options.canContinue,
    toDisplayPath: options.toDisplayPath,
    fileReadStateCache: options.fileReadStateCache,
  });

  let nextActiveHistoryProcessSummary = options.activeHistoryProcessSummary;
  for (const executionRecord of batchExecution.executionRecords) {
    nextActiveHistoryProcessSummary = recordToolStepInActiveHistorySummary(
      nextActiveHistoryProcessSummary,
      executionRecord.toolCall,
      executionRecord.success,
      executionRecord.changedFilePath,
      options.createHistoryProcessSummary,
      options.toDisplayPath,
    );
  }

  for (const changeSummaryEntry of batchExecution.batchWriteFiles) {
    upsertChangeSummaryFile(options.turnWriteFiles, changeSummaryEntry);
  }

  const hasBatchWriteSummary = batchExecution.batchWriteFiles.length > 0 || batchExecution.writeFailCount > 0;
  let nextTurnWriteRounds = options.turnWriteRounds;
  if (hasBatchWriteSummary) {
    nextTurnWriteRounds += 1;
    for (const message of buildAppliedChangeSummaryResponses({
      messageId: options.messageId,
      summaryId,
      files: batchExecution.batchWriteFiles,
      writeSuccessCount: batchExecution.writeSuccessCount,
      writeFailCount: batchExecution.writeFailCount,
    })) {
      options.postMessage(message);
    }
  }

  const writeFailureFollowUpState = resolveWriteFailureFollowUpState({
    toolResults: batchExecution.toolResults,
    recoverableWriteFailRounds: options.recoverableWriteFailRounds,
  });

  if (writeFailureFollowUpState.canContinueAfterWriteFailures) {
    info(
      `检测到 ${writeFailureFollowUpState.recoverableWriteFailCount} 个可恢复写失败，允许继续续轮；已使用 ${writeFailureFollowUpState.nextRecoverableWriteFailRounds}/${MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS} 次恢复续轮额度`,
    );
  } else if (writeFailureFollowUpState.fatalWriteFailCount > 0) {
    info(`检测到 ${writeFailureFollowUpState.fatalWriteFailCount} 个不可恢复写失败，停止本次自动续轮`);
  } else if (writeFailureFollowUpState.reachedRetryLimit) {
    info(`可恢复写失败已达到续轮上限（${MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS} 次），停止本次自动续轮`);
  }

  if (batchExecution.status === 'interrupted') {
    return {
      kind: 'halted',
      nextStepSequence: batchExecution.nextStepSequence,
      nextTurnWriteRounds,
      nextRecoverableWriteFailRounds: writeFailureFollowUpState.nextRecoverableWriteFailRounds,
      nextActiveHistoryProcessSummary,
      shouldFinalizeStoppedRun: options.getActiveRunId() === null,
    };
  }

  if (options.getActiveRunId() !== options.messageId) {
    return {
      kind: 'halted',
      nextStepSequence: batchExecution.nextStepSequence,
      nextTurnWriteRounds,
      nextRecoverableWriteFailRounds: writeFailureFollowUpState.nextRecoverableWriteFailRounds,
      nextActiveHistoryProcessSummary,
      shouldFinalizeStoppedRun: options.getActiveRunId() === null,
    };
  }

  if (batchExecution.writeFailCount > 0 && !writeFailureFollowUpState.canContinueAfterWriteFailures) {
    return {
      kind: 'halted',
      nextStepSequence: batchExecution.nextStepSequence,
      nextTurnWriteRounds,
      nextRecoverableWriteFailRounds: writeFailureFollowUpState.nextRecoverableWriteFailRounds,
      nextActiveHistoryProcessSummary,
      shouldFinalizeStoppedRun: true,
    };
  }

  const toolFeedback = buildToolFeedback({
    toolResults: batchExecution.toolResults,
    deferredToolCalls: batchExecution.deferredToolCalls,
    readOnlyBatchLimited: batchExecution.readOnlyBatchLimited,
    sameFileToolCallLimited: batchExecution.sameFileToolCallLimited,
    duplicateReadOnlyToolCallsSkippedCount: batchExecution.duplicateReadOnlyToolCallsSkippedCount,
    recoverableWriteFailCount: writeFailureFollowUpState.recoverableWriteFailCount,
    remainingRecoverableWriteFailureFollowUpRounds: writeFailureFollowUpState.remainingRecoverableWriteFailureFollowUpRounds,
  });
  options.chatHistory.push({ role: 'user', content: toolFeedback });
  options.saveChatHistory();

  const modelConfig = getModelConfig();
  const followUpRequest = await prepareChatRequestExecution({
    modelConfig,
    requestMode: options.requestMode,
    remindedMessages: await prepareRemindedMessages({
      history: options.historyForFollowUp,
      requestMode: options.requestMode,
      contextWindow: modelConfig.contextWindow,
      maxTokens: getMaxTokens(),
      modelConfig,
      apiKey: options.apiConfig.apiKey,
      temperature: options.apiConfig.temperature,
    }),
    apiKey: options.apiConfig.apiKey,
    maxTokens: getMaxTokens(),
    temperature: options.apiConfig.temperature,
    allowCustomPrompt: false,
  });

  return {
    kind: 'follow-up',
    nextStepSequence: batchExecution.nextStepSequence,
    nextTurnWriteRounds,
    nextRecoverableWriteFailRounds: writeFailureFollowUpState.nextRecoverableWriteFailRounds,
    nextActiveHistoryProcessSummary,
    followUpSystemPrompt: followUpRequest.systemPrompt,
    followUpMessages: followUpRequest.messages,
    followUpApiConfig: followUpRequest.apiConfig,
  };
}

export type BeginAssistantStreamingRequestOptions = {
  abortStream: AbortStreamFn | null;
  runId: string;
  runtime: Pick<
    BasicAssistantStreamRuntimeAccess,
    'setAbortStream' | 'setToolCallsInProgress' | 'setActiveRunId' | 'setStepSequence' | 'setToolCallRound'
  >;
  clearWriteBackups: () => void;
};

export function beginAssistantStreamingRequest(options: BeginAssistantStreamingRequestOptions): void {
  const beginRunResult = beginStreamingRun({
    abortStream: options.abortStream,
    runId: options.runId,
  });

  if (beginRunResult.abortStreamToStop) {
    (beginRunResult.abortStreamToStop as AbortStreamFn)();
  }

  options.runtime.setAbortStream(beginRunResult.nextAbortStream);
  options.runtime.setToolCallsInProgress(beginRunResult.nextToolCallsInProgress);
  options.runtime.setActiveRunId(beginRunResult.nextActiveRunId);
  options.runtime.setStepSequence(beginRunResult.nextStepSequence);
  options.runtime.setToolCallRound(beginRunResult.nextToolCallRound);
  options.clearWriteBackups();
}

// ─── Context-Length 400 自动重试辅助 ─────────────────────────────
// 即使 token 估算 + 安全缓冲都到位，少数极端情况（例如超大 tool 结果累积、
// 模型分词差异特别大）仍可能触发 API 的 "maximum context length" 400 错误。
// 我们对这类错误做一次性降级重试：更激进地裁剪历史 + 降低 max_tokens，
// 让用户在大多数情况下感知不到失败，只是略微多等一会。
const CONTEXT_LENGTH_ERROR_PATTERNS: RegExp[] = [
  /maximum context length/i,
  /context[_\s-]?length.*(exceed|too\s*long|too\s*large)/i,
  /reduce the length of the messages/i,
  /上下文长度/,
  /token.*(超出|超过|过长)/,
];

/**
 * 判断流式请求错误消息是否属于 "context length exceeded" 类型。
 * 纯文本匹配，不依赖具体厂商的错误码结构。
 * 导出：供单元测试覆盖各种模式
 */
export function isContextLengthError(errorMessage: string): boolean {
  if (!errorMessage) {
    return false;
  }
  return CONTEXT_LENGTH_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * 在遇到 context-length 400 错误后，对当前消息数组做一次性激进裁剪。
 * 规则：
 *   - 保留首条 system 消息（如果存在）
 *   - 保留最后一条用户消息（当前提问无论如何都要留）
 *   - 从中间历史里丢弃最前面约 30% 的消息
 *   - 如果裁剪后没有变化（消息太少或已经是最小集），返回原数组让上层放弃重试
 */
export function aggressivelyTrimMessagesAfterContextError(
  messages: ChatMessageParam[],
): ChatMessageParam[] {
  if (messages.length <= 2) {
    return messages;
  }

  const firstMessageIsSystem = messages[0].role === 'system';
  const systemPrefix = firstMessageIsSystem ? [messages[0]] : [];
  const nonSystemMessages = firstMessageIsSystem ? messages.slice(1) : messages;

  if (nonSystemMessages.length <= 1) {
    return messages;
  }

  const lastNonSystemMessage = nonSystemMessages[nonSystemMessages.length - 1];
  const middleHistory = nonSystemMessages.slice(0, -1);
  // 中间历史至少删除 1 条，最多删除 30%，保证每次重试都能真的瘦身
  const dropCountFromFront = Math.max(1, Math.floor(middleHistory.length * 0.3));
  const retainedMiddle = middleHistory.slice(dropCountFromFront);

  return [...systemPrefix, ...retainedMiddle, lastNonSystemMessage];
}

export type StartBasicAssistantStreamRequestOptions = {
  apiConfig: ApiClientConfig;
  messages: ChatMessageParam[];
  messageId: string;
  chatHistory: ChatSessionHistoryMessage[];
  displayHistory: ChatSessionDisplayMessage[];
  runtime: Pick<
    BasicAssistantStreamRuntimeAccess,
    'getActiveRunId' | 'getActiveHistoryProcessSummary' | 'setAbortStream' | 'setActiveRunId' | 'setStepSequence' | 'setActiveHistoryProcessSummary'
  >;
  postMessage: (message: ExtensionMessage) => void;
  saveChatHistory: () => void;
  createDisplayMessageId: DisplayMessageIdFactory;
  createHistoryProcessSummary: () => HistoryProcessSummary;
  onToolCalls: (context: {
    fullContent: string;
    parsedToolCalls: ParsedToolCall[];
    displayContent: string;
    assistantTimestamp: number;
  }) => void | Promise<void>;
  onPlainCompleted?: () => void;
  onErrorBeforeNotify?: () => void;
  retryRequestId?: string;
  emitEmptyChunkOnFirstChunk?: boolean;
  toolCallTransitionStreamDoneBeforeUpdate?: boolean;
  completionStreamDoneBeforeUpdate?: boolean;
  processSummaryResolver?: () => HistoryProcessSummary | undefined;
  onDoneLog?: (fullContent: string, thinkingElapsed: number) => void;
  onErrorLog?: (rawErrorMessage: string, finalErrorMessage: string) => void;
  resolveErrorMessage?: (errorMessage: string) => string;
};

export function startBasicAssistantStreamRequest(options: StartBasicAssistantStreamRequestOptions): AbortStreamFn {
  const streamStartTime = Date.now();
  let isFirstChunk = true;

  // 可变状态：保存当前正在运行的消息集、max_tokens 和 abort 函数。
  // 只要检测到 context-length 错误，就用降级后的参数重启一次 stream，
  // 并把 currentAbort 指向新的 abort，这样外层返回的闭包仍能中断到最新的请求。
  let currentMessages = options.messages;
  let currentMaxTokens = options.apiConfig.maxTokens;
  let contextLengthRetryAttempted = false;
  let currentAbort: AbortStreamFn;

  function handleChunk(chunk: string): void {
    if (options.runtime.getActiveRunId() !== options.messageId) {
      return;
    }

    if (options.emitEmptyChunkOnFirstChunk && isFirstChunk) {
      isFirstChunk = false;
      options.postMessage({
        type: 'streamChunk',
        chunk: '',
        messageId: options.messageId,
      });
    }

    options.postMessage({
      type: 'streamChunk',
      chunk,
      messageId: options.messageId,
    });
  }

  function handleDone(fullContent: string): void {
    if (options.runtime.getActiveRunId() !== options.messageId) {
      return;
    }

    options.runtime.setAbortStream(null);
    const thinkingElapsed = Date.now() - streamStartTime;
    const assistantTimestamp = Date.now();
    options.chatHistory.push({
      role: 'assistant',
      content: fullContent,
      timestamp: assistantTimestamp,
    });
    options.onDoneLog?.(fullContent, thinkingElapsed);

    const assistantDisplayResult = applyAssistantResponseDisplay({
      displayHistory: options.displayHistory,
      content: fullContent,
      timestamp: assistantTimestamp,
      messageId: options.messageId,
      createDisplayMessageId: options.createDisplayMessageId,
      processSummary: options.processSummaryResolver?.(),
      retryRequestId: options.retryRequestId,
      thinkingElapsed,
      toolCallTransitionStreamDoneBeforeUpdate: options.toolCallTransitionStreamDoneBeforeUpdate,
      completionStreamDoneBeforeUpdate: options.completionStreamDoneBeforeUpdate,
    });

    if (assistantDisplayResult.kind === 'tool-calls') {
      const nextSummary = recordThinkingElapsedInActiveHistorySummary(
        options.runtime.getActiveHistoryProcessSummary(),
        thinkingElapsed,
        options.createHistoryProcessSummary,
      );
      options.runtime.setActiveHistoryProcessSummary(nextSummary);
      options.saveChatHistory();
      for (const message of assistantDisplayResult.messages) {
        options.postMessage(message);
      }
      void options.onToolCalls({
        fullContent,
        parsedToolCalls: assistantDisplayResult.parsedToolCalls,
        displayContent: assistantDisplayResult.displayContent,
        assistantTimestamp,
      });
      return;
    }

    options.saveChatHistory();
    for (const message of assistantDisplayResult.messages) {
      options.postMessage(message);
    }
    options.onPlainCompleted?.();

    const completionState = consumeRunCompletionState({
      activeHistoryProcessSummary: options.runtime.getActiveHistoryProcessSummary(),
    });
    options.runtime.setActiveRunId(completionState.nextActiveRunId);
    options.runtime.setStepSequence(completionState.nextStepSequence);
    options.runtime.setActiveHistoryProcessSummary(completionState.nextActiveHistoryProcessSummary);
  }

  function handleError(errorMessage: string): void {
    if (options.runtime.getActiveRunId() !== options.messageId) {
      return;
    }

    // 第一次遇到 context-length 错误时尝试自动降级重试一次。
    // 重试仍然失败或者已经重试过时，走原有错误处理，让用户看到友好的错误提示。
    if (!contextLengthRetryAttempted && isContextLengthError(errorMessage)) {
      const trimmedMessages = aggressivelyTrimMessagesAfterContextError(currentMessages);
      const reducedMaxTokens = Math.max(256, Math.floor(currentMaxTokens * 0.5));
      const canShrinkMessages = trimmedMessages.length < currentMessages.length;
      const canReduceCompletion = reducedMaxTokens < currentMaxTokens;

      if (canShrinkMessages || canReduceCompletion) {
        contextLengthRetryAttempted = true;
        info(
          `检测到 context-length 400，自动降级重试：messages ${currentMessages.length} → ${trimmedMessages.length}，max_tokens ${currentMaxTokens} → ${reducedMaxTokens}`,
        );
        currentMessages = trimmedMessages;
        currentMaxTokens = reducedMaxTokens;
        // 重新发起一次流式请求，并把 abort 句柄更新到 runtime
        currentAbort = startStream();
        options.runtime.setAbortStream(currentAbort);
        return;
      }
    }

    const completionState = consumeStreamingRunCompletionState({
      activeHistoryProcessSummary: options.runtime.getActiveHistoryProcessSummary(),
    });
    options.runtime.setAbortStream(completionState.nextAbortStream);
    options.runtime.setActiveRunId(completionState.nextActiveRunId);
    options.runtime.setStepSequence(completionState.nextStepSequence);
    options.postMessage({ type: 'setLoading', loading: false });
    options.onErrorBeforeNotify?.();

    const finalErrorMessage = options.resolveErrorMessage
      ? options.resolveErrorMessage(errorMessage)
      : errorMessage;
    options.postMessage({
      type: 'showError',
      message: finalErrorMessage,
      retryRequestId: options.retryRequestId,
    });
    options.runtime.setActiveHistoryProcessSummary(completionState.nextActiveHistoryProcessSummary);
    options.onErrorLog?.(errorMessage, finalErrorMessage);
  }

  function startStream(): AbortStreamFn {
    // 每次（包括重试）都用最新的 currentMessages / currentMaxTokens 构造 apiConfig。
    // 保留 apiConfig 其余字段（apiKey / baseUrl / 温度等）不变。
    const effectiveApiConfig: ApiClientConfig = {
      ...options.apiConfig,
      maxTokens: currentMaxTokens,
    };
    return sendStreamRequest(
      effectiveApiConfig,
      currentMessages,
      handleChunk,
      handleDone,
      handleError,
    );
  }

  currentAbort = startStream();
  // 外层返回的 abort 闭包：每次调用都会中断最新的 currentAbort，
  // 这样即使发生过重试，用户主动停止仍能作用到当前正在运行的请求。
  return () => currentAbort();
}
