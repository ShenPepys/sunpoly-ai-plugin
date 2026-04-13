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
import type { ExtensionMessage, WebviewMessage, WorkMode, ChatSession, HistoryProcessSummary, ChatSessionDisplayMessage, ChatSessionHistoryMessage } from './messageTypes';
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
import type { SessionStore } from './SessionStore';

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

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  private readonly sessionDisplayHistoryAccessors = createSessionDisplayHistoryAccessors({
    createDisplayMessageId: createDisplayMessageIdHelper,
    toChangedFileDisplayPath: filePath => getDisplayPathHelper(filePath),
  });

  // ==================== 构造与初始化 ====================

  constructor(host: IChatHost, store: SessionStore, options?: { forceSessionLauncher?: boolean }) {
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
    this.host.postMessage(message);
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
      shouldShowWelcomeOnInitialRender: !this.sessionLauncherVisible && this.displayHistory.length === 0,
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
          this.activeRunId = activeRunId;
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

    // 确保 API Key 已配置
    const apiKey = await ensureApiKey();
    if (!apiKey) {
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

    const assistantMsgId = `assistant-${Date.now()}`;
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
          this.activeRunId = activeRunId;
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
          this.activeRunId = activeRunId;
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
      resolveErrorMessage: errorMessage => {
        const isImageError = errorMessage.includes('image_url')
          || (errorMessage.includes('image') && errorMessage.includes('unknown'));
        if (isImageError) {
          return '当前模型不支持图片输入，请删除图片后重新发送，或切换到支持视觉的模型（如 GPT-4o、Claude 3 等）。';
        }

        return errorMessage;
      },
      onErrorLog: rawErrorMessage => {
        error('AI API 调用失败:', rawErrorMessage);
      },
    });
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
        this.activeRunId = completionState.nextActiveRunId;
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
        this.activeRunId = completionState.nextActiveRunId;
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
          this.activeRunId = completionState.nextActiveRunId;
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
        apiConfig,
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
            this.activeRunId = activeRunId;
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
            this.handleToolCalls(fullContent, apiConfig, reuseMsgId, requestMode, parsedToolCalls, retryRequestId)
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
          this.activeRunId = completionState.nextActiveRunId;
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
            streamDoneBeforeUpdate: true,
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
    const history = this.chatHistory as ChatSessionHistoryMessage[];
    const prepareResult = prepareRegenerateRequest({
      history,
      displayHistory: this.displayHistory,
      targetAssistantMessageId,
      isToolFeedbackMessage,
      getDisplayHistoryMessageById,
      getLastAssistantDisplayHistoryMessage,
      cloneDisplayHistoryMessages,
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

    const apiKey = await ensureApiKey();
    if (!apiKey) {
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
          this.activeRunId = activeRunId;
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
          this.activeRunId = activeRunId;
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

    this.activeRunId = resetResult.nextActiveRunId;
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
      cloneHistoryProcessSummary,
    });
    this.pendingRegenerateState = rollbackResult.nextPendingState;

    if (!rollbackResult.rolledBack) {
      return false;
    }

    this.chatHistory = rollbackResult.restoredHistory as ChatMessageParam[];
    this.displayHistory = rollbackResult.restoredDisplayHistory;
    this.saveChatHistory();
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
    const sessionListResponse = this.saveSessions();
    for (const message of switchPlan.messages) {
      this.postMessage(message);
    }
    this.postMessage(sessionListResponse);
    this.syncHostTitle();
    info(`切换会话到: ${switchPlan.sessionName}`);
  }

  private deleteSession(sessionId: string): void {
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
    const title = activeSession?.name || 'AI 聊天';
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
