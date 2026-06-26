/**
 * UI Transcript 持久化模块
 *
 * 负责管理 UI 转录记录的创建、更新、索引、克隆和历史恢复。
 * 从 ChatEngine.ts 中提取，所有方法均为无状态纯函数或接受显式依赖的函数。
 */
import { info } from '../logger';
import type {
  ExtensionMessage,
  PersistedUiEntry,
  PersistedUiEvent,
  PersistedUiMessageEntry,
} from './messageTypes';
import {
  buildExpiredChangeSummaryResponse,
  collectWriteBackupMessageIds,
  isChangeSummaryFileUndoable,
} from './fileChanges';
import type { WriteBackupEntry } from './fileChanges';
import { cloneHistoryProcessSummary } from './ChatViewProvider_displayHistory';

// ==================== 类型定义 ====================

/** 运行时索引映射，用于快速定位 stepId/summaryId 所属的消息 */
export type UiMessageIndexes = {
  stepToMessageId: Map<string, string>;
  summaryToMessageId: Map<string, string>;
};

/** postMessage 回调签名 */
export type PostMessageFn = (message: ExtensionMessage) => void;

// ==================== 克隆 ====================

/** 深克隆单个 UI 事件 */
export function cloneUiEvent(event: PersistedUiEvent): PersistedUiEvent {
  if (event.type === 'showChangeSummary') {
    return {
      ...event,
      files: event.files.map(file => ({ ...file })),
    };
  }

  if (event.type === 'showHistoryProcessSummary') {
    return {
      ...event,
      summary: cloneHistoryProcessSummary(event.summary),
    };
  }

  return { ...event };
}

/** 深克隆整份 UI 转录记录 */
export function cloneUiTranscript(uiTranscript: PersistedUiEntry[]): PersistedUiEntry[] {
  return uiTranscript.map(entry => {
    if (entry.type === 'error') {
      return { ...entry };
    }

    const clonedEvents = Array.isArray(entry.events)
      ? entry.events.map(event => cloneUiEvent(event))
      : undefined;

    return {
      ...entry,
      events: clonedEvents,
    };
  });
}

// ==================== 消息条目基础操作 ====================

/** 确保转录中存在指定 messageId 的条目，不存在则新建 */
export function ensureUiMessageEntry(
  transcript: PersistedUiEntry[],
  messageId: string,
  role: 'user' | 'assistant',
  createdAt: number,
): PersistedUiMessageEntry | null {
  const existing = transcript.find((entry): entry is PersistedUiMessageEntry => {
    return entry.type === 'message' && entry.messageId === messageId;
  });
  if (existing) {
    existing.role = role;
    if (!existing.createdAt) {
      existing.createdAt = createdAt;
    }
    if (!Array.isArray(existing.events)) {
      existing.events = [];
    }
    return existing;
  }

  const entry: PersistedUiMessageEntry = {
    type: 'message',
    messageId,
    role,
    createdAt,
    content: '',
    events: [],
  };
  transcript.push(entry);
  return entry;
}

/** 查找指定 messageId 的条目，不存在返回 null */
export function findUiMessageEntry(
  transcript: PersistedUiEntry[],
  messageId: string,
): PersistedUiMessageEntry | null {
  const entry = transcript.find((item): item is PersistedUiMessageEntry => {
    return item.type === 'message' && item.messageId === messageId;
  });
  return entry ?? null;
}

/** 获取指定消息的 createdAt 时间戳，找不到则返回 fallback */
export function getUiMessageCreatedAt(
  transcript: PersistedUiEntry[],
  messageId: string,
  fallback: number = Date.now(),
): number {
  const entry = findUiMessageEntry(transcript, messageId);
  return entry?.createdAt ?? fallback;
}

/** 设置指定消息的内容、角色和时间戳 */
export function setUiMessageContent(
  transcript: PersistedUiEntry[],
  messageId: string,
  role: 'user' | 'assistant',
  createdAt: number,
  content: string,
  partial = false,
): void {
  const entry = ensureUiMessageEntry(transcript, messageId, role, createdAt);
  if (!entry) {
    return;
  }

  entry.content = content;
  if (partial) {
    entry.partial = true;
    return;
  }

  delete entry.partial;
}

// ==================== 事件与错误追加 ====================

/** 向转录末尾追加一条错误记录 */
export function appendUiError(
  transcript: PersistedUiEntry[],
  message: string,
  retryable = true,
  createdAt = Date.now(),
): void {
  transcript.push({
    type: 'error',
    createdAt,
    message,
    retryable: retryable ? true : undefined,
  });
}

