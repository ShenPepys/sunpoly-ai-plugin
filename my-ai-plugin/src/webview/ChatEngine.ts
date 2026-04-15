/**
 * 聊天引擎
 *
 * 持有所有聊天业务状态和方法，不依赖具体的 Webview 容器类型。
 * 侧边栏（ChatViewProvider）和编辑器 Tab（ChatTabPanel）各自持有独立的 ChatEngine 实例，
 * 通过 IChatHost 接口与宿主通信。
 */
import * as vscode from 'vscode';
import { info, error } from '../logger';
import { getModelConfig, ensureApiKey, getMaxTokens, getTemperature, getAllModels, getActiveModelIndex, getPanelTitle } from '../config';
import { sendStreamRequest } from '../api/client';
import type { ApiClientConfig, AbortStreamFn } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import type { CommandExecutionRequest, CommandType } from '../commands/handler';
import type {
  ExtensionMessage,
  WebviewMessage,
  WorkMode,
  ChatSession,
  HistoryProcessSummary,
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  PersistedUiEntry,
  PersistedUiEvent,
  PersistedUiMessageEntry,
} from './messageTypes';
import { formatToolResults } from '../tools';
import type { ParsedToolCall } from '../tools';
import { buildContextUsageSnapshot, buildUpdateTokenCountResponse } from './ChatViewProvider_a_contextUsage';
import { buildChatViewHtml } from './ChatViewProvider_b_html';
import {
  applyAssistantResponseDisplay,
  analyzeAssistantResponseDisplay,
  appendDisplayHistoryUserMessage,
  buildAssistantDisplayCompletionMessages,
  cloneDisplayHistoryMessages,
  cloneHistoryProcessSummary,
  createDisplayMessageId as createDisplayMessageIdHelper,
  createHistoryProcessSummary,
  getDisplayHistoryMessageById,
  getLastAssistantDisplayHistoryMessage,
  getUserDisplayContent,
  isToolFeedbackMessage,
  normalizeHistoryMessages,
  upsertAssistantDisplayHistoryMessage,
} from './ChatViewProvider_c_displayHistory';
import {
  buildFinalTurnChangeSummaryResponse,
  getDisplayPath as getDisplayPathHelper,
} from './ChatViewProvider_d_fileChanges';
import type { ChangeSummaryFile, WriteBackupEntry } from './ChatViewProvider_d_fileChanges';
import {
  buildChatExportMarkdown,
  saveChatExportMarkdown,
} from './ChatViewProvider_e_workspaceContext';
import {
  clearSessionConversation,
  planInitialSessionBootstrap,
  buildUpdateSessionsResponse,
  buildSessionTitle as buildSessionTitleHelper,
  planClearCurrentSession,
  planCreateSession,
  planDeleteSession,
  planOpenSessionLauncher,
  planRenameSession,
  planSwitchSession,
  prepareActiveSessionForSave,
} from './ChatViewProvider_f_sessions';
import {
  createSessionDisplayHistoryAccessors,
  getActiveSession as getActiveSessionHelper,
  getSessionDisplayHistoryForExport,
  resolveSessionDisplayHistory,
  setSessionDisplayHistory,
} from './ChatViewProvider_o_sessionAccess';
import { prepareRegenerateRequest } from './ChatViewProvider_g_regenerate';
import type { PendingRegenerateState } from './ChatViewProvider_g_regenerate';
import {
  buildSlashCommandRequest,
  resolveCommandType as resolveCommandTypeHelper,
} from './ChatViewProvider_h_commands';
import {
  clearRetryableRequestsForSession as clearRetryableRequestsForSessionHelper,
  cloneRequestImages as cloneRequestImagesHelper,
  createRetryRequestId as createRetryRequestIdHelper,
  rememberRetryableRequest as rememberRetryableRequestHelper,
} from './ChatViewProvider_i_retryRequests';
import type { RequestImageAttachment, RetryableRequestState } from './ChatViewProvider_i_retryRequests';
import {
  insertCodeToEditor as insertCodeToEditorHelper,
} from './ChatViewProvider_j_ideActions';
import {
  consumeSessionScopedRuntimeReset,
  consumeRunCompletionState,
  consumeStreamingRunCompletionState,
  clearPendingRegenerateState as clearPendingRegenerateStateHelper,
  getClonedActiveHistoryProcessSummary as getClonedActiveHistoryProcessSummaryHelper,
  hasRunningTask as hasRunningTaskHelper,
  resetActiveHistoryProcessSummary as resetActiveHistoryProcessSummaryHelper,
  rollbackPendingRegenerateState as rollbackPendingRegenerateStateHelper,
} from './ChatViewProvider_k_runtimeState';
import { tryHandleLightweightWebviewMessage } from './ChatViewProvider_l_webviewDispatch';
import { handleRemainingWebviewMessage } from './ChatViewProvider_m_webviewRouting';
import {
  prepareChatRequestExecution,
  prepareRemindedMessages,
  buildUpdateModelsResponse,
} from './ChatViewProvider_n_modelAndSession';
import {
  beginAssistantStreamingRequest,
  executeToolCallBatchRound,
  prepareUserTurnRequest,
  startBasicAssistantStreamRequest,
} from './ChatViewProvider_p_requestExecution';
import type { IChatHost } from './IChatHost';
import type { SessionRunLock, SessionStore } from './SessionStore';

type DeferredToolStep = {
  stepId: string;
  stepDesc: string;
  toolCall: ParsedToolCall;
  startedAt: number;
};

type UserMessageRequestOptions = {
  userContentOverride?: string;
  retryRequestId?: string;
  requestMode?: WorkMode;
};

export class ChatEngine {

  // ==================== 宿主引用 ====================

  /** 宿主容器（侧边栏或 Tab），通过它与前端通信和获取 VS Code 资源 */
  private host: IChatHost;

  /** 共享会话存储，多 Tab 共用同一个 sessions 池 */
  private store: SessionStore;

  private readonly engineId: string;

  // ==================== 会话状态 ====================

  /** 所有会话列表（委托到 SessionStore，多引擎共享同一引用） */
  private get sessions(): ChatSession[] {
    return this.store.sessions;
  }
  private set sessions(value: ChatSession[]) {
    this.store.sessions = value;
  }

  /** 当前活跃会话的 ID */
  private activeSessionId: string = '';

  /**
   * 当前活跃会话的对话历史（getter 返回对活跃会话历史数组的引用）
   * push / slice 等操作会直接修改会话内的数组内容
   */
  private get chatHistory(): ChatMessageParam[] {
    const session = this.sessions.find(s => s.id === this.activeSessionId);
    return session ? (session.history as ChatMessageParam[]) : [];
  }

  /** chatHistory setter：用于整体替换（如 clearHistory） */
  private set chatHistory(value: ChatMessageParam[]) {
    const session = this.sessions.find(s => s.id === this.activeSessionId);
    if (session) {
      session.history = value;
    }
  }

  private get uiTranscript(): PersistedUiEntry[] {
    const session = getActiveSessionHelper(this.sessions, this.activeSessionId);
    if (!session) {
      return [];
    }

    if (!Array.isArray(session.uiTranscript)) {
      session.uiTranscript = [];
    }

    return session.uiTranscript;
  }

  private set uiTranscript(value: PersistedUiEntry[]) {
    const session = getActiveSessionHelper(this.sessions, this.activeSessionId);
    if (session) {
      session.uiTranscript = value;
    }
  }

  // ==================== 运行时状态 ====================

  /** 当前工作模式：code（可修改文件）、ask（只读对话）、plan（先规划后执行） */
  private currentMode: WorkMode = 'code';

  /** 用户通过 @ Mentions 添加的上下文文件路径列表 */
  private contextFiles: string[] = [];

