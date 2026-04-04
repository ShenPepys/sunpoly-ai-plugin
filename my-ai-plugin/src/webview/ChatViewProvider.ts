/**
 * Webview 聊天面板提供者
 * 
 * 负责创建和管理侧边栏中的聊天 Webview 面板。
 * 实现 VS Code 的 WebviewViewProvider 接口，
 * 处理 Webview 的生命周期和消息通信。
 */
import * as vscode from 'vscode';
import { info, error } from '../logger';
import { getModelConfig, ensureApiKey, getMaxTokens, getTemperature, getLanguage } from '../config';
import { sendStreamRequest } from '../api/client';
import type { ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { buildSystemPrompt } from '../prompts/system';
import { getEditorContext } from '../utils/editor';
import { getEnvContext } from '../utils/context';
import type { ExtensionMessage, WebviewMessage } from './messageTypes';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Provider 的注册 ID，必须与 package.json 中 views.id 一致 */
  public static readonly viewType = 'my-ai-plugin.chatView';

  /** 当前活跃的 Webview 实例引用，用于从外部向 Webview 发送消息 */
  private webviewView?: vscode.WebviewView;

  /** 对话历史记录，用于多轮对话上下文 */
  private chatHistory: ChatMessageParam[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    // 设置 HTML 内容
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // 监听来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleWebviewMessage(message),
      undefined,
      [],
    );

    info('聊天面板 Webview 已初始化');
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
        this.clearHistory();
        this.postMessage({ type: 'clearChat' });
        break;

      default:
        error('未知的 Webview 消息类型:', message);
    }
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

    // 构建系统提示词
    const systemPrompt = buildSystemPrompt(envContext, modelConfig);

    // 构建消息列表：系统提示词 + 历史对话 + 当前用户消息
    // 如果用户选中了代码，自动附带到消息中
    const editorCtx = getEditorContext();
    let userContent = text;
    if (editorCtx && editorCtx.selectedCode) {
      userContent += `\n\n## 当前选中的代码\n- 文件：${editorCtx.fileName}\n- 语言：${editorCtx.fileLanguage}\n- 行号：第 ${editorCtx.startLine} 行 ~ 第 ${editorCtx.endLine} 行\n\n\`\`\`${editorCtx.fileLanguage}\n${editorCtx.selectedCode}\n\`\`\``;
    }

    // 添加到对话历史
    this.chatHistory.push({ role: 'user', content: userContent });

    const messages: ChatMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...this.chatHistory,
    ];

    // 构建 API 配置
    const apiConfig: ApiClientConfig = {
      baseUrl: modelConfig.baseUrl,
      apiKey,
      modelId: modelConfig.modelId,
      maxTokens: getMaxTokens(),
      temperature: getTemperature(),
    };

    // 发起流式请求
    const assistantMsgId = `assistant-${Date.now()}`;

    sendStreamRequest(
      apiConfig,
      messages,
      // onChunk：逐字推送到 Webview
      (chunk) => {
        this.postMessage({
          type: 'streamChunk',
          chunk,
          messageId: assistantMsgId,
        });
      },
      // onDone：流式传输完成
      (fullContent) => {
        this.postMessage({
          type: 'streamDone',
          messageId: assistantMsgId,
        });
        // 将 AI 回复加入对话历史
        this.chatHistory.push({ role: 'assistant', content: fullContent });
        info(`AI 回复完成，长度: ${fullContent.length}`);
      },
      // onError：出错处理
      (errorMessage) => {
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
    info('对话历史已清空');
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
    <!-- 消息列表区域 -->
    <div id="messages">
      <div class="welcome-message">
        <p><strong>你好！我是 AI 编程助手</strong></p>
        <p>你可以：</p>
        <ul>
          <li>直接输入问题与我对话</li>
          <li>选中代码后右键使用快捷功能</li>
          <li>使用快捷键 <kbd>Ctrl+Shift+E</kbd> 解释代码</li>
        </ul>
      </div>
    </div>

    <!-- 加载指示器 -->
    <div id="loading" class="hidden">
      <div class="loading-dots">
        <span></span><span></span><span></span>
      </div>
    </div>

    <!-- 输入区域 -->
    <div id="input-area">
      <textarea
        id="user-input"
        placeholder="输入任何问题...（Ctrl+L）"
        rows="2"
      ></textarea>
      <div id="input-toolbar">
        <div class="input-toolbar-left">
          <button id="btn-add-context" class="toolbar-icon-btn" title="添加上下文">+</button>
          <button id="btn-code-mode" class="toolbar-icon-btn" title="代码模式">&lt;&gt; Code</button>
          <span id="model-label" class="model-label">DeepSeek Chat</span>
        </div>
        <div class="input-toolbar-right">
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
