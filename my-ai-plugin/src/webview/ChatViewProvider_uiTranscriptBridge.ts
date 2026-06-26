import type {
  ChatSession,
  ExtensionMessage,
  PersistedUiEntry,
  PersistedUiEvent,
  PersistedUiMessageEntry,
} from './messageTypes';
import type { WriteBackupEntry } from './fileChanges';
import { capturePersistedUiState } from './ChatViewProvider_persistedUi';
import {
  appendUiError,
  appendUiEvent as appendUiEventHelper,
  cloneUiTranscript as cloneUiTranscriptHelper,
  collectUndoableSummaryIdsForMessage as collectUndoableSummaryIdsForMessageHelper,
  ensureUiMessageEntry as ensureUiMessageEntryHelper,
  expireUndoableSummariesForMessageIds as expireUndoableSummariesForMessageIdsHelper,
  expireUndoableSummariesForWriteBackups as expireUndoableSummariesForWriteBackupsHelper,
  expireUndoableSiblingSummaries as expireUndoableSiblingSummariesHelper,
  findMessageIdByStepId as findMessageIdByStepIdHelper,
  findMessageIdBySummaryId as findMessageIdBySummaryIdHelper,
  findUiMessageEntry as findUiMessageEntryHelper,
  getUiMessageCreatedAt as getUiMessageCreatedAtHelper,
  markUiMessageStopped as markUiMessageStoppedHelper,
  rebuildUiMessageIndexes as rebuildUiMessageIndexesHelper,
  removeLastAssistantUiMessage as removeLastAssistantUiMessageHelper,
  resetUiMessageState as resetUiMessageStateHelper,
  resetUiRuntimeState as resetUiRuntimeStateHelper,
  restoreUiTranscriptToWebview as restoreUiTranscriptToWebviewHelper,
  setUiMessageContent as setUiMessageContentHelper,
} from './ChatViewProvider_uiTranscript';

export type UiMessageIndexes = {
  stepToMessageId: Map<string, string>;
  summaryToMessageId: Map<string, string>;
};

export type UiTranscriptBridgeDeps = {
  getActiveSessionId: () => string;
  getSessionById: (sessionId: string) => ChatSession | undefined;
  getUiTranscriptForSession: (sessionId: string) => PersistedUiEntry[];
  getUiMessageIndexes: (sessionId: string) => UiMessageIndexes;
  postSessionMessage: (sessionId: string, message: ExtensionMessage) => void;
  hostPostMessage: (message: ExtensionMessage) => void;
  persistActiveSession: () => void;
};

