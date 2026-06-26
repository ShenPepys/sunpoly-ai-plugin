import type { AbortStreamFn } from '../api/client';
import type { ChangeSummaryFile, WriteBackupEntry } from './fileChanges';
import type { PendingRegenerateState } from './ChatViewProvider_regenerate';
import { hasRunningTask as hasRunningTaskHelper } from './ChatViewProvider_runtimeState';
import type { HistoryProcessSummary, WorkMode } from './messageTypes';
import type { SessionStore } from './SessionStore';

export type SessionRuntimeState = {
  activeRunId: string | null;
  abortStream: AbortStreamFn | null;
  toolCallsInProgress: boolean;
  stepSequence: number;
  toolCallRound: number;
  turnWriteFiles: ChangeSummaryFile[];
  turnWriteRounds: number;
  recoverableWriteFailRounds: number;
  activeHistoryProcessSummary: HistoryProcessSummary | null;
  pendingRegenerateState: PendingRegenerateState | null;
  writeBackups: Map<string, WriteBackupEntry>;
  stepToMessageId: Map<string, string>;
  summaryToMessageId: Map<string, string>;
  currentMode: WorkMode;
  contextFiles: string[];
};

export const LAUNCHER_SESSION_RUNTIME_KEY = '__launcher__';

export function createSessionRuntimeState(): SessionRuntimeState {
  return {
    activeRunId: null,
    abortStream: null,
    toolCallsInProgress: false,
    stepSequence: 0,
    toolCallRound: 0,
    turnWriteFiles: [],
    turnWriteRounds: 0,
    recoverableWriteFailRounds: 0,
    activeHistoryProcessSummary: null,
    pendingRegenerateState: null,
    writeBackups: new Map(),
    stepToMessageId: new Map(),
    summaryToMessageId: new Map(),
    currentMode: 'code',
    contextFiles: [],
  };
}

export function getSessionRuntimeKey(sessionId: string): string {
  return sessionId || LAUNCHER_SESSION_RUNTIME_KEY;
}

export class SessionRuntimeManager {
  private readonly sessionRuntimeBySessionId = new Map<string, SessionRuntimeState>();

  constructor(
    private readonly engineId: string,
    private readonly store: SessionStore,
    private readonly getActiveSessionId: () => string,
  ) {}

  getSessionRuntimeState(sessionId: string = this.getActiveSessionId()): SessionRuntimeState {
    const runtimeKey = getSessionRuntimeKey(sessionId);
    const existingRuntime = this.sessionRuntimeBySessionId.get(runtimeKey);
    if (existingRuntime) {
      return existingRuntime;
    }

    const nextRuntime = createSessionRuntimeState();
    this.sessionRuntimeBySessionId.set(runtimeKey, nextRuntime);
    return nextRuntime;
  }

  clearSessionRuntimeState(sessionId: string): void {
    const runtimeKey = getSessionRuntimeKey(sessionId);
    this.sessionRuntimeBySessionId.delete(runtimeKey);
  }

  hasRunningTaskElsewhere(sessionId: string = this.getActiveSessionId()): boolean {
    const runLock = this.store.getRunLock(sessionId);
    return !!runLock && runLock.ownerId !== this.engineId;
  }

  isSessionRunningInOtherTab(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    return this.hasRunningTaskElsewhere(sessionId);
  }

  hasRunningTask(sessionId: string = this.getActiveSessionId()): boolean {
    const runtime = this.getSessionRuntimeState(sessionId);
    return hasRunningTaskHelper({
      activeRunId: runtime.activeRunId,
      abortStream: runtime.abortStream,
      toolCallsInProgress: runtime.toolCallsInProgress,
    });
  }

  setSessionActiveRunIdState(sessionId: string, nextActiveRunId: string | null): void {
    const runtime = this.getSessionRuntimeState(sessionId);
    if (nextActiveRunId === null) {
      this.store.releaseRunLock({
        ownerId: this.engineId,
        sessionId,
        runId: runtime.activeRunId ?? undefined,
      });
    }

    runtime.activeRunId = nextActiveRunId;
  }

  getCrossTabRunConflictMessage(sessionId: string): string {
    const runLock = this.store.getRunLock(sessionId);
    if (runLock && runLock.ownerId !== this.engineId) {
      return '当前会话正在其他聊天 Tab 中生成，请先停止当前任务后再继续。';
    }

    return '当前会话已有进行中的任务，请先停止当前任务后再继续。';
  }

  tryAcquireSessionRunLock(sessionId: string, runId: string): string | null {
    if (!sessionId) {
      return '当前没有可用会话，请重新发送消息。';
    }

    const acquireResult = this.store.tryAcquireRunLock({
      ownerId: this.engineId,
      sessionId,
      runId,
    });
    if (acquireResult.acquired) {
      return null;
    }

    return this.getCrossTabRunConflictMessage(sessionId);
  }

  tryAcquireCurrentSessionRunLock(runId: string): string | null {
    return this.tryAcquireSessionRunLock(this.getActiveSessionId(), runId);
  }

  resetOwnedRunState(sessionId: string = this.getActiveSessionId()): void {
    const runtime = this.getSessionRuntimeState(sessionId);
    this.setSessionActiveRunIdState(sessionId, null);
    runtime.abortStream = null;
    runtime.toolCallsInProgress = false;
    runtime.stepSequence = 0;
    runtime.toolCallRound = 0;
    runtime.activeHistoryProcessSummary = null;
  }
}