  /** 当前流式请求的中断函数（null 表示没有进行中的请求） */
  private abortStream: AbortStreamFn | null = null;

  private activeRunId: string | null = null;

  /** 防止 handleToolCalls 被并发执行 */
  private toolCallsInProgress = false;

  private stepSequence = 0;

  /** 当次请求内工具调用的轮次计数，每次新发送/重新生成时清零 */
  private toolCallRound = 0;

  /**
   * 写前备份：AI 每次写文件前先把原始内容存在这里，供 Undo 使用
   * key = 文件路径，value.originalContent = null 表示文件原本不存在（新建）
   * 用户发送新消息时清空（上一轮不再可撤）
   */
  private writeBackups: Map<string, WriteBackupEntry> = new Map();

  private sessionLauncherVisible = false;

  /**
   * 本轮对话中已应用的文件变更列表，跨多轮工具调用收集
   * 在 handleUserMessage / regenerateResponse 开始时清空，
   * 用于 AI 回复结束后展示"本轮全量变更"汇总条
   */
  private turnWriteFiles: ChangeSummaryFile[] = [];

  /**
   * 本轮对话中完成写入操作的工具调用轮次数
   * 只有多轮（>= 2）才需要全量汇总，单轮多文件已有批次 summary
   */
  private turnWriteRounds: number = 0;

  private activeHistoryProcessSummary: HistoryProcessSummary | null = null;

  private pendingRegenerateState: PendingRegenerateState | null = null;

  private retryableRequests: Map<string, RetryableRequestState> = new Map();

  private stepToMessageId: Map<string, string> = new Map();

  private summaryToMessageId: Map<string, string> = new Map();

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  private readonly sessionDisplayHistoryAccessors = createSessionDisplayHistoryAccessors({
    createDisplayMessageId: createDisplayMessageIdHelper,
    toChangedFileDisplayPath: filePath => getDisplayPathHelper(filePath),
  });

  // ==================== 构造与初始化 ====================

