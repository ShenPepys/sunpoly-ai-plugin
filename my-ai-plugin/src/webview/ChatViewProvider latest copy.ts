/**
 * Webview 聊天面板提供者
 * 
 * 负责创建和管理侧边栏中的聊天 Webview 面板。
 * 实现 VS Code 的 WebviewViewProvider 接口，
 * 处理 Webview 的生命周期和消息通信。
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
  loadSessionsState,
  planCreateSession,
  planDeleteSession,
  planOpenSessionLauncher,
  planRenameSession,
  planSwitchSession,
  prepareActiveSessionForSave,
  sortSessionsByUpdatedAt as sortSessionsByUpdatedAtHelper,
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Provider 的注册 ID，必须与 package.json 中 views.id 一致 */
  public static readonly viewType = 'my-ai-plugin.chatView';

  /** 当前活跃的 Webview 实例引用，用于从外部向 Webview 发送消息 */
  private webviewView?: vscode.WebviewView;

  /** 所有会话列表，持久化到 globalState */
  private sessions: ChatSession[] = [];

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
   * 用于 AI 回复结束后展示“本轮全量变更”汇总条
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

  /** 插件根目录 URI，用于加载 media 资源 */
  private readonly extensionUri: vscode.Uri;

  /** VS Code 扩展上下文，用于 globalState 持久化 */
  private context: vscode.ExtensionContext;

  private readonly sessionDisplayHistoryAccessors = createSessionDisplayHistoryAccessors({
    createDisplayMessageId: createDisplayMessageIdHelper,
    toChangedFileDisplayPath: filePath => getDisplayPathHelper(filePath),
  });

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    // 从 globalState 加载会话数据（与旧单会话数据兼容）
    this.loadSessions();
  }

  /**
   * VS Code 在侧边栏面板首次可见时调用此方法
   * 负责初始化 Webview 的 HTML 内容和消息监听
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView;

    // 配置 Webview 权限
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'media'),
      ],
    };

    // 隐藏侧边栏时保留 Webview 状态，避免切换时重建 DOM
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // 重新可见时推送 token 计数（可能已更新）
        this.pushTokenCount();
      }
    });

    // 设置 HTML 内容
    webviewView.webview.html = buildChatViewHtml({
      webview: webviewView.webview,
      extensionUri: this.extensionUri,
      panelTitle: getPanelTitle(),
      shouldShowWelcomeOnInitialRender: !this.sessionLauncherVisible && this.displayHistory.length === 0,
    });

    // 监听来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleWebviewMessage(message),
      undefined,
      [],
    );

    info('聊天面板 Webview 已初始化');

    // 初始化完成后推送模型列表、工作模式和会话列表到前端
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
  }

  /**
   * 向 Webview 发送消息
   * 供外部模块调用（如命令处理器、API 回调等）
   */
  public postMessage(message: ExtensionMessage): void {
    if (this.webviewView) {
      this.webviewView.webview.postMessage(message);
    }
  }

  /**
   * 确保聊天面板可见
   * 用于从命令或右键菜单触发时，自动打开侧边栏
   */
  public reveal(): void {
    if (this.webviewView) {
      this.webviewView.show(true);
    }
  }

  public async runCommandRequest(commandRequest: CommandExecutionRequest): Promise<void> {
    if (this.hasRunningTask()) {
      const message = '当前仍在生成，请先停止当前任务后再执行新的命令。';
      this.postMessage({ type: 'showError', message });
      vscode.window.showWarningMessage(message);
      return;
    }

    await vscode.commands.executeCommand('my-ai-plugin.chatView.focus');
    this.reveal();
    await this.handleUserMessage(commandRequest.displayText, undefined, {
      userContentOverride: commandRequest.userMessage,
      requestMode: commandRequest.requestMode,
    });
  }

  /**
   * 处理 Webview 发来的消息
   * 根据 message.type 分发到不同的处理逻辑
   */
  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
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

  /** 获取当前工作模式（供外部模块使用） */
  public getMode(): WorkMode {
    return this.currentMode;
  }

  /** 从外部切换工作模式（供 Ctrl+. 快捷键使用） */
  public switchMode(mode: WorkMode): void {
    this.currentMode = mode;
    this.postMessage({ type: 'updateMode', mode });
  }

  /**
   * 向 Webview 推送当前模型列表和活跃模型
   */
  public sendModelList(): void {
    const models = getAllModels();
    const activeIndex = getActiveModelIndex();
    const modelConfig = getModelConfig();
    this.postMessage(buildUpdateModelsResponse({
      models,
      activeIndex,
      // 把当前模型的视觉能力标识推送给前端，用于控制上传图片入口的可用状态
      supportsVision: modelConfig.supportsVision ?? false,
    }));
  }

  /**
   * 处理用户发送的聊天消息
   * 构建 Prompt → 调用 AI API（流式）→ 逐字推送到 Webview
   * @param text 用户输入的文字
   * @param images 可选的图片附件列表（base64 格式），由前端在发送时一并传来
   */
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

  /**
   * 处理 AI 回复中的工具调用
   * 
   * 流程：解析工具调用 → 静默执行 → 结果作为上下文传给 AI → AI 替换原气泡内容
   * 用户始终只看到一个 AI 气泡，不会出现重复回复
   * 
   * @param aiResponse AI 的完整回复文本
   * @param apiConfig API 配置（用于续轮请求）
   * @param reuseMsgId 复用的气泡 ID，续轮回复会替换该气泡内容而不是创建新气泡
   */
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

  /**
   * 处理「重新生成」请求
   * 将历史中最后一条 assistant 消息删除，然后重新发送前一条 user 消息
   */
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
    // 直接调用内部发送方法，不再显示用户消息气泡（已有）
    await this.regenerateResponse(prepareResult.userText, this.currentMode, targetAssistantMessageId);
  }

  /**
   * 重新发起 AI 请求，不向界面添加用户消息气泡
   * 与 handleUserMessage 区别：跳过添加用户 UI 消息和保存用户历史这两步
   */
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

  /**
   * 重置只应属于当前会话的瞬时运行时状态
   * 这些状态不参与持久化，若跨会话残留会导致 Undo、上下文文件、重做态等串到别的会话
   *
   * @param options.clearContextFiles 是否同时清空输入区上下文文件
   */
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
    info('对话历史已清空');

    clearRetryableRequestsForSessionHelper(this.retryableRequests, clearPlan.clearRetryableSessionId);
    for (const message of clearPlan.messages) {
      this.postMessage(message);
    }
  }

  /**
   * 将对话历史持久化到 globalState
   * 每次消息变更后调用，保证重启后可恢复
   */
  private saveChatHistory(): void {
    prepareActiveSessionForSave({
      session: getActiveSessionHelper(this.sessions, this.activeSessionId),
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    // 历史已经包含在当前会话里，直接保存整个会话列表即可
    const sessionListResponse = this.saveSessions();
    this.postMessage(sessionListResponse);
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

  /**
   * 从 globalState 加载会话数据
   * 如果没有新式会话数据，自动将旧 chatHistory 迁移到第一个会话
   */
  private loadSessions(): void {
    const state = loadSessionsState({
      savedSessions: this.context.globalState.get<ChatSession[]>('chatSessions'),
      savedActiveId: this.context.globalState.get<string>('activeSessionId'),
      oldHistory: this.context.globalState.get<Array<{ role: string; content: unknown }>>('chatHistory'),
      normalizeHistoryMessages,
      sanitizeDisplayHistory: this.sessionDisplayHistoryAccessors.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: this.sessionDisplayHistoryAccessors.buildDisplayHistoryFromRawHistory,
    });

    this.sessions = state.sessions;
    this.activeSessionId = state.activeSessionId;

    if (state.shouldResave) {
      this.saveSessions();
    }

    info(`加载会话数据：共 ${this.sessions.length} 个会话，当前活跃: ${this.activeSessionId}`);
  }

  /**
   * 将所有会话序列化到 globalState
   * 同时更新 token 计数、负责所有会话数据的唯一展适备份
   */
  private saveSessions(): ReturnType<typeof buildUpdateSessionsResponse> {
    this.sessions = sortSessionsByUpdatedAtHelper(this.sessions);
    this.context.globalState.update('chatSessions', this.sessions);
    this.context.globalState.update('activeSessionId', this.activeSessionId);
    this.pushTokenCount();
    return buildUpdateSessionsResponse(this.sessions, this.activeSessionId);
  }

  /**
   * 切换到指定会话
   * @param sessionId 目标会话 ID
   */
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
    info(`切换会话到: ${switchPlan.sessionName}`);
  }

  /**
   * 删除指定会话
   * 当前会话被删时自动切换到列表中第一个
   * @param sessionId 要删除的会话 ID
   */
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
    info(`删除会话: ${deletePlan.deletedSessionId}`);
  }

  /**
   * 估算对话历史的 token 数并推送到 Webview
   * 粗略估算：英文约 4 字符/token，中文约 2 字符/token
   */
  private pushTokenCount(): void {
    const modelConfig = getModelConfig();
    const contextUsage = buildContextUsageSnapshot(this.chatHistory, {
      contextWindow: modelConfig.contextWindow,
      maxTokens: getMaxTokens(),
    });
    this.postMessage(buildUpdateTokenCountResponse(contextUsage));
  }

  /**
   * 导出对话历史为 Markdown 文件
   * 弹出保存对话框，用户选择保存位置
   */
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
