import { getMaxTokens, getModelConfig } from '../config';
import { sendStreamRequest } from '../api/client';
import type { AbortStreamFn, ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import type { ModelConfig } from '../prompts/types';
import { formatToolResults } from '../tools';
import type { ParsedToolCall } from '../tools';
import {
  applyAssistantResponseDisplay,
  appendDisplayHistoryUserMessage,
  getUserDisplayContent,
} from './ChatViewProvider_c_displayHistory';
import type { DisplayMessageIdFactory } from './ChatViewProvider_c_displayHistory';
import {
  buildAppliedChangeSummaryResponses,
  executeToolCallBatch,
  upsertChangeSummaryFile,
} from './ChatViewProvider_d_fileChanges';
import type { ChangeSummaryFile, WriteBackupEntry } from './ChatViewProvider_d_fileChanges';
import { buildUserContentWithContext } from './ChatViewProvider_e_workspaceContext';
import {
  cloneRequestImages,
  rememberRetryableRequest,
} from './ChatViewProvider_i_retryRequests';
import type {
  RequestImageAttachment,
  RetryableRequestState,
} from './ChatViewProvider_i_retryRequests';
import {
  beginStreamingRun,
  consumeRunCompletionState,
  consumeStreamingRunCompletionState,
  recordThinkingElapsedInActiveHistorySummary,
  recordToolStepInActiveHistorySummary,
} from './ChatViewProvider_k_runtimeState';
import {
  buildChatRequestMessages,
  buildUserRequestContent,
  prepareRemindedMessages,
} from './ChatViewProvider_n_modelAndSession';
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
};

export type ExecuteToolCallBatchRoundResult =
  | {
    kind: 'halted';
    nextStepSequence: number;
    nextTurnWriteRounds: number;
    nextActiveHistoryProcessSummary: HistoryProcessSummary | null;
    shouldFinalizeStoppedRun: boolean;
  }
  | {
    kind: 'follow-up';
    nextStepSequence: number;
    nextTurnWriteRounds: number;
    nextActiveHistoryProcessSummary: HistoryProcessSummary | null;
    followUpSystemPrompt: string;
    followUpMessages: ChatMessageParam[];
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

  if (batchExecution.status === 'interrupted') {
    return {
      kind: 'halted',
      nextStepSequence: batchExecution.nextStepSequence,
      nextTurnWriteRounds,
      nextActiveHistoryProcessSummary,
      shouldFinalizeStoppedRun: options.getActiveRunId() === null,
    };
  }

  if (options.getActiveRunId() !== options.messageId) {
    return {
      kind: 'halted',
      nextStepSequence: batchExecution.nextStepSequence,
      nextTurnWriteRounds,
      nextActiveHistoryProcessSummary,
      shouldFinalizeStoppedRun: options.getActiveRunId() === null,
    };
  }

  const resultText = formatToolResults(batchExecution.toolResults);
  const toolFeedback = [
    '以下是工具执行结果（不要在回复中重复展示这些原始数据，直接基于结果回答用户的问题）：',
    '',
    resultText,
  ].join('\n');
  options.chatHistory.push({ role: 'user', content: toolFeedback });
  options.saveChatHistory();

  const modelConfig = getModelConfig();
  const followUpRequest = buildChatRequestMessages({
    modelConfig,
    requestMode: options.requestMode,
    remindedMessages: prepareRemindedMessages({
      history: options.historyForFollowUp,
      requestMode: options.requestMode,
      contextWindow: modelConfig.contextWindow,
      maxTokens: getMaxTokens(),
    }),
    allowCustomPrompt: false,
  });

  return {
    kind: 'follow-up',
    nextStepSequence: batchExecution.nextStepSequence,
    nextTurnWriteRounds,
    nextActiveHistoryProcessSummary,
    followUpSystemPrompt: followUpRequest.systemPrompt,
    followUpMessages: followUpRequest.messages,
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

  return sendStreamRequest(
    options.apiConfig,
    options.messages,
    chunk => {
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
    },
    fullContent => {
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
    },
    errorMessage => {
      if (options.runtime.getActiveRunId() !== options.messageId) {
        return;
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
    },
  );
}