/**
 * 向指定消息追加一个 UI 事件，同时更新运行时索引。
 * stepId 和 summaryId 类的事件会被记录到 indexes 中以供后续快速查找。
 */
export function appendUiEvent(
  transcript: PersistedUiEntry[],
  messageId: string,
  event: PersistedUiEvent,
  indexes: UiMessageIndexes,
): void {
  const entry = ensureUiMessageEntry(transcript, messageId, 'assistant', Date.now());
  if (!entry) {
    return;
  }

  if (!Array.isArray(entry.events)) {
    entry.events = [];
  }

  entry.events.push(event);
  if (event.type === 'addStep') {
    indexes.stepToMessageId.set(event.stepId, messageId);
  }
  if (event.type === 'showDiff' && event.summaryId) {
    indexes.summaryToMessageId.set(event.summaryId, messageId);
  }
  if (event.type === 'showChangeSummary') {
    indexes.summaryToMessageId.set(event.summaryId, messageId);
  }
}

// ==================== 索引管理 ====================

/** 清空运行时 UI 消息索引 */
export function resetUiRuntimeState(indexes: UiMessageIndexes): void {
  indexes.stepToMessageId.clear();
  indexes.summaryToMessageId.clear();
}

/** 遍历转录记录，重建 stepId/summaryId → messageId 的索引映射 */
export function rebuildUiMessageIndexes(
  transcript: PersistedUiEntry[],
  indexes: UiMessageIndexes,
): void {
  resetUiRuntimeState(indexes);

  for (const entry of transcript) {
    if (entry.type !== 'message' || !Array.isArray(entry.events)) {
      continue;
    }

    for (const event of entry.events) {
      if (event.type === 'addStep') {
        indexes.stepToMessageId.set(event.stepId, entry.messageId);
      }

      if (event.type === 'showDiff' && event.summaryId) {
        indexes.summaryToMessageId.set(event.summaryId, entry.messageId);
      }

      if (event.type === 'showChangeSummary') {
        indexes.summaryToMessageId.set(event.summaryId, entry.messageId);
      }
    }
  }
}

// ==================== ID 查找 ====================

/** 根据 stepId 查找所属消息的 messageId（优先查索引，回退线性扫描） */
export function findMessageIdByStepId(
  transcript: PersistedUiEntry[],
  stepId: string,
  indexes: UiMessageIndexes,
): string | null {
  const mappedMessageId = indexes.stepToMessageId.get(stepId);
  if (mappedMessageId) {
    return mappedMessageId;
  }

  for (const entry of transcript) {
    if (entry.type !== 'message' || !Array.isArray(entry.events)) {
      continue;
    }

    const hasStep = entry.events.some(event => {
      if (event.type === 'addStep' || event.type === 'updateStep' || event.type === 'showDiff') {
        return event.stepId === stepId;
      }
      return false;
    });

    if (hasStep) {
      return entry.messageId;
    }
  }

  return null;
}

/** 根据 summaryId 查找所属消息的 messageId（优先查索引，回退线性扫描） */
export function findMessageIdBySummaryId(
  transcript: PersistedUiEntry[],
  summaryId: string,
  indexes: UiMessageIndexes,
): string | null {
  const mappedMessageId = indexes.summaryToMessageId.get(summaryId);
  if (mappedMessageId) {
    return mappedMessageId;
  }

  for (const entry of transcript) {
    if (entry.type !== 'message' || !Array.isArray(entry.events)) {
      continue;
    }

    const hasSummary = entry.events.some(event => {
      if (event.type === 'showDiff') {
        return event.summaryId === summaryId;
      }
      if (event.type === 'showChangeSummary' || event.type === 'updateChangeSummary') {
        return event.summaryId === summaryId;
      }
      return false;
    });

    if (hasSummary) {
      return entry.messageId;
    }
  }

  return null;
}

// ==================== Undo 过期 ====================