export function createUiTranscriptBridge(deps: UiTranscriptBridgeDeps) {
  const resolveSessionId = (sessionId?: string) => sessionId ?? deps.getActiveSessionId();

  return {
    capturePersistedUiState(sessionId: string, message: ExtensionMessage): void {
      if (!deps.getSessionById(sessionId)) {
        return;
      }

      const shouldPersist = capturePersistedUiState({
        transcript: deps.getUiTranscriptForSession(sessionId),
        indexes: deps.getUiMessageIndexes(sessionId),
        message,
      });

      if (shouldPersist) {
        this.persistUiTranscript(sessionId);
      }
    },

    persistUiTranscript(sessionId: string = deps.getActiveSessionId()): void {
      if (!deps.getSessionById(sessionId)) {
        return;
      }

      deps.persistActiveSession();
    },

    ensureUiMessageEntry(
      messageId: string,
      role: 'user' | 'assistant',
      createdAt: number,
      sessionId?: string,
    ): PersistedUiMessageEntry | null {
      return ensureUiMessageEntryHelper(deps.getUiTranscriptForSession(resolveSessionId(sessionId)), messageId, role, createdAt);
    },

    findUiMessageEntry(messageId: string, sessionId?: string): PersistedUiMessageEntry | null {
      return findUiMessageEntryHelper(deps.getUiTranscriptForSession(resolveSessionId(sessionId)), messageId);
    },

    getUiMessageCreatedAt(messageId: string, fallback = Date.now(), sessionId?: string): number {
      return getUiMessageCreatedAtHelper(deps.getUiTranscriptForSession(resolveSessionId(sessionId)), messageId, fallback);
    },

    setUiMessageContent(
      messageId: string,
      role: 'user' | 'assistant',
      createdAt: number,
      content: string,
      partial = false,
      sessionId?: string,
    ): void {
      setUiMessageContentHelper(deps.getUiTranscriptForSession(resolveSessionId(sessionId)), messageId, role, createdAt, content, partial);
    },

    appendUiError(
      message: string,
      retryable = true,
      createdAt = Date.now(),
      sessionId?: string,
    ): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      if (!deps.getSessionById(resolvedSessionId)) {
        return;
      }

      appendUiError(deps.getUiTranscriptForSession(resolvedSessionId), message, retryable, createdAt);
    },

    appendUiEvent(messageId: string, event: PersistedUiEvent, sessionId?: string): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      appendUiEventHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        messageId,
        event,
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    resetUiRuntimeState(sessionId?: string): void {
      resetUiRuntimeStateHelper(deps.getUiMessageIndexes(resolveSessionId(sessionId)));
    },

    rebuildUiMessageIndexes(sessionId?: string): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      rebuildUiMessageIndexesHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    findMessageIdByStepId(stepId: string, sessionId?: string): string | null {
      const resolvedSessionId = resolveSessionId(sessionId);
      return findMessageIdByStepIdHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        stepId,
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    findMessageIdBySummaryId(summaryId: string, sessionId?: string): string | null {
      const resolvedSessionId = resolveSessionId(sessionId);
      return findMessageIdBySummaryIdHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        summaryId,
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    collectUndoableSummaryIdsForMessage(messageId: string, sessionId?: string): string[] {
      return collectUndoableSummaryIdsForMessageHelper(deps.getUiTranscriptForSession(resolveSessionId(sessionId)), messageId);
    },

    expireUndoableSummariesForMessageIds(
      messageIds: string[],
      sessionId: string,
      options?: { excludeSummaryIds?: string[]; text?: string },
    ): void {
      expireUndoableSummariesForMessageIdsHelper(
        deps.getUiTranscriptForSession(sessionId),
        messageIds,
        msg => deps.postSessionMessage(sessionId, msg),
        options,
      );
    },

    expireUndoableSummariesForWriteBackups(
      writeBackups: Map<string, WriteBackupEntry>,
      sessionId: string,
      text = 'Undo expired',
    ): void {
      expireUndoableSummariesForWriteBackupsHelper(
        deps.getUiTranscriptForSession(sessionId),
        writeBackups,
        msg => deps.postSessionMessage(sessionId, msg),
        text,
      );
    },

    expireUndoableSiblingSummaries(summaryId: string, sessionId: string): void {
      expireUndoableSiblingSummariesHelper(
        deps.getUiTranscriptForSession(sessionId),
        summaryId,
        deps.getUiMessageIndexes(sessionId),
        msg => deps.postSessionMessage(sessionId, msg),
      );
    },

    resetUiMessageState(messageId: string, sessionId?: string): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      resetUiMessageStateHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        messageId,
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    removeLastAssistantUiMessage(sessionId?: string): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      removeLastAssistantUiMessageHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    markUiMessageStopped(messageId: string, sessionId?: string): void {
      const resolvedSessionId = resolveSessionId(sessionId);
      markUiMessageStoppedHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        messageId,
        deps.getUiMessageIndexes(resolvedSessionId),
      );
    },

    restoreUiTranscriptToWebview(sessionId?: string): boolean {
      const resolvedSessionId = resolveSessionId(sessionId);
      return restoreUiTranscriptToWebviewHelper(
        deps.getUiTranscriptForSession(resolvedSessionId),
        deps.getUiMessageIndexes(resolvedSessionId),
        message => deps.hostPostMessage(message),
      );
    },

    cloneUiTranscript(uiTranscript: PersistedUiEntry[]): PersistedUiEntry[] {
      return cloneUiTranscriptHelper(uiTranscript);
    },
  };
}

export type UiTranscriptBridge = ReturnType<typeof createUiTranscriptBridge>;
