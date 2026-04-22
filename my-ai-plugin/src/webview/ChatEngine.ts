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
import type { ParsedToolCall } from '../tools';
import { FileReadStateCache } from '../tools';
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
  buildExpiredChangeSummaryResponse,
  buildFinalTurnChangeSummaryResponse,
  collectWriteBackupMessageIds,
  getDisplayPath as getDisplayPathHelper,
  isChangeSummaryFileUndoable,
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

type UserMessageRequestOptions = {
  userContentOverride?: string;
  retryRequestId?: string;
  requestMode?: WorkMode;
};

type SessionRuntimeState = {
  activeRunId: string | null;
  abortStream: AbortStreamFn | null;
  toolCallsInProgress: boolean;
  stepSequence: number;
  toolCallRound: number;
  turnWriteFiles: ChangeSummaryFile[];
  turnWriteRounds: number;
  activeHistoryProcessSummary: HistoryProcessSummary | null;
  pendingRegenerateState: PendingRegenerateState | null;
  writeBackups: Map<string, WriteBackupEntry>;
  stepToMessageId: Map<string, string>;
  summaryToMessageId: Map<string, string>;
  currentMode: WorkMode;
  contextFiles: string[];
};

const LAUNCHER_SESSION_RUNTIME_KEY = '__launcher__';

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

  private getSessionById(sessionId: string): ChatSession | undefined {
    if (!sessionId) {
      return undefined;
    }

    return this.sessions.find(session => session.id === sessionId);
  }

  private getChatHistoryForSession(sessionId: string): ChatMessageParam[] {
    const session = this.getSessionById(sessionId);
    return session ? (session.history as ChatMessageParam[]) : [];
  }

  private setChatHistoryForSession(sessionId: string, value: ChatMessageParam[]): void {
    const session = this.getSessionById(sessionId);
    if (session) {
      session.history = value;
    }
  }

  private getUiTranscriptForSession(sessionId: string): PersistedUiEntry[] {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return [];
    }

    if (!Array.isArray(session.uiTranscript)) {
      session.uiTranscript = [];
    }

    return session.uiTranscript;
  }

  private setUiTranscriptForSession(sessionId: string, value: PersistedUiEntry[]): void {
    const session = this.getSessionById(sessionId);
    if (session) {
      session.uiTranscript = value;
    }
  }

  private getDisplayHistoryForSession(sessionId: string): ChatSessionDisplayMessage[] {
    return resolveSessionDisplayHistory({
      session: this.getSessionById(sessionId),
      sanitizeDisplayHistory: this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });
  }

  private setDisplayHistoryForSession(sessionId: string, value: ChatSessionDisplayMessage[]): void {
    setSessionDisplayHistory(
      this.getSessionById(sessionId),
      value,
      this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
    );
  }

  /**
   * 当前活跃会话的对话历史（getter 返回对活跃会话历史数组的引用）
   * push / slice 等操作会直接修改会话内的数组内容
   */
  private get chatHistory(): ChatMessageParam[] {
    return this.getChatHistoryForSession(this.activeSessionId);
  }

  /** chatHistory setter：用于整体替换（如 clearHistory） */
  private set chatHistory(value: ChatMessageParam[]) {
    this.setChatHistoryForSession(this.activeSessionId, value);
  }

  private get uiTranscript(): PersistedUiEntry[] {
    return this.getUiTranscriptForSession(this.activeSessionId);
  }

  private set uiTranscript(value: PersistedUiEntry[]) {
    this.setUiTranscriptForSession(this.activeSessionId, value);
  }

  // ==================== 运行时状态 ====================

  private readonly sessionRuntimeBySessionId: Map<string, SessionRuntimeState> = new Map();

  private sessionLauncherVisible = false;

  private retryableRequests: Map<string, RetryableRequestState> = new Map();

  /**
   * 文件读取状态 LRU 缓存（引擎级，跨会话共享）。
   * 记录模型通过 read_file 工具读取过的文件信息，
   * 用于 edit_file 执行前的"先读后编"校验。
   */
  private readonly fileReadStateCache = new FileReadStateCache();

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

  private createSessionRuntimeState(): SessionRuntimeState {
    return {
      activeRunId: null,
      abortStream: null,
      toolCallsInProgress: false,
      stepSequence: 0,
      toolCallRound: 0,
      turnWriteFiles: [],
      turnWriteRounds: 0,
      activeHistoryProcessSummary: null,
      pendingRegenerateState: null,
      writeBackups: new Map(),
      stepToMessageId: new Map(),
      summaryToMessageId: new Map(),
      currentMode: 'code',
      contextFiles: [],
    };
  }

  private getSessionRuntimeKey(sessionId: string): string {
    return sessionId || LAUNCHER_SESSION_RUNTIME_KEY;
  }

  private getSessionRuntimeState(sessionId: string = this.activeSessionId): SessionRuntimeState {
    const runtimeKey = this.getSessionRuntimeKey(sessionId);
    const existingRuntime = this.sessionRuntimeBySessionId.get(runtimeKey);
    if (existingRuntime) {
      return existingRuntime;
    }

    const nextRuntime = this.createSessionRuntimeState();
    this.sessionRuntimeBySessionId.set(runtimeKey, nextRuntime);
    return nextRuntime;
  }

  private clearSessionRuntimeState(sessionId: string): void {
    const runtimeKey = this.getSessionRuntimeKey(sessionId);
    this.sessionRuntimeBySessionId.delete(runtimeKey);
  }

  private get abortStream(): AbortStreamFn | null {
    return this.getSessionRuntimeState().abortStream;
  }

  private set abortStream(value: AbortStreamFn | null) {
    this.getSessionRuntimeState().abortStream = value;
  }

  private get activeRunId(): string | null {
    return this.getSessionRuntimeState().activeRunId;
  }

  private set activeRunId(value: string | null) {
    this.getSessionRuntimeState().activeRunId = value;
  }

  private get toolCallsInProgress(): boolean {
    return this.getSessionRuntimeState().toolCallsInProgress;
  }

  private set toolCallsInProgress(value: boolean) {
    this.getSessionRuntimeState().toolCallsInProgress = value;
  }

  private get stepSequence(): number {
    return this.getSessionRuntimeState().stepSequence;
  }

  private set stepSequence(value: number) {
    this.getSessionRuntimeState().stepSequence = value;
  }

  private get toolCallRound(): number {
    return this.getSessionRuntimeState().toolCallRound;
  }

  private set toolCallRound(value: number) {
    this.getSessionRuntimeState().toolCallRound = value;
  }

  private get writeBackups(): Map<string, WriteBackupEntry> {
    return this.getSessionRuntimeState().writeBackups;
  }

  private get turnWriteFiles(): ChangeSummaryFile[] {
    return this.getSessionRuntimeState().turnWriteFiles;
  }

  private set turnWriteFiles(value: ChangeSummaryFile[]) {
    this.getSessionRuntimeState().turnWriteFiles = value;
  }

  private get turnWriteRounds(): number {
    return this.getSessionRuntimeState().turnWriteRounds;
  }

  private set turnWriteRounds(value: number) {
    this.getSessionRuntimeState().turnWriteRounds = value;
  }

  private get activeHistoryProcessSummary(): HistoryProcessSummary | null {
    return this.getSessionRuntimeState().activeHistoryProcessSummary;
  }

  private set activeHistoryProcessSummary(value: HistoryProcessSummary | null) {
    this.getSessionRuntimeState().activeHistoryProcessSummary = value;
  }

  private get pendingRegenerateState(): PendingRegenerateState | null {
    return this.getSessionRuntimeState().pendingRegenerateState;
  }

  private set pendingRegenerateState(value: PendingRegenerateState | null) {
    this.getSessionRuntimeState().pendingRegenerateState = value;
  }

  private get currentMode(): WorkMode {
    return this.getSessionRuntimeState().currentMode;
  }

  private set currentMode(value: WorkMode) {
    this.getSessionRuntimeState().currentMode = value;
  }

  private get contextFiles(): string[] {
    return this.getSessionRuntimeState().contextFiles;
  }

  private set contextFiles(value: string[]) {
    this.getSessionRuntimeState().contextFiles = value;
  }

  private get stepToMessageId(): Map<string, string> {
    return this.getSessionRuntimeState().stepToMessageId;
  }

  private get summaryToMessageId(): Map<string, string> {
    return this.getSessionRuntimeState().summaryToMessageId;
  }

  private getGlobalRunLock(sessionId: string): SessionRunLock | null {
    return this.store.getRunLock(sessionId);
  }

  private hasRunningTaskElsewhere(sessionId: string = this.activeSessionId): boolean {
    const runLock = this.getGlobalRunLock(sessionId);
    return !!runLock && runLock.ownerId !== this.engineId;
  }

  private isSessionRunningInOtherTab(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    const runLock = this.getGlobalRunLock(sessionId);
    return !!runLock && runLock.ownerId !== this.engineId;
  }

  private hasRunningTask(sessionId: string = this.activeSessionId): boolean {
    const runtime = this.getSessionRuntimeState(sessionId);
    return hasRunningTaskHelper({
      activeRunId: runtime.activeRunId,
      abortStream: runtime.abortStream,
      toolCallsInProgress: runtime.toolCallsInProgress,
    });
  }

  private setSessionActiveRunIdState(sessionId: string, nextActiveRunId: string | null): void {
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

  private setActiveRunIdState(nextActiveRunId: string | null): void {
    this.setSessionActiveRunIdState(this.activeSessionId, nextActiveRunId);
  }

  private getCrossTabRunConflictMessage(sessionId: string): string {
    const runLock = this.getGlobalRunLock(sessionId);
    if (runLock && runLock.ownerId !== this.engineId) {
      return '当前会话正在其他聊天 Tab 中生成，请先停止当前任务后再继续。';
    }

    return '当前会话已有进行中的任务，请先停止当前任务后再继续。';
  }

  private tryAcquireSessionRunLock(sessionId: string, runId: string): string | null {
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

  private tryAcquireCurrentSessionRunLock(runId: string): string | null {
    return this.tryAcquireSessionRunLock(this.activeSessionId, runId);
  }

  private resetOwnedRunState(sessionId: string = this.activeSessionId): void {
    const runtime = this.getSessionRuntimeState(sessionId);
    this.setSessionActiveRunIdState(sessionId, null);
    runtime.abortStream = null;
    runtime.toolCallsInProgress = false;
    runtime.stepSequence = 0;
    runtime.toolCallRound = 0;
    runtime.activeHistoryProcessSummary = null;
  }

  private syncActiveSessionTransientState(): void {
    this.host.postMessage({ type: 'updateMode', mode: this.currentMode });
    this.host.postMessage({ type: 'clearContextFiles' });

    for (const filePath of this.contextFiles) {
      this.host.postMessage({
        type: 'addContextFile',
        filePath,
        fileName: filePath.split(/[\\/]/).pop() || filePath,
      });
    }
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

  /**
   * 销毁引擎，释放该引擎持有的所有运行锁。
   * 在宿主（ChatTabPanel）被关闭时调用，防止会话被永久锁定。
   */
  public dispose(): void {
    this.store.releaseRunLock({ ownerId: this.engineId });
    info(`ChatEngine disposed: ${this.engineId}`);
  }

  /** 向前端发送消息（委托给宿主） */
  public postMessage(message: ExtensionMessage): void {
    this.postSessionMessage(this.activeSessionId, message);
  }

  private postSessionMessage(sessionId: string, message: ExtensionMessage): void {
    this.capturePersistedUiState(sessionId, message);
    if (sessionId && sessionId !== this.activeSessionId) {
      return;
    }

    this.host.postMessage(message);
  }

  private capturePersistedUiState(sessionId: string, message: ExtensionMessage): void {
    if (!this.getSessionById(sessionId)) {
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
          sessionId,
        );
        if (message.role === 'user' && !message.readOnly) {
          this.persistUiTranscript(sessionId);
        }
        return;

      case 'streamChunk': {
        const createdAt = this.getUiMessageCreatedAt(message.messageId, message.createdAt ?? Date.now(), sessionId);
        const entry = this.ensureUiMessageEntry(message.messageId, 'assistant', createdAt, sessionId);
        if (!entry) {
          return;
        }

        entry.content += message.chunk;
        entry.partial = true;
        return;
      }

      case 'streamDone': {
        const entry = this.findUiMessageEntry(message.messageId, sessionId);
        if (entry && entry.role === 'assistant') {
          delete entry.partial;
          this.persistUiTranscript(sessionId);
        }
        return;
      }

      case 'updateMessage':
        this.setUiMessageContent(
          message.messageId,
          'assistant',
          this.getUiMessageCreatedAt(message.messageId, Date.now(), sessionId),
          message.content,
          false,
          sessionId,
        );
        this.persistUiTranscript(sessionId);
        return;

      case 'showError':
        this.appendUiError(message.message, message.retryable, message.createdAt ?? Date.now(), sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'generationStopped':
        if (message.messageId) {
          this.markUiMessageStopped(message.messageId, sessionId);
          this.persistUiTranscript(sessionId);
        }
        return;

      case 'thinkingComplete':
        this.appendUiEvent(message.messageId, {
          type: 'thinkingComplete',
          elapsed: message.elapsed,
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'showHistoryProcessSummary':
        this.appendUiEvent(message.messageId, {
          type: 'showHistoryProcessSummary',
          summary: message.summary,
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'addStep':
        this.appendUiEvent(message.messageId, {
          type: 'addStep',
          stepId: message.stepId,
          icon: message.icon,
          description: message.description,
          status: message.status,
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'updateStep': {
        const messageId = this.findMessageIdByStepId(message.stepId, sessionId);
        if (!messageId) {
          return;
        }

        this.appendUiEvent(messageId, {
          type: 'updateStep',
          stepId: message.stepId,
          status: message.status,
          description: message.description,
          elapsed: message.elapsed,
        }, sessionId);
        this.persistUiTranscript(sessionId);
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
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'showChangeSummary':
        this.appendUiEvent(message.messageId, {
          type: 'showChangeSummary',
          summaryId: message.summaryId,
          needsConfirm: message.needsConfirm,
          files: message.files,
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'updateChangeSummary': {
        const messageId = this.findMessageIdBySummaryId(message.summaryId, sessionId);
        if (!messageId) {
          return;
        }

        this.appendUiEvent(messageId, {
          type: 'updateChangeSummary',
          summaryId: message.summaryId,
          status: message.status,
          text: message.text,
        }, sessionId);
        this.persistUiTranscript(sessionId);
        return;
      }

      case 'resetMessageState':
        this.resetUiMessageState(message.messageId, sessionId);
        this.persistUiTranscript(sessionId);
        return;

      case 'removeLastAssistantMessage':
        this.removeLastAssistantUiMessage(sessionId);
        this.persistUiTranscript(sessionId);
        return;

      default:
        return;
    }
  }

  private persistUiTranscript(sessionId: string = this.activeSessionId): void {
    if (!this.getSessionById(sessionId)) {
      return;
    }

    this.store.persist(this.activeSessionId);
  }

  private ensureUiMessageEntry(
    messageId: string,
    role: 'user' | 'assistant',
    createdAt: number,
    sessionId: string = this.activeSessionId,
  ): PersistedUiMessageEntry | null {
    if (!this.getSessionById(sessionId)) {
      return null;
    }

    const transcript = this.getUiTranscriptForSession(sessionId);
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

  private findUiMessageEntry(messageId: string, sessionId: string = this.activeSessionId): PersistedUiMessageEntry | null {
    const entry = this.getUiTranscriptForSession(sessionId).find((item): item is PersistedUiMessageEntry => {
      return item.type === 'message' && item.messageId === messageId;
    });
    return entry ?? null;
  }

  private getUiMessageCreatedAt(messageId: string, fallback = Date.now(), sessionId: string = this.activeSessionId): number {
    const entry = this.findUiMessageEntry(messageId, sessionId);
    return entry?.createdAt ?? fallback;
  }

  private setUiMessageContent(
    messageId: string,
    role: 'user' | 'assistant',
    createdAt: number,
    content: string,
    partial = false,
    sessionId: string = this.activeSessionId,
  ): void {
    const entry = this.ensureUiMessageEntry(messageId, role, createdAt, sessionId);
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

  private appendUiError(
    message: string,
    retryable = true,
    createdAt = Date.now(),
    sessionId: string = this.activeSessionId,
  ): void {
    if (!this.getSessionById(sessionId)) {
      return;
    }

    this.getUiTranscriptForSession(sessionId).push({
      type: 'error',
      createdAt,
      message,
      retryable: retryable ? true : undefined,
    });
  }

  private appendUiEvent(
    messageId: string,
    event: PersistedUiEvent,
    sessionId: string = this.activeSessionId,
  ): void {
    const entry = this.ensureUiMessageEntry(messageId, 'assistant', Date.now(), sessionId);
    if (!entry) {
      return;
    }

    if (!Array.isArray(entry.events)) {
      entry.events = [];
    }

    entry.events.push(event);
    const runtime = this.getSessionRuntimeState(sessionId);
    if (event.type === 'addStep') {
      runtime.stepToMessageId.set(event.stepId, messageId);
    }
    if (event.type === 'showDiff' && event.summaryId) {
      runtime.summaryToMessageId.set(event.summaryId, messageId);
    }
    if (event.type === 'showChangeSummary') {
      runtime.summaryToMessageId.set(event.summaryId, messageId);
    }
  }

  private resetUiRuntimeState(sessionId: string = this.activeSessionId): void {
    const runtime = this.getSessionRuntimeState(sessionId);
    runtime.stepToMessageId.clear();
    runtime.summaryToMessageId.clear();
  }

  private rebuildUiMessageIndexes(sessionId: string = this.activeSessionId): void {
    const runtime = this.getSessionRuntimeState(sessionId);
    this.resetUiRuntimeState(sessionId);

    for (const entry of this.getUiTranscriptForSession(sessionId)) {
      if (entry.type !== 'message' || !Array.isArray(entry.events)) {
        continue;
      }

      for (const event of entry.events) {
        if (event.type === 'addStep') {
          runtime.stepToMessageId.set(event.stepId, entry.messageId);
        }

        if (event.type === 'showDiff' && event.summaryId) {
          runtime.summaryToMessageId.set(event.summaryId, entry.messageId);
        }

        if (event.type === 'showChangeSummary') {
          runtime.summaryToMessageId.set(event.summaryId, entry.messageId);
        }
      }
    }
  }

  private findMessageIdByStepId(stepId: string, sessionId: string = this.activeSessionId): string | null {
    const mappedMessageId = this.getSessionRuntimeState(sessionId).stepToMessageId.get(stepId);
    if (mappedMessageId) {
      return mappedMessageId;
    }

    for (const entry of this.getUiTranscriptForSession(sessionId)) {
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

  private findMessageIdBySummaryId(summaryId: string, sessionId: string = this.activeSessionId): string | null {
    const mappedMessageId = this.getSessionRuntimeState(sessionId).summaryToMessageId.get(summaryId);
    if (mappedMessageId) {
      return mappedMessageId;
    }

    for (const entry of this.getUiTranscriptForSession(sessionId)) {
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

  private collectUndoableSummaryIdsForMessage(messageId: string, sessionId: string = this.activeSessionId): string[] {
    const entry = this.findUiMessageEntry(messageId, sessionId);
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

  private expireUndoableSummariesForMessageIds(
    messageIds: string[],
    sessionId: string,
    options?: { excludeSummaryIds?: string[]; text?: string },
  ): void {
    const excludeSummaryIds = new Set(options?.excludeSummaryIds ?? []);
    const postedSummaryIds = new Set<string>();

    for (const messageId of messageIds) {
      for (const summaryId of this.collectUndoableSummaryIdsForMessage(messageId, sessionId)) {
        if (excludeSummaryIds.has(summaryId) || postedSummaryIds.has(summaryId)) {
          continue;
        }

        postedSummaryIds.add(summaryId);
        this.postSessionMessage(sessionId, buildExpiredChangeSummaryResponse(summaryId, options?.text));
      }
    }
  }

  private expireUndoableSummariesForWriteBackups(
    writeBackups: Map<string, WriteBackupEntry>,
    sessionId: string,
    text = 'Undo expired',
  ): void {
    const messageIds = collectWriteBackupMessageIds(writeBackups);
    if (messageIds.length === 0) {
      return;
    }

    this.expireUndoableSummariesForMessageIds(messageIds, sessionId, { text });
  }

  private expireUndoableSiblingSummaries(summaryId: string, sessionId: string): void {
    const messageId = this.findMessageIdBySummaryId(summaryId, sessionId);
    if (!messageId) {
      return;
    }

    this.expireUndoableSummariesForMessageIds([messageId], sessionId, { excludeSummaryIds: [summaryId] });
  }

  private resetUiMessageState(messageId: string, sessionId: string = this.activeSessionId): void {
    const entry = this.findUiMessageEntry(messageId, sessionId);
    if (!entry) {
      return;
    }

    delete entry.partial;
    entry.events = [];
    this.rebuildUiMessageIndexes(sessionId);
  }

  private removeLastAssistantUiMessage(sessionId: string = this.activeSessionId): void {
    const transcript = this.getUiTranscriptForSession(sessionId);
    for (let index = transcript.length - 1; index >= 0; index--) {
      const entry = transcript[index];
      if (entry.type === 'message' && entry.role === 'assistant') {
        transcript.splice(index, 1);
        this.rebuildUiMessageIndexes(sessionId);
        return;
      }
    }
  }

  private markUiMessageStopped(messageId: string, sessionId: string = this.activeSessionId): void {
    const entry = this.findUiMessageEntry(messageId, sessionId);
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
      }, sessionId);
    }

    for (const summaryId of pendingSummaryIds) {
      this.appendUiEvent(messageId, {
        type: 'updateChangeSummary',
        summaryId,
        status: 'cancelled',
        text: '✗ Cancelled',
      }, sessionId);
    }
  }

  private restoreUiTranscriptToWebview(sessionId: string = this.activeSessionId): boolean {
    const transcript = this.getUiTranscriptForSession(sessionId);
    if (transcript.length === 0) {
      return false;
    }

    this.resetUiRuntimeState(sessionId);
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

    this.rebuildUiMessageIndexes(sessionId);
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
    const safeIndex = Math.max(0, Math.min(activeIndex, models.length - 1));
    return models[safeIndex]?.name || 'AI';
  }

  /** 推送模型列表到前端 */
  public sendModelList(): void {
    const models = getAllModels();
    const activeIndex = getActiveModelIndex();
    const safeIndex = Math.max(0, Math.min(activeIndex, models.length - 1));
    const modelConfig = getModelConfig();
    this.postMessage(buildUpdateModelsResponse({
      models,
      activeIndex: safeIndex,
      supportsVision: modelConfig.supportsVision ?? false,
    }));
  }

  /**
   * Webview 初始化后由宿主调用，推送初始状态到前端
   * 包括模型列表、工作模式、会话列表和历史消息恢复
   */
  public initializeWebviewState(): void {
    this.sendModelList();
    this.syncActiveSessionTransientState();
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
    this.fileReadStateCache.clear();
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
    this.activeSessionId = '';
    this.sessionLauncherVisible = true;
    this.contextFiles = [];
    const sessionListResponse = this.saveSessions();
    this.host.postMessage(sessionListResponse);
    this.syncActiveSessionTransientState();
    this.host.postMessage({ type: 'setSessionLauncher', visible: true });
    this.host.postMessage({ type: 'clearChat' });
    this.host.postMessage({ type: 'setLoading', loading: false });
    this.host.postMessage({ type: 'focusInput' });
    this.syncHostTitle();
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
        onUndoAllCompleted: summaryId => {
          this.expireUndoableSiblingSummaries(summaryId, this.activeSessionId);
        },
        onUndoSingleCompleted: (summaryId, remainingCount) => {
          if (remainingCount === 0) {
            this.expireUndoableSiblingSummaries(summaryId, this.activeSessionId);
          }
        },
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
    const initialSessionId = this.activeSessionId;
    const initialMode = this.currentMode;
    const initialContextFiles = this.contextFiles.slice();
    info(`[锁诊断] handleUserMessage 入口: engineId=${this.engineId}, initialSessionId=${initialSessionId}, launcherVisible=${this.sessionLauncherVisible}`);
    if (this.hasRunningTask(initialSessionId)) {
      const message = '当前仍在生成，请先停止当前任务后再发送新的消息。';
      this.postSessionMessage(initialSessionId, { type: 'showError', message });
      return;
    }

    if (initialSessionId && this.hasRunningTaskElsewhere(initialSessionId)) {
      info(`[锁诊断] hasRunningTaskElsewhere 命中: engineId=${this.engineId}, sessionId=${initialSessionId}`);
      const message = this.getCrossTabRunConflictMessage(initialSessionId);
      this.postSessionMessage(initialSessionId, { type: 'showError', message });
      return;
    }
    info(`[锁诊断] hasRunningTaskElsewhere 未命中: engineId=${this.engineId}, sessionId=${initialSessionId}, 全局锁快照=${JSON.stringify(this.store.runLocks)}`);

    if (this.sessionLauncherVisible || !getActiveSessionHelper(this.sessions, initialSessionId)) {
      const createSessionPlan = planCreateSession({
        sessions: this.sessions,
        name: buildSessionTitleHelper(text),
      });
      this.sessions = createSessionPlan.nextSessions;
      this.activeSessionId = createSessionPlan.nextActiveSessionId;
      if (typeof createSessionPlan.nextSessionLauncherVisible === 'boolean') {
        this.sessionLauncherVisible = createSessionPlan.nextSessionLauncherVisible;
      }
      const createdSessionRuntime = this.getSessionRuntimeState(this.activeSessionId);
      createdSessionRuntime.currentMode = initialMode;
      createdSessionRuntime.contextFiles = initialContextFiles;
      const sessionListResponse = this.saveSessions();
      for (const message of createSessionPlan.messages) {
        this.postMessage(message);
      }
      this.postMessage(sessionListResponse);
      this.syncHostTitle();
    }

    const sessionId = this.activeSessionId;
    const sessionRuntime = this.getSessionRuntimeState(sessionId);
    const sessionChatHistory = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const sessionDisplayHistory = this.getDisplayHistoryForSession(sessionId);

    const assistantMsgId = `assistant-${Date.now()}`;
    info(`[锁诊断] tryAcquireSessionRunLock: engineId=${this.engineId}, sessionId=${sessionId}, runId=${assistantMsgId}`);
    const runLockError = this.tryAcquireSessionRunLock(sessionId, assistantMsgId);
    if (runLockError) {
      info(`[锁诊断] tryAcquireSessionRunLock 被拒: engineId=${this.engineId}, sessionId=${sessionId}, error=${runLockError}`);
      this.postSessionMessage(sessionId, { type: 'showError', message: runLockError });
      return;
    }
    info(`[锁诊断] tryAcquireSessionRunLock 成功: engineId=${this.engineId}, sessionId=${sessionId}, 当前全局锁=${JSON.stringify(this.store.runLocks)}`);

    sessionRuntime.turnWriteFiles = [];
    sessionRuntime.turnWriteRounds = 0;
    sessionRuntime.activeHistoryProcessSummary = resetActiveHistoryProcessSummaryHelper();

    const userMsgId = `user-${Date.now()}`;
    this.postSessionMessage(sessionId, {
      type: 'addMessage',
      role: 'user',
      content: text,
      messageId: userMsgId,
    });

    this.postSessionMessage(sessionId, { type: 'setLoading', loading: true });

    const retryRequestId = requestOptions?.retryRequestId || createRetryRequestIdHelper();
    const requestMode = requestOptions?.requestMode || sessionRuntime.currentMode;
    sessionRuntime.currentMode = requestMode;
    this.postMessage({ type: 'updateMode', mode: requestMode });
    info('handleUserMessage 模式快照', {
      requestMode,
      currentMode: sessionRuntime.currentMode,
      hasUserContentOverride: !!requestOptions?.userContentOverride,
      retryRequestId,
    });
    const contextFilePaths = requestOptions?.userContentOverride ? [] : sessionRuntime.contextFiles.slice();

    try {

      const apiKey = await ensureApiKey();
      if (!apiKey) {
        this.resetOwnedRunState(sessionId);
        this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
        this.postSessionMessage(sessionId, {
          type: 'showError',
          message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey',
          retryRequestId,
        });
        return;
      }

      const modelConfig = getModelConfig();

      const preparedUserTurn = prepareUserTurnRequest({
        text,
        retryRequestId,
        requestMode,
        activeSessionId: sessionId,
        images,
        userContentOverride: requestOptions?.userContentOverride,
        contextFilePaths,
        chatHistory: sessionChatHistory,
        displayHistory: sessionDisplayHistory,
        retryableRequests: this.retryableRequests,
        modelConfig,
        allModels: getAllModels(),
        createDisplayMessageId: createDisplayMessageIdHelper,
      });

      if (contextFilePaths.length > 0) {
        sessionRuntime.contextFiles = [];
        this.postMessage({ type: 'clearContextFiles' });
      }

      this.saveChatHistory(sessionId);

      if (preparedUserTurn.visionWarning) {
        this.postSessionMessage(sessionId, preparedUserTurn.visionWarning);
      }
      const finalUserContent = preparedUserTurn.finalUserContent;

      this.postSessionMessage(sessionId, { type: 'clearImageAttachments' });

      const requestExecution = prepareChatRequestExecution({
        modelConfig,
        requestMode,
        remindedMessages: prepareRemindedMessages({
          history: sessionChatHistory as ChatMessageParam[],
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
        abortStream: sessionRuntime.abortStream,
        runId: assistantMsgId,
        runtime: {
          setAbortStream: abortStream => {
            sessionRuntime.abortStream = abortStream;
          },
          setToolCallsInProgress: toolCallsInProgress => {
            sessionRuntime.toolCallsInProgress = toolCallsInProgress;
          },
          setActiveRunId: activeRunId => {
            this.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            sessionRuntime.stepSequence = stepSequence;
          },
          setToolCallRound: toolCallRound => {
            sessionRuntime.toolCallRound = toolCallRound;
          },
        },
        clearWriteBackups: () => {
          this.expireUndoableSummariesForWriteBackups(sessionRuntime.writeBackups, sessionId);
          sessionRuntime.writeBackups.clear();
        },
      });

      sessionRuntime.abortStream = startBasicAssistantStreamRequest({
        apiConfig,
        messages,
        messageId: assistantMsgId,
        chatHistory: sessionChatHistory,
        displayHistory: sessionDisplayHistory,
        runtime: {
          getActiveRunId: () => this.getSessionRuntimeState(sessionId).activeRunId,
          getActiveHistoryProcessSummary: () => this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.getSessionRuntimeState(sessionId).abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            this.getSessionRuntimeState(sessionId).stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postSessionMessage(sessionId, message),
        saveChatHistory: () => this.saveChatHistory(sessionId),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        onToolCalls: ({ fullContent, parsedToolCalls }) => {
          this.handleToolCalls(sessionId, fullContent, apiConfig, assistantMsgId, requestMode, parsedToolCalls, retryRequestId)
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
      this.resetOwnedRunState(sessionId);
      error('启动用户消息请求失败:', errMsg);
      this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      this.postSessionMessage(sessionId, {
        type: 'showError',
        message: `请求启动失败：${errMsg}`,
        retryRequestId,
      });
    }
  }

  // ==================== 工具调用处理 ====================

  private async handleToolCalls(
    sessionId: string,
    aiResponse: string,
    apiConfig: ApiClientConfig,
    reuseMsgId: string,
    requestMode: WorkMode,
    parsedToolCalls?: ParsedToolCall[],
    retryRequestId?: string,
  ): Promise<void> {
    const sessionRuntime = this.getSessionRuntimeState(sessionId);
    const sessionChatHistory = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const sessionDisplayHistory = this.getDisplayHistoryForSession(sessionId);
    const toolCallAnalysis = parsedToolCalls
      ? { kind: 'tool-calls' as const, parsedToolCalls }
      : analyzeAssistantResponseDisplay(aiResponse);
    const toolCalls = toolCallAnalysis.kind === 'tool-calls'
      ? toolCallAnalysis.parsedToolCalls
      : [];
    if (toolCalls.length === 0) {
      if (sessionRuntime.activeRunId === reuseMsgId) {
        this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
        const completionState = consumeRunCompletionState({
          activeHistoryProcessSummary: sessionRuntime.activeHistoryProcessSummary,
          resetActiveHistoryProcessSummary: false,
        });
        this.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
        sessionRuntime.stepSequence = completionState.nextStepSequence;
        sessionRuntime.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
      }
      return;
    }

    if (sessionRuntime.activeRunId !== reuseMsgId) {
      if (sessionRuntime.activeRunId === null) {
        this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
        const completionState = consumeRunCompletionState({
          activeHistoryProcessSummary: sessionRuntime.activeHistoryProcessSummary,
        });
        this.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
        sessionRuntime.stepSequence = completionState.nextStepSequence;
        sessionRuntime.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
      }
      return;
    }

    if (sessionRuntime.toolCallsInProgress) {
      info('handleToolCalls 已在执行中，跳过重复调用');
      return;
    }
    sessionRuntime.toolCallsInProgress = true;
    sessionRuntime.toolCallRound += 1;
    sessionRuntime.currentMode = requestMode;
    if (sessionId === this.activeSessionId) {
      this.postMessage({ type: 'updateMode', mode: requestMode });
    }
    info('handleToolCalls 模式快照', { reuseMsgId, requestMode, currentMode: sessionRuntime.currentMode, toolCallRound: sessionRuntime.toolCallRound });

    try {

      info(`检测到 ${toolCalls.length} 个工具调用，立即执行，当前轮次: ${sessionRuntime.toolCallRound}`);

      const batchRound = await executeToolCallBatchRound({
        toolCalls,
        requestMode,
        messageId: reuseMsgId,
        apiConfig,
        stepSequenceStart: sessionRuntime.stepSequence,
        writeBackups: sessionRuntime.writeBackups,
        turnWriteFiles: sessionRuntime.turnWriteFiles,
        turnWriteRounds: sessionRuntime.turnWriteRounds,
        activeHistoryProcessSummary: sessionRuntime.activeHistoryProcessSummary,
        chatHistory: sessionChatHistory,
        historyForFollowUp: sessionChatHistory as ChatMessageParam[],
        postMessage: message => this.postSessionMessage(sessionId, message),
        canContinue: () => this.getSessionRuntimeState(sessionId).activeRunId === reuseMsgId,
        getActiveRunId: () => this.getSessionRuntimeState(sessionId).activeRunId,
        saveChatHistory: () => this.saveChatHistory(sessionId),
        createHistoryProcessSummary,
        toDisplayPath: getDisplayPathHelper,
        fileReadStateCache: this.fileReadStateCache,
      });
      sessionRuntime.stepSequence = batchRound.nextStepSequence;
      sessionRuntime.turnWriteRounds = batchRound.nextTurnWriteRounds;
      sessionRuntime.activeHistoryProcessSummary = batchRound.nextActiveHistoryProcessSummary;

      if (batchRound.kind === 'halted') {
        if (batchRound.shouldFinalizeStoppedRun) {
          this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
          const completionState = consumeRunCompletionState({
            activeHistoryProcessSummary: sessionRuntime.activeHistoryProcessSummary,
          });
          this.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
          sessionRuntime.stepSequence = completionState.nextStepSequence;
          sessionRuntime.activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
        }
        return;
      }

      info('续轮系统提示词模式', {
        requestMode,
        systemPromptModePreview: batchRound.followUpSystemPrompt.slice(0, 120),
      });

      sessionRuntime.abortStream = startBasicAssistantStreamRequest({
        apiConfig: batchRound.followUpApiConfig,
        messages: batchRound.followUpMessages,
        messageId: reuseMsgId,
        chatHistory: sessionChatHistory,
        displayHistory: sessionDisplayHistory,
        runtime: {
          getActiveRunId: () => this.getSessionRuntimeState(sessionId).activeRunId,
          getActiveHistoryProcessSummary: () => this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.getSessionRuntimeState(sessionId).abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            this.getSessionRuntimeState(sessionId).stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postSessionMessage(sessionId, message),
        saveChatHistory: () => this.saveChatHistory(sessionId),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        emitEmptyChunkOnFirstChunk: true,
        toolCallTransitionStreamDoneBeforeUpdate: true,
        processSummaryResolver: () => getClonedActiveHistoryProcessSummaryHelper(
          this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          cloneHistoryProcessSummary,
        ),
        onToolCalls: ({ fullContent, parsedToolCalls, displayContent, assistantTimestamp }) => {
          if (this.getSessionRuntimeState(sessionId).toolCallRound < 200) {
            this.handleToolCalls(sessionId, fullContent, batchRound.followUpApiConfig, reuseMsgId, requestMode, parsedToolCalls, retryRequestId)
              .catch(err => error('续轮工具调用处理异常:', err instanceof Error ? err.message : String(err)));
            return;
          }

          const finalProcessSummary = getClonedActiveHistoryProcessSummaryHelper(
            this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
            cloneHistoryProcessSummary,
          );
          const rolledBack = this.rollbackPendingRegenerateState(reuseMsgId, sessionId);
          if (!rolledBack) {
            upsertAssistantDisplayHistoryMessage(sessionDisplayHistory, {
              content: displayContent,
              timestamp: assistantTimestamp,
              processSummary: finalProcessSummary,
              messageId: reuseMsgId,
              createDisplayMessageId: createDisplayMessageIdHelper,
            });
            this.saveChatHistory(sessionId);
            for (const message of buildAssistantDisplayCompletionMessages({
              messageId: reuseMsgId,
              displayContent,
              processSummary: finalProcessSummary,
            })) {
              this.postSessionMessage(sessionId, message);
            }
          }

          this.postSessionMessage(sessionId, {
            type: 'showError',
            message: '工具调用轮次已达上限（200 轮），已自动停止。请缩小任务范围后重试。',
            retryRequestId,
          });
          this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
          const completionState = consumeRunCompletionState({
            activeHistoryProcessSummary: this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          });
          this.setSessionActiveRunIdState(sessionId, completionState.nextActiveRunId);
          this.getSessionRuntimeState(sessionId).stepSequence = completionState.nextStepSequence;
          this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary = completionState.nextActiveHistoryProcessSummary;
        },
        onPlainCompleted: () => {
          const latestRuntime = this.getSessionRuntimeState(sessionId);
          if (latestRuntime.turnWriteRounds >= 2) {
            this.postSessionMessage(sessionId, buildFinalTurnChangeSummaryResponse(reuseMsgId, latestRuntime.turnWriteFiles));
          }
          latestRuntime.pendingRegenerateState = clearPendingRegenerateStateHelper(latestRuntime.pendingRegenerateState, reuseMsgId);
        },
        onErrorBeforeNotify: () => {
          const rolledBack = this.rollbackPendingRegenerateState(reuseMsgId, sessionId);
          const finalProcessSummary = getClonedActiveHistoryProcessSummaryHelper(
            this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
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
          this.saveChatHistory(sessionId);
          for (const message of buildAssistantDisplayCompletionMessages({
            messageId: reuseMsgId,
            displayContent: '⚠️ 工具执行出错，请重试。',
            processSummary: finalProcessSummary,
            includeUpdateMessage: true,
          })) {
            this.postSessionMessage(sessionId, message);
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
      this.getSessionRuntimeState(sessionId).toolCallsInProgress = false;
    }
  }

  // ==================== 重新生成 ====================

  private async handleRegenerate(targetAssistantMessageId: string): Promise<void> {
    const sessionId = this.activeSessionId;
    if (this.hasRunningTask(sessionId)) {
      const message = '当前仍在生成，请先停止当前任务后再重新生成。';
      this.postSessionMessage(sessionId, { type: 'showError', message });
      return;
    }

    if (sessionId && this.hasRunningTaskElsewhere(sessionId)) {
      const message = this.getCrossTabRunConflictMessage(sessionId);
      this.postSessionMessage(sessionId, { type: 'showError', message });
      return;
    }

    const history = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const prepareResult = prepareRegenerateRequest({
      history,
      displayHistory: this.getDisplayHistoryForSession(sessionId),
      uiTranscript: this.cloneUiTranscript(this.getUiTranscriptForSession(sessionId)),
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

    this.getSessionRuntimeState(sessionId).pendingRegenerateState = prepareResult.pendingState;
    this.setChatHistoryForSession(sessionId, prepareResult.trimmedHistory as ChatMessageParam[]);

    info('重新生成回复，参考用户消息长度:', prepareResult.userText.length);
    await this.regenerateResponse(sessionId, prepareResult.userText, this.getSessionRuntimeState(sessionId).currentMode, targetAssistantMessageId);
  }

  private async regenerateResponse(
    sessionId: string,
    userText: string,
    requestMode: WorkMode,
    reuseMessageId?: string,
  ): Promise<void> {
    const sessionRuntime = this.getSessionRuntimeState(sessionId);
    const sessionChatHistory = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const sessionDisplayHistory = this.getDisplayHistoryForSession(sessionId);
    sessionRuntime.turnWriteFiles = [];
    sessionRuntime.turnWriteRounds = 0;
    sessionRuntime.activeHistoryProcessSummary = resetActiveHistoryProcessSummaryHelper();
    this.postSessionMessage(sessionId, { type: 'setLoading', loading: true });

    const regenMsgId = reuseMessageId || `ai-regen-${Date.now()}`;
    const retryRequestId = createRetryRequestIdHelper();
    const runLockError = this.tryAcquireSessionRunLock(sessionId, regenMsgId);
    if (runLockError) {
      this.rollbackPendingRegenerateState(regenMsgId, sessionId);
      this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      this.postSessionMessage(sessionId, { type: 'showError', message: runLockError, retryRequestId });
      return;
    }

    try {

      const apiKey = await ensureApiKey();
      if (!apiKey) {
        this.resetOwnedRunState(sessionId);
        this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
        this.rollbackPendingRegenerateState(regenMsgId, sessionId);
        this.postSessionMessage(sessionId, { type: 'showError', message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey', retryRequestId });
        return;
      }

      const modelConfig = getModelConfig();
      const requestExecution = prepareChatRequestExecution({
        modelConfig,
        requestMode,
        remindedMessages: prepareRemindedMessages({
          history: sessionChatHistory as ChatMessageParam[],
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
        abortStream: sessionRuntime.abortStream,
        runId: regenMsgId,
        runtime: {
          setAbortStream: abortStream => {
            sessionRuntime.abortStream = abortStream;
          },
          setToolCallsInProgress: toolCallsInProgress => {
            sessionRuntime.toolCallsInProgress = toolCallsInProgress;
          },
          setActiveRunId: activeRunId => {
            this.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            sessionRuntime.stepSequence = stepSequence;
          },
          setToolCallRound: toolCallRound => {
            sessionRuntime.toolCallRound = toolCallRound;
          },
        },
        clearWriteBackups: () => {
          this.expireUndoableSummariesForWriteBackups(sessionRuntime.writeBackups, sessionId);
          sessionRuntime.writeBackups.clear();
        },
      });

      if (reuseMessageId) {
        this.postSessionMessage(sessionId, { type: 'resetMessageState', messageId: regenMsgId });
      } else {
        this.postSessionMessage(sessionId, { type: 'addMessage', role: 'assistant', content: '', messageId: regenMsgId });
      }

      sessionRuntime.abortStream = startBasicAssistantStreamRequest({
        apiConfig,
        messages,
        messageId: regenMsgId,
        chatHistory: sessionChatHistory,
        displayHistory: sessionDisplayHistory,
        runtime: {
          getActiveRunId: () => this.getSessionRuntimeState(sessionId).activeRunId,
          getActiveHistoryProcessSummary: () => this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.getSessionRuntimeState(sessionId).abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            this.getSessionRuntimeState(sessionId).stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.getSessionRuntimeState(sessionId).activeHistoryProcessSummary = summary;
          },
        },
        postMessage: message => this.postSessionMessage(sessionId, message),
        saveChatHistory: () => this.saveChatHistory(sessionId),
        createDisplayMessageId: createDisplayMessageIdHelper,
        createHistoryProcessSummary,
        retryRequestId,
        onToolCalls: ({ fullContent, parsedToolCalls }) => {
          this.handleToolCalls(sessionId, fullContent, apiConfig, regenMsgId, requestMode, parsedToolCalls, retryRequestId)
            .catch(err => error('重生成工具调用处理异常:', err instanceof Error ? err.message : String(err)));
        },
        onPlainCompleted: () => {
          sessionRuntime.pendingRegenerateState = clearPendingRegenerateStateHelper(sessionRuntime.pendingRegenerateState, regenMsgId);
        },
        onErrorBeforeNotify: () => {
          this.rollbackPendingRegenerateState(regenMsgId, sessionId);
        },
        onDoneLog: fullContent => {
          info('重新生成完成，长度:', fullContent.length);
        },
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.resetOwnedRunState(sessionId);
      this.rollbackPendingRegenerateState(regenMsgId, sessionId);
      this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      this.postSessionMessage(sessionId, {
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

  private rollbackPendingRegenerateState(runId: string, sessionId: string = this.activeSessionId): boolean {
    const rollbackResult = rollbackPendingRegenerateStateHelper({
      pendingState: this.getSessionRuntimeState(sessionId).pendingRegenerateState,
      runId,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: uiTranscript => this.cloneUiTranscript(uiTranscript),
      cloneHistoryProcessSummary,
    });
    this.getSessionRuntimeState(sessionId).pendingRegenerateState = rollbackResult.nextPendingState;

    if (!rollbackResult.rolledBack) {
      return false;
    }

    this.setChatHistoryForSession(sessionId, rollbackResult.restoredHistory as ChatMessageParam[]);
    this.setDisplayHistoryForSession(sessionId, rollbackResult.restoredDisplayHistory);
    this.setUiTranscriptForSession(sessionId, rollbackResult.restoredUiTranscript);
    this.rebuildUiMessageIndexes(sessionId);
    this.saveChatHistory(sessionId);

    if (rollbackResult.restoredUiTranscript.length > 0) {
      if (sessionId === this.activeSessionId) {
        this.postMessage({ type: 'clearChat' });
        this.restoreUiTranscriptToWebview(sessionId);
      }
      return true;
    }

    if (sessionId === this.activeSessionId) {
      this.postMessage({ type: 'resetMessageState', messageId: rollbackResult.messageId });
      for (const message of buildAssistantDisplayCompletionMessages({
        messageId: rollbackResult.messageId,
        displayContent: rollbackResult.restoreContent,
        processSummary: rollbackResult.restoreProcessSummary,
        includeUpdateMessage: true,
      })) {
        this.postMessage(message);
      }
    }

    return true;
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

  private saveChatHistory(sessionId: string = this.activeSessionId): void {
    prepareActiveSessionForSave({
      session: this.getSessionById(sessionId),
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    const sessionListResponse = this.saveSessions();
    this.host.postMessage(sessionListResponse);
  }

  private switchSession(sessionId: string): void {
    info(`[锁诊断] switchSession: engineId=${this.engineId}, targetSessionId=${sessionId}, 全局锁快照=${JSON.stringify(this.store.runLocks)}`);
    if (this.isSessionRunningInOtherTab(sessionId)) {
      this.postMessage({
        type: 'showError',
        message: '目标会话正在其他聊天 Tab 中生成，请先停止当前任务后再切换。',
      });
      return;
    }

    const switchPlan = planSwitchSession({
      hasRunningTask: false,
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

    if (switchPlan.clearRetryableSessionId) {
      clearRetryableRequestsForSessionHelper(this.retryableRequests, switchPlan.clearRetryableSessionId);
    }

    this.sessions = switchPlan.nextSessions;
    this.activeSessionId = switchPlan.nextActiveSessionId;
    this.sessionLauncherVisible = switchPlan.nextSessionLauncherVisible;
    this.fileReadStateCache.clear();
    const activeSession = getActiveSessionHelper(this.sessions, this.activeSessionId);
    const hasUiTranscript = Array.isArray(activeSession?.uiTranscript) && activeSession.uiTranscript.length > 0;
    const sessionListResponse = this.saveSessions();
    this.host.postMessage(sessionListResponse);
    if (hasUiTranscript) {
      this.host.postMessage({ type: 'clearChat' });
      this.host.postMessage({ type: 'setSessionLauncher', visible: false });
      this.restoreUiTranscriptToWebview(this.activeSessionId);
    } else {
      for (const message of switchPlan.messages) {
        this.host.postMessage(message);
      }
    }
    this.syncActiveSessionTransientState();
    this.host.postMessage({ type: 'setLoading', loading: this.hasRunningTask(this.activeSessionId) });
    this.syncHostTitle();
    info(`切换会话到: ${switchPlan.sessionName}`);
  }

  private deleteSession(sessionId: string): void {
    if (this.hasRunningTask(sessionId)) {
      this.postMessage({
        type: 'showError',
        message: '目标会话仍在生成，请先停止当前任务后再删除。',
      });
      return;
    }

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
    this.clearSessionRuntimeState(deletePlan.deletedSessionId);
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
