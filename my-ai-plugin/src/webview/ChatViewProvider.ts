/**
 * Webview 聊天面板提供者
 * 
 * 负责创建和管理侧边栏中的聊天 Webview 面板。
 * 实现 VS Code 的 WebviewViewProvider 接口，
 * 处理 Webview 的生命周期和消息通信。
 */
import * as vscode from 'vscode';
import { info, error } from '../logger';
import { getModelConfig, ensureApiKey, getMaxTokens, getTemperature, getAllModels, getActiveModelIndex, setActiveModelIndex, getPanelTitle } from '../config';
import { sendStreamRequest } from '../api/client';
import type { ApiClientConfig, AbortStreamFn } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { buildSystemPrompt } from '../prompts/system';
import { getEditorContext } from '../utils/editor';
import { getEnvContext, detectProjectType, getGitStatus } from '../utils/context';
import type { ExtensionMessage, WebviewMessage, WorkMode } from './messageTypes';
import { parseToolCalls, hasToolCalls, stripToolCalls, executeToolCalls, formatToolResults, readFile } from '../tools';
import type { ToolExecutionResult, ParsedToolCall, ToolCallType } from '../tools';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Provider 的注册 ID，必须与 package.json 中 views.id 一致 */
  public static readonly viewType = 'my-ai-plugin.chatView';

  /** 当前活跃的 Webview 实例引用，用于从外部向 Webview 发送消息 */
  private webviewView?: vscode.WebviewView;

  /** 对话历史记录，用于多轮对话上下文 */
  private chatHistory: ChatMessageParam[] = [];

  /** 当前工作模式：code（可修改文件）、ask（只读对话）、plan（先规划后执行） */
  private currentMode: WorkMode = 'code';

  /** 用户通过 @ Mentions 添加的上下文文件路径列表 */
  private contextFiles: string[] = [];

  /** 当前流式请求的中断函数（null 表示没有进行中的请求） */
  private abortStream: AbortStreamFn | null = null;

  /** 待用户确认的文件变更（stepId → resolve 函数），Accept/Reject 时触发 */
  private pendingConfirms: Map<string, (accepted: boolean) => void> = new Map();

  private activeRunId: string | null = null;

  private stepSequence = 0;

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  /** 插件根目录 URI，用于加载 media 资源 */
  private readonly extensionUri: vscode.Uri;

  /** VS Code 扩展上下文，用于 globalState 持久化 */
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;

    // 从 globalState 恢复对话历史
    const saved = context.globalState.get<ChatMessageParam[]>('chatHistory');
    if (saved && saved.length > 0) {
      this.chatHistory = saved;
      info(`从持久化存储恢复 ${saved.length} 条对话记录`);
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

    // 初始化完成后推送模型列表和当前工作模式到前端
    this.sendModelList();
    this.postMessage({ type: 'updateMode', mode: this.currentMode });

    // 恢复持久化的对话历史到界面
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
        this.handleUserMessage(message.text);
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
        this.clearHistory();
        this.contextFiles = [];
        for (const resolve of this.pendingConfirms.values()) { resolve(false); }
        this.pendingConfirms.clear();
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

      case 'stopGeneration':
        this.activeRunId = null;
        this.stepSequence = 0;
        if (this.abortStream) {
          info('用户主动停止生成');
          this.abortStream();
          this.abortStream = null;
        }
        if (this.pendingConfirms.size > 0) {
          info(`停止生成：清理 ${this.pendingConfirms.size} 个待确认变更`);
          for (const resolve of this.pendingConfirms.values()) {
            resolve(false);
          }
          this.pendingConfirms.clear();
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
    this.postMessage({
      type: 'updateModels',
      models: models.map((m, i) => ({ name: m.name, index: i })),
      activeIndex: Math.min(activeIndex, models.length - 1),
    });
  }

  /**
   * 处理用户发送的聊天消息
   * 构建 Prompt → 调用 AI API（流式）→ 逐字推送到 Webview
   */
  private async handleUserMessage(text: string): Promise<void> {
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

    // 确保 API Key 已配置
    const apiKey = await ensureApiKey();
    if (!apiKey) {
      this.postMessage({ type: 'setLoading', loading: false });
      this.postMessage({
        type: 'showError',
        message: '未配置 API Key，请在设置中配置 myAiPlugin.apiKey',
      });
      return;
    }

    // 获取配置
    const modelConfig = getModelConfig();
    const envContext = getEnvContext();
    const projectType = detectProjectType();
    const gitInfo = getGitStatus();

    // 构建系统提示词（根据当前工作模式生成不同的提示词）
    const systemPrompt = buildSystemPrompt(envContext, modelConfig, this.currentMode, '中文', projectType, gitInfo);

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

    // 添加到对话历史并持久化
    this.chatHistory.push({ role: 'user', content: userContent });
    this.saveChatHistory();

    // 上下文窗口管理：估算 token 数，超过阈值时截断旧消息
    const contextMessages = this.trimChatHistory(this.chatHistory);

    const messages: ChatMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...contextMessages,
    ];

    // 构建 API 配置
    const apiConfig: ApiClientConfig = {
      baseUrl: modelConfig.baseUrl,
      apiKey,
      modelId: modelConfig.modelId,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
    };

    // 发起流式请求，保存 abort 句柄用于停止生成
    const assistantMsgId = `assistant-${Date.now()}`;
    const streamStartTime = Date.now();
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
        });
      },
      // onDone：流式传输完成，检测并执行工具调用
      (fullContent) => {
        if (this.activeRunId !== assistantMsgId) {
          return;
        }
        this.abortStream = null;
        const thinkingElapsed = Date.now() - streamStartTime;

        // 将 AI 回复加入对话历史并持久化
        this.chatHistory.push({ role: 'assistant', content: fullContent });
        this.saveChatHistory();
        info(`AI 回复完成，长度: ${fullContent.length}，耗时: ${thinkingElapsed}ms`);

        if (hasToolCalls(fullContent)) {
          // 剥离 tool_call 标签后更新界面显示（用户看不到原始 XML）
          const cleanContent = stripToolCalls(fullContent);
          this.postMessage({
            type: 'updateMessage',
            messageId: assistantMsgId,
            content: cleanContent,
          });
          this.postMessage({ type: 'streamDone', messageId: assistantMsgId });
          if (thinkingElapsed > 1000) {
            this.postMessage({ type: 'thinkingComplete', messageId: assistantMsgId, elapsed: thinkingElapsed });
          }
          this.postMessage({ type: 'setLoading', loading: true });
          this.handleToolCalls(fullContent, apiConfig, assistantMsgId);
        } else {
          this.postMessage({ type: 'streamDone', messageId: assistantMsgId });
          if (thinkingElapsed > 1000) {
            this.postMessage({ type: 'thinkingComplete', messageId: assistantMsgId, elapsed: thinkingElapsed });
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
        this.postMessage({
          type: 'showError',
          message: errorMessage,
        });
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

    info(`检测到 ${toolCalls.length} 个工具调用，逐步执行...`);

    // Windsurf 风格：逐步执行每个工具调用，发送结构化步骤消息
    const results: ToolExecutionResult[] = [];
    const changeSummaryFiles: Array<{ path: string; additions: number; deletions: number; status: 'created' | 'modified' | 'read' | 'listed' }> = [];

    for (let i = 0; i < toolCalls.length; i++) {
      if (this.activeRunId !== reuseMsgId) {
        return;
      }
      const tc = toolCalls[i];
      const stepId = `step-${reuseMsgId}-${this.stepSequence++}`;
      const stepDesc = this.getToolStepDescription(tc);
      const stepIcon = this.getToolStepIcon(tc.type);

      // 发送步骤开始（前端显示 spinner）
      this.postMessage({ type: 'addStep', messageId: reuseMsgId, stepId, icon: stepIcon, description: stepDesc, status: 'running' });

      const startTime = Date.now();

      const isWriteOp = tc.type === 'write_file' || tc.type === 'edit_file';

      // 对于写入/编辑操作：先读取旧内容、展示 diff、等待用户确认
      if (isWriteOp) {
        let oldFileContent = '';
        try {
          const readResult = await readFile(tc.path);
          if (readResult.success) { oldFileContent = readResult.content; }
        } catch { /* 新文件，无旧内容 */ }

        const newContent = tc.type === 'write_file'
          ? (tc.content || '')
          : (oldFileContent.replace(tc.oldContent || '', tc.newContent || ''));
        const { additions, deletions } = this.calculateDiffStats(oldFileContent, newContent);
        const lang = this.detectLanguage(tc.path);

        // 展示 diff 并等待用户确认
        this.postMessage({
          type: 'showDiff', messageId: reuseMsgId, stepId, filePath: tc.path,
          language: lang, additions, deletions, oldContent: oldFileContent, newContent, needsConfirm: true,
        });

        // 异步等待用户点击 Accept 或 Reject
        const accepted = await new Promise<boolean>((resolve) => {
          this.pendingConfirms.set(stepId, resolve);
        });

        if (this.activeRunId !== reuseMsgId) {
          return;
        }

        const elapsed = Date.now() - startTime;

        if (accepted) {
          // 用户接受：执行文件操作
          const result = await executeToolCalls([tc], this.currentMode);
          const singleResult = result[0];
          results.push(singleResult);
          const status = singleResult.result.success ? 'done' : 'error';
          this.postMessage({ type: 'updateStep', stepId, status, elapsed });
          changeSummaryFiles.push({
            path: tc.path, additions, deletions,
            status: oldFileContent ? 'modified' : 'created',
          });
        } else {
          // 用户拒绝：跳过该操作，记录为失败结果
          results.push({ toolCall: tc, result: { success: false, content: '用户拒绝了此文件变更' } });
          this.postMessage({ type: 'updateStep', stepId, status: 'error', elapsed, description: `${stepDesc} (已拒绝)` });
        }
      } else {
        // 读取/列出目录：直接执行，无需确认
        const result = await executeToolCalls([tc], this.currentMode);
        const singleResult = result[0];
        results.push(singleResult);
        const elapsed = Date.now() - startTime;
        const status = singleResult.result.success ? 'done' : 'error';
        this.postMessage({ type: 'updateStep', stepId, status, elapsed });

        if (tc.type === 'read_file' && singleResult.result.success) {
          changeSummaryFiles.push({ path: tc.path, additions: 0, deletions: 0, status: 'read' });
        } else if (tc.type === 'list_dir' && singleResult.result.success) {
          changeSummaryFiles.push({ path: tc.path, additions: 0, deletions: 0, status: 'listed' });
        }
      }
    }

    if (this.activeRunId !== reuseMsgId) {
      return;
    }

    if (changeSummaryFiles.length > 0) {
      this.postMessage({ type: 'showChangeSummary', messageId: reuseMsgId, files: changeSummaryFiles });
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
        if (this.activeRunId !== reuseMsgId) {
          return;
        }
        this.abortStream = null;
        this.chatHistory.push({ role: 'assistant', content: fullContent });
        this.saveChatHistory();
        info(`续轮回复完成，长度: ${fullContent.length}`);

        if (hasToolCalls(fullContent)) {
          this.postMessage({ type: 'streamDone', messageId: reuseMsgId });
          const cleanContent = stripToolCalls(fullContent);
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
        this.postMessage({ type: 'showError', message: errorMessage });
        error('续轮 AI 调用失败:', errorMessage);
      },
    );
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
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            // 关键词过滤
            if (!keyword || fileName.toLowerCase().includes(lowerKeyword)) {
              if (!openPaths.has(filePath)) {
                openPaths.add(filePath);
                openFiles.push({ filePath, fileName: `📌 ${fileName}` });
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
        vscode.window.showInformationMessage('工作流功能开发中...');
        break;

      case 'upload':
        vscode.window.showInformationMessage('图片上传功能开发中...');
        break;
    }
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
    this.context.globalState.update('chatHistory', this.chatHistory);
    // 同步推送 token 用量估算
    this.pushTokenCount();
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
      <div class="context-panel-item" data-action="mentions">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>
        </div>
        <span class="context-item-label">Mentions</span>
      </div>
      <div class="context-panel-item" data-action="workflow">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
        </div>
        <span class="context-item-label">Trigger Workflow</span>
      </div>
      <div class="context-panel-item" data-action="upload">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
        <span class="context-item-label">Upload Image</span>
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
      <textarea
        id="user-input"
        placeholder="输入任何问题...（Ctrl+L）"
        rows="2"
      ></textarea>
      <div id="input-toolbar">
        <div class="input-toolbar-left">
          <button id="btn-add-context" class="toolbar-icon-btn" title="添加上下文">+</button>
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
