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
import { buildContextUsageSnapshot, buildUpdateTokenCountResponse } from './ChatViewProvider_contextUsage';
import { buildChatViewHtml } from './ChatViewProvider_html';
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
} from './ChatViewProvider_displayHistory';
import {
  buildExpiredChangeSummaryResponse,
  buildFinalTurnChangeSummaryResponse,
  collectWriteBackupMessageIds,
  getDisplayPath as getDisplayPathHelper,
  isChangeSummaryFileUndoable,
} from './fileChanges';
import type { ChangeSummaryFile, WriteBackupEntry } from './fileChanges';
import {
  buildChatExportMarkdown,
  saveChatExportMarkdown,
} from './ChatViewProvider_workspaceContext';
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
  createSessionDisplayHistoryAccessors,
  getActiveSession as getActiveSessionHelper,
  getSessionDisplayHistoryForExport,
  resolveSessionDisplayHistory,
  setSessionDisplayHistory,
} from './ChatViewProvider_sessions';
import { prepareRegenerateRequest } from './ChatViewProvider_regenerate';
import type { PendingRegenerateState } from './ChatViewProvider_regenerate';
import {
  buildSlashCommandRequest,
  resolveCommandType as resolveCommandTypeHelper,
} from './ChatViewProvider_commands';
import {
  clearRetryableRequestsForSession as clearRetryableRequestsForSessionHelper,
  cloneRequestImages as cloneRequestImagesHelper,
  createRetryRequestId as createRetryRequestIdHelper,
  rememberRetryableRequest as rememberRetryableRequestHelper,
} from './ChatViewProvider_retryRequests';
import type { RequestImageAttachment, RetryableRequestState } from './ChatViewProvider_retryRequests';
import {
  insertCodeToEditor as insertCodeToEditorHelper,
} from './ChatViewProvider_ideActions';
import {
  consumeSessionScopedRuntimeReset,
  consumeRunCompletionState,
  consumeStreamingRunCompletionState,
  clearPendingRegenerateState as clearPendingRegenerateStateHelper,
  getClonedActiveHistoryProcessSummary as getClonedActiveHistoryProcessSummaryHelper,
  resetActiveHistoryProcessSummary as resetActiveHistoryProcessSummaryHelper,
  rollbackPendingRegenerateState as rollbackPendingRegenerateStateHelper,
} from './ChatViewProvider_runtimeState';
import { SessionRuntimeManager } from './ChatViewProvider_runtimeAccess';
import { tryHandleLightweightWebviewMessage, handleRemainingWebviewMessage } from './ChatViewProvider_webviewMessaging';
import {
  prepareChatRequestExecution,
  prepareRemindedMessages,
  buildUpdateModelsResponse,
} from './ChatViewProvider_modelAndSession';
import {
  beginAssistantStreamingRequest,
  startBasicAssistantStreamRequest,
} from './ChatViewProvider_requestExecution';
import { executeUserMessageFlow, executeToolCallsFlow } from './ChatViewProvider_requestFlow';
import { createUiTranscriptBridge } from './ChatViewProvider_uiTranscriptBridge';
import type { UiTranscriptBridge } from './ChatViewProvider_uiTranscriptBridge';
import {
  buildEngineHtml,
  executeClearCurrentSession,
  executeOpenSessionLauncher,
  getEngineActiveModelName,
  initializeEngineWebviewState,
  runEngineCommandRequest,
  sendEngineModelList,
  switchEngineMode,
} from './ChatViewProvider_engineHostApi';
import type { IChatHost } from './IChatHost';
import type { SessionStore } from './SessionStore';

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

  private readonly runtimeManager: SessionRuntimeManager;

  private readonly uiBridge: UiTranscriptBridge;

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
    this.runtimeManager = new SessionRuntimeManager(this.engineId, this.store, () => this.activeSessionId);
    this.uiBridge = createUiTranscriptBridge({
      getActiveSessionId: () => this.activeSessionId,
      getSessionById: sessionId => this.getSessionById(sessionId),
      getUiTranscriptForSession: sessionId => this.getUiTranscriptForSession(sessionId),
      getUiMessageIndexes: sessionId => {
        const runtime = this.runtimeManager.getSessionRuntimeState(sessionId);
        return {
          stepToMessageId: runtime.stepToMessageId,
          summaryToMessageId: runtime.summaryToMessageId,
        };
      },
      postSessionMessage: (sessionId, message) => {
        if (!sessionId || sessionId === this.activeSessionId) {
          this.host.postMessage(message);
        }
      },
      hostPostMessage: message => this.host.postMessage(message),
      persistActiveSession: () => {
        this.store.persist(this.activeSessionId);
      },
    });
    // 从共享存储加载会话数据（首个引擎实际读取 globalState，后续引擎复用缓存）
    this.loadSessions();

    // 新建 Tab 时强制进入 launcher 状态，避免多 Tab 默认进入同一个会话
    if (options?.forceSessionLauncher) {
      this.activeSessionId = '';
      this.sessionLauncherVisible = true;
    }
  }

  private get abortStream(): AbortStreamFn | null {
    return this.runtimeManager.getSessionRuntimeState().abortStream;
  }

  private set abortStream(value: AbortStreamFn | null) {
    this.runtimeManager.getSessionRuntimeState().abortStream = value;
  }

  private get activeRunId(): string | null {
    return this.runtimeManager.getSessionRuntimeState().activeRunId;
  }

  private set activeRunId(value: string | null) {
    this.runtimeManager.getSessionRuntimeState().activeRunId = value;
  }

  private get toolCallsInProgress(): boolean {
    return this.runtimeManager.getSessionRuntimeState().toolCallsInProgress;
  }

  private set toolCallsInProgress(value: boolean) {
    this.runtimeManager.getSessionRuntimeState().toolCallsInProgress = value;
  }

  private get stepSequence(): number {
    return this.runtimeManager.getSessionRuntimeState().stepSequence;
  }

  private set stepSequence(value: number) {
    this.runtimeManager.getSessionRuntimeState().stepSequence = value;
  }

  private get toolCallRound(): number {
    return this.runtimeManager.getSessionRuntimeState().toolCallRound;
  }

  private set toolCallRound(value: number) {
    this.runtimeManager.getSessionRuntimeState().toolCallRound = value;
  }

  private get writeBackups(): Map<string, WriteBackupEntry> {
    return this.runtimeManager.getSessionRuntimeState().writeBackups;
  }

  private get turnWriteFiles(): ChangeSummaryFile[] {
    return this.runtimeManager.getSessionRuntimeState().turnWriteFiles;
  }

  private set turnWriteFiles(value: ChangeSummaryFile[]) {
    this.runtimeManager.getSessionRuntimeState().turnWriteFiles = value;
  }

  private get turnWriteRounds(): number {
    return this.runtimeManager.getSessionRuntimeState().turnWriteRounds;
  }

  private set turnWriteRounds(value: number) {
    this.runtimeManager.getSessionRuntimeState().turnWriteRounds = value;
  }

  private get activeHistoryProcessSummary(): HistoryProcessSummary | null {
    return this.runtimeManager.getSessionRuntimeState().activeHistoryProcessSummary;
  }

  private set activeHistoryProcessSummary(value: HistoryProcessSummary | null) {
    this.runtimeManager.getSessionRuntimeState().activeHistoryProcessSummary = value;
  }

  private get pendingRegenerateState(): PendingRegenerateState | null {
    return this.runtimeManager.getSessionRuntimeState().pendingRegenerateState;
  }

  private set pendingRegenerateState(value: PendingRegenerateState | null) {
    this.runtimeManager.getSessionRuntimeState().pendingRegenerateState = value;
  }

  private get currentMode(): WorkMode {
    return this.runtimeManager.getSessionRuntimeState().currentMode;
  }

  private set currentMode(value: WorkMode) {
    this.runtimeManager.getSessionRuntimeState().currentMode = value;
  }

  private get contextFiles(): string[] {
    return this.runtimeManager.getSessionRuntimeState().contextFiles;
  }

  private set contextFiles(value: string[]) {
    this.runtimeManager.getSessionRuntimeState().contextFiles = value;
  }

  private get stepToMessageId(): Map<string, string> {
    return this.runtimeManager.getSessionRuntimeState().stepToMessageId;
  }

  private get summaryToMessageId(): Map<string, string> {
    return this.runtimeManager.getSessionRuntimeState().summaryToMessageId;
  }

  private hasRunningTask(sessionId: string = this.activeSessionId): boolean {
    return this.runtimeManager.hasRunningTask(sessionId);
  }

  private setActiveRunIdState(nextActiveRunId: string | null): void {
    this.runtimeManager.setSessionActiveRunIdState(this.activeSessionId, nextActiveRunId);
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
    this.uiBridge.capturePersistedUiState(sessionId, message);
    if (sessionId && sessionId !== this.activeSessionId) {
      return;
    }

    this.host.postMessage(message);
  }

  private buildEngineHostApiDeps() {
    return {
      postMessage: (message: ExtensionMessage) => this.postMessage(message),
      hostPostMessage: (message: ExtensionMessage) => this.host.postMessage(message),
      getSessions: () => this.sessions,
      getActiveSessionId: () => this.activeSessionId,
      setActiveSessionId: (sessionId: string) => {
        this.activeSessionId = sessionId;
      },
      getSessionLauncherVisible: () => this.sessionLauncherVisible,
      setSessionLauncherVisible: (visible: boolean) => {
        this.sessionLauncherVisible = visible;
      },
      getDisplayHistory: () => this.displayHistory,
      getChatHistory: () => this.chatHistory,
      getUiTranscript: () => this.uiTranscript,
      syncActiveSessionTransientState: () => this.syncActiveSessionTransientState(),
      resetUiRuntimeState: () => this.uiBridge.resetUiRuntimeState(),
      pushTokenCount: () => this.pushTokenCount(),
      syncHostTitle: () => this.syncHostTitle(),
      restoreUiTranscriptToWebview: () => this.uiBridge.restoreUiTranscriptToWebview(),
      persistUiTranscript: () => this.uiBridge.persistUiTranscript(),
      saveSessions: () => this.saveSessions(),
      resetSessionScopedRuntimeState: () => this.resetSessionScopedRuntimeState(),
      clearFileReadStateCache: () => this.fileReadStateCache.clear(),
      clearRetryableForSession: (sessionId: string) => {
        clearRetryableRequestsForSessionHelper(this.retryableRequests, sessionId);
      },
      hasRunningTask: () => this.hasRunningTask(),
      isSessionRunningInOtherTab: (sessionId: string) => this.runtimeManager.isSessionRunningInOtherTab(sessionId),
      hostReveal: () => this.host.reveal(),
      handleUserMessage: async (
        text: string,
        images: undefined,
        requestOptions: { userContentOverride: string; requestMode: WorkMode },
      ) => {
        await this.handleUserMessage(text, images, requestOptions);
      },
      getContextFiles: () => [...this.contextFiles],
      setContextFiles: (filePaths: string[]) => {
        this.contextFiles = filePaths;
      },
      getHost: () => this.host,
    };
  }

  /** 获取当前工作模式 */
  public getMode(): WorkMode {
    return this.currentMode;
  }

  /** 切换工作模式 */
  public switchMode(mode: WorkMode): void {
    switchEngineMode(mode, nextMode => {
      this.currentMode = nextMode;
    }, message => this.postMessage(message));
  }

  /** 获取当前活跃模型名称（用于状态栏同步） */
  public getActiveModelName(): string {
    return getEngineActiveModelName();
  }

  /** 推送模型列表到前端 */
  public sendModelList(): void {
    sendEngineModelList(message => this.postMessage(message));
  }

  /**
   * Webview 初始化后由宿主调用，推送初始状态到前端
   * 包括模型列表、工作模式、会话列表和历史消息恢复
   */
  public initializeWebviewState(): void {
    initializeEngineWebviewState(this.buildEngineHostApiDeps());
  }

  /** 获取面板 HTML（供宿主设置到 Webview） */
  public buildHtml(): string {
    return buildEngineHtml(this.buildEngineHostApiDeps());
  }

  public async runCommandRequest(commandRequest: CommandExecutionRequest): Promise<void> {
    await runEngineCommandRequest(commandRequest, this.buildEngineHostApiDeps());
  }

  public clearCurrentSession(): void {
    executeClearCurrentSession(this.buildEngineHostApiDeps());
  }

  public openSessionLauncher(): void {
    executeOpenSessionLauncher(this.buildEngineHostApiDeps());
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
          this.uiBridge.expireUndoableSiblingSummaries(summaryId, this.activeSessionId);
        },
        onUndoSingleCompleted: (summaryId, remainingCount) => {
          if (remainingCount === 0) {
            this.uiBridge.expireUndoableSiblingSummaries(summaryId, this.activeSessionId);
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

    if (this.hasRunningTask(initialSessionId)) {
      const message = '当前仍在生成，请先停止当前任务后再发送新的消息。';
      this.postSessionMessage(initialSessionId, { type: 'showError', message });
      return;
    }

    if (initialSessionId && this.runtimeManager.hasRunningTaskElsewhere(initialSessionId)) {
      const message = this.runtimeManager.getCrossTabRunConflictMessage(initialSessionId);
      this.postSessionMessage(initialSessionId, { type: 'showError', message });
      return;
    }

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
      const createdSessionRuntime = this.runtimeManager.getSessionRuntimeState(this.activeSessionId);
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
    const sessionRuntime = this.runtimeManager.getSessionRuntimeState(sessionId);
    const sessionChatHistory = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const sessionDisplayHistory = this.getDisplayHistoryForSession(sessionId);

    const userMsgId = `user-${Date.now()}`;
    this.postSessionMessage(sessionId, {
      type: 'addMessage',
      role: 'user',
      content: text,
      messageId: userMsgId,
    });

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

    await executeUserMessageFlow({
      sessionId,
      userText: text,
      requestMode,
      images,
      chatHistory: sessionChatHistory,
      displayHistory: sessionDisplayHistory,
      contextFilePaths,
      retryableRequests: this.retryableRequests,
      userContentOverride: requestOptions?.userContentOverride,
      retryRequestId,
      setSessionActiveRunIdState: (sid, runId) => this.runtimeManager.setSessionActiveRunIdState(sid, runId),
      setSessionAbortStream: (sid, fn) => {
        this.runtimeManager.getSessionRuntimeState(sid).abortStream = fn;
      },
      setSessionStepSequence: (sid, seq) => {
        this.runtimeManager.getSessionRuntimeState(sid).stepSequence = seq;
      },
      setSessionToolCallRound: (sid, round) => {
        this.runtimeManager.getSessionRuntimeState(sid).toolCallRound = round;
      },
      setSessionToolCallsInProgress: (sid, value) => {
        this.runtimeManager.getSessionRuntimeState(sid).toolCallsInProgress = value;
      },
      setSessionTurnWriteFiles: (sid, files) => {
        this.runtimeManager.getSessionRuntimeState(sid).turnWriteFiles = files;
      },
      setSessionTurnWriteRounds: (sid, rounds) => {
        this.runtimeManager.getSessionRuntimeState(sid).turnWriteRounds = rounds;
      },
      setSessionRecoverableWriteFailRounds: (sid, rounds) => {
        this.runtimeManager.getSessionRuntimeState(sid).recoverableWriteFailRounds = rounds;
      },
      setSessionActiveHistoryProcessSummary: (sid, summary) => {
        this.runtimeManager.getSessionRuntimeState(sid).activeHistoryProcessSummary = summary;
      },
      getSessionActiveRunId: sid => this.runtimeManager.getSessionRuntimeState(sid).activeRunId,
      getSessionActiveHistoryProcessSummary: sid => this.runtimeManager.getSessionRuntimeState(sid).activeHistoryProcessSummary,
      getSessionAbortStream: () => this.abortStream,
      postSessionMessage: (sid, message) => this.postSessionMessage(sid, message),
      postMessage: message => this.postMessage(message),
      tryAcquireSessionRunLock: (sid, runId) => this.runtimeManager.tryAcquireSessionRunLock(sid, runId),
      saveChatHistory: sid => this.saveChatHistory(sid),
      clearContextFiles: () => {
        sessionRuntime.contextFiles = [];
        this.postMessage({ type: 'clearContextFiles' });
      },
      expireUndoableSummariesForWriteBackups: () => {
        this.uiBridge.expireUndoableSummariesForWriteBackups(sessionRuntime.writeBackups, sessionId);
      },
      clearWriteBackups: () => {
        sessionRuntime.writeBackups.clear();
      },
      handleToolCalls: (sid, fullContent, apiConfig, assistantMsgId, mode, parsedToolCalls, retryId) =>
        this.handleToolCalls(sid, fullContent, apiConfig, assistantMsgId, mode, parsedToolCalls, retryId),
    });
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
    const sessionRuntime = this.runtimeManager.getSessionRuntimeState(sessionId);

    await executeToolCallsFlow({
      sessionId,
      aiResponse,
      apiConfig,
      reuseMsgId,
      requestMode,
      parsedToolCalls,
      retryRequestId,
      chatHistory: this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[],
      displayHistory: this.getDisplayHistoryForSession(sessionId),
      getSessionActiveRunId: sid => this.runtimeManager.getSessionRuntimeState(sid).activeRunId,
      getSessionActiveHistoryProcessSummary: sid => this.runtimeManager.getSessionRuntimeState(sid).activeHistoryProcessSummary,
      getSessionToolCallsInProgress: sid => this.runtimeManager.getSessionRuntimeState(sid).toolCallsInProgress,
      getSessionToolCallRound: sid => this.runtimeManager.getSessionRuntimeState(sid).toolCallRound,
      getSessionStepSequence: sid => this.runtimeManager.getSessionRuntimeState(sid).stepSequence,
      getSessionTurnWriteFiles: sid => this.runtimeManager.getSessionRuntimeState(sid).turnWriteFiles,
      getSessionTurnWriteRounds: sid => this.runtimeManager.getSessionRuntimeState(sid).turnWriteRounds,
      getSessionRecoverableWriteFailRounds: sid => this.runtimeManager.getSessionRuntimeState(sid).recoverableWriteFailRounds,
      getSessionPendingRegenerateState: sid => this.runtimeManager.getSessionRuntimeState(sid).pendingRegenerateState,
      getSessionAbortStream: sid => this.runtimeManager.getSessionRuntimeState(sid).abortStream,
      setSessionActiveRunIdState: (sid, runId) => this.runtimeManager.setSessionActiveRunIdState(sid, runId),
      setSessionStepSequence: (sid, seq) => {
        this.runtimeManager.getSessionRuntimeState(sid).stepSequence = seq;
      },
      setSessionToolCallRound: (sid, round) => {
        this.runtimeManager.getSessionRuntimeState(sid).toolCallRound = round;
      },
      setSessionToolCallsInProgress: (sid, value) => {
        this.runtimeManager.getSessionRuntimeState(sid).toolCallsInProgress = value;
      },
      setSessionActiveHistoryProcessSummary: (sid, summary) => {
        this.runtimeManager.getSessionRuntimeState(sid).activeHistoryProcessSummary = summary;
      },
      setSessionAbortStream: (sid, fn) => {
        this.runtimeManager.getSessionRuntimeState(sid).abortStream = fn;
      },
      setSessionTurnWriteRounds: (sid, rounds) => {
        this.runtimeManager.getSessionRuntimeState(sid).turnWriteRounds = rounds;
      },
      setSessionRecoverableWriteFailRounds: (sid, rounds) => {
        this.runtimeManager.getSessionRuntimeState(sid).recoverableWriteFailRounds = rounds;
      },
      setSessionPendingRegenerateState: (sid, state) => {
        this.runtimeManager.getSessionRuntimeState(sid).pendingRegenerateState = state;
      },
      setSessionCurrentMode: (sid, mode) => {
        this.runtimeManager.getSessionRuntimeState(sid).currentMode = mode;
      },
      postSessionMessage: (sid, message) => this.postSessionMessage(sid, message),
      postMessage: message => this.postMessage(message),
      saveChatHistory: sid => this.saveChatHistory(sid),
      isActiveSession: sid => sid === this.activeSessionId,
      rollbackPendingRegenerateState: (runId, sid) => this.rollbackPendingRegenerateState(runId, sid),
      expireUndoableSummariesForWriteBackups: () => {
        this.uiBridge.expireUndoableSummariesForWriteBackups(sessionRuntime.writeBackups, sessionId);
      },
      clearWriteBackups: () => {
        sessionRuntime.writeBackups.clear();
      },
      getWriteBackups: sid => this.runtimeManager.getSessionRuntimeState(sid).writeBackups,
      fileReadStateCache: this.fileReadStateCache,
      handleToolCalls: (sid, fullContent, config, msgId, mode, calls, retryId) =>
        this.handleToolCalls(sid, fullContent, config, msgId, mode, calls, retryId),
    });
  }

  // ==================== 重新生成 ====================

  private async handleRegenerate(targetAssistantMessageId: string): Promise<void> {
    const sessionId = this.activeSessionId;
    if (this.hasRunningTask(sessionId)) {
      const message = '当前仍在生成，请先停止当前任务后再重新生成。';
      this.postSessionMessage(sessionId, { type: 'showError', message });
      return;
    }

    if (sessionId && this.runtimeManager.hasRunningTaskElsewhere(sessionId)) {
      const message = this.runtimeManager.getCrossTabRunConflictMessage(sessionId);
      this.postSessionMessage(sessionId, { type: 'showError', message });
      return;
    }

    const history = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const prepareResult = prepareRegenerateRequest({
      history,
      displayHistory: this.getDisplayHistoryForSession(sessionId),
      uiTranscript: this.uiBridge.cloneUiTranscript(this.getUiTranscriptForSession(sessionId)),
      targetAssistantMessageId,
      isToolFeedbackMessage,
      getDisplayHistoryMessageById,
      getLastAssistantDisplayHistoryMessage,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: uiTranscript => this.uiBridge.cloneUiTranscript(uiTranscript),
      cloneHistoryProcessSummary,
    });

    if (!prepareResult.ok) {
      vscode.window.showInformationMessage(prepareResult.errorMessage);
      return;
    }

    this.runtimeManager.getSessionRuntimeState(sessionId).pendingRegenerateState = prepareResult.pendingState;
    this.setChatHistoryForSession(sessionId, prepareResult.trimmedHistory as ChatMessageParam[]);

    info('重新生成回复，参考用户消息长度:', prepareResult.userText.length);
    await this.regenerateResponse(sessionId, prepareResult.userText, this.runtimeManager.getSessionRuntimeState(sessionId).currentMode, targetAssistantMessageId);
  }

  private async regenerateResponse(
    sessionId: string,
    userText: string,
    requestMode: WorkMode,
    reuseMessageId?: string,
  ): Promise<void> {
    const sessionRuntime = this.runtimeManager.getSessionRuntimeState(sessionId);
    const sessionChatHistory = this.getChatHistoryForSession(sessionId) as ChatSessionHistoryMessage[];
    const sessionDisplayHistory = this.getDisplayHistoryForSession(sessionId);
    sessionRuntime.turnWriteFiles = [];
    sessionRuntime.turnWriteRounds = 0;
    sessionRuntime.activeHistoryProcessSummary = resetActiveHistoryProcessSummaryHelper();
    this.postSessionMessage(sessionId, { type: 'setLoading', loading: true });

    const regenMsgId = reuseMessageId || `ai-regen-${Date.now()}`;
    const retryRequestId = createRetryRequestIdHelper();
    const runLockError = this.runtimeManager.tryAcquireSessionRunLock(sessionId, regenMsgId);
    if (runLockError) {
      this.rollbackPendingRegenerateState(regenMsgId, sessionId);
      this.postSessionMessage(sessionId, { type: 'setLoading', loading: false });
      this.postSessionMessage(sessionId, { type: 'showError', message: runLockError, retryRequestId });
      return;
    }

    try {

      const apiKey = await ensureApiKey();
      if (!apiKey) {
        this.runtimeManager.resetOwnedRunState(sessionId);
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
            this.runtimeManager.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            sessionRuntime.stepSequence = stepSequence;
          },
          setToolCallRound: toolCallRound => {
            sessionRuntime.toolCallRound = toolCallRound;
          },
        },
        clearWriteBackups: () => {
          this.uiBridge.expireUndoableSummariesForWriteBackups(sessionRuntime.writeBackups, sessionId);
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
          getActiveRunId: () => this.runtimeManager.getSessionRuntimeState(sessionId).activeRunId,
          getActiveHistoryProcessSummary: () => this.runtimeManager.getSessionRuntimeState(sessionId).activeHistoryProcessSummary,
          setAbortStream: abortStream => {
            this.runtimeManager.getSessionRuntimeState(sessionId).abortStream = abortStream;
          },
          setActiveRunId: activeRunId => {
            this.runtimeManager.setSessionActiveRunIdState(sessionId, activeRunId);
          },
          setStepSequence: stepSequence => {
            this.runtimeManager.getSessionRuntimeState(sessionId).stepSequence = stepSequence;
          },
          setActiveHistoryProcessSummary: summary => {
            this.runtimeManager.getSessionRuntimeState(sessionId).activeHistoryProcessSummary = summary;
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
      this.runtimeManager.resetOwnedRunState(sessionId);
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
    this.uiBridge.resetUiRuntimeState();

    if (resetResult.shouldClearContextFiles) {
      this.contextFiles = resetResult.nextContextFiles;
      this.postMessage({ type: 'clearContextFiles' });
    }

    this.postMessage({ type: 'setLoading', loading: false });
  }

  private rollbackPendingRegenerateState(runId: string, sessionId: string = this.activeSessionId): boolean {
    const rollbackResult = rollbackPendingRegenerateStateHelper({
      pendingState: this.runtimeManager.getSessionRuntimeState(sessionId).pendingRegenerateState,
      runId,
      cloneDisplayHistoryMessages,
      cloneUiTranscript: uiTranscript => this.uiBridge.cloneUiTranscript(uiTranscript),
      cloneHistoryProcessSummary,
    });
    this.runtimeManager.getSessionRuntimeState(sessionId).pendingRegenerateState = rollbackResult.nextPendingState;

    if (!rollbackResult.rolledBack) {
      return false;
    }

    this.setChatHistoryForSession(sessionId, rollbackResult.restoredHistory as ChatMessageParam[]);
    this.setDisplayHistoryForSession(sessionId, rollbackResult.restoredDisplayHistory);
    this.setUiTranscriptForSession(sessionId, rollbackResult.restoredUiTranscript);
    this.uiBridge.rebuildUiMessageIndexes(sessionId);
    this.saveChatHistory(sessionId);

    if (rollbackResult.restoredUiTranscript.length > 0) {
      if (sessionId === this.activeSessionId) {
        this.postMessage({ type: 'clearChat' });
        this.uiBridge.restoreUiTranscriptToWebview(sessionId);
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

    if (this.runtimeManager.isSessionRunningInOtherTab(sessionId)) {
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
      this.uiBridge.restoreUiTranscriptToWebview(this.activeSessionId);
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

    if (this.runtimeManager.isSessionRunningInOtherTab(sessionId)) {
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
    this.runtimeManager.clearSessionRuntimeState(deletePlan.deletedSessionId);
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