  constructor(host: IChatHost, store: SessionStore, options?: { forceSessionLauncher?: boolean }) {
    this.engineId = `engine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.host = host;
    this.store = store;
    // 从共享存储加载会话数据（首个引擎实际读取 globalState，后续引擎复用缓存）
    this.loadSessions();

    // 新建 Tab 时强制进入 launcher 状态，避免多 Tab 默认进入同一个会话
    if (options?.forceSessionLauncher) {
      this.activeSessionId = '';
      this.sessionLauncherVisible = true;
    }
  }

  private getGlobalRunLock(): SessionRunLock | null {
    return this.store.runLock;
  }

  private hasRunningTaskElsewhere(): boolean {
    const runLock = this.getGlobalRunLock();
    return !!runLock && runLock.ownerId !== this.engineId;
  }

  private isSessionRunningInOtherTab(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    const runLock = this.getGlobalRunLock();
    return !!runLock && runLock.ownerId !== this.engineId && runLock.sessionId === sessionId;
  }

  private setActiveRunIdState(nextActiveRunId: string | null): void {
    if (nextActiveRunId === null) {
      this.store.releaseRunLock({
        ownerId: this.engineId,
        runId: this.activeRunId ?? undefined,
      });
    }

    this.activeRunId = nextActiveRunId;
  }

  private getCrossTabRunConflictMessage(sessionId: string): string {
    const runLock = this.getGlobalRunLock();
    if (runLock && runLock.sessionId === sessionId) {
      return '当前会话正在其他聊天 Tab 中生成，请先停止当前任务后再继续。';
    }

    return '当前已有其他聊天 Tab 正在生成，请先停止当前任务后再继续。';
  }

  private tryAcquireCurrentSessionRunLock(runId: string): string | null {
    const sessionId = this.activeSessionId;
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

  private resetOwnedRunState(): void {
    this.setActiveRunIdState(null);
    this.abortStream = null;
    this.toolCallsInProgress = false;
    this.stepSequence = 0;
    this.toolCallRound = 0;
    this.activeHistoryProcessSummary = null;
  }

  // ==================== displayHistory 代理 ====================

  private get displayHistory(): ChatSessionDisplayMessage[] {
    return resolveSessionDisplayHistory({
      session: getActiveSessionHelper(this.sessions, this.activeSessionId),
      sanitizeDisplayHistory: this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });
  }

  private set displayHistory(value: ChatSessionDisplayMessage[]) {
    setSessionDisplayHistory(
      getActiveSessionHelper(this.sessions, this.activeSessionId),
      value,
      this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
    );
  }

  // ==================== 公开 API（供宿主调用） ====================

  /** 向前端发送消息（委托给宿主） */
  public postMessage(message: ExtensionMessage): void {
    this.capturePersistedUiState(message);
    this.host.postMessage(message);
  }

  private capturePersistedUiState(message: ExtensionMessage): void {
    if (!getActiveSessionHelper(this.sessions, this.activeSessionId)) {
      return;
    }

    switch (message.type) {
      case 'addMessage':
        this.setUiMessageContent(
          message.messageId,
          message.role,
          message.createdAt ?? Date.now(),
          message.content,
          !!message.partial,
        );
        if (message.role === 'user' && !message.readOnly) {
          this.persistUiTranscript();
        }
        return;

      case 'streamChunk': {
        const createdAt = this.getUiMessageCreatedAt(message.messageId, message.createdAt ?? Date.now());
        const entry = this.ensureUiMessageEntry(message.messageId, 'assistant', createdAt);
        if (!entry) {
          return;
        }

        entry.content += message.chunk;
        entry.partial = true;
        return;
      }

      case 'streamDone': {
        const entry = this.findUiMessageEntry(message.messageId);
        if (entry && entry.role === 'assistant') {
          delete entry.partial;
          this.persistUiTranscript();
        }
        return;
      }

      case 'updateMessage':
        this.setUiMessageContent(
          message.messageId,
          'assistant',
          this.getUiMessageCreatedAt(message.messageId),
          message.content,
        );
        this.persistUiTranscript();
        return;

      case 'showError':
        this.appendUiError(message.message, message.retryable, message.createdAt ?? Date.now());
        this.persistUiTranscript();
        return;

      case 'generationStopped':
        if (message.messageId) {
          this.markUiMessageStopped(message.messageId);
          this.persistUiTranscript();
        }
        return;

      case 'thinkingComplete':
        this.appendUiEvent(message.messageId, {
          type: 'thinkingComplete',
          elapsed: message.elapsed,
        });
        this.persistUiTranscript();
        return;

      case 'showHistoryProcessSummary':
        this.appendUiEvent(message.messageId, {
          type: 'showHistoryProcessSummary',
          summary: message.summary,
        });
        this.persistUiTranscript();
        return;

      case 'addStep':
        this.appendUiEvent(message.messageId, {
          type: 'addStep',
          stepId: message.stepId,
          icon: message.icon,
          description: message.description,
          status: message.status,
        });
        this.persistUiTranscript();
        return;

      case 'updateStep': {
        const messageId = this.findMessageIdByStepId(message.stepId);
        if (!messageId) {
          return;
        }

        this.appendUiEvent(messageId, {
          type: 'updateStep',
          stepId: message.stepId,
          status: message.status,
          description: message.description,
          elapsed: message.elapsed,
        });
        this.persistUiTranscript();
        return;
      }

      case 'showDiff':
        this.appendUiEvent(message.messageId, {
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
        });
        this.persistUiTranscript();
        return;

      case 'showChangeSummary':
        this.appendUiEvent(message.messageId, {
          type: 'showChangeSummary',
          summaryId: message.summaryId,
          needsConfirm: message.needsConfirm,
          files: message.files,
        });
        this.persistUiTranscript();
        return;

      case 'updateChangeSummary': {
        const messageId = this.findMessageIdBySummaryId(message.summaryId);
        if (!messageId) {
          return;
        }

        this.appendUiEvent(messageId, {
          type: 'updateChangeSummary',
          summaryId: message.summaryId,
          status: message.status,
          text: message.text,
        });
        this.persistUiTranscript();
        return;
      }

      case 'resetMessageState':
        this.resetUiMessageState(message.messageId);
        this.persistUiTranscript();
        return;

      case 'removeLastAssistantMessage':
        this.removeLastAssistantUiMessage();
        this.persistUiTranscript();
        return;

      default:
        return;
    }
  }

  private persistUiTranscript(): void {
    if (!getActiveSessionHelper(this.sessions, this.activeSessionId)) {
      return;
    }

    this.store.persist(this.activeSessionId);
  }

  private ensureUiMessageEntry(
    messageId: string,
    role: 'user' | 'assistant',
    createdAt: number,
  ): PersistedUiMessageEntry | null {
    const session = getActiveSessionHelper(this.sessions, this.activeSessionId);
    if (!session) {
      return null;
    }

    if (!Array.isArray(session.uiTranscript)) {
      session.uiTranscript = [];
    }

    const transcript = session.uiTranscript;
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

  private findUiMessageEntry(messageId: string): PersistedUiMessageEntry | null {
    const entry = this.uiTranscript.find((item): item is PersistedUiMessageEntry => {
      return item.type === 'message' && item.messageId === messageId;
    });
    return entry ?? null;
  }

  private getUiMessageCreatedAt(messageId: string, fallback = Date.now()): number {
    const entry = this.findUiMessageEntry(messageId);
    return entry?.createdAt ?? fallback;
  }

  private setUiMessageContent(
    messageId: string,
    role: 'user' | 'assistant',
    createdAt: number,
    content: string,
    partial = false,
  ): void {
    const entry = this.ensureUiMessageEntry(messageId, role, createdAt);
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

  private appendUiError(message: string, retryable = true, createdAt = Date.now()): void {
    const session = getActiveSessionHelper(this.sessions, this.activeSessionId);
    if (!session) {
      return;
    }

    if (!Array.isArray(session.uiTranscript)) {
      session.uiTranscript = [];
    }

    session.uiTranscript.push({
      type: 'error',
      createdAt,
      message,
      retryable: retryable ? true : undefined,
    });
  }

  private appendUiEvent(messageId: string, event: PersistedUiEvent): void {
    const entry = this.ensureUiMessageEntry(messageId, 'assistant', Date.now());
    if (!entry) {
      return;
    }

    if (!Array.isArray(entry.events)) {
      entry.events = [];
    }

    entry.events.push(event);
    if (event.type === 'addStep') {
      this.stepToMessageId.set(event.stepId, messageId);
    }
    if (event.type === 'showDiff' && event.summaryId) {
      this.summaryToMessageId.set(event.summaryId, messageId);
    }
    if (event.type === 'showChangeSummary') {
      this.summaryToMessageId.set(event.summaryId, messageId);
    }
  }

  private resetUiRuntimeState(): void {
    this.stepToMessageId.clear();
    this.summaryToMessageId.clear();
  }

  private rebuildUiMessageIndexes(): void {
    this.resetUiRuntimeState();

    for (const entry of this.uiTranscript) {
      if (entry.type !== 'message' || !Array.isArray(entry.events)) {
        continue;
      }

      for (const event of entry.events) {
        if (event.type === 'addStep') {
          this.stepToMessageId.set(event.stepId, entry.messageId);
        }

        if (event.type === 'showDiff' && event.summaryId) {
          this.summaryToMessageId.set(event.summaryId, entry.messageId);
        }

        if (event.type === 'showChangeSummary') {
          this.summaryToMessageId.set(event.summaryId, entry.messageId);
        }
      }
    }
  }

  private findMessageIdByStepId(stepId: string): string | null {
    const mappedMessageId = this.stepToMessageId.get(stepId);
    if (mappedMessageId) {
      return mappedMessageId;
    }

    for (const entry of this.uiTranscript) {
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

  private findMessageIdBySummaryId(summaryId: string): string | null {
    const mappedMessageId = this.summaryToMessageId.get(summaryId);
    if (mappedMessageId) {
      return mappedMessageId;
    }

    for (const entry of this.uiTranscript) {
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

  private resetUiMessageState(messageId: string): void {
    const entry = this.findUiMessageEntry(messageId);
    if (!entry) {
      return;
    }

    delete entry.partial;
    entry.events = [];
    this.rebuildUiMessageIndexes();
  }

  private removeLastAssistantUiMessage(): void {
    const transcript = this.uiTranscript;
    for (let index = transcript.length - 1; index >= 0; index--) {
      const entry = transcript[index];
      if (entry.type === 'message' && entry.role === 'assistant') {
        transcript.splice(index, 1);
        this.rebuildUiMessageIndexes();
        return;
      }
    }
  }

  private markUiMessageStopped(messageId: string): void {
    const entry = this.findUiMessageEntry(messageId);
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

      this.appendUiEvent(messageId, {
        type: 'updateStep',
        stepId,
        status: 'error',
        description: cancelledDescription,
      });
    }

    for (const summaryId of pendingSummaryIds) {
      this.appendUiEvent(messageId, {
        type: 'updateChangeSummary',
        summaryId,
        status: 'cancelled',
        text: '✗ Cancelled',
      });
    }
  }

  private restoreUiTranscriptToWebview(): boolean {
    const transcript = this.uiTranscript;
    if (transcript.length === 0) {
      return false;
    }

    this.resetUiRuntimeState();
    info(`恢复 ${transcript.length} 条 UI 历史到界面`);

    for (const entry of transcript) {
      if (entry.type === 'error') {
        this.host.postMessage({
          type: 'showError',
          message: entry.message,
          retryable: entry.retryable,
          createdAt: entry.createdAt,
          readOnly: true,
        });
        continue;
      }

      this.host.postMessage({
        type: 'addMessage',
        role: entry.role,
        content: entry.content,
        messageId: entry.messageId,
        createdAt: entry.createdAt,
        partial: entry.partial,
        readOnly: true,
      });

      if (entry.role === 'assistant') {
        this.host.postMessage({ type: 'streamDone', messageId: entry.messageId });
      }

      for (const event of entry.events ?? []) {
        switch (event.type) {
          case 'thinkingComplete':
            this.host.postMessage({
              type: 'thinkingComplete',
              messageId: entry.messageId,
              elapsed: event.elapsed,
              isExecutionMessage: false,
            });
            break;

          case 'showHistoryProcessSummary':
            this.host.postMessage({
              type: 'showHistoryProcessSummary',
              messageId: entry.messageId,
              summary: event.summary,
            });
            break;

          case 'addStep':
            this.host.postMessage({
              type: 'addStep',
              messageId: entry.messageId,
              stepId: event.stepId,
              icon: event.icon,
              description: event.description,
              status: event.status,
            });
            break;

          case 'updateStep':
            this.host.postMessage({
              type: 'updateStep',
              stepId: event.stepId,
              status: event.status,
              description: event.description,
              elapsed: event.elapsed,
            });
            break;

          case 'showDiff':
            this.host.postMessage({
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
            this.host.postMessage({
              type: 'showChangeSummary',
              messageId: entry.messageId,
              summaryId: event.summaryId,
              needsConfirm: event.needsConfirm,
              files: event.files,
              readOnly: true,
            });
            break;

          case 'updateChangeSummary':
            this.host.postMessage({
              type: 'updateChangeSummary',
              summaryId: event.summaryId,
              status: event.status,
              text: event.text,
            });
            break;
        }
      }
    }

    this.rebuildUiMessageIndexes();
    return true;
  }

  private cloneUiTranscript(uiTranscript: PersistedUiEntry[]): PersistedUiEntry[] {
    return uiTranscript.map(entry => {
      if (entry.type === 'error') {
        return { ...entry };
      }

      const clonedEvents = Array.isArray(entry.events)
        ? entry.events.map(event => this.cloneUiEvent(event))
        : undefined;

      return {
        ...entry,
        events: clonedEvents,
      };
    });
  }

  private cloneUiEvent(event: PersistedUiEvent): PersistedUiEvent {
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

  /** 获取当前工作模式 */
  public getMode(): WorkMode {
    return this.currentMode;
  }

  /** 切换工作模式 */
  public switchMode(mode: WorkMode): void {
    this.currentMode = mode;
    this.postMessage({ type: 'updateMode', mode });
  }

  /** 获取当前活跃模型名称（用于状态栏同步） */
  public getActiveModelName(): string {
    const models = getAllModels();
    const activeIndex = getActiveModelIndex();
    return models[activeIndex]?.name || 'AI';
  }

  /** 推送模型列表到前端 */
  public sendModelList(): void {
    const models = getAllModels();
    const activeIndex = getActiveModelIndex();
    const modelConfig = getModelConfig();
    this.postMessage(buildUpdateModelsResponse({
      models,
      activeIndex,
      supportsVision: modelConfig.supportsVision ?? false,
    }));
  }

  /**
   * Webview 初始化后由宿主调用，推送初始状态到前端
   * 包括模型列表、工作模式、会话列表和历史消息恢复
   */
  public initializeWebviewState(): void {
    this.sendModelList();
    this.postMessage({ type: 'updateMode', mode: this.currentMode });
    this.resetUiRuntimeState();

    const activeSession = getActiveSessionHelper(this.sessions, this.activeSessionId);
    const hasUiTranscript = Array.isArray(activeSession?.uiTranscript) && activeSession.uiTranscript.length > 0;

    if (!this.sessionLauncherVisible && hasUiTranscript) {
      this.postMessage(buildUpdateSessionsResponse(this.sessions, this.activeSessionId));
      this.pushTokenCount();
      this.restoreUiTranscriptToWebview();
      this.syncHostTitle();
      return;
    }

    const initialSessionBootstrapPlan = planInitialSessionBootstrap({
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      sessionLauncherVisible: this.sessionLauncherVisible,
      displayHistory: this.displayHistory,
      rawHistoryCount: this.chatHistory.length,
      createDisplayMessageId: createDisplayMessageIdHelper,
    });
    this.postMessage(initialSessionBootstrapPlan.sessionListResponse);
    this.pushTokenCount();

    if (initialSessionBootstrapPlan.kind === 'restore') {
      info(`恢复 ${initialSessionBootstrapPlan.restoredDisplayHistoryCount} 条历史消息到界面（原始 ${initialSessionBootstrapPlan.restoredRawHistoryCount} 条）`);
    }
    for (const message of initialSessionBootstrapPlan.renderMessages) {
      this.postMessage(message);
    }

    if (!this.sessionLauncherVisible && !hasUiTranscript && this.uiTranscript.length > 0) {
      this.persistUiTranscript();
    }

    // 初始化完成后同步宿主标题（Tab 标签文字显示当前会话名）
    this.syncHostTitle();
  }

  /** 获取面板 HTML（供宿主设置到 Webview） */
  public buildHtml(): string {
    const webview = this.host.getWebview();
    if (!webview) {
      return '';
    }
    return buildChatViewHtml({
      webview,
      extensionUri: this.host.getExtensionUri(),
      panelTitle: getPanelTitle(),
      shouldShowWelcomeOnInitialRender: !this.sessionLauncherVisible && this.displayHistory.length === 0 && this.uiTranscript.length === 0,
    });
  }

  public async runCommandRequest(commandRequest: CommandExecutionRequest): Promise<void> {
    if (this.hasRunningTask()) {
      const message = '当前仍在生成，请先停止当前任务后再执行新的命令。';
      this.postMessage({ type: 'showError', message });
      vscode.window.showWarningMessage(message);
      return;
    }

    this.host.reveal();
    await this.handleUserMessage(commandRequest.displayText, undefined, {
      userContentOverride: commandRequest.userMessage,
      requestMode: commandRequest.requestMode,
    });
  }

  public clearCurrentSession(): void {
    if (this.hasRunningTask()) {
      this.postMessage({
        type: 'showError',
        message: '当前会话仍在生成，请先停止当前任务后再清空对话。',
      });
      return;
    }

    if (this.isSessionRunningInOtherTab(this.activeSessionId)) {
      this.postMessage({
        type: 'showError',
        message: '当前会话正在其他聊天 Tab 中生成，请先停止当前任务后再清空对话。',
      });
      return;
    }

    const clearPlan = planClearCurrentSession({
      sessionLauncherVisible: this.sessionLauncherVisible,
      activeSessionId: this.activeSessionId,
    });

    if (clearPlan.kind === 'blocked') {
      this.postMessage({
        type: 'showError',
        message: clearPlan.errorMessage,
      });
      return;
    }

    this.resetSessionScopedRuntimeState();
    clearSessionConversation(getActiveSessionHelper(this.sessions, this.activeSessionId));
    const sessionListResponse = this.saveSessions();
    this.postMessage(sessionListResponse);
    this.syncHostTitle();
    info('对话历史已清空');

    clearRetryableRequestsForSessionHelper(this.retryableRequests, clearPlan.clearRetryableSessionId);
    for (const message of clearPlan.messages) {
      this.postMessage(message);
    }
  }

  public openSessionLauncher(): void {
    const launcherPlan = planOpenSessionLauncher({
      hasRunningTask: this.hasRunningTask(),
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    });
    if (launcherPlan.kind === 'blocked') {
      this.postMessage({
        type: 'showError',
        message: launcherPlan.errorMessage,
      });
      return;
    }

    this.resetSessionScopedRuntimeState();
    this.sessionLauncherVisible = launcherPlan.nextSessionLauncherVisible;
    this.postMessage(launcherPlan.sessionListResponse);
    for (const message of launcherPlan.messages) {
      this.postMessage(message);
    }
  }

  // ==================== Webview 消息处理 ====================

  public async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    try {
      const lightweightHandled = await tryHandleLightweightWebviewMessage(message, {
        sendModelList: () => this.sendModelList(),
        pushTokenCount: () => this.pushTokenCount(),
        applyModeChange: mode => this.switchMode(mode),
        insertCodeToEditor: insertCodeToEditorHelper,
        getContextFiles: () => [...this.contextFiles],
        setContextFiles: filePaths => {
          this.contextFiles = filePaths;
        },
        resolveCommandType: resolveCommandTypeHelper,
        handleSlashCommand: async type => {
          const commandRequest = buildSlashCommandRequest(type);
          if (!commandRequest) {
            return;
          }

          await this.runCommandRequest(commandRequest);
        },
        onModelSwitch: this.onModelSwitch,
      });
      if (lightweightHandled) {
        return;
      }

      const handled = await handleRemainingWebviewMessage({
        message,
        currentMode: this.currentMode,
        activeSessionId: this.activeSessionId,
        retryableRequests: this.retryableRequests,
        writeBackups: this.writeBackups,
        activeRunId: this.activeRunId,
        abortStream: this.abortStream,
        getContextFiles: () => [...this.contextFiles],
        setContextFiles: filePaths => {
          this.contextFiles = filePaths;
        },
        hasRunningTask: () => this.hasRunningTask(),
        handleUserMessage: async (text, images, requestOptions) => {
          await this.handleUserMessage(text, images, requestOptions);
        },
        clearCurrentSession: () => this.clearCurrentSession(),
        exportChatToMarkdown: async () => this.exportChatToMarkdown(),
        openSessionLauncher: () => this.openSessionLauncher(),
        switchSession: sessionId => this.switchSession(sessionId),
        deleteSession: sessionId => this.deleteSession(sessionId),
        renameSession: (sessionId, name) => {
          const renamePlan = planRenameSession({
            sessions: this.sessions,
            targetSessionId: sessionId,
            name,
          });
          if (renamePlan.kind !== 'rename') {
            return;
          }

          this.sessions = renamePlan.nextSessions;
          const sessionListResponse = this.saveSessions();
          this.postMessage(sessionListResponse);
          this.syncHostTitle();
        },
        handleRegenerate: async assistantMessageId => {
          await this.handleRegenerate(assistantMessageId);
        },
        setActiveRunId: activeRunId => {
          this.setActiveRunIdState(activeRunId);
        },
        setAbortStream: abortStream => {
          this.abortStream = abortStream;
        },
        setToolCallsInProgress: toolCallsInProgress => {
          this.toolCallsInProgress = toolCallsInProgress;
        },
        setStepSequence: stepSequence => {
          this.stepSequence = stepSequence;
        },
        setToolCallRound: toolCallRound => {
          this.toolCallRound = toolCallRound;
        },
        setActiveHistoryProcessSummary: summary => {
          this.activeHistoryProcessSummary = summary;
        },
        rollbackPendingRegenerateState: runId => this.rollbackPendingRegenerateState(runId),
        getTurnWriteRounds: () => this.turnWriteRounds,
        getTurnWriteFiles: () => this.turnWriteFiles,
        postMessage: messageToPost => this.postMessage(messageToPost),
        logInfo: (logMessage, payload) => {
          if (payload === undefined) {
            info(logMessage);
            return;
          }

          info(logMessage, payload);
        },
      });

      if (!handled) {
        this.postMessage({ type: 'showError', message: `未知消息类型：${(message as { type?: string }).type || 'unknown'}` });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      error('处理 Webview 消息失败:', { type: message.type, error: errMsg });
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({ type: 'showError', message: `操作失败：${errMsg}` });
    }
  }

  // ==================== 用户消息处理 ====================

  private async handleUserMessage(
    text: string,
    images?: RequestImageAttachment[],
    requestOptions?: UserMessageRequestOptions,
  ): Promise<void> {
    if (this.hasRunningTask()) {
      const message = '当前仍在生成，请先停止当前任务后再发送新的消息。';
      this.postMessage({ type: 'showError', message });
      return;
    }

    if (this.hasRunningTaskElsewhere()) {
      const message = this.getCrossTabRunConflictMessage(this.activeSessionId);
      this.postMessage({ type: 'showError', message });
      return;
    }

    if (this.sessionLauncherVisible || !getActiveSessionHelper(this.sessions, this.activeSessionId)) {
      const createSessionPlan = planCreateSession({
        sessions: this.sessions,
        name: buildSessionTitleHelper(text),
      });
      this.sessions = createSessionPlan.nextSessions;
      this.activeSessionId = createSessionPlan.nextActiveSessionId;
      if (typeof createSessionPlan.nextSessionLauncherVisible === 'boolean') {
        this.sessionLauncherVisible = createSessionPlan.nextSessionLauncherVisible;
      }
      const sessionListResponse = this.saveSessions();
      for (const message of createSessionPlan.messages) {
        this.postMessage(message);
      }
      this.postMessage(sessionListResponse);
      this.syncHostTitle();
    }

    const assistantMsgId = `assistant-${Date.now()}`;
    const runLockError = this.tryAcquireCurrentSessionRunLock(assistantMsgId);
    if (runLockError) {
      this.postMessage({ type: 'showError', message: runLockError });
      return;
    }

    // 每轮对话开始时清空跨轮文件记录和轮次计数器
    this.turnWriteFiles = [];
    this.turnWriteRounds = 0;
    this.activeHistoryProcessSummary = resetActiveHistoryProcessSummaryHelper();

    // 先在界面上显示用户消息
    const userMsgId = `user-${Date.now()}`;
    this.postMessage({
      type: 'addMessage',
      role: 'user',
      content: text,
      messageId: userMsgId,
    });

    // 显示加载状态
    this.postMessage({ type: 'setLoading', loading: true });

    const retryRequestId = requestOptions?.retryRequestId || createRetryRequestIdHelper();
    const requestMode = requestOptions?.requestMode || this.currentMode;
    this.currentMode = requestMode;
    this.postMessage({ type: 'updateMode', mode: this.currentMode });
    info('handleUserMessage 模式快照', {
      requestMode,
      currentMode: this.currentMode,
      hasUserContentOverride: !!requestOptions?.userContentOverride,
      retryRequestId,
    });
    const contextFilePaths = requestOptions?.userContentOverride ? [] : this.contextFiles.slice();

    try {

      // 确保 API Key 已配置
      const apiKey = await ensureApiKey();
      if (!apiKey) {
        this.resetOwnedRunState();
        this.postMessage({ type: 'setLoading', loading: false });
        this.postMessage({
          type: 'showError',
          message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey',
          retryRequestId,
        });
        return;
      }

      // 获取配置
      const modelConfig = getModelConfig();

      const preparedUserTurn = prepareUserTurnRequest({
        text,
        retryRequestId,
        requestMode,
        activeSessionId: this.activeSessionId,
        images,
        userContentOverride: requestOptions?.userContentOverride,
        contextFilePaths,
        chatHistory: this.chatHistory as ChatSessionHistoryMessage[],
        displayHistory: this.displayHistory,
        retryableRequests: this.retryableRequests,
        modelConfig,
        allModels: getAllModels(),
        createDisplayMessageId: createDisplayMessageIdHelper,
      });

      if (contextFilePaths.length > 0) {
        this.contextFiles = [];
        this.postMessage({ type: 'clearContextFiles' });
      }

      this.saveChatHistory();

      // 构建最终发送给 API 的用户消息内容
      if (preparedUserTurn.visionWarning) {
        this.postMessage(preparedUserTurn.visionWarning);
      }
      const finalUserContent = preparedUserTurn.finalUserContent;

      // 通知 Webview 清空图片缩略图（图片已处理）
      this.postMessage({ type: 'clearImageAttachments' });

      const requestExecution = prepareChatRequestExecution({
        modelConfig,
        requestMode,
        remindedMessages: prepareRemindedMessages({
          history: this.chatHistory,
          requestMode,
          contextWindow: modelConfig.contextWindow,
          maxTokens: getMaxTokens(),
          excludeLastMessage: true,
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
        abortStream: this.abortStream,
        runId: assistantMsgId,
        runtime: {
          setAbortStream: abortStream => {
            this.abortStream = abortStream;
          },
          setToolCallsInProgress: toolCallsInProgress => {
            this.toolCallsInProgress = toolCallsInProgress;
          },
          setActiveRunId: activeRunId => {
            this.setActiveRunIdState(activeRunId);
          },
          setStepSequence: stepSequence => {
            this.stepSequence = stepSequence;
          },
          setToolCallRound: toolCallRound => {
            this.toolCallRound = toolCallRound;
          },
        },
        clearWriteBackups: () => {
          this.writeBackups.clear();
        },
      });
      // 新消息开始：清空上一轮写文件备份（上一轮的 Undo 不再有效）

      // 发起流式请求，保存 abort 句柄用于停止生成
      this.abortStream = startBasicAssistantStreamRequest({
        apiConfig,
        messages,
        messageId: assistantMsgId,
        chatHistory: this.chatHistory as ChatSessionHistoryMessage[],
        displayHistory: this.displayHistory,
        runtime: {
          getActiveRunId: () => this.activeRunId,
          getActiveHistoryProcessSummary: () => this.activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setActiveRunIdState(activeRunId);
          },
          setStepSequence: stepSequence => {
            this.stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postMessage(message),
        saveChatHistory: () => this.saveChatHistory(),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        onToolCalls: ({ fullContent, parsedToolCalls }) => {
          this.handleToolCalls(fullContent, apiConfig, assistantMsgId, requestMode, parsedToolCalls, retryRequestId)
            .catch(err => error('工具调用处理异常:', err instanceof Error ? err.message : String(err)));
        },
        onDoneLog: (fullContent, thinkingElapsed) => {
          info(`AI 回复完成，长度: ${fullContent.length}，耗时: ${thinkingElapsed}ms`);
        },
        onErrorLog: rawErrorMessage => {
          error('AI API 调用失败:', rawErrorMessage);
        },
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.resetOwnedRunState();
      error('启动用户消息请求失败:', errMsg);
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({
        type: 'showError',
        message: `请求启动失败：${errMsg}`,
        retryRequestId,
      });
    }
  }

  // ==================== 工具调用处理 ====================

  private async handleToolCalls(
    aiResponse: string,
    apiConfig: ApiClientConfig,
    reuseMsgId: string,
    requestMode: WorkMode,
    parsedToolCalls?: ParsedToolCall[],
    retryRequestId?: string,
  ): Promise<void> {
    const toolCallAnalysis = parsedToolCalls
      ? { kind: 'tool-calls' as const, parsedToolCalls }
      : analyzeAssistantResponseDisplay(aiResponse);
    const toolCalls = toolCallAnalysis.kind === 'tool-calls'
      ? toolCallAnalysis.parsedToolCalls
      : [];
    if (toolCalls.length === 0) {
      if (this.activeRunId === reuseMsgId) {
        this.postMessage({ type: 'setLoading', loading: false });
        const completionState = consumeRunCompletionState({
          activeHistoryProcessSummary: this.activeHistoryProcessSummary,
          resetActiveHistoryProcessSummary: false,
        });
        this.setActiveRunIdState(completionState.nextActiveRunId);
        this.stepSequence = completionState.nextStepSequence;
        this.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
      }
      return;
    }

    if (this.activeRunId !== reuseMsgId) {
      if (this.activeRunId === null) {
        this.postMessage({ type: 'setLoading', loading: false });
        const completionState = consumeRunCompletionState({
          activeHistoryProcessSummary: this.activeHistoryProcessSummary,
        });
        this.setActiveRunIdState(completionState.nextActiveRunId);
        this.stepSequence = completionState.nextStepSequence;
        this.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
      }
      return;
    }

    if (this.toolCallsInProgress) {
      info('handleToolCalls 已在执行中，跳过重复调用');
      return;
    }
    this.toolCallsInProgress = true;
    this.toolCallRound++;
    this.currentMode = requestMode;
    this.postMessage({ type: 'updateMode', mode: this.currentMode });
    info('handleToolCalls 模式快照', { reuseMsgId, requestMode, currentMode: this.currentMode, toolCallRound: this.toolCallRound });

    try {

      info(`检测到 ${toolCalls.length} 个工具调用，立即执行，当前轮次: ${this.toolCallRound}`);

      const batchRound = await executeToolCallBatchRound({
        toolCalls,
        requestMode,
        messageId: reuseMsgId,
        apiConfig,
        stepSequenceStart: this.stepSequence,
        writeBackups: this.writeBackups,
        turnWriteFiles: this.turnWriteFiles,
        turnWriteRounds: this.turnWriteRounds,
        activeHistoryProcessSummary: this.activeHistoryProcessSummary,
        chatHistory: this.chatHistory as ChatSessionHistoryMessage[],
        historyForFollowUp: this.chatHistory,
        postMessage: message => this.postMessage(message),
        canContinue: () => this.activeRunId === reuseMsgId,
        getActiveRunId: () => this.activeRunId,
        saveChatHistory: () => this.saveChatHistory(),
        createHistoryProcessSummary,
        toDisplayPath: getDisplayPathHelper,
      });
      this.stepSequence = batchRound.nextStepSequence;
      this.turnWriteRounds = batchRound.nextTurnWriteRounds;
      this.activeHistoryProcessSummary = batchRound.nextActiveHistoryProcessSummary;

      if (batchRound.kind === 'halted') {
        if (batchRound.shouldFinalizeStoppedRun) {
          this.postMessage({ type: 'setLoading', loading: false });
          const completionState = consumeRunCompletionState({
            activeHistoryProcessSummary: this.activeHistoryProcessSummary,
          });
          this.setActiveRunIdState(completionState.nextActiveRunId);
          this.stepSequence = completionState.nextStepSequence;
          this.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
        }
        return;
      }

      info('续轮系统提示词模式', {
        requestMode,
        systemPromptModePreview: batchRound.followUpSystemPrompt.slice(0, 120),
      });

      this.abortStream = startBasicAssistantStreamRequest({
        apiConfig: batchRound.followUpApiConfig,
        messages: batchRound.followUpMessages,
        messageId: reuseMsgId,
        chatHistory: this.chatHistory as ChatSessionHistoryMessage[],
        displayHistory: this.displayHistory,
        runtime: {
          getActiveRunId: () => this.activeRunId,
          getActiveHistoryProcessSummary: () => this.activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setActiveRunIdState(activeRunId);
          },
          setStepSequence: stepSequence => {
            this.stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postMessage(message),
        saveChatHistory: () => this.saveChatHistory(),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        emitEmptyChunkOnFirstChunk: true,
        toolCallTransitionStreamDoneBeforeUpdate: true,
        processSummaryResolver: () => getClonedActiveHistoryProcessSummaryHelper(
          this.activeHistoryProcessSummary,
          cloneHistoryProcessSummary,
        ),
        onToolCalls: ({ fullContent, parsedToolCalls, displayContent, assistantTimestamp }) => {
          if (this.toolCallRound < 200) {
            this.handleToolCalls(fullContent, batchRound.followUpApiConfig, reuseMsgId, requestMode, parsedToolCalls, retryRequestId)
              .catch(err => error('续轮工具调用处理异常:', err instanceof Error ? err.message : String(err)));
            return;
          }

          const finalProcessSummary = getClonedActiveHistoryProcessSummaryHelper(
            this.activeHistoryProcessSummary,
            cloneHistoryProcessSummary,
          );
          const rolledBack = this.rollbackPendingRegenerateState(reuseMsgId);
          if (!rolledBack) {
            upsertAssistantDisplayHistoryMessage(this.displayHistory, {
              content: displayContent,
              timestamp: assistantTimestamp,
              processSummary: finalProcessSummary,
              messageId: reuseMsgId,
              createDisplayMessageId: createDisplayMessageIdHelper,
            });
            this.saveChatHistory();
            for (const message of buildAssistantDisplayCompletionMessages({
              messageId: reuseMsgId,
              displayContent,
              processSummary: finalProcessSummary,
            })) {
              this.postMessage(message);
            }
          }

          this.postMessage({
            type: 'showError',
            message: '工具调用轮次已达上限（200 轮），已自动停止。请缩小任务范围后重试。',
            retryRequestId,
          });
          this.postMessage({ type: 'setLoading', loading: false });
          const completionState = consumeRunCompletionState({
            activeHistoryProcessSummary: this.activeHistoryProcessSummary,
          });
          this.setActiveRunIdState(completionState.nextActiveRunId);
          this.stepSequence = completionState.nextStepSequence;
          this.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
        },
        onPlainCompleted: () => {
          if (this.turnWriteRounds >= 2) {
            this.postMessage(buildFinalTurnChangeSummaryResponse(reuseMsgId, this.turnWriteFiles));
          }
          this.pendingRegenerateState = clearPendingRegenerateStateHelper(this.pendingRegenerateState, reuseMsgId);
        },
        onErrorBeforeNotify: () => {
          const rolledBack = this.rollbackPendingRegenerateState(reuseMsgId);
          const finalProcessSummary = getClonedActiveHistoryProcessSummaryHelper(
            this.activeHistoryProcessSummary,
            cloneHistoryProcessSummary,
          );
          if (rolledBack) {
            return;
          }

          upsertAssistantDisplayHistoryMessage(this.displayHistory, {
            content: '⚠️ 工具执行出错，请重试。',
            timestamp: Date.now(),
            processSummary: finalProcessSummary,
            messageId: reuseMsgId,
            createDisplayMessageId: createDisplayMessageIdHelper,
          });
          this.saveChatHistory();
          for (const message of buildAssistantDisplayCompletionMessages({
            messageId: reuseMsgId,
            displayContent: '⚠️ 工具执行出错，请重试。',
            processSummary: finalProcessSummary,
            includeUpdateMessage: true,
          })) {
            this.postMessage(message);
          }
        },
        onDoneLog: fullContent => {
          info(`续轮回复完成，长度: ${fullContent.length}`);
        },
        onErrorLog: errorMessage => {
          error('续轮 AI 调用失败:', errorMessage);
        },
      });

    } finally {
      this.toolCallsInProgress = false;
    }
  }

  // ==================== 重新生成 ====================

  private async handleRegenerate(targetAssistantMessageId: string): Promise<void> {
    if (this.hasRunningTask()) {
      const message = '当前仍在生成，请先停止当前任务后再重新生成。';
      this.postMessage({ type: 'showError', message });
      return;
    }

    if (this.hasRunningTaskElsewhere()) {
      const message = this.getCrossTabRunConflictMessage(this.activeSessionId);
      this.postMessage({ type: 'showError', message });
      return;
    }

    const history = this.chatHistory as ChatSessionHistoryMessage[];
    const prepareResult = prepareRegenerateRequest({
      history,
      displayHistory: this.displayHistory,
      uiTranscript: this.cloneUiTranscript(this.uiTranscript),
      targetAssistantMessageId,
      isToolFeedbackMessage,
      getDisplayHistoryMessageById,
      getLastAssistantDisplayHistoryMessage,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: uiTranscript => this.cloneUiTranscript(uiTranscript),
      cloneHistoryProcessSummary,
    });

    if (!prepareResult.ok) {
      vscode.window.showInformationMessage(prepareResult.errorMessage);
      return;
    }

    this.pendingRegenerateState = prepareResult.pendingState;
    this.chatHistory = prepareResult.trimmedHistory as ChatMessageParam[];

    info('重新生成回复，参考用户消息长度:', prepareResult.userText.length);
    await this.regenerateResponse(prepareResult.userText, this.currentMode, targetAssistantMessageId);
  }

  private async regenerateResponse(userText: string, requestMode: WorkMode, reuseMessageId?: string): Promise<void> {
    // 重新生成也是新的一轮，清空跨轮文件记录和轮次计数器
    this.turnWriteFiles = [];
    this.turnWriteRounds = 0;
    this.activeHistoryProcessSummary = resetActiveHistoryProcessSummaryHelper();
    this.postMessage({ type: 'setLoading', loading: true });

    const regenMsgId = reuseMessageId || `ai-regen-${Date.now()}`;
    const retryRequestId = createRetryRequestIdHelper();
    const runLockError = this.tryAcquireCurrentSessionRunLock(regenMsgId);
    if (runLockError) {
      this.rollbackPendingRegenerateState(regenMsgId);
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({ type: 'showError', message: runLockError, retryRequestId });
      return;
    }

    try {

      const apiKey = await ensureApiKey();
      if (!apiKey) {
        this.resetOwnedRunState();
        this.postMessage({ type: 'setLoading', loading: false });
        this.rollbackPendingRegenerateState(regenMsgId);
        this.postMessage({ type: 'showError', message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey', retryRequestId });
        return;
      }

      const modelConfig = getModelConfig();
      const requestExecution = prepareChatRequestExecution({
        modelConfig,
        requestMode,
        remindedMessages: prepareRemindedMessages({
          history: this.chatHistory,
          requestMode,
          contextWindow: modelConfig.contextWindow,
          maxTokens: getMaxTokens(),
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
        abortStream: this.abortStream,
        runId: regenMsgId,
        runtime: {
          setAbortStream: abortStream => {
            this.abortStream = abortStream;
          },
          setToolCallsInProgress: toolCallsInProgress => {
            this.toolCallsInProgress = toolCallsInProgress;
          },
          setActiveRunId: activeRunId => {
            this.setActiveRunIdState(activeRunId);
          },
          setStepSequence: stepSequence => {
            this.stepSequence = stepSequence;
          },
          setToolCallRound: toolCallRound => {
            this.toolCallRound = toolCallRound;
          },
        },
        clearWriteBackups: () => {
          this.writeBackups.clear();
        },
      });
      // 重新生成：清空上一轮写文件备份
      if (reuseMessageId) {
        this.postMessage({ type: 'resetMessageState', messageId: regenMsgId });
      } else {
        this.postMessage({ type: 'addMessage', role: 'assistant', content: '', messageId: regenMsgId });
      }

      this.abortStream = startBasicAssistantStreamRequest({
        apiConfig,
        messages,
        messageId: regenMsgId,
        chatHistory: this.chatHistory as ChatSessionHistoryMessage[],
        displayHistory: this.displayHistory,
        runtime: {
          getActiveRunId: () => this.activeRunId,
          getActiveHistoryProcessSummary: () => this.activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setActiveRunIdState(activeRunId);
          },
          setStepSequence: stepSequence => {
            this.stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postMessage(message),
        saveChatHistory: () => this.saveChatHistory(),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        onToolCalls: ({ fullContent, parsedToolCalls }) => {
          this.handleToolCalls(fullContent, apiConfig, regenMsgId, requestMode, parsedToolCalls, retryRequestId)
            .catch(err => error('重生成工具调用处理异常:', err instanceof Error ? err.message : String(err)));
        },
        onPlainCompleted: () => {
          this.pendingRegenerateState = clearPendingRegenerateStateHelper(this.pendingRegenerateState, regenMsgId);
        },
        onErrorBeforeNotify: () => {
          this.rollbackPendingRegenerateState(regenMsgId);
        },
        onDoneLog: fullContent => {
          info('重新生成完成，长度:', fullContent.length);
        },
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({
        type: 'showError',
        message: `重新生成启动失败：${errMsg}`,
        retryRequestId,
      });
    }
  }

  // ==================== 运行时状态管理 ====================

  private resetSessionScopedRuntimeState(options?: { clearContextFiles?: boolean }): void {
    const resetResult = consumeSessionScopedRuntimeReset<ChangeSummaryFile>({
      abortStream: this.abortStream,
      clearContextFiles: options?.clearContextFiles,
    });

    if (resetResult.abortStreamToStop) {
      (resetResult.abortStreamToStop as AbortStreamFn)();
    }

    this.setActiveRunIdState(resetResult.nextActiveRunId);
    this.abortStream = resetResult.nextAbortStream;
    this.toolCallsInProgress = resetResult.nextToolCallsInProgress;
    this.stepSequence = resetResult.nextStepSequence;
    this.toolCallRound = resetResult.nextToolCallRound;
    this.turnWriteFiles = resetResult.nextTurnWriteFiles;
    this.turnWriteRounds = resetResult.nextTurnWriteRounds;
    if (resetResult.shouldClearWriteBackups) {
      this.writeBackups.clear();
    }
    this.pendingRegenerateState = resetResult.nextPendingRegenerateState;
    this.activeHistoryProcessSummary = resetResult.nextActiveHistoryProcessSummary;
    this.resetUiRuntimeState();

    if (resetResult.shouldClearContextFiles) {
      this.contextFiles = resetResult.nextContextFiles;
      this.postMessage({ type: 'clearContextFiles' });
    }

    this.postMessage({ type: 'setLoading', loading: false });
  }

  private rollbackPendingRegenerateState(runId: string): boolean {
    const rollbackResult = rollbackPendingRegenerateStateHelper({
      pendingState: this.pendingRegenerateState,
      runId,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: uiTranscript => this.cloneUiTranscript(uiTranscript),
      cloneHistoryProcessSummary,
    });
    this.pendingRegenerateState = rollbackResult.nextPendingState;

    if (!rollbackResult.rolledBack) {
      return false;
    }

    this.chatHistory = rollbackResult.restoredHistory as ChatMessageParam[];
    this.displayHistory = rollbackResult.restoredDisplayHistory;
    this.uiTranscript = rollbackResult.restoredUiTranscript;
    this.rebuildUiMessageIndexes();
    this.saveChatHistory();

    if (rollbackResult.restoredUiTranscript.length > 0) {
      this.postMessage({ type: 'clearChat' });
      this.restoreUiTranscriptToWebview();
      return true;
    }

    this.postMessage({ type: 'resetMessageState', messageId: rollbackResult.messageId });
    for (const message of buildAssistantDisplayCompletionMessages({
      messageId: rollbackResult.messageId,
      displayContent: rollbackResult.restoreContent,
      processSummary: rollbackResult.restoreProcessSummary,
      includeUpdateMessage: true,
    })) {
      this.postMessage(message);
    }

    return true;
  }

  private hasRunningTask(): boolean {
    return hasRunningTaskHelper({
      activeRunId: this.activeRunId,
      abortStream: this.abortStream,
      toolCallsInProgress: this.toolCallsInProgress,
    });
  }

  // ==================== 会话管理 ====================

  private loadSessions(): void {
    const loadResult = this.store.load({
      normalizeHistoryMessages,
      sanitizeDisplayHistory: this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    this.activeSessionId = loadResult.activeSessionId;

    if (loadResult.shouldResave) {
      this.saveSessions();
    }

    info(`加载会话数据：共 ${this.sessions.length} 个会话，活跃: ${this.activeSessionId}`);
  }

  private saveSessions(): ReturnType<typeof buildUpdateSessionsResponse> {
    this.pushTokenCount();
    return this.store.persist(this.activeSessionId);
  }

  private saveChatHistory(): void {
    prepareActiveSessionForSave({
      session: getActiveSessionHelper(this.sessions, this.activeSessionId),
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    const sessionListResponse = this.saveSessions();
    this.postMessage(sessionListResponse);
  }

  private switchSession(sessionId: string): void {
    if (this.isSessionRunningInOtherTab(sessionId)) {
      this.postMessage({
        type: 'showError',
        message: '目标会话正在其他聊天 Tab 中生成，请先停止当前任务后再切换。',
      });
      return;
    }

    const switchPlan = planSwitchSession({
      hasRunningTask: this.hasRunningTask(),
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      targetSessionId: sessionId,
      sessionLauncherVisible: this.sessionLauncherVisible,
      sanitizeDisplayHistory: this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
      createDisplayMessageId: createDisplayMessageIdHelper,
    });

    if (switchPlan.kind === 'blocked') {
      this.postMessage({
        type: 'showError',
        message: switchPlan.errorMessage,
      });
      return;
    }

    if (switchPlan.kind === 'noop') {
      return;
    }

    this.resetSessionScopedRuntimeState();
    this.sessions = switchPlan.nextSessions;
    this.activeSessionId = switchPlan.nextActiveSessionId;
    this.sessionLauncherVisible = switchPlan.nextSessionLauncherVisible;
    if (switchPlan.clearRetryableSessionId) {
      clearRetryableRequestsForSessionHelper(this.retryableRequests, switchPlan.clearRetryableSessionId);
    }
    const activeSession = getActiveSessionHelper(this.sessions, this.activeSessionId);
    const hasUiTranscript = Array.isArray(activeSession?.uiTranscript) && activeSession.uiTranscript.length > 0;
    const sessionListResponse = this.saveSessions();
    if (hasUiTranscript) {
      this.postMessage({ type: 'clearChat' });
      this.postMessage({ type: 'setSessionLauncher', visible: false });
      this.restoreUiTranscriptToWebview();
    } else {
      for (const message of switchPlan.messages) {
        this.postMessage(message);
      }
      if (this.uiTranscript.length > 0) {
        this.persistUiTranscript();
      }
    }
    this.postMessage(sessionListResponse);
    this.syncHostTitle();
    info(`切换会话到: ${switchPlan.sessionName}`);
  }

  private deleteSession(sessionId: string): void {
    if (this.isSessionRunningInOtherTab(sessionId)) {
      this.postMessage({
        type: 'showError',
        message: '目标会话正在其他聊天 Tab 中生成，请先停止当前任务后再删除。',
      });
      return;
    }

    const deletePlan = planDeleteSession({
      hasRunningTask: this.hasRunningTask(),
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      targetSessionId: sessionId,
    });

    if (deletePlan.kind === 'blocked') {
      this.postMessage({
        type: 'showError',
        message: deletePlan.errorMessage,
      });
      return;
    }

    if (deletePlan.kind === 'noop') {
      return;
    }

    clearRetryableRequestsForSessionHelper(this.retryableRequests, deletePlan.clearRetryableSessionId);
    this.sessions = deletePlan.nextSessions;
    if (deletePlan.shouldResetSessionRuntime) {
      this.resetSessionScopedRuntimeState();
    }
    this.activeSessionId = deletePlan.nextActiveSessionId;
    if (typeof deletePlan.nextSessionLauncherVisible === 'boolean') {
      this.sessionLauncherVisible = deletePlan.nextSessionLauncherVisible;
    }
    const sessionListResponse = this.saveSessions();
    for (const message of deletePlan.messages) {
      this.postMessage(message);
    }
    this.postMessage(sessionListResponse);
    this.syncHostTitle();
    info(`删除会话: ${deletePlan.deletedSessionId}`);
  }

  // ==================== 辅助方法 ====================

  /** 将当前活跃会话名称同步到宿主标题（Tab 标签文字） */
  private syncHostTitle(): void {
    const activeSession = getActiveSessionHelper(this.sessions, this.activeSessionId);
    const title = activeSession?.name || getPanelTitle();
    this.host.setTitle?.(title);
  }

  private pushTokenCount(): void {
    const modelConfig = getModelConfig();
    const contextUsage = buildContextUsageSnapshot(this.chatHistory, {
      contextWindow: modelConfig.contextWindow,
      maxTokens: getMaxTokens(),
    });
    this.postMessage(buildUpdateTokenCountResponse(contextUsage));
  }

  private async exportChatToMarkdown(): Promise<void> {
    if (this.displayHistory.length === 0) {
      vscode.window.showInformationMessage('当前没有对话可导出');
      return;
    }

    const displayHistory = getSessionDisplayHistoryForExport({
      session: getActiveSessionHelper(this.sessions, this.activeSessionId),
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    const markdown = buildChatExportMarkdown(displayHistory);
    const savedFilePath = await saveChatExportMarkdown(markdown);
    if (!savedFilePath) {
      return;
    }

    vscode.window.showInformationMessage(`对话已导出到 ${savedFilePath}`);
    info(`对话导出成功: ${savedFilePath}`);
  }
}