/** 收集指定消息中仍然可 Undo 的 ChangeSummary ID 列表 */
export function collectUndoableSummaryIdsForMessage(
  transcript: PersistedUiEntry[],
  messageId: string,
): string[] {
  const entry = findUiMessageEntry(transcript, messageId);
  if (!entry || !Array.isArray(entry.events)) {
    return [];
  }

  const summaryStates = new Map<string, { hasUndoableFiles: boolean; latestStatus: string | null }>();
  for (const event of entry.events) {
    if (event.type === 'showChangeSummary') {
      const current = summaryStates.get(event.summaryId);
      summaryStates.set(event.summaryId, {
        hasUndoableFiles: event.files.some(file => isChangeSummaryFileUndoable(file)),
        latestStatus: current?.latestStatus ?? null,
      });
      continue;
    }

    if (event.type === 'updateChangeSummary') {
      const current = summaryStates.get(event.summaryId);
      summaryStates.set(event.summaryId, {
        hasUndoableFiles: current?.hasUndoableFiles ?? false,
        latestStatus: event.status,
      });
    }
  }

  const summaryIds: string[] = [];
  for (const [summaryId, state] of summaryStates.entries()) {
    if (!state.hasUndoableFiles) {
      continue;
    }

    if (state.latestStatus === 'undone' || state.latestStatus === 'cancelled') {
      continue;
    }

    summaryIds.push(summaryId);
  }

  return summaryIds;
}

/**
 * 将指定消息中可 Undo 的 ChangeSummary 标记为过期。
 * 通过 postMessage 回调发送过期通知。
 */
export function expireUndoableSummariesForMessageIds(
  transcript: PersistedUiEntry[],
  messageIds: string[],
  postMessage: PostMessageFn,
  options?: { excludeSummaryIds?: string[]; text?: string },
): void {
  const excludeSummaryIds = new Set(options?.excludeSummaryIds ?? []);
  const postedSummaryIds = new Set<string>();

  for (const messageId of messageIds) {
    for (const summaryId of collectUndoableSummaryIdsForMessage(transcript, messageId)) {
      if (excludeSummaryIds.has(summaryId) || postedSummaryIds.has(summaryId)) {
        continue;
      }

      postedSummaryIds.add(summaryId);
      postMessage(buildExpiredChangeSummaryResponse(summaryId, options?.text));
    }
  }
}

/** 从 WriteBackups 中提取关联的消息 ID，并将对应的 Undo 标记为过期 */
export function expireUndoableSummariesForWriteBackups(
  transcript: PersistedUiEntry[],
  writeBackups: Map<string, WriteBackupEntry>,
  postMessage: PostMessageFn,
  text = 'Undo expired',
): void {
  const messageIds = collectWriteBackupMessageIds(writeBackups);
  if (messageIds.length === 0) {
    return;
  }

  expireUndoableSummariesForMessageIds(transcript, messageIds, postMessage, { text });
}

/** 将同一消息内的其他 Undo 兄弟摘要标记为过期 */
export function expireUndoableSiblingSummaries(
  transcript: PersistedUiEntry[],
  summaryId: string,
  indexes: UiMessageIndexes,
  postMessage: PostMessageFn,
): void {
  const messageId = findMessageIdBySummaryId(transcript, summaryId, indexes);
  if (!messageId) {
    return;
  }

  expireUndoableSummariesForMessageIds(transcript, [messageId], postMessage, { excludeSummaryIds: [summaryId] });
}

// ==================== 消息状态重置 ====================

/** 重置指定消息的 UI 状态（清空事件列表并重建索引） */
export function resetUiMessageState(
  transcript: PersistedUiEntry[],
  messageId: string,
  indexes: UiMessageIndexes,
): void {
  const entry = findUiMessageEntry(transcript, messageId);
  if (!entry) {
    return;
  }

  delete entry.partial;
  entry.events = [];
  rebuildUiMessageIndexes(transcript, indexes);
}

/** 移除转录中最后一条 assistant 消息并重建索引 */
export function removeLastAssistantUiMessage(
  transcript: PersistedUiEntry[],
  indexes: UiMessageIndexes,
): void {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index];
    if (entry.type === 'message' && entry.role === 'assistant') {
      transcript.splice(index, 1);
      rebuildUiMessageIndexes(transcript, indexes);
      return;
    }
  }
}

