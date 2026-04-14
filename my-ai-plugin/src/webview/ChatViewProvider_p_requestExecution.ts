import { getMaxTokens, getModelConfig } from '../config';
import { sendStreamRequest } from '../api/client';
import type { AbortStreamFn, ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import type { ModelConfig } from '../prompts/types';
import type { ParsedToolCall, ToolExecutionResult } from '../tools';
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
  buildUserRequestContent,
  prepareChatRequestExecution,
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
    followUpApiConfig: ApiClientConfig;
  };

 const MAX_TOOL_RESULT_SNIPPET_CHARS = 1600;
 const MAX_DIRECTORY_ENTRIES_IN_FEEDBACK = 40;
 const MAX_DEFERRED_TOOL_CALLS_IN_FEEDBACK = 12;

 function truncateFeedbackText(content: string, maxChars: number, suffix: string): string {
   if (content.length <= maxChars) {
     return content;
   }

   return `${content.slice(0, maxChars)}\n${suffix}`;
 }

 function buildReadResultSummary(result: ToolExecutionResult): string {
   const content = result.result.content || '';
   const lineCount = content ? content.split(/\r?\n/).length : 0;
   const snippet = truncateFeedbackText(
     content,
     MAX_TOOL_RESULT_SNIPPET_CHARS,
     `...(内容已压缩，原始返回 ${content.length} 字符，如仍需细读请继续读取该文件)`,
   );

   return [
     `### 读取文件 ${result.toolCall.path}`,
     `- 状态：${result.result.success ? '成功' : '失败'}`,
     `- 估计行数：${lineCount}`,
     '- 关键信息片段：',
     '```',
     snippet,
     '```',
   ].join('\n');
 }

 function buildListResultSummary(result: ToolExecutionResult): string {
   const lines = (result.result.content || '').split(/\r?\n/).filter(Boolean);
   const directoryCount = lines.filter(line => line.startsWith('[DIR]')).length;
   const fileCount = lines.filter(line => line.startsWith('[FILE]')).length;
   const visibleLines = lines.slice(0, MAX_DIRECTORY_ENTRIES_IN_FEEDBACK);
   const suffix = lines.length > visibleLines.length
     ? `...(目录项已压缩，原始共 ${lines.length} 项)`
     : '';

   return [
     `### 目录列表 ${result.toolCall.path}`,
     `- 状态：${result.result.success ? '成功' : '失败'}`,
     `- 条目统计：目录 ${directoryCount}，文件 ${fileCount}，合计 ${lines.length}`,
     '- 条目摘要：',
     '```',
     visibleLines.join('\n') || '(空目录)',
     suffix,
     '```',
   ].join('\n');
 }

 function buildWriteResultSummary(result: ToolExecutionResult): string {
   const content = truncateFeedbackText(
     result.result.content || '',
     500,
     '...(结果已压缩)',
   );

   return [
     `### ${result.toolCall.type} ${result.toolCall.path}`,
     `- 状态：${result.result.success ? '成功' : '失败'}`,
     '- 结果：',
     '```',
     content,
     '```',
   ].join('\n');
 }

 function buildSingleToolResultSummary(result: ToolExecutionResult): string {
   if (result.toolCall.type === 'read_file') {
     return buildReadResultSummary(result);
   }

   if (result.toolCall.type === 'list_dir') {
     return buildListResultSummary(result);
   }

   return buildWriteResultSummary(result);
 }

 function buildDeferredToolCallsSummary(toolCalls: ParsedToolCall[]): string {
   if (toolCalls.length === 0) {
     return '';
   }

   const visibleToolCalls = toolCalls.slice(0, MAX_DEFERRED_TOOL_CALLS_IN_FEEDBACK);
   const lines = visibleToolCalls.map(toolCall => `- ${toolCall.type} ${toolCall.path}`);

   if (toolCalls.length > visibleToolCalls.length) {
     lines.push(`- ...(其余 ${toolCalls.length - visibleToolCalls.length} 个待读操作已省略)`);
   }

   return [
     '## 待读取目标（上一轮计划但本轮未执行）',
     ...lines,
   ].join('\n');
 }

 function buildToolFeedback(options: {
   toolResults: ToolExecutionResult[];
   deferredToolCalls: ParsedToolCall[];
   readOnlyBatchLimited: boolean;
 }): string {
   const sections: string[] = [
     '以下是本轮工具执行后的阶段摘要。不要原样复述这些结果，请基于它们继续分析并决定下一步。',
   ];

   if (options.readOnlyBatchLimited) {
     sections.push(
       `为了避免本地模型上下文过长，本轮只执行了少量只读工具调用，仍有 ${options.deferredToolCalls.length} 个待读取项被延后。请先基于当前结果给出阶段判断，再继续读取下一批最关键的 1~3 个文件或目录，不要一次请求过多 read_file / list_dir。`,
     );
   }

   sections.push('## 本轮执行结果');
   sections.push(
     options.toolResults.map(result => buildSingleToolResultSummary(result)).join('\n\n'),
   );

   if (options.deferredToolCalls.length > 0) {
     sections.push(buildDeferredToolCallsSummary(options.deferredToolCalls));
     sections.push('如果信息仍然不足，请继续读取最关键的下一批文件；如果已经足够回答，再给出最终结论。');
   }

   return sections.filter(Boolean).join('\n\n');
 }

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

  const toolFeedback = buildToolFeedback({
    toolResults: batchExecution.toolResults,
    deferredToolCalls: batchExecution.deferredToolCalls,
    readOnlyBatchLimited: batchExecution.readOnlyBatchLimited,
  });
  options.chatHistory.push({ role: 'user', content: toolFeedback });
  options.saveChatHistory();

  const modelConfig = getModelConfig();
  const followUpRequest = prepareChatRequestExecution({
    modelConfig,
    requestMode: options.requestMode,
    remindedMessages: prepareRemindedMessages({
      history: options.historyForFollowUp,
      requestMode: options.requestMode,
      contextWindow: modelConfig.contextWindow,
      maxTokens: getMaxTokens(),
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
