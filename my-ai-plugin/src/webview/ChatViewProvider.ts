/**
 * Webview 聊天面板提供者（薄壳）
 *
 * 实现 VS Code 的 WebviewViewProvider 接口和 IChatHost 接口，
 * 所有聊天业务逻辑委托给内部的 ChatEngine 实例。
 * 本文件只负责：
 *   1. VS Code 侧边栏生命周期管理（resolveWebviewView）
 *   2. IChatHost 适配（postMessage、reveal 等）
 *   3. 对外暴露公开 API 供 extension.ts / handler.ts 调用
 */
import * as vscode from 'vscode';
import { info } from '../logger';
import type { CommandExecutionRequest } from '../commands/handler';
import type { ExtensionMessage, WebviewMessage, WorkMode } from './messageTypes';
import type { IChatHost } from './IChatHost';
import { ChatEngine } from './ChatEngine';
import { SessionStore } from './SessionStore';

export class ChatViewProvider implements vscode.WebviewViewProvider, IChatHost {
  /** Provider 的注册 ID，必须与 package.json 中 views.id 一致 */
  public static readonly viewType = 'my-ai-plugin.chatView';

  /** 当前活跃的 Webview 实例引用 */
  private webviewView?: vscode.WebviewView;

  /** 插件根目录 URI */
  private readonly extensionUri: vscode.Uri;

  /** VS Code 扩展上下文 */
  private readonly context: vscode.ExtensionContext;

  /** 聊天引擎，持有所有业务状态和方法 */
  private readonly engine: ChatEngine;

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    // 廈代路径：侧边栏已移除，此处仅保留编译兼容
    const store = new SessionStore(context.globalState);
    this.engine = new ChatEngine(this, store);

    // 将 onModelSwitch 桥接到引擎
    // 引擎内部设置回调时会通过此代理触发外部回调
    Object.defineProperty(this.engine, 'onModelSwitch', {
      get: () => this.onModelSwitch,
      set: (fn: ((modelName: string) => void) | undefined) => {
        this.onModelSwitch = fn;
      },
    });
  }

  // ==================== IChatHost 实现 ====================

  /** 向前端 Webview 发送消息 */
  public postMessage(message: ExtensionMessage): void {
    if (this.webviewView) {
      this.webviewView.webview.postMessage(message);
    }
  }

  /** 获取当前 Webview 实例 */
  public getWebview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  /** 获取插件根目录 URI */
  public getExtensionUri(): vscode.Uri {
    return this.extensionUri;
  }

  /** 获取 globalState 持久化存储 */
  public getGlobalState(): vscode.Memento {
    return this.context.globalState;
  }

  /** 使侧边栏面板可见 */
  public reveal(): void {
    if (this.webviewView) {
      this.webviewView.show(true);
    }
  }

  // ==================== WebviewViewProvider 生命周期 ====================

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
        this.engine.sendModelList();
      }
    });

    // 设置 HTML 内容（由引擎构建）
    webviewView.webview.html = this.engine.buildHtml();

    // 监听来自 Webview 的消息，委托给引擎处理
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.engine.handleWebviewMessage(message),
      undefined,
      [],
    );

    info('聊天面板 Webview 已初始化');

    // 初始化完成后推送初始状态到前端
    this.engine.initializeWebviewState();
  }

  // ==================== 对外公开 API ====================

  /** 执行命令请求（供 extension.ts 命令处理器调用） */
  public async runCommandRequest(commandRequest: CommandExecutionRequest): Promise<void> {
    await vscode.commands.executeCommand('my-ai-plugin.chatView.focus');
    await this.engine.runCommandRequest(commandRequest);
  }

  /** 清空当前会话（供 extension.ts 清空命令调用） */
  public clearCurrentSession(): void {
    this.engine.clearCurrentSession();
  }

  /** 获取当前工作模式（供 extension.ts 快捷键使用） */
  public getMode(): WorkMode {
    return this.engine.getMode();
  }

  /** 切换工作模式（供 extension.ts 快捷键使用） */
  public switchMode(mode: WorkMode): void {
    this.engine.switchMode(mode);
  }

  /** 打开会话启动器（供 extension.ts 新建对话命令使用） */
  public openSessionLauncher(): void {
    this.engine.openSessionLauncher();
  }
}