/** 标记指定消息为"已停止"：将所有运行中的步骤标记为取消，将待确认的变更摘要标记为取消 */
export function markUiMessageStopped(
  transcript: PersistedUiEntry[],
  messageId: string,
  indexes: UiMessageIndexes,
): void {
  const entry = findUiMessageEntry(transcript, messageId);
  if (!entry) {
    return;
  }

  entry.partial = true;
  const events = entry.events ?? [];
  const stepStates = new Map<string, { status: 'running' | 'done' | 'error'; description: string }>();
  const pendingSummaryIds = new Set<string>();

  for (const event of events) {
    if (event.type === 'addStep') {
      stepStates.set(event.stepId, {
        status: event.status,
        description: event.description,
      });
      continue;
    }

    if (event.type === 'updateStep') {
      const current = stepStates.get(event.stepId);
      stepStates.set(event.stepId, {
        status: event.status,
        description: event.description ?? current?.description ?? '',
      });
      continue;
    }

    if (event.type === 'showChangeSummary' && event.needsConfirm) {
      pendingSummaryIds.add(event.summaryId);
      continue;
    }

    if (event.type === 'updateChangeSummary') {
      pendingSummaryIds.delete(event.summaryId);
    }
  }

  for (const [stepId, stepState] of stepStates.entries()) {
    if (stepState.status !== 'running') {
      continue;
    }

    const cancelledDescription = stepState.description.includes('(已取消)')
      ? stepState.description
      : `${stepState.description} (已取消)`;

    appendUiEvent(transcript, messageId, {
      type: 'updateStep',
      stepId,
      status: 'error',
      description: cancelledDescription,
    }, indexes);
  }

  for (const summaryId of pendingSummaryIds) {
    appendUiEvent(transcript, messageId, {
      type: 'updateChangeSummary',
      summaryId,
      status: 'cancelled',
      text: '✗ Cancelled',
    }, indexes);
  }
}

// ==================== 历史恢复 ====================

/**
 * 将指定会话的 UI 转录恢复到 Webview。
 * 依次重放所有消息和事件，重建运行时索引。
 * 返回 true 表示成功恢复，false 表示转录为空无需恢复。
 */
export function restoreUiTranscriptToWebview(
  transcript: PersistedUiEntry[],
  indexes: UiMessageIndexes,
  postMessage: PostMessageFn,
): boolean {
  if (transcript.length === 0) {
    return false;
  }

  resetUiRuntimeState(indexes);
  info(`恢复 ${transcript.length} 条 UI 历史到界面`);

  for (const entry of transcript) {
    if (entry.type === 'error') {
      postMessage({
        type: 'showError',
        message: entry.message,
        retryable: entry.retryable,
        createdAt: entry.createdAt,
        readOnly: true,
      });
      continue;
    }

    postMessage({
      type: 'addMessage',
      role: entry.role,
      content: entry.content,
      messageId: entry.messageId,
      createdAt: entry.createdAt,
      partial: entry.partial,
      readOnly: true,
    });

    if (entry.role === 'assistant') {
      postMessage({ type: 'streamDone', messageId: entry.messageId });
    }

    for (const event of entry.events ?? []) {
      switch (event.type) {
        case 'thinkingComplete':
          postMessage({
            type: 'thinkingComplete',
            messageId: entry.messageId,
            elapsed: event.elapsed,
            isExecutionMessage: false,
          });
          break;

        case 'showHistoryProcessSummary':
          postMessage({
            type: 'showHistoryProcessSummary',
            messageId: entry.messageId,
            summary: event.summary,
          });
          break;

        case 'addStep':
          postMessage({
            type: 'addStep',
            messageId: entry.messageId,
            stepId: event.stepId,
            icon: event.icon,
            description: event.description,
            status: event.status,
          });
          break;

        case 'updateStep':
          postMessage({
            type: 'updateStep',
            stepId: event.stepId,
            status: event.status,
            description: event.description,
            elapsed: event.elapsed,
          });
          break;

        case 'showDiff':
          postMessage({
            type: 'showDiff',
            messageId: entry.messageId,
            stepId: event.stepId,
            summaryId: event.summaryId,
            filePath: event.filePath,
            language: event.language,
            additions: event.additions,
            deletions: event.deletions,
            oldContent: event.oldContent,
            newContent: event.newContent,
            noticeText: event.noticeText,
            needsConfirm: event.needsConfirm,
            collapsed: event.collapsed,
            readOnly: true,
          });
          break;

        case 'showChangeSummary':
          postMessage({
            type: 'showChangeSummary',
            messageId: entry.messageId,
            summaryId: event.summaryId,
            needsConfirm: event.needsConfirm,
            files: event.files,
            readOnly: true,
          });
          break;

        case 'updateChangeSummary':
          postMessage({
            type: 'updateChangeSummary',
            summaryId: event.summaryId,
            status: event.status,
            text: event.text,
          });
          break;
      }
    }
  }

  rebuildUiMessageIndexes(transcript, indexes);
  return true;
}
