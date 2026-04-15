import type { ChatMessageParam } from '../api/types';
import type { PendingRegenerateState } from './ChatViewProvider_g_regenerate';
import type { HistoryProcessSummary } from './messageTypes';
import type { ParsedToolCall } from '../tools';

export type RunningTaskState = {
  activeRunId: string | null;
  abortStream: unknown;
  toolCallsInProgress: boolean;
};

export function hasRunningTask(state: RunningTaskState): boolean {
  return state.activeRunId !== null
    || state.abortStream !== null
    || state.toolCallsInProgress;
}

export type StopGenerationState = {
  activeRunId: string | null;
  abortStream: unknown;
};

export type StopGenerationResult = {
  stoppedRunId: string | null;
  abortStreamToStop: unknown;
  nextActiveRunId: null;
  nextAbortStream: null;
  nextToolCallsInProgress: false;
  nextStepSequence: 0;
  nextToolCallRound: 0;
  nextActiveHistoryProcessSummary: null;
};

export function consumeStopGenerationRequest(state: StopGenerationState): StopGenerationResult {
  return {
    stoppedRunId: state.activeRunId,
    abortStreamToStop: state.abortStream,
    nextActiveRunId: null,
    nextAbortStream: null,
    nextToolCallsInProgress: false,
    nextStepSequence: 0,
    nextToolCallRound: 0,
    nextActiveHistoryProcessSummary: null,
  };
}

export type BeginStreamingRunState = {
  abortStream: unknown;
  runId: string;
};

export type BeginStreamingRunResult = {
  abortStreamToStop: unknown;
  nextAbortStream: null;
  nextToolCallsInProgress: false;
  nextActiveRunId: string;
  nextStepSequence: 0;
  nextToolCallRound: 0;
};

export function beginStreamingRun(state: BeginStreamingRunState): BeginStreamingRunResult {
  return {
    abortStreamToStop: state.abortStream,
    nextAbortStream: null,
    nextToolCallsInProgress: false,
    nextActiveRunId: state.runId,
    nextStepSequence: 0,
    nextToolCallRound: 0,
  };
}

export type RunCompletionStateOptions = {
  activeHistoryProcessSummary: HistoryProcessSummary | null;
  resetActiveHistoryProcessSummary?: boolean;
};

export type RunCompletionStateResult = {
  nextActiveRunId: null;
  nextStepSequence: 0;
  nextActiveHistoryProcessSummary: HistoryProcessSummary | null;
};

export function consumeRunCompletionState(
  options: RunCompletionStateOptions,
): RunCompletionStateResult {
  return {
    nextActiveRunId: null,
    nextStepSequence: 0,
    nextActiveHistoryProcessSummary: options.resetActiveHistoryProcessSummary === false
      ? options.activeHistoryProcessSummary
      : null,
  };
}

export type StreamingRunCompletionStateResult = RunCompletionStateResult & {
  nextAbortStream: null;
};

export function consumeStreamingRunCompletionState(
  options: RunCompletionStateOptions,
): StreamingRunCompletionStateResult {
  return {
    nextAbortStream: null,
    ...consumeRunCompletionState(options),
  };
}

export type SessionScopedRuntimeResetOptions = {
  abortStream: unknown;
  clearContextFiles?: boolean;
};

export type SessionScopedRuntimeResetResult<ChangedFile = never> = {
  abortStreamToStop: unknown;
  nextActiveRunId: null;
  nextAbortStream: null;
  nextToolCallsInProgress: false;
  nextStepSequence: 0;
  nextToolCallRound: 0;
  nextTurnWriteFiles: ChangedFile[];
  nextTurnWriteRounds: 0;
  shouldClearWriteBackups: true;
  nextPendingRegenerateState: null;
  nextActiveHistoryProcessSummary: null;
  shouldClearContextFiles: boolean;
  nextContextFiles: string[];
};

export function consumeSessionScopedRuntimeReset<ChangedFile = never>(
  options: SessionScopedRuntimeResetOptions,
): SessionScopedRuntimeResetResult<ChangedFile> {
  return {
    abortStreamToStop: options.abortStream,
    nextActiveRunId: null,
    nextAbortStream: null,
    nextToolCallsInProgress: false,
    nextStepSequence: 0,
    nextToolCallRound: 0,
    nextTurnWriteFiles: [],
    nextTurnWriteRounds: 0,
    shouldClearWriteBackups: true,
    nextPendingRegenerateState: null,
    nextActiveHistoryProcessSummary: null,
    shouldClearContextFiles: options.clearContextFiles !== false,
    nextContextFiles: [],
  };
}

