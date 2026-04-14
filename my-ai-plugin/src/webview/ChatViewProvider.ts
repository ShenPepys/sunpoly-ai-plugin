/**
 * Webview 聊天面板提供者
 * 
 * 负责创建和管理侧边栏中的聊天 Webview 面板。
 * 实现 VS Code 的 WebviewViewProvider 接口，
 * 处理 Webview 的生命周期和消息通信。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { info, error } from '../logger';
import { getModelConfig, ensureApiKey, getMaxTokens, getTemperature, getAllModels, getActiveModelIndex, setActiveModelIndex, getPanelTitle, getCustomSystemPrompt } from '../config';
import { sendStreamRequest } from '../api/client';
import type { ApiClientConfig, AbortStreamFn } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { buildSystemPrompt } from '../prompts/system';
import { getEditorContext } from '../utils/editor';
import { getEnvContext, detectProjectType, getGitStatus, getProjectContext } from '../utils/context';
import type { ExtensionMessage, WebviewMessage, WorkMode, ChatSession, PersistedUiEntry, PersistedUiEvent, PersistedUiMessageEntry } from './messageTypes';
import { parseToolCalls, hasToolCalls, stripToolCalls, executeToolCalls, formatToolResults, readFile } from '../tools';
import { readErrorFromClipboard, buildErrorAnalysisPrompt } from '../terminal/terminalCapture';
import type { ToolExecutionResult, ParsedToolCall, ToolCallType } from '../tools';

type ChangeSummaryFile = {
  path: string;
  displayPath: string;
  additions: number;
  deletions: number;
  status: 'created' | 'modified' | 'read' | 'listed';
  issueText?: string;
};

type PreviewFileState = {
  content: string;
  exists: boolean;
};

type PreviewBuildResult = {
  newContent: string;
  canApply: boolean;
  issueText?: string;
};

type DeferredToolStep = {
  stepId: string;
  stepDesc: string;
  toolCall: ParsedToolCall;
  startedAt: number;
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

  private get uiTranscript(): PersistedUiEntry[] {
    const session = this.sessions.find(s => s.id === this.activeSessionId);
    if (!session) {
      return [];
    }
    if (!session.uiTranscript) {
      session.uiTranscript = [];
    }
    return session.uiTranscript;
  }

  private set uiTranscript(value: PersistedUiEntry[]) {
    const session = this.sessions.find(s => s.id === this.activeSessionId);
    if (session) {
      session.uiTranscript = value;
    }
  }

  /** 当前工作模式：code（可修改文件）、ask（只读对话）、plan（先规划后执行） */
  private currentMode: WorkMode = 'code';

  /** 用户通过 @ Mentions 添加的上下文文件路径列表 */
  private contextFiles: string[] = [];

  /** 当前流式请求的中断函数（null 表示没有进行中的请求） */
  private abortStream: AbortStreamFn | null = null;

  /** 待用户确认的文件变更（stepId → resolve 函数），Accept/Reject 时触发 */
  private pendingConfirms: Map<string, (accepted: boolean) => void> = new Map();

  private pendingBatchConfirms: Map<string, (accepted: boolean) => void> = new Map();

  private activeRunId: string | null = null;

  /** 防止 handleToolCalls 被并发执行 */
  private toolCallsInProgress = false;

  private stepSequence = 0;

  private stepToMessageId: Map<string, string> = new Map();

  private summaryToMessageId: Map<string, string> = new Map();

  private stoppedRunIds: Set<string> = new Set();

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  /** 插件根目录 URI，用于加载 media 资源 */
  private readonly extensionUri: vscode.Uri;

  /** VS Code 扩展上下文，用于 globalState 持久化 */
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    // 从 globalState 加载会话数据（与旧单会话数据兼容）
    this.loadSessions();
  }

  private ensureUiMessageEntry(
    messageId: string,
    role: 'user' | 'assistant',
    createdAt: number,
  ): PersistedUiMessageEntry | null {
    const transcript = this.uiTranscript;
    const existing = transcript.find((entry): entry is PersistedUiMessageEntry => {
      return entry.type === 'message' && entry.messageId === messageId;
    });

    if (existing) {
      existing.role = role;
      if (!existing.events) {
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
    } else {
      delete entry.partial;
    }
  }

  private appendUiError(message: string, retryable = true, createdAt = Date.now()): void {
    this.uiTranscript.push({
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

    if (!entry.events) {
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
    for (const resolve of this.pendingConfirms.values()) {
      resolve(false);
    }
    this.pendingConfirms.clear();
    for (const resolve of this.pendingBatchConfirms.values()) {
      resolve(false);
    }
    this.pendingBatchConfirms.clear();
    this.stoppedRunIds.clear();
    this.stepSequence = 0;
  }

  private findMessageIdByStepId(stepId: string): string | null {
    const mappedMessageId = this.stepToMessageId.get(stepId);
    if (mappedMessageId) {
      return mappedMessageId;
    }

    for (const entry of this.uiTranscript) {
      if (entry.type !== 'message' || !entry.events) {
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
      if (entry.type !== 'message' || !entry.events) {
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

  private removeLastAssistantUiMessage(): void {
    const transcript = this.uiTranscript;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const entry = transcript[i];
      if (entry.type === 'message' && entry.role === 'assistant') {
        transcript.splice(i, 1);
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
        stepStates.set(event.stepId, { status: event.status, description: event.description });
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

  private getUiMessageCreatedAt(messageId: string, fallback = Date.now()): number {
    const entry = this.findUiMessageEntry(messageId);
    return entry?.createdAt ?? fallback;
  }

  private postUiThinkingComplete(messageId: string, elapsed: number): void {
    this.appendUiEvent(messageId, { type: 'thinkingComplete', elapsed });
    this.saveSessions();
    this.postMessage({ type: 'thinkingComplete', messageId, elapsed });
  }

  private postUiStepStart(
    messageId: string,
    stepId: string,
    icon: string,
    description: string,
    status: 'running' | 'done' | 'error',
  ): void {
    this.appendUiEvent(messageId, { type: 'addStep', stepId, icon, description, status });
    this.saveSessions();
    this.postMessage({ type: 'addStep', messageId, stepId, icon, description, status });
  }

  private postUiStepUpdate(
    stepId: string,
    status: 'running' | 'done' | 'error',
    description?: string,
    elapsed?: number,
  ): void {
    const messageId = this.findMessageIdByStepId(stepId);
    if (messageId) {
      this.appendUiEvent(messageId, { type: 'updateStep', stepId, status, description, elapsed });
      this.saveSessions();
    }
    this.postMessage({ type: 'updateStep', stepId, status, description, elapsed });
  }

  private postUiDiff(
    messageId: string,
    data: {
      stepId: string;
      summaryId?: string;
      filePath: string;
      language: string;
      additions: number;
      deletions: number;
      oldContent: string;
      newContent: string;
      noticeText?: string;
      needsConfirm: boolean;
      collapsed?: boolean;
    },
  ): void {
    this.appendUiEvent(messageId, { type: 'showDiff', ...data });
    this.saveSessions();
    this.postMessage({ type: 'showDiff', messageId, ...data });
  }

  private postUiChangeSummary(
    messageId: string,
    summaryId: string,
    needsConfirm: boolean,
    files: ChangeSummaryFile[],
  ): void {
    this.appendUiEvent(messageId, { type: 'showChangeSummary', summaryId, needsConfirm, files });
    this.saveSessions();
    this.postMessage({ type: 'showChangeSummary', messageId, summaryId, needsConfirm, files });
  }

  private postUiChangeSummaryUpdate(
    summaryId: string,
    status: 'applying' | 'accepted' | 'partial' | 'failed' | 'rejected' | 'cancelled',
    text: string,
  ): void {
    const messageId = this.findMessageIdBySummaryId(summaryId);
    if (messageId) {
      this.appendUiEvent(messageId, { type: 'updateChangeSummary', summaryId, status, text });
      this.saveSessions();
    }
    this.postMessage({ type: 'updateChangeSummary', summaryId, status, text });
  }

  private postChatError(message: string, retryable = true, createdAt = Date.now()): void {
    this.appendUiError(message, retryable, createdAt);
    this.saveSessions();
    this.postMessage({ type: 'showError', message, retryable, createdAt });
  }

  private restoreUiTranscriptToWebview(): void {
    if (this.uiTranscript.length === 0) {
      return;
    }

    info(`恢复 ${this.uiTranscript.length} 条 UI 历史到界面`);

    for (const entry of this.uiTranscript) {
      if (entry.type === 'error') {
        this.postMessage({
          type: 'showError',
          message: entry.message,
          retryable: entry.retryable,
          createdAt: entry.createdAt,
          readOnly: true,
        });
        continue;
      }

      this.postMessage({
        type: 'addMessage',
        role: entry.role,
        content: entry.content,
        messageId: entry.messageId,
        createdAt: entry.createdAt,
        partial: entry.partial,
        readOnly: true,
      });

      if (entry.role === 'assistant') {
        this.postMessage({ type: 'streamDone', messageId: entry.messageId });
      }

      for (const event of entry.events ?? []) {
        switch (event.type) {
          case 'thinkingComplete':
            this.postMessage({
              type: 'thinkingComplete',
              messageId: entry.messageId,
              elapsed: event.elapsed,
            });
            break;
          case 'addStep':
            this.postMessage({
              type: 'addStep',
              messageId: entry.messageId,
              stepId: event.stepId,
              icon: event.icon,
              description: event.description,
              status: event.status,
            });
            break;
          case 'updateStep':
            this.postMessage({
              type: 'updateStep',
              stepId: event.stepId,
              status: event.status,
              description: event.description,
              elapsed: event.elapsed,
            });
            break;
          case 'showDiff':
            this.postMessage({
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
            this.postMessage({
              type: 'showChangeSummary',
              messageId: entry.messageId,
              summaryId: event.summaryId,
              needsConfirm: event.needsConfirm,
              files: event.files,
              readOnly: true,
            });
            break;
          case 'updateChangeSummary':
            this.postMessage({
              type: 'updateChangeSummary',
              summaryId: event.summaryId,
              status: event.status,
              text: event.text,
            });
            break;
        }
      }
    }
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
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

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
    this.sendSessionList();

    // 恢复当前活跃会话的历史到界面
    this.restoreHistoryToWebview();
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

  /**
   * 处理 Webview 发来的消息
   * 根据 message.type 分发到不同的处理逻辑
   */
  private handleWebviewMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'sendMessage':
        info('收到用户消息:', message.text);
        // 同时传递图片附件（如果有），由 handleUserMessage 检测视觉能力后决定是否注入
        this.handleUserMessage(message.text, message.images);
        break;

      case 'copyCode':
        // 将代码复制到剪贴板
        vscode.env.clipboard.writeText(message.code);
        vscode.window.showInformationMessage('代码已复制到剪贴板');
        break;

      case 'insertCode':
        // 将代码插入到当前编辑器
        this.insertCodeToEditor(message.code);
        break;

      case 'clearChat':
        info('用户清空对话');
        if (this.abortStream) {
          this.abortStream();
          this.abortStream = null;
        }
        this.activeRunId = null;
        this.stepSequence = 0;
        this.toolCallsInProgress = false;
        this.clearHistory();
        this.contextFiles = [];
        for (const resolve of this.pendingConfirms.values()) { resolve(false); }
        this.pendingConfirms.clear();
        for (const resolve of this.pendingBatchConfirms.values()) { resolve(false); }
        this.pendingBatchConfirms.clear();
        this.postMessage({ type: 'setLoading', loading: false });
        this.postMessage({ type: 'clearChat' });
        this.postMessage({ type: 'clearContextFiles' });
        break;

      case 'requestModels':
        // Webview 请求模型列表（下拉框展开时触发）
        this.sendModelList();
        break;

      case 'switchModel':
        // 用户切换模型
        info(`用户切换模型到索引: ${message.index}`);
        setActiveModelIndex(message.index);
        this.sendModelList();
        // 通知外部更新状态栏
        const models = getAllModels();
        if (this.onModelSwitch && models[message.index]) {
          this.onModelSwitch(models[message.index].name);
        }
        break;

      case 'switchMode':
        // 用户切换工作模式
        info(`用户切换工作模式: ${message.mode}`);
        this.currentMode = message.mode;
        this.postMessage({ type: 'updateMode', mode: this.currentMode });
        break;

      case 'contextAction':
        // 上下文面板选项点击
        this.handleContextAction(message.action);
        break;

      case 'removeContextFile':
        // 移除已添加的上下文文件
        this.contextFiles = this.contextFiles.filter(f => f !== message.filePath);
        info(`移除上下文文件: ${message.filePath}，剩余 ${this.contextFiles.length} 个`);
        break;

      case 'searchWorkspaceFiles':
        // 搜索工作区文件并返回结果
        this.searchWorkspaceFiles(message.keyword);
        break;

      case 'addContextFile':
        // @ mention 选中文件后添加到上下文列表
        if (!this.contextFiles.includes(message.filePath)) {
          this.contextFiles.push(message.filePath);
          info(`@ mention 添加上下文文件: ${message.filePath}`);
        }
        break;

      case 'exportChat':
        this.exportChatToMarkdown();
        break;

      case 'createSession':
        this.createNewSession();
        break;

      case 'switchSession':
        this.switchSession(message.sessionId);
        break;

      case 'deleteSession':
        this.deleteSession(message.sessionId);
        break;

      case 'renameSession':
        this.renameSession(message.sessionId, message.name);
        break;

      case 'analyzeTerminalError':
        this.handleAnalyzeTerminalError();
        break;

      case 'regenerate':
        this.handleRegenerate();
        break;

      case 'stopGeneration':
        const stoppedRunId = this.activeRunId;
        if (stoppedRunId) {
          this.stoppedRunIds.add(stoppedRunId);
        }
        this.stepSequence = 0;
        this.toolCallsInProgress = false;
        if (this.abortStream) {
          info('用户主动停止生成');
          this.abortStream();
          this.abortStream = null;
        }
        if (stoppedRunId) {
          this.markUiMessageStopped(stoppedRunId);
          this.saveSessions();
          this.stoppedRunIds.delete(stoppedRunId);
        }
        this.activeRunId = null;
        if (this.pendingConfirms.size > 0) {
          info(`停止生成：清理 ${this.pendingConfirms.size} 个待确认变更`);
          for (const resolve of this.pendingConfirms.values()) {
            resolve(false);
          }
          this.pendingConfirms.clear();
        }
        if (this.pendingBatchConfirms.size > 0) {
          info(`停止生成：清理 ${this.pendingBatchConfirms.size} 个待确认批量变更`);
          for (const resolve of this.pendingBatchConfirms.values()) {
            resolve(false);
          }
          this.pendingBatchConfirms.clear();
        }
        this.postMessage({ type: 'generationStopped' });
        this.postMessage({ type: 'setLoading', loading: false });
        break;

      case 'executeCommand':
        info(`Slash 命令执行: ${message.command}`);
        vscode.commands.executeCommand(message.command);
        break;

      case 'acceptChange': {
        const resolve = this.pendingConfirms.get(message.stepId);
        if (resolve) {
          info(`用户接受文件变更: ${message.stepId}`);
          this.pendingConfirms.delete(message.stepId);
          resolve(true);
        }
        break;
      }

      case 'rejectChange': {
        const resolve = this.pendingConfirms.get(message.stepId);
        if (resolve) {
          info(`用户拒绝文件变更: ${message.stepId}`);
          this.pendingConfirms.delete(message.stepId);
          resolve(false);
        }
        break;
      }

      case 'acceptAllChanges': {
        const resolve = this.pendingBatchConfirms.get(message.summaryId);
        if (resolve) {
          info(`用户接受批量文件变更: ${message.summaryId}`);
          this.pendingBatchConfirms.delete(message.summaryId);
          resolve(true);
        }
        break;
      }

      case 'rejectAllChanges': {
        const resolve = this.pendingBatchConfirms.get(message.summaryId);
        if (resolve) {
          info(`用户拒绝批量文件变更: ${message.summaryId}`);
          this.pendingBatchConfirms.delete(message.summaryId);
          resolve(false);
        }
        break;
      }

      default:
        error('未知的 Webview 消息类型:', message);
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
    const safeIndex = Math.min(activeIndex, models.length - 1);
    const modelConfig = getModelConfig();
    this.postMessage({
      type: 'updateModels',
      models: models.map((m, i) => ({ name: m.name, index: i })),
      activeIndex: safeIndex,
      // 把当前模型的视觉能力标识推送给前端，用于控制上传图片入口的可用状态
      supportsVision: modelConfig.supportsVision ?? false,
    });
  }

  /**
   * 处理用户发送的聊天消息
   * 构建 Prompt → 调用 AI API（流式）→ 逐字推送到 Webview
   * @param text 用户输入的文字
   * @param images 可选的图片附件列表（base64 格式），由前端在发送时一并传来
   */
  private async handleUserMessage(
    text: string,
    images?: Array<{ id: string; dataUrl: string; fileName: string; mimeType: string; sizeKB: number }>
  ): Promise<void> {
    // 先在界面上显示用户消息
    const userCreatedAt = Date.now();
    const userMsgId = `user-${userCreatedAt}`;
    this.postMessage({
      type: 'addMessage',
      role: 'user',
      content: text,
      messageId: userMsgId,
      createdAt: userCreatedAt,
    });
    this.setUiMessageContent(userMsgId, 'user', userCreatedAt, text);
    this.saveSessions();

    // 显示加载状态
    this.postMessage({ type: 'setLoading', loading: true });

    // 确保 API Key 已配置
    const apiKey = await ensureApiKey();
    if (!apiKey) {
      this.postMessage({ type: 'setLoading', loading: false });
      this.postChatError('未配置 API Key，请在设置中配置 myAiPlugin.apiKey', false);
      return;
    }

    // 获取配置
    const modelConfig = getModelConfig();
    const envContext = getEnvContext();
    const projectType = detectProjectType();
    const gitInfo = getGitStatus();

    // 构建系统提示词：用户已配置自定义提示词时直接使用，否则使用内置默认
    const customPrompt = getCustomSystemPrompt();
    const baseSystemPrompt = customPrompt
      ? customPrompt
      : buildSystemPrompt(envContext, modelConfig, this.currentMode, '中文', projectType, gitInfo);
    // 自动读取项目背景（README.md + package.json）并追加到系统提示词末尾
    const projectCtx = getProjectContext();
    const systemPrompt = projectCtx ? `${baseSystemPrompt}

${projectCtx}` : baseSystemPrompt;

    // 构建消息列表：系统提示词 + 历史对话 + 当前用户消息
    // 附带上下文：选中代码 + @ Mentions 引用的文件
    const editorCtx = getEditorContext();
    let userContent = text;

    // 附加编辑器中选中的代码
    if (editorCtx && editorCtx.selectedCode) {
      userContent += `\n\n## 当前选中的代码\n- 文件：${editorCtx.fileName}\n- 语言：${editorCtx.fileLanguage}\n- 行号：第 ${editorCtx.startLine} 行 ~ 第 ${editorCtx.endLine} 行\n\n\`\`\`${editorCtx.fileLanguage}\n${editorCtx.selectedCode}\n\`\`\``;
    }

    // 附加 @ Mentions 引用的文件内容
    const contextContent = await this.buildContextContent();
    if (contextContent) {
      userContent += `\n\n${contextContent}`;
    }

    // 通知 Webview 清空文件标签（文件已注入到本次消息）
    this.postMessage({ type: 'clearContextFiles' });

    // 添加到对话历史并持久化（历史只存文本部分，图片不持久化以节省空间）
    this.chatHistory.push({ role: 'user', content: userContent });
    this.saveChatHistory();

    // 上下文窗口管理：估算 token 数，超过阈值时截断旧消息
    const contextMessages = this.trimChatHistory(this.chatHistory);

    // 构建最终发送给 API 的用户消息内容
    // 有图片且模型支持视觉时，组装为多模态 ContentPart 数组
    const hasImages = images && images.length > 0;
    let finalUserContent: ChatMessageParam['content'];
    if (hasImages && modelConfig.supportsVision) {
      // OpenAI Vision API 格式：先文本，再图片内容块
      finalUserContent = [
        { type: 'text', text: userContent },
        ...images.map(img => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
      ];
    } else {
      if (hasImages && !modelConfig.supportsVision) {
        // 模型不支持视觉，告知前端并仅发送文本
        this.postMessage({ type: 'visionNotSupported', modelName: modelConfig.modelName });
      }
      finalUserContent = userContent;
    }

    // 通知 Webview 清空图片缩略图（图片已处理）
    this.postMessage({ type: 'clearImageAttachments' });

    const messages: ChatMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...contextMessages.slice(0, -1), // 历史消息（不含最后一条，最后一条用 finalUserContent 替换）
      { role: 'user', content: finalUserContent },
    ];

    // 构建 API 配置
    const apiConfig: ApiClientConfig = {
      baseUrl: modelConfig.baseUrl,
      apiKey,
      modelId: modelConfig.modelId,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
    };

    // 清理上一轮可能残留的状态（用户未点停止直接发新消息时）
    if (this.abortStream) {
      this.abortStream();
      this.abortStream = null;
    }
    for (const resolve of this.pendingConfirms.values()) { resolve(false); }
    this.pendingConfirms.clear();
    for (const resolve of this.pendingBatchConfirms.values()) { resolve(false); }
    this.pendingBatchConfirms.clear();
    this.toolCallsInProgress = false;

    // 发起流式请求，保存 abort 句柄用于停止生成
    const assistantCreatedAt = Date.now();
    const assistantMsgId = `assistant-${assistantCreatedAt}`;
    const streamStartTime = assistantCreatedAt;
    this.activeRunId = assistantMsgId;
    this.stepSequence = 0;

    this.abortStream = sendStreamRequest(
      apiConfig,
      messages,
      // onChunk：逐字推送到 Webview
      (chunk) => {
        if (this.activeRunId !== assistantMsgId) {
          return;
        }
        this.postMessage({
          type: 'streamChunk',
          chunk,
          messageId: assistantMsgId,
          createdAt: assistantCreatedAt,
        });
      },
      // onDone：流式传输完成，检测并执行工具调用
      (fullContent) => {
        const stopped = this.stoppedRunIds.has(assistantMsgId);
        if (this.activeRunId !== assistantMsgId && !stopped) {
          return;
        }
        this.abortStream = null;
        const thinkingElapsed = Date.now() - streamStartTime;
        const displayContent = hasToolCalls(fullContent) ? stripToolCalls(fullContent) : fullContent;

        // 将 AI 回复加入对话历史并持久化
        this.chatHistory.push({ role: 'assistant', content: fullContent });
        this.saveChatHistory();
        this.setUiMessageContent(assistantMsgId, 'assistant', assistantCreatedAt, displayContent, stopped);
        this.saveSessions();
        info(`AI 回复完成，长度: ${fullContent.length}，耗时: ${thinkingElapsed}ms`);

        if (stopped) {
          if (displayContent !== fullContent) {
            this.postMessage({
              type: 'updateMessage',
              messageId: assistantMsgId,
              content: displayContent,
            });
          }
          this.postMessage({ type: 'streamDone', messageId: assistantMsgId });
          return;
        }

        if (hasToolCalls(fullContent)) {
          // 剥离 tool_call 标签后更新界面显示（用户看不到原始 XML）
          this.postMessage({
            type: 'updateMessage',
            messageId: assistantMsgId,
            content: displayContent,
          });
          this.postMessage({ type: 'streamDone', messageId: assistantMsgId });
          if (thinkingElapsed > 1000) {
            this.postUiThinkingComplete(assistantMsgId, thinkingElapsed);
          }
          this.postMessage({ type: 'setLoading', loading: true });
          this.handleToolCalls(fullContent, apiConfig, assistantMsgId);
        } else {
          this.postMessage({ type: 'streamDone', messageId: assistantMsgId });
          if (thinkingElapsed > 1000) {
            this.postUiThinkingComplete(assistantMsgId, thinkingElapsed);
          }
          this.activeRunId = null;
          this.stepSequence = 0;
        }
      },
      // onError：出错处理
      (errorMessage) => {
        if (this.activeRunId !== assistantMsgId) {
          return;
        }
        this.abortStream = null;
        this.activeRunId = null;
        this.stepSequence = 0;
        this.postMessage({ type: 'setLoading', loading: false });
        this.postChatError(errorMessage);
        error('AI API 调用失败:', errorMessage);
      },
    );
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
  private async handleToolCalls(aiResponse: string, apiConfig: ApiClientConfig, reuseMsgId: string): Promise<void> {
    const toolCalls = parseToolCalls(aiResponse);
    if (toolCalls.length === 0) {
      return;
    }

    if (this.activeRunId !== reuseMsgId) {
      return;
    }

    if (this.toolCallsInProgress) {
      info('handleToolCalls 已在执行中，跳过重复调用');
      return;
    }
    this.toolCallsInProgress = true;

    try {

      info(`检测到 ${toolCalls.length} 个工具调用，逐步执行...`);

      const results: ToolExecutionResult[] = [];
      const previewBaseStates = new Map<string, PreviewFileState>();
      const previewCurrentStates = new Map<string, PreviewFileState>();
      const previewIssues = new Map<string, string>();
      const deferredSteps: DeferredToolStep[] = [];
      const writeFilePaths = new Set<string>();
      const summaryId = `summary-${reuseMsgId}-${Date.now()}-${this.stepSequence}`;
      let deferRemainingSteps = false;

      for (let i = 0; i < toolCalls.length; i++) {
        if (this.activeRunId !== reuseMsgId) {
          return;
        }
        const tc = toolCalls[i];
        const stepId = `step-${reuseMsgId}-${this.stepSequence++}`;
        const stepDesc = this.getToolStepDescription(tc);
        const stepIcon = this.getToolStepIcon(tc.type);

        // 发送步骤开始（前端显示 spinner）
        this.postUiStepStart(reuseMsgId, stepId, stepIcon, stepDesc, 'running');

        const startTime = Date.now();

        const isWriteOp = tc.type === 'write_file' || tc.type === 'edit_file';

        if (deferRemainingSteps || isWriteOp) {
          deferRemainingSteps = true;
          deferredSteps.push({ stepId, stepDesc, toolCall: tc, startedAt: startTime });

          if (isWriteOp) {
            if (tc.type === 'write_file') { writeFilePaths.add(tc.path); }
            const initialPreviewState = await this.ensurePreviewFileState(previewBaseStates, tc.path);
            if (!previewCurrentStates.has(tc.path)) {
              previewCurrentStates.set(tc.path, {
                content: initialPreviewState.content,
                exists: initialPreviewState.exists,
              });
            }

            const currentPreviewState = previewCurrentStates.get(tc.path) || initialPreviewState;
            const previewResult = this.buildPreviewContent(tc, currentPreviewState.content);
            const nextPreviewState: PreviewFileState = previewResult.canApply || tc.type === 'write_file'
              ? {
                content: previewResult.newContent,
                exists: tc.type === 'write_file' ? true : currentPreviewState.exists,
              }
              : {
                content: currentPreviewState.content,
                exists: currentPreviewState.exists,
              };

            previewCurrentStates.set(tc.path, nextPreviewState);

            if (previewResult.issueText) {
              previewIssues.set(tc.path, previewResult.issueText);
            } else {
              previewIssues.delete(tc.path);
            }

            // write_file 语义是"创建/覆盖"，始终展示完整新内容（以空内容为基准）
            // edit_file 语义是"局部修改"，展示实际差异
            const diffOldContent = tc.type === 'write_file' ? '' : currentPreviewState.content;
            const { additions, deletions } = this.calculateDiffStats(diffOldContent, nextPreviewState.content);
            const lang = this.detectLanguage(tc.path);

            this.postUiDiff(reuseMsgId, {
              stepId,
              summaryId,
              filePath: tc.path,
              language: lang,
              additions,
              deletions,
              oldContent: diffOldContent,
              newContent: nextPreviewState.content,
              noticeText: previewResult.issueText,
              needsConfirm: false,
              collapsed: true,
            });
          }

          continue;
        }

        const result = await executeToolCalls([tc], this.currentMode);
        const singleResult = result[0];
        results.push(singleResult);
        const elapsed = Date.now() - startTime;
        const status = singleResult.result.success ? 'done' : 'error';
        this.postUiStepUpdate(stepId, status, undefined, elapsed);
      }

      if (this.activeRunId !== reuseMsgId) {
        return;
      }

      if (deferredSteps.length > 0) {
        const summaryFiles = this.buildPreviewSummaryFiles(previewBaseStates, previewCurrentStates, writeFilePaths, previewIssues);
        this.postUiChangeSummary(reuseMsgId, summaryId, true, summaryFiles);

        const accepted = await new Promise<boolean>((resolve) => {
          this.pendingBatchConfirms.set(summaryId, resolve);
        });
        this.pendingBatchConfirms.delete(summaryId);

        if (!accepted) {
          const isCancelled = this.activeRunId !== reuseMsgId;
          this.postUiChangeSummaryUpdate(
            summaryId,
            isCancelled ? 'cancelled' : 'rejected',
            isCancelled ? '✗ Cancelled' : '✗ Rejected all changes',
          );

          for (const deferredStep of deferredSteps) {
            const deferredIsWriteOp = deferredStep.toolCall.type === 'write_file' || deferredStep.toolCall.type === 'edit_file';
            const suffix = isCancelled ? '(已取消)' : (deferredIsWriteOp ? '(已拒绝)' : '(已跳过)');
            const message = isCancelled
              ? '用户取消了生成'
              : (deferredIsWriteOp ? '用户拒绝了批量文件变更' : '由于用户拒绝了批量文件变更，后续工具调用已跳过');

            results.push({
              toolCall: deferredStep.toolCall,
              result: { success: false, content: message },
            });

            this.postUiStepUpdate(
              deferredStep.stepId,
              'error',
              `${deferredStep.stepDesc} ${suffix}`,
              Date.now() - deferredStep.startedAt,
            );
          }

          if (isCancelled) {
            return;
          }
        }

        if (this.activeRunId !== reuseMsgId) {
          this.postUiChangeSummaryUpdate(summaryId, 'cancelled', '✗ Cancelled');
          return;
        }

        if (accepted) {
          this.postUiChangeSummaryUpdate(summaryId, 'applying', 'Applying changes...');

          let successCount = 0;
          let failureCount = 0;

          for (const deferredStep of deferredSteps) {
            if (this.activeRunId !== reuseMsgId) {
              this.postUiChangeSummaryUpdate(
                summaryId,
                successCount > 0 || failureCount > 0 ? 'partial' : 'cancelled',
                successCount > 0 || failureCount > 0
                  ? `⚠ Cancelled after applying ${successCount}/${deferredSteps.length} changes`
                  : '✗ Cancelled',
              );
              return;
            }

            const result = await executeToolCalls([deferredStep.toolCall], this.currentMode);
            const singleResult = result[0];
            results.push(singleResult);

            if (singleResult.result.success) {
              successCount += 1;
            } else {
              failureCount += 1;
            }

            const status = singleResult.result.success ? 'done' : 'error';
            this.postUiStepUpdate(
              deferredStep.stepId,
              status,
              undefined,
              Date.now() - deferredStep.startedAt,
            );
          }

          if (failureCount === 0) {
            this.postUiChangeSummaryUpdate(summaryId, 'accepted', `✓ Applied all ${successCount} changes`);
          } else if (successCount === 0) {
            this.postUiChangeSummaryUpdate(summaryId, 'failed', `✗ Failed to apply ${failureCount} changes`);
          } else {
            this.postUiChangeSummaryUpdate(
              summaryId,
              'partial',
              `⚠ Applied ${successCount}/${deferredSteps.length} changes, ${failureCount} failed`,
            );
          }
        }
      }

      const resultText = formatToolResults(results);

      // 将工具结果作为系统级上下文追加，告诉 AI 直接基于结果回答
      const toolFeedback = [
        '以下是工具执行结果（不要在回复中重复展示这些原始数据，直接基于结果回答用户的问题）：',
        '',
        resultText,
      ].join('\n');
      this.chatHistory.push({ role: 'user', content: toolFeedback });
      this.saveChatHistory();

      // 构建续轮消息
      const modelConfig = getModelConfig();
      const envContext = getEnvContext();
      const systemPrompt = buildSystemPrompt(envContext, modelConfig, this.currentMode, '中文', detectProjectType(), getGitStatus());

      const followUpMessages: ChatMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...this.trimChatHistory(this.chatHistory),
      ];

      let isFirstChunk = true;
      this.abortStream = sendStreamRequest(
        apiConfig,
        followUpMessages,
        (chunk) => {
          if (this.activeRunId !== reuseMsgId) {
            return;
          }
          if (isFirstChunk) {
            isFirstChunk = false;
            this.postMessage({ type: 'streamChunk', chunk: '', messageId: reuseMsgId });
          }
          this.postMessage({ type: 'streamChunk', chunk, messageId: reuseMsgId });
        },
        (fullContent) => {
          const stopped = this.stoppedRunIds.has(reuseMsgId);
          if (this.activeRunId !== reuseMsgId && !stopped) {
            return;
          }
          this.abortStream = null;
          const cleanContent = hasToolCalls(fullContent) ? stripToolCalls(fullContent) : fullContent;
          this.chatHistory.push({ role: 'assistant', content: fullContent });
          this.saveChatHistory();
          this.setUiMessageContent(
            reuseMsgId,
            'assistant',
            this.getUiMessageCreatedAt(reuseMsgId),
            cleanContent,
            stopped,
          );
          this.saveSessions();
          info(`续轮回复完成，长度: ${fullContent.length}`);

          if (stopped) {
            if (cleanContent !== fullContent) {
              this.postMessage({ type: 'updateMessage', messageId: reuseMsgId, content: cleanContent });
            }
            this.postMessage({ type: 'streamDone', messageId: reuseMsgId });
            return;
          }

          if (hasToolCalls(fullContent)) {
            this.postMessage({ type: 'streamDone', messageId: reuseMsgId });
            this.postMessage({ type: 'updateMessage', messageId: reuseMsgId, content: cleanContent });
            this.postMessage({ type: 'setLoading', loading: true });
            if (this.chatHistory.length < 30) {
              this.handleToolCalls(fullContent, apiConfig, reuseMsgId);
            } else {
              this.activeRunId = null;
              this.stepSequence = 0;
            }
          } else {
            this.postMessage({ type: 'streamDone', messageId: reuseMsgId });
            this.activeRunId = null;
            this.stepSequence = 0;
          }
        },
        (errorMessage) => {
          if (this.activeRunId !== reuseMsgId) {
            return;
          }
          this.abortStream = null;
          this.activeRunId = null;
          this.stepSequence = 0;
          this.postMessage({ type: 'streamDone', messageId: reuseMsgId });
          this.postMessage({ type: 'updateMessage', messageId: reuseMsgId, content: '⚠️ 工具执行出错，请重试。' });
          this.setUiMessageContent(
            reuseMsgId,
            'assistant',
            this.getUiMessageCreatedAt(reuseMsgId),
            '⚠️ 工具执行出错，请重试。',
          );
          this.saveSessions();
          this.postChatError(errorMessage);
          error('续轮 AI 调用失败:', errorMessage);
        },
      );

    } finally {
      this.toolCallsInProgress = false;
    }
  }

  /**
   * 生成工具步骤的描述文字（Windsurf 风格，如 "Reading login.html"）
   */
  private getToolStepDescription(tc: ParsedToolCall): string {
    const fileName = tc.path.split(/[/\\]/).pop() || tc.path;
    switch (tc.type) {
      case 'read_file': return `Reading ${fileName}`;
      case 'write_file': return `Creating ${fileName}`;
      case 'edit_file': return `Editing ${fileName}`;
      case 'list_dir': return `Listing ${fileName}`;
      default: return `Processing ${fileName}`;
    }
  }

  /**
   * 工具类型对应的图标 emoji
   */
  private getToolStepIcon(type: ToolCallType): string {
    switch (type) {
      case 'read_file': return '📖';
      case 'write_file': return '📝';
      case 'edit_file': return '✏️';
      case 'list_dir': return '📁';
      default: return '📄';
    }
  }

  /**
   * 根据文件扩展名推断语言（用于 diff 语法高亮标签）
   */
  private detectLanguage(filePath: string): string {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', java: 'java', cs: 'csharp', go: 'go', rs: 'rust',
      html: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
      md: 'markdown', sh: 'bash', bat: 'batch', ps1: 'powershell',
      sql: 'sql', vue: 'vue', svelte: 'svelte', php: 'php', rb: 'ruby',
    };
    return langMap[ext] || ext || 'text';
  }

  private getDisplayPath(filePath: string): string {
    const relativePath = vscode.workspace.asRelativePath(filePath, false);
    return relativePath || (filePath.split(/[\\/]/).pop() || filePath);
  }

  private async ensurePreviewFileState(previewStates: Map<string, PreviewFileState>, filePath: string): Promise<PreviewFileState> {
    const cachedState = previewStates.get(filePath);
    if (cachedState) {
      return cachedState;
    }

    let nextState: PreviewFileState = {
      content: '',
      exists: false,
    };

    try {
      const readResult = await readFile(filePath);
      if (readResult.success) {
        nextState = {
          content: readResult.content,
          exists: true,
        };
      }
    } catch {
      nextState = {
        content: '',
        exists: false,
      };
    }

    previewStates.set(filePath, nextState);
    return nextState;
  }

  private buildPreviewContent(toolCall: ParsedToolCall, currentContent: string): PreviewBuildResult {
    if (toolCall.type === 'write_file') {
      return {
        newContent: toolCall.content || '',
        canApply: true,
      };
    }

    if (toolCall.type !== 'edit_file') {
      return {
        newContent: currentContent,
        canApply: false,
      };
    }

    const oldSegment = toolCall.oldContent;
    const newSegment = toolCall.newContent || '';
    if (oldSegment === undefined || oldSegment === '') {
      return {
        newContent: currentContent,
        canApply: false,
        issueText: '预览提示：编辑片段缺少 old 内容，实际执行会失败',
      };
    }

    if (!currentContent.includes(oldSegment)) {
      return {
        newContent: currentContent,
        canApply: false,
        issueText: '预览提示：当前文件中未找到要替换的内容，实际执行会失败',
      };
    }

    return {
      newContent: currentContent.replace(oldSegment, newSegment),
      canApply: true,
    };
  }

  private buildPreviewSummaryFiles(
    previewBaseStates: Map<string, PreviewFileState>,
    previewCurrentStates: Map<string, PreviewFileState>,
    writeFilePaths: Set<string> = new Set(),
    previewIssues: Map<string, string> = new Map(),
  ): ChangeSummaryFile[] {
    const summaryFiles: ChangeSummaryFile[] = [];

    for (const [filePath, currentState] of previewCurrentStates.entries()) {
      const baseState = previewBaseStates.get(filePath);
      if (!baseState) {
        continue;
      }

      // write_file 始终以空内容为基准，与 showDiff 保持一致
      const baseContent = writeFilePaths.has(filePath) ? '' : baseState.content;
      const diffStats = this.calculateDiffStats(baseContent, currentState.content);
      summaryFiles.push({
        path: filePath,
        displayPath: this.getDisplayPath(filePath),
        additions: diffStats.additions,
        deletions: diffStats.deletions,
        status: baseState.exists ? 'modified' : 'created',
        issueText: previewIssues.get(filePath),
      });
    }

    return summaryFiles;
  }

  private calculateDiffStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
    const oldLines = this.splitContentToLines(oldContent);
    const newLines = this.splitContentToLines(newContent);
    const operations = this.buildDiffOperationTypes(oldLines, newLines);

    let additions = 0;
    let deletions = 0;

    for (const operation of operations) {
      if (operation === 'add') {
        additions += 1;
      } else if (operation === 'del') {
        deletions += 1;
      }
    }

    return { additions, deletions };
  }

  private splitContentToLines(content: string): string[] {
    if (!content) {
      return [];
    }

    let normalized = content.replace(/\r\n/g, '\n');
    if (normalized.endsWith('\n')) {
      normalized = normalized.slice(0, -1);
    }

    if (!normalized) {
      return [];
    }

    return normalized.split('\n');
  }

  private buildDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
    let prefixLength = 0;
    while (
      prefixLength < oldLines.length &&
      prefixLength < newLines.length &&
      oldLines[prefixLength] === newLines[prefixLength]
    ) {
      prefixLength += 1;
    }

    let oldSuffixIndex = oldLines.length - 1;
    let newSuffixIndex = newLines.length - 1;
    while (
      oldSuffixIndex >= prefixLength &&
      newSuffixIndex >= prefixLength &&
      oldLines[oldSuffixIndex] === newLines[newSuffixIndex]
    ) {
      oldSuffixIndex -= 1;
      newSuffixIndex -= 1;
    }

    const operations: Array<'context' | 'add' | 'del'> = [];

    for (let index = 0; index < prefixLength; index += 1) {
      operations.push('context');
    }

    const middleOldLines = oldLines.slice(prefixLength, oldSuffixIndex + 1);
    const middleNewLines = newLines.slice(prefixLength, newSuffixIndex + 1);
    operations.push(...this.buildMiddleDiffOperationTypes(middleOldLines, middleNewLines));

    const suffixLength = oldLines.length - (oldSuffixIndex + 1);
    for (let index = 0; index < suffixLength; index += 1) {
      operations.push('context');
    }

    return operations;
  }

  private buildMiddleDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
    if (oldLines.length === 0) {
      return newLines.map(() => 'add');
    }

    if (newLines.length === 0) {
      return oldLines.map(() => 'del');
    }

    if (oldLines.length * newLines.length <= 120000) {
      return this.buildMiddleDiffOperationTypesByLcs(oldLines, newLines);
    }

    return this.buildMiddleDiffOperationTypesByLookahead(oldLines, newLines);
  }

  private buildMiddleDiffOperationTypesByLcs(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
    const rowCount = oldLines.length;
    const columnCount = newLines.length;
    const lcsTable: number[][] = [];

    for (let row = 0; row <= rowCount; row += 1) {
      lcsTable.push(new Array(columnCount + 1).fill(0));
    }

    for (let row = rowCount - 1; row >= 0; row -= 1) {
      for (let column = columnCount - 1; column >= 0; column -= 1) {
        if (oldLines[row] === newLines[column]) {
          lcsTable[row][column] = lcsTable[row + 1][column + 1] + 1;
        } else {
          lcsTable[row][column] = Math.max(lcsTable[row + 1][column], lcsTable[row][column + 1]);
        }
      }
    }

    const operations: Array<'context' | 'add' | 'del'> = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < rowCount && newIndex < columnCount) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        operations.push('context');
        oldIndex += 1;
        newIndex += 1;
      } else if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
        operations.push('del');
        oldIndex += 1;
      } else {
        operations.push('add');
        newIndex += 1;
      }
    }

    while (oldIndex < rowCount) {
      operations.push('del');
      oldIndex += 1;
    }

    while (newIndex < columnCount) {
      operations.push('add');
      newIndex += 1;
    }

    return operations;
  }

  private buildMiddleDiffOperationTypesByLookahead(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
    const operations: Array<'context' | 'add' | 'del'> = [];
    let oldIndex = 0;
    let newIndex = 0;
    const lookaheadSize = 20;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        operations.push('context');
        oldIndex += 1;
        newIndex += 1;
        continue;
      }

      const nextNewMatch = this.findNextMatchingLine(newLines, newIndex + 1, oldLines[oldIndex], lookaheadSize);
      const nextOldMatch = this.findNextMatchingLine(oldLines, oldIndex + 1, newLines[newIndex], lookaheadSize);

      if (nextNewMatch !== -1 && (nextOldMatch === -1 || nextNewMatch - newIndex <= nextOldMatch - oldIndex)) {
        while (newIndex < nextNewMatch) {
          operations.push('add');
          newIndex += 1;
        }
        continue;
      }

      if (nextOldMatch !== -1) {
        while (oldIndex < nextOldMatch) {
          operations.push('del');
          oldIndex += 1;
        }
        continue;
      }

      operations.push('del');
      operations.push('add');
      oldIndex += 1;
      newIndex += 1;
    }

    while (oldIndex < oldLines.length) {
      operations.push('del');
      oldIndex += 1;
    }

    while (newIndex < newLines.length) {
      operations.push('add');
      newIndex += 1;
    }

    return operations;
  }

  private findNextMatchingLine(lines: string[], startIndex: number, targetLine: string, lookaheadSize: number): number {
    const maxIndex = Math.min(lines.length, startIndex + lookaheadSize);
    for (let index = startIndex; index < maxIndex; index += 1) {
      if (lines[index] === targetLine) {
        return index;
      }
    }
    return -1;
  }

  /**
   * 搜索工作区文件并返回匹配结果给 Webview
   * 使用 VS Code workspace.findFiles API 查找文件
   * 
   * @param keyword 搜索关键词（文件名模糊匹配）
   */
  private async searchWorkspaceFiles(keyword: string): Promise<void> {
    try {
      // 收集当前打开的编辑器文件（优先显示）
      const openFiles: { filePath: string; fileName: string }[] = [];
      const openPaths = new Set<string>();
      const lowerKeyword = keyword.toLowerCase();

      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const tabInput = tab.input as { uri?: vscode.Uri } | undefined;
          if (tabInput?.uri) {
            const filePath = tabInput.uri.fsPath;
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(tabInput.uri);
            // 优先取相对路径，避免同名文件无法区分
            const displayName = workspaceFolder
              ? filePath.replace(workspaceFolder.uri.fsPath, '').replace(/^[\\/]/, '')
              : filePath.split(/[\\/]/).pop() || filePath;
            // 关键词过滤：对文件名和路径都做匹配
            if (!keyword || displayName.toLowerCase().includes(lowerKeyword)) {
              if (!openPaths.has(filePath)) {
                openPaths.add(filePath);
                openFiles.push({ filePath, fileName: `📌 ${displayName}` });
              }
            }
          }
        }
      }

      // 搜索工作区中的文件，排除常见的非代码目录
      const pattern = keyword ? `**/*${keyword}*` : '**/*';
      const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**}';
      const uris = await vscode.workspace.findFiles(pattern, excludePattern, 20);

      const searchFiles = uris
        .filter(uri => !openPaths.has(uri.fsPath))
        .map(uri => {
          const filePath = uri.fsPath;
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = workspaceFolder
            ? filePath.replace(workspaceFolder.uri.fsPath, '').replace(/^[\\/]/, '')
            : filePath.split(/[\\/]/).pop() || filePath;
          return { filePath, fileName: relativePath };
        });

      // 打开的文件在前，搜索结果在后
      const files = [...openFiles, ...searchFiles].slice(0, 20);
      this.postMessage({ type: 'workspaceFiles', files });
    } catch (err) {
      error('搜索工作区文件失败:', String(err));
      this.postMessage({ type: 'workspaceFiles', files: [] });
    }
  }

  /**
   * 处理上下文面板操作
   * 
   * @param action 操作类型：mentions（引用文件）、workflow（触发工作流）、upload（上传图片）
   */
  private async handleContextAction(action: string): Promise<void> {
    switch (action) {
      case 'mentions': {
        // 弹出 VS Code 文件选择器，让用户选择要引用的文件
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFolders: false,
          openLabel: '添加为上下文',
          filters: {
            '所有文件': ['*'],
          },
        });

        if (files && files.length > 0) {
          for (const file of files) {
            const filePath = file.fsPath;

            // 防止重复添加同一文件
            if (this.contextFiles.includes(filePath)) {
              continue;
            }

            this.contextFiles.push(filePath);
            const fileName = filePath.split(/[\\/]/).pop() || filePath;

            // 通知 Webview 显示文件标签
            this.postMessage({
              type: 'addContextFile',
              filePath,
              fileName,
            });

            info(`添加上下文文件: ${fileName}`);
          }
        }
        break;
      }

      case 'workflow':
        await this.handleTriggerWorkflow();
        break;

      case 'upload':
        // 图片上传全部在前端处理，后端收到此消息时什么都不做
        break;
    }
  }

  /**
   * 处理「重新生成」请求
   * 将历史中最后一条 assistant 消息删除，然后重新发送前一条 user 消息
   */
  private async handleRegenerate(): Promise<void> {
    const history = this.chatHistory;

    // 找到最后一条 assistant 消息的位置
    let lastAssistantIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }

    if (lastAssistantIdx === -1) {
      vscode.window.showInformationMessage('没有可以重新生成的回复');
      return;
    }

    // 找到该 assistant 消息前面的最后一条 user 消息
    let lastUserIdx = -1;
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx === -1) {
      vscode.window.showInformationMessage('找不到对应的用户消息');
      return;
    }

    // 取出用户消息内容（剩下文字部分）
    const userContent = history[lastUserIdx].content;
    const userText = typeof userContent === 'string' ? userContent : '';

    // 剔除最后一条 assistant 消息（最后一轮从用户消息开始重做）
    this.chatHistory = history.slice(0, lastAssistantIdx);
    this.saveChatHistory();

    info('重新生成回复，参考用户消息长度:', userText.length);
    // 直接调用内部发送方法，不再显示用户消息气泡（已有）
    await this.regenerateResponse(userText);
  }

  /**
   * 重新发起 AI 请求，不向界面添加用户消息气泡
   * 与 handleUserMessage 区别：跳过添加用户 UI 消息和保存用户历史这两步
   */
  private async regenerateResponse(userText: string): Promise<void> {
    this.postMessage({ type: 'setLoading', loading: true });

    const apiKey = await ensureApiKey();
    if (!apiKey) {
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({ type: 'showError', message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey' });
      return;
    }

    const modelConfig = getModelConfig();
    const envContext = getEnvContext();
    const projectType = detectProjectType();
    const gitInfo = getGitStatus();
    const customPrompt = getCustomSystemPrompt();
    const baseSystemPromptRegen = customPrompt
      ? customPrompt
      : buildSystemPrompt(envContext, modelConfig, this.currentMode, '中文', projectType, gitInfo);
    const projectCtxRegen = getProjectContext();
    const systemPrompt = projectCtxRegen
      ? `${baseSystemPromptRegen}\n\n${projectCtxRegen}`
      : baseSystemPromptRegen;

    const contextMessages = this.trimChatHistory(this.chatHistory);
    const messages: ChatMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...contextMessages,
    ];

    const apiConfig: ApiClientConfig = {
      baseUrl: modelConfig.baseUrl,
      apiKey,
      modelId: modelConfig.modelId,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
    };

    const regenMsgId = `ai-regen-${Date.now()}`;
    this.postMessage({ type: 'addMessage', role: 'assistant', content: '', messageId: regenMsgId });

    let fullContent = '';
    this.abortStream = await sendStreamRequest(
      apiConfig,
      messages,
      (chunk: string) => {
        fullContent += chunk;
        this.postMessage({ type: 'streamChunk', messageId: regenMsgId, chunk });
      },
      async () => {
        this.abortStream = null;
        const cleanContent = hasToolCalls(fullContent) ? stripToolCalls(fullContent) : fullContent;
        if (cleanContent !== fullContent) {
          this.postMessage({ type: 'updateMessage', messageId: regenMsgId, content: cleanContent });
        }
        this.postMessage({ type: 'streamDone', messageId: regenMsgId });
        this.chatHistory.push({ role: 'assistant', content: fullContent });
        this.saveChatHistory();
        info('重新生成完成，长度:', fullContent.length);
      },
      (err: unknown) => {
        this.abortStream = null;
        this.postMessage({ type: 'setLoading', loading: false });
        this.postMessage({ type: 'showError', message: String(err) });
      }
    );
  }

  /**
   * 处理「分析终端错误」请求
   * 从剪贴板读取错误内容，直接发给 AI 分析修复
   */
  private async handleAnalyzeTerminalError(): Promise<void> {
    const errorText = await readErrorFromClipboard();
    if (!errorText) {
      vscode.window.showInformationMessage(
        '剪贴板为空。请先在终端中选中错误文本并复制 (Ctrl+C)，然后再点击此按鈕。'
      );
      return;
    }
    const prompt = buildErrorAnalysisPrompt(errorText);
    info('分析终端错误，剪贴板内容长度:', errorText.length);
    await this.handleUserMessage(prompt);
  }

  /**
   * 处理触发工作流的全流程
   * 扫描工作区 .windsurf/workflows/ 目录 → QuickPick 选择 → 确认副作用 → 注入 Prompt 并执行
   */
  private async handleTriggerWorkflow(): Promise<void> {
    const workflows = this.discoverWorkflows();

    if (workflows.length === 0) {
      vscode.window.showInformationMessage(
        '当前工作区没有可用的工作流。\n请在 <工作区根>/.windsurf/workflows/ 目录下创建 .md 文件。'
      );
      return;
    }

    // 构建 QuickPick 选项，每项展示名称、说明和副作用标注
    const items = workflows.map(w => ({
      label: w.name,
      description: w.description || '无说明',
      detail: w.sideEffects.length > 0
        ? `副作用：${w.sideEffects.join('、')}`
        : '无文件修改 / 命令执行',
      filePath: w.filePath,
      promptContent: w.promptContent,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要运行的工作流',
      matchOnDescription: true,
      matchOnDetail: false,
    });

    if (!selected) { return; }

    // 二次确认：展示副作用提示
    const confirmLabel = '运行此工作流';
    const sideEffectMsg = selected.detail !== '无文件修改 / 命令执行'
      ? `\n注意：${selected.detail}`
      : '';
    const confirm = await vscode.window.showWarningMessage(
      `将运行「${selected.label}」${sideEffectMsg}`,
      { modal: true },
      confirmLabel
    );

    if (confirm !== confirmLabel) { return; }

    // 将工作流内容作为用户消息发送，进入正常 AI 调用链路
    info(`触发工作流: ${selected.label}`);
    await this.handleUserMessage(selected.promptContent);
  }

  /**
   * 扫描工作区 .windsurf/workflows/ 目录，解析 .md 文件的元信息
   * 返回工作流列表，含名称、说明、副作用和可用 Prompt
   */
  private discoverWorkflows(): Array<{
    name: string;
    description: string;
    filePath: string;
    promptContent: string;
    sideEffects: string[];
  }> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return []; }

    const workflowsDir = path.join(workspaceRoot, '.windsurf', 'workflows');
    if (!fs.existsSync(workflowsDir)) { return []; }

    let files: string[];
    try {
      files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.md'));
    } catch {
      return [];
    }

    return files.map(f => {
      const filePath = path.join(workflowsDir, f);
      const raw = fs.readFileSync(filePath, 'utf-8');

      // 解析 YAML frontmatter：---\n...\n---
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      let description = '';
      if (frontmatterMatch) {
        const descMatch = frontmatterMatch[1].match(/description:\s*(.+)/);
        if (descMatch) { description = descMatch[1].trim(); }
      }

      // frontmatter 弹出后的正文作为 prompt
      const promptContent = frontmatterMatch
        ? raw.slice(frontmatterMatch[0].length).trim()
        : raw.trim();

      // 扫描 prompt 内容，识别可能的副作用关键词
      const lowerPrompt = promptContent.toLowerCase();
      const sideEffects: string[] = [];
      if (/write_file|edit_file|创建文件|修改文件/.test(lowerPrompt)) {
        sideEffects.push('可能修改文件');
      }
      if (/run_command|执行命令|运行命令/.test(lowerPrompt)) {
        sideEffects.push('可能执行命令');
      }

      // 文件名转为显示名称（去掉 .md 后缀，连字符转空格）
      const name = path.basename(f, '.md').replace(/[-_]/g, ' ');

      return { name, description, filePath, promptContent, sideEffects };
    });
  }

  /**
   * 读取上下文文件内容，构建注入 Prompt 的文本
   * 读取后清空文件列表（每次发送消息只注入一次）
   */
  private async buildContextContent(): Promise<string> {
    if (this.contextFiles.length === 0) {
      return '';
    }

    const sections: string[] = [];
    sections.push('## 用户引用的上下文文件\n');

    for (const filePath of this.contextFiles) {
      try {
        const fileUri = vscode.Uri.file(filePath);
        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(fileBytes).toString('utf-8');
        const fileName = filePath.split(/[\\/]/).pop() || filePath;

        sections.push(`### ${fileName}\n\`\`\`\n${content}\n\`\`\`\n`);
      } catch (err) {
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        sections.push(`### ${fileName}\n> ⚠️ 无法读取文件: ${err}\n`);
      }
    }

    // 读取后清空列表
    this.contextFiles = [];

    return sections.join('\n');
  }

  /**
   * 将代码插入到当前活动编辑器的光标位置
   */
  private insertCodeToEditor(code: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('没有打开的编辑器，无法插入代码');
      return;
    }

    editor.edit(editBuilder => {
      // 如果有选中内容则替换，否则在光标位置插入
      if (editor.selection.isEmpty) {
        editBuilder.insert(editor.selection.active, code);
      } else {
        editBuilder.replace(editor.selection, code);
      }
    });

    vscode.window.showInformationMessage('代码已插入到编辑器');
  }

  /**
   * 清空对话历史
   */
  public clearHistory(): void {
    this.chatHistory = [];
    this.uiTranscript = [];
    this.resetUiRuntimeState();
    this.saveChatHistory();
    info('对话历史已清空');
  }

  /**
   * 上下文窗口管理：当历史消息估算 token 数超过阈值时，截断旧消息
   * 保留最近的消息，确保不超过模型的上下文窗口限制
   * @param history 完整对话历史
   * @returns 截断后的消息数组（发送给 API 用）
   */
  private trimChatHistory(history: ChatMessageParam[]): ChatMessageParam[] {
    // 上下文窗口 token 上限（预留 4000 给 system prompt + 回复）
    const maxContextTokens = 28000;
    let totalChars = 0;

    // 从最新消息往前累加，直到超过阈值
    let startIndex = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      const content = typeof history[i].content === 'string' ? history[i].content as string : '';
      totalChars += content.length;
      // 粗略估算：混合语言约 3 字符/token
      if (totalChars / 3 > maxContextTokens) {
        startIndex = i + 1;
        break;
      }
      startIndex = i;
    }

    if (startIndex > 0) {
      info(`上下文窗口截断：跳过前 ${startIndex} 条消息，保留 ${history.length - startIndex} 条`);
    }

    return history.slice(startIndex);
  }

  /**
   * 将对话历史持久化到 globalState
   * 每次消息变更后调用，保证重启后可恢复
   */
  private saveChatHistory(): void {
    // 历史已经包含在当前会话里，直接保存整个会话列表即可
    this.saveSessions();
  }

  // ==================== 会话管理 ====================

  /**
   * 从 globalState 加载会话数据
   * 如果没有新式会话数据，自动将旧 chatHistory 迁移到第一个会话
   */
  private loadSessions(): void {
    const savedSessions = this.context.globalState.get<ChatSession[]>('chatSessions');

    if (savedSessions && savedSessions.length > 0) {
      this.sessions = savedSessions;
      const savedActiveId = this.context.globalState.get<string>('activeSessionId');
      // 确保 activeSessionId 对应的会话确实存在
      const valid = savedSessions.find(s => s.id === savedActiveId);
      this.activeSessionId = valid ? savedActiveId! : savedSessions[0].id;
    } else {
      // 新安装或迁移旧数据：用旧 chatHistory 创建第一个会话
      const oldHistory = this.context.globalState.get<Array<{ role: string; content: unknown }>>('chatHistory');
      const first = this.createSessionObject('会话 1');
      if (oldHistory && oldHistory.length > 0) {
        first.history = oldHistory;
      }
      this.sessions = [first];
      this.activeSessionId = first.id;
      this.saveSessions();
    }

    info(`加载会话数据：共 ${this.sessions.length} 个会话，当前活跃: ${this.activeSessionId}`);
  }

  /**
   * 将所有会话序列化到 globalState
   * 同时更新 token 计数、负责所有会话数据的唯一展适备份
   */
  private saveSessions(): void {
    this.context.globalState.update('chatSessions', this.sessions);
    this.context.globalState.update('activeSessionId', this.activeSessionId);
    this.pushTokenCount();
  }

  /**
   * 创建一个新会话对象（不导致切换）
   * @param name 初始名称
   */
  private createSessionObject(name: string): ChatSession {
    return {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      createdAt: Date.now(),
      history: [],
    };
  }

  /**
   * 新建会话并切换到新会话
   * 名称自动生成为 "会话 N"
   */
  private createNewSession(): void {
    const name = `会话 ${this.sessions.length + 1}`;
    const newSession = this.createSessionObject(name);
    this.sessions.push(newSession);
    this.activeSessionId = newSession.id;
    this.resetUiRuntimeState();
    this.saveSessions();
    // 清空界面并确保不显示旧内容
    this.postMessage({ type: 'clearChat' });
    this.sendSessionList();
    info(`新建会话: ${name}`);
  }

  /**
   * 切换到指定会话
   * @param sessionId 目标会话 ID
   */
  private switchSession(sessionId: string): void {
    if (sessionId === this.activeSessionId) { return; }
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) { return; }
    this.activeSessionId = sessionId;
    this.resetUiRuntimeState();
    this.saveSessions();
    // 先清空界面，再还原新会话历史
    this.postMessage({ type: 'clearChat' });
    this.restoreHistoryToWebview();
    this.sendSessionList();
    info(`切换会话到: ${session.name}`);
  }

  /**
   * 删除指定会话
   * 当前会话被删时自动切换到列表中第一个
   * @param sessionId 要删除的会话 ID
   */
  private deleteSession(sessionId: string): void {
    if (this.sessions.length <= 1) {
      vscode.window.showWarningMessage('至少保留一个会话');
      return;
    }
    const index = this.sessions.findIndex(s => s.id === sessionId);
    if (index === -1) { return; }
    this.sessions.splice(index, 1);
    // 删除的是当前会话则自动跳到相邻的会话
    if (this.activeSessionId === sessionId) {
      const newIndex = Math.min(index, this.sessions.length - 1);
      this.activeSessionId = this.sessions[newIndex].id;
      this.resetUiRuntimeState();
      this.postMessage({ type: 'clearChat' });
      this.restoreHistoryToWebview();
    }
    this.saveSessions();
    this.sendSessionList();
    info(`删除会话: ${sessionId}`);
  }

  /**
   * 重命名指定会话
   * @param sessionId 会话 ID
   * @param name 新名称（自动 trim，空名称不生效）
   */
  private renameSession(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) { return; }
    const session = this.sessions.find(s => s.id === sessionId);
    if (session) {
      session.name = trimmed;
      this.saveSessions();
      this.sendSessionList();
    }
  }

  /**
   * 将会话列表摘要推送到 Webview（不含完整历史，减少传输量）
   */
  public sendSessionList(): void {
    this.postMessage({
      type: 'updateSessions',
      sessions: this.sessions.map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        // 历史消息数：过滤工具反馈中间消息，只计用户和 AI 的回合
        messageCount: (s.history as Array<{ role: string }>)
          .filter(m => m.role === 'user' || m.role === 'assistant').length,
      })),
      activeSessionId: this.activeSessionId,
    });
  }

  /**
   * 估算对话历史的 token 数并推送到 Webview
   * 粗略估算：英文约 4 字符/token，中文约 2 字符/token
   */
  private pushTokenCount(): void {
    let charCount = 0;
    for (const msg of this.chatHistory) {
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      }
    }
    // 混合语言粗略估算：平均 3 字符/token
    const tokenCount = Math.round(charCount / 3);
    this.postMessage({ type: 'updateTokenCount', tokenCount });
  }

  /**
   * 导出对话历史为 Markdown 文件
   * 弹出保存对话框，用户选择保存位置
   */
  private async exportChatToMarkdown(): Promise<void> {
    if (this.chatHistory.length === 0) {
      vscode.window.showInformationMessage('当前没有对话可导出');
      return;
    }

    const lines: string[] = [];
    lines.push('# AI 对话记录');
    lines.push('');
    lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
    lines.push('');

    for (const msg of this.chatHistory) {
      const content = typeof msg.content === 'string' ? msg.content : '';

      // 跳过工具反馈消息
      if (msg.role === 'user' && content.startsWith('以下是工具执行结果')) {
        continue;
      }

      if (msg.role === 'user') {
        lines.push('## 🧑 用户');
        lines.push('');
        // 截断附加的上下文信息
        const cutIndex = content.indexOf('\n\n## ');
        lines.push(cutIndex > 0 ? content.substring(0, cutIndex) : content);
      } else {
        lines.push('## 🤖 AI');
        lines.push('');
        lines.push(stripToolCalls(content));
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    const markdown = lines.join('\n');

    // 弹出保存对话框
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`ai-chat-${Date.now()}.md`),
      filters: { 'Markdown': ['md'], '所有文件': ['*'] },
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf-8'));
      vscode.window.showInformationMessage(`对话已导出到 ${uri.fsPath}`);
      info(`对话导出成功: ${uri.fsPath}`);
    }
  }

  /**
   * 将持久化的对话历史恢复到 Webview 界面
   * 只显示用户消息和 AI 最终回复（过滤掉工具调用中间消息）
   */
  private restoreHistoryToWebview(): void {
    this.resetUiRuntimeState();

    if (this.uiTranscript.length > 0) {
      this.restoreUiTranscriptToWebview();
      return;
    }

    if (this.chatHistory.length === 0) {
      return;
    }

    info(`恢复 ${this.chatHistory.length} 条历史消息到界面`);

    for (let i = 0; i < this.chatHistory.length; i++) {
      const msg = this.chatHistory[i];

      // 跳过工具反馈消息（包含"工具执行结果"的 user 消息是系统注入的，不应显示）
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('以下是工具执行结果')) {
        continue;
      }

      // AI 回复：剥离 tool_call 标签后显示
      let displayContent = typeof msg.content === 'string' ? msg.content : '';
      if (msg.role === 'assistant' && hasToolCalls(displayContent)) {
        displayContent = stripToolCalls(displayContent);
        // 如果剥离后为空（纯工具调用无文字），跳过
        if (!displayContent.trim()) {
          continue;
        }
      }

      // 用户消息：只显示原始文本（截断附加的上下文/代码片段）
      if (msg.role === 'user') {
        // 截断 "## 当前选中的代码" 及之后的附加内容
        const cutIndex = displayContent.indexOf('\n\n## ');
        if (cutIndex > 0) {
          displayContent = displayContent.substring(0, cutIndex);
        }
      }

      const msgId = `restored-${i}-${Date.now()}`;
      this.postMessage({
        type: 'addMessage',
        role: msg.role as 'user' | 'assistant',
        content: displayContent,
        messageId: msgId,
        readOnly: true,
      });
    }
  }

  /**
   * 生成 Webview 的完整 HTML 内容
   * 注入 CSS/JS 资源的 Webview URI 和 CSP 安全策略
   */
  private getHtmlContent(webview: vscode.Webview): string {
    // 获取 media 文件夹中资源的 Webview 安全 URI
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
    );
    const renderJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat_a_render.js')
    );
    const stepsJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat_b_steps.js')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );

    // CSP nonce：防止 XSS 注入，只允许带有此 nonce 的脚本执行
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>AI 聊天</title>
</head>
<body>
  <div id="chat-container">
    <!-- 聊天内搜索栏（默认隐藏，Ctrl+F 显示） -->
    <div id="search-bar" class="search-bar hidden">
      <input id="search-input" type="text" placeholder="搜索对话内容..." />
      <span id="search-count" class="search-count"></span>
      <button id="search-prev" class="search-nav-btn" title="上一个">▲</button>
      <button id="search-next" class="search-nav-btn" title="下一个">▼</button>
      <button id="search-close" class="search-nav-btn" title="关闭搜索">✕</button>
    </div>
    <!-- 会话 Tab 标签条 -->
    <div id="session-tabs-bar" class="session-tabs-bar">
      <div id="session-tabs" class="session-tabs"></div>
      <button id="btn-new-session" class="session-new-btn" title="新建会话">+</button>
    </div>
    <!-- 消息列表区域 -->
    <div id="messages">
      <div class="welcome-message">
        <p><strong>👋 你好！我是 ${getPanelTitle()}</strong></p>
        <div class="welcome-section">
          <p class="welcome-subtitle">快捷键</p>
          <div class="welcome-shortcuts">
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>Q</kbd><span>聚焦聊天</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>E</kbd><span>解释代码</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>F</kbd><span>修复代码</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>M</kbd><span>切换模式</span></div>
          </div>
        </div>
        <div class="welcome-section">
          <p class="welcome-subtitle">快速操作</p>
          <div class="welcome-shortcuts">
            <div class="shortcut-item"><kbd>@</kbd><span>引用工作区文件</span></div>
            <div class="shortcut-item"><kbd>/</kbd><span>Slash 快捷命令</span></div>
          </div>
        </div>
        <p class="welcome-hint">选中代码后右键也可使用 AI 功能</p>
      </div>
    </div>

    <!-- 加载指示器 -->
    <div id="loading" class="hidden">
      <div class="loading-dots">
        <span></span><span></span><span></span>
      </div>
    </div>

    <!-- 模型选择面板（点击模型名称弹出） -->
    <div id="model-panel" class="model-panel hidden">
      <div class="model-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="model-search" type="text" placeholder="搜索模型..." />
      </div>
      <div id="model-panel-list" class="model-panel-list"></div>
    </div>

    <!-- 上下文面板（点击 + 按钮弹出） -->
    <div id="context-panel" class="context-panel hidden">
      <div class="context-panel-group-label">添加上下文</div>
      <div class="context-panel-item" data-action="mentions">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>
        </div>
        <span class="context-item-label">@ 引用文件</span>
      </div>
      <div class="context-panel-item" data-action="upload">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
        <span class="context-item-label">上传图片</span>
      </div>
      <div class="context-panel-separator"></div>
      <div class="context-panel-group-label">执行动作</div>
      <div class="context-panel-item" data-action="workflow">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
        </div>
        <span class="context-item-label">运行工作流</span>
      </div>
    </div>

    <!-- 模式选择面板（点击 Code 按钮弹出） -->
    <div id="mode-panel" class="mode-panel hidden">
      <div class="mode-panel-item active" data-mode="code">
        <div class="mode-item-icon">&lt;&gt;</div>
        <div class="mode-item-info">
          <div class="mode-item-name">Code<span class="mode-item-check">✓</span></div>
          <div class="mode-item-desc">Can write and edit code</div>
        </div>
      </div>
      <div class="mode-panel-item" data-mode="ask">
        <div class="mode-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="mode-item-info">
          <div class="mode-item-name">Ask</div>
          <div class="mode-item-desc">Reads but won't edit</div>
        </div>
      </div>
      <div class="mode-panel-item" data-mode="plan">
        <div class="mode-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="16" x2="12" y2="16"/></svg>
        </div>
        <div class="mode-item-info">
          <div class="mode-item-name">Plan</div>
          <div class="mode-item-desc">Plan changes before implementing</div>
        </div>
      </div>
      <div class="mode-panel-hint">Use <kbd>Ctrl</kbd> <kbd>.</kbd> to switch modes</div>
    </div>

    <!-- 输入区域 -->
    <div id="input-area">
      <!-- @ 文件搜索下拉菜单（绝对定位在输入区上方） -->
      <div id="mention-dropdown" class="mention-dropdown hidden"></div>
      <div id="context-files" class="context-files"></div>
      <div id="image-attachments" class="image-attachments"></div>
      <textarea
        id="user-input"
        placeholder="输入任何问题...（Ctrl+L）"
        rows="2"
      ></textarea>
      <div id="input-toolbar">
        <div class="input-toolbar-left">
          <button id="btn-add-context" class="toolbar-icon-btn" title="添加上下文">+</button>
          <button id="btn-terminal-error" class="toolbar-icon-btn" title="分析终端错误（先在终端复制错误文本）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="7 9 12 12 17 9" style="stroke-width:1.5"/></svg>
          </button>
          <button id="btn-code-mode" class="toolbar-icon-btn" title="切换工作模式">&lt;&gt;<span class="toolbar-text"> Code</span></button>
          <div id="model-selector" class="model-selector">
            <span id="model-label" class="model-label"><span class="toolbar-text">DeepSeek Chat</span></span>
          </div>
        </div>
        <div class="input-toolbar-right">
          <span id="char-count" class="char-count" title="输入字符数"></span>
          <span id="token-count" class="token-count" title="当前对话估算 Token 数"></span>
          <button id="btn-export" class="toolbar-icon-btn" title="导出对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button id="btn-clear" class="toolbar-icon-btn" title="清空对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
          <button id="btn-send" class="send-btn" title="发送消息">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${renderJsUri}"></script>
  <script nonce="${nonce}" src="${stepsJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

/**
 * 生成随机 nonce 字符串
 * 用于 CSP 安全策略，确保只有合法脚本可以执行
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
