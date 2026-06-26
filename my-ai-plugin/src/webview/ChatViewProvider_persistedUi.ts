import type { ExtensionMessage, PersistedUiEntry, PersistedUiEvent } from './messageTypes';
import {
  appendUiError,
  appendUiEvent,
  ensureUiMessageEntry,
  findMessageIdByStepId,
  findMessageIdBySummaryId,
  findUiMessageEntry,
  getUiMessageCreatedAt,
  markUiMessageStopped,
  removeLastAssistantUiMessage,
  resetUiMessageState,
  setUiMessageContent,
} from './ChatViewProvider_uiTranscript';

export type CapturePersistedUiStateOptions = {
  transcript: PersistedUiEntry[];
  indexes: { stepToMessageId: Map<string, string>; summaryToMessageId: Map<string, string> };
  message: ExtensionMessage;
};

/**
 * 将 ExtensionMessage 分发到对应的 uiTranscript 操作。
 * 纯函数：只修改 transcript / indexes，不涉及持久化或 webview 推送。
 *
 * @returns true 如果调用方应该在处理后持久化 uiTranscript
 */
export function capturePersistedUiState(options: CapturePersistedUiStateOptions): boolean {
  const { transcript, indexes, message } = options;

  switch (message.type) {
    case 'addMessage':
      setUiMessageContent(
        transcript,
        message.messageId,
        message.role,
        message.createdAt ?? Date.now(),
        message.content,
        !!message.partial,
      );
      return message.role === 'user' && !message.readOnly;

    case 'streamChunk': {
      const createdAt = getUiMessageCreatedAt(transcript, message.messageId, message.createdAt ?? Date.now());
      const entry = ensureUiMessageEntry(transcript, message.messageId, 'assistant', createdAt);
      if (!entry) {
        return false;
      }

      entry.content += message.chunk;
      entry.partial = true;
      return false;
    }

    case 'streamDone': {
      const entry = findUiMessageEntry(transcript, message.messageId);
      if (entry && entry.role === 'assistant') {
        delete entry.partial;
        return true;
      }
      return false;
    }

    case 'updateMessage':
      setUiMessageContent(
        transcript,
        message.messageId,
        'assistant',
        getUiMessageCreatedAt(transcript, message.messageId, Date.now()),
        message.content,
        false,
      );
      return true;

    case 'showError':
      appendUiError(transcript, message.message, message.retryable, message.createdAt ?? Date.now());
      return true;

    case 'generationStopped':
      if (message.messageId) {
        markUiMessageStopped(transcript, message.messageId, indexes);
        return true;
      }
      return false;

    case 'thinkingComplete':
      appendUiEvent(transcript, message.messageId, {
        type: 'thinkingComplete',
        elapsed: message.elapsed,
      } as PersistedUiEvent, indexes);
      return true;

    case 'showHistoryProcessSummary':
      appendUiEvent(transcript, message.messageId, {
        type: 'showHistoryProcessSummary',
        summary: message.summary,
      } as PersistedUiEvent, indexes);
      return true;

    case 'addStep':
      appendUiEvent(transcript, message.messageId, {
        type: 'addStep',
        stepId: message.stepId,
        icon: message.icon,
        description: message.description,
        status: message.status,
      } as PersistedUiEvent, indexes);
      return true;

    case 'updateStep': {
      const messageId = findMessageIdByStepId(transcript, message.stepId, indexes);
      if (!messageId) {
        return false;
      }

      appendUiEvent(transcript, messageId, {
        type: 'updateStep',
        stepId: message.stepId,
        status: message.status,
        description: message.description,
        elapsed: message.elapsed,
      } as PersistedUiEvent, indexes);
      return true;
    }

    case 'showDiff':
      appendUiEvent(transcript, message.messageId, {
        type: 'showDiff',
        stepId: message.stepId,
        summaryId: message.summaryId,
        filePath: message.filePath,
        language: message.language,
        additions: message.additions,
        deletions: message.deletions,
        oldContent: message.oldContent,
        newContent: message.newContent,
        noticeText: message.noticeText,
        needsConfirm: message.needsConfirm,
        collapsed: message.collapsed,
        readOnly: message.readOnly,
      } as PersistedUiEvent, indexes);
      return true;

    case 'showChangeSummary':
      appendUiEvent(transcript, message.messageId, {
        type: 'showChangeSummary',
        summaryId: message.summaryId,
        needsConfirm: message.needsConfirm,
        files: message.files,
      } as PersistedUiEvent, indexes);
      return true;

    case 'updateChangeSummary': {
      const messageId = findMessageIdBySummaryId(transcript, message.summaryId, indexes);
      if (!messageId) {
        return false;
      }

      appendUiEvent(transcript, messageId, {
        type: 'updateChangeSummary',
        summaryId: message.summaryId,
        status: message.status,
        text: message.text,
      } as PersistedUiEvent, indexes);
      return true;
    }

    case 'resetMessageState':
      resetUiMessageState(transcript, message.messageId, indexes);
      return true;

    case 'removeLastAssistantMessage':
      removeLastAssistantUiMessage(transcript, indexes);
      return true;

    default:
      return false;
  }
}