export function clearPendingRegenerateState(
  pendingState: PendingRegenerateState | null,
  runId: string,
): PendingRegenerateState | null {
  if (!pendingState || pendingState.runId !== runId) {
    return pendingState;
  }

  return null;
}

export function consumePendingRegenerateState(
  pendingState: PendingRegenerateState | null,
  runId: string,
): { matched: false; nextState: PendingRegenerateState | null } | { matched: true; nextState: null; consumedState: PendingRegenerateState } {
  if (!pendingState || pendingState.runId !== runId) {
    return {
      matched: false,
      nextState: pendingState,
    };
  }

  return {
    matched: true,
    nextState: null,
    consumedState: pendingState,
  };
}

export function resetActiveHistoryProcessSummary(): HistoryProcessSummary | null {
  return null;
}

export function getClonedActiveHistoryProcessSummary(
  activeSummary: HistoryProcessSummary | null,
  cloneHistoryProcessSummary: (summary: HistoryProcessSummary) => HistoryProcessSummary,
): HistoryProcessSummary | undefined {
  if (!activeSummary || activeSummary.totalSteps === 0) {
    return undefined;
  }

  return cloneHistoryProcessSummary(activeSummary);
}

export function recordThinkingElapsedInActiveHistorySummary(
  activeSummary: HistoryProcessSummary | null,
  elapsedMs: number,
  createHistoryProcessSummary: () => HistoryProcessSummary,
): HistoryProcessSummary | null {
  if (elapsedMs <= 1000) {
    return activeSummary;
  }

  const nextSummary = activeSummary ?? createHistoryProcessSummary();
  nextSummary.thinkingElapsedMs = elapsedMs;
  return nextSummary;
}

export function recordToolStepInActiveHistorySummary(
  activeSummary: HistoryProcessSummary | null,
  toolCall: ParsedToolCall,
  success: boolean,
  changedFilePath: string | undefined,
  createHistoryProcessSummary: () => HistoryProcessSummary,
  toChangedFileDisplayPath: (filePath: string) => string,
): HistoryProcessSummary {
  const summary = activeSummary ?? createHistoryProcessSummary();
  summary.totalSteps += 1;

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

  if (!success) {
    summary.failedCount += 1;
    return summary;
  }

  if (changedFilePath && (toolCall.type === 'write_file' || toolCall.type === 'edit_file')) {
    const displayPath = toChangedFileDisplayPath(changedFilePath);
    if (!summary.changedFiles.includes(displayPath)) {
      summary.changedFiles.push(displayPath);
    }
  }

  return summary;
}

export type RollbackPendingRegenerateStateOptions = {
  pendingState: PendingRegenerateState | null;
  runId: string;
  cloneDisplayHistoryMessages: (displayHistory: PendingRegenerateState['displayHistory']) => PendingRegenerateState['displayHistory'];
  cloneUiTranscript: (uiTranscript: PendingRegenerateState['uiTranscript']) => PendingRegenerateState['uiTranscript'];
  cloneHistoryProcessSummary: (summary: HistoryProcessSummary) => HistoryProcessSummary;
};

export type RollbackPendingRegenerateStateResult =
  | {
    rolledBack: false;
    nextPendingState: PendingRegenerateState | null;
  }
  | {
    rolledBack: true;
    nextPendingState: null;
    restoredHistory: ChatMessageParam[];
    restoredDisplayHistory: PendingRegenerateState['displayHistory'];
    restoredUiTranscript: PendingRegenerateState['uiTranscript'];
    messageId: string;
    restoreContent: string;
    restoreProcessSummary?: HistoryProcessSummary;
  };

export function rollbackPendingRegenerateState(
  options: RollbackPendingRegenerateStateOptions,
): RollbackPendingRegenerateStateResult {
  const consumeResult = consumePendingRegenerateState(options.pendingState, options.runId);
  if (!consumeResult.matched) {
    return {
      rolledBack: false,
      nextPendingState: consumeResult.nextState,
    };
  }

  return {
    rolledBack: true,
    nextPendingState: null,
    restoredHistory: consumeResult.consumedState.history as ChatMessageParam[],
    restoredDisplayHistory: options.cloneDisplayHistoryMessages(consumeResult.consumedState.displayHistory),
    restoredUiTranscript: options.cloneUiTranscript(consumeResult.consumedState.uiTranscript),
    messageId: consumeResult.consumedState.messageId,
    restoreContent: consumeResult.consumedState.restoreContent,
    restoreProcessSummary: consumeResult.consumedState.restoreProcessSummary
      ? options.cloneHistoryProcessSummary(consumeResult.consumedState.restoreProcessSummary)
      : undefined,
  };
}
