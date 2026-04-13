/**
 * 编辑器 Tab 聊天面板
 *
 * 在 VS Code 编辑器右侧区域（ViewColumn.Two）打开聊天 Tab，
 * 实现 IChatHost 接口，内部持有独立的 ChatEngine 实例。
 * 作为插件的主交互入口，类似 Windsurf Cascade 的右侧面板。
 */
import * as vscode from 'vscode';
import { info } from '../logger';
import type { CommandExecutionRequest } from '../commands/handler';
import type { ExtensionMessage, WebviewMessage, WorkMode } from './messageTypes';
import type { IChatHost } from './IChatHost';
import { ChatEngine } from './ChatEngine';
import type { SessionStore } from './SessionStore';

export class ChatTabPanel implements IChatHost {

  /** 唯一标识，用于 ChatTabManager 管理 */
  public readonly tabId: string;

  /** VS Code 编辑器面板实例 */
  private readonly panel: vscode.WebviewPanel;

  /** 聊天引擎，持有该 Tab 独立的业务状态 */
  private readonly engine: ChatEngine;

  /** 插件根目录 URI */
  private readonly extensionUri: vscode.Uri;

  /** globalState 持久化存储引用 */
  private readonly globalState: vscode.Memento;

  /** Tab 关闭时触发的回调，由 ChatTabManager 设置 */
  public onDispose?: () => void;

  /** 模型切换回调，外部设置后在切换模型时触发 */
  public onModelSwitch?: (modelName: string) => void;

  constructor(context: vscode.ExtensionContext, store: SessionStore, options?: { forceSessionLauncher?: boolean }) {
    this.tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.extensionUri = context.extensionUri;
    this.globalState = context.globalState;

    // 创建 WebviewPanel
    this.panel = vscode.window.createWebviewPanel(
      'my-ai-plugin.chatTab',
      'AI 聊天',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'media'),
        ],
      },
    );

    // 设置 Tab 图标（复用侧边栏图标）
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');

    // 创建引擎实例（共享同一个 SessionStore）
    this.engine = new ChatEngine(this, store, options);

    // 桥接 onModelSwitch 到引擎
    Object.defineProperty(this.engine, 'onModelSwitch', {
      get: () => this.onModelSwitch,
      set: (fn: ((modelName: string) => void) | undefined) => {
        this.onModelSwitch = fn;
      },
    });

    // 设置 HTML
    this.panel.webview.html = this.engine.buildHtml();

    // 监听前端消息
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.engine.handleWebviewMessage(message),
    );

    // 监听 Tab 关闭，清理资源
    this.panel.onDidDispose(() => {
      info(`聊天 Tab 已关闭: ${this.tabId}`);
      this.onDispose?.();
    });

    info(`聊天 Tab 已创建: ${this.tabId}`);

    // 初始化前端状态
    this.engine.initializeWebviewState();
  }

  // ==================== IChatHost 实现 ====================

  public postMessage(message: ExtensionMessage): void {
    this.panel.webview.postMessage(message);
  }

  public getWebview(): vscode.Webview | undefined {
    return this.panel.webview;
  }

  public getExtensionUri(): vscode.Uri {
    return this.extensionUri;
  }

  public getGlobalState(): vscode.Memento {
    return this.globalState;
  }

  public reveal(): void {
    this.panel.reveal(undefined, true);
  }

  // ==================== Tab 状态查询 ====================

  /** 当前 Tab 是否处于活跃/可见状态 */
  public get isActive(): boolean {
    return this.panel.active;
  }

  /** 当前 Tab 是否可见 */
  public get isVisible(): boolean {
    return this.panel.visible;
  }

  /** 监听 Tab 可见状态变化 */
  public onDidChangeViewState(listener: (active: boolean) => void): vscode.Disposable {
    return this.panel.onDidChangeViewState(e => {
      listener(e.webviewPanel.active);
    });
  }

  /** 更新 Tab 标题 */
  public setTitle(title: string): void {
    this.panel.title = title;
  }

  // ==================== 对外公开 API（与 ChatViewProvider 对齐） ====================

  /** 执行命令请求（供 extension.ts 命令处理器调用） */
  public async runCommandRequest(commandRequest: CommandExecutionRequest): Promise<void> {
    this.panel.reveal(undefined, true);
    await this.engine.runCommandRequest(commandRequest);
  }

  /** 清空当前会话 */
  public clearCurrentSession(): void {
    this.engine.clearCurrentSession();
  }

  /** 获取当前工作模式 */
  public getMode(): WorkMode {
    return this.engine.getMode();
  }

  /** 切换工作模式 */
  public switchMode(mode: WorkMode): void {
    this.engine.switchMode(mode);
  }

  /** 打开会话启动器（新建对话入口） */
  public openSessionLauncher(): void {
    this.engine.openSessionLauncher();
  }

  /** 获取当前活跃模型名称（用于状态栏同步） */
  public getActiveModelName(): string {
    return this.engine.getActiveModelName();
  }

  /** 关闭此 Tab */
  public dispose(): void {
    this.panel.dispose();
  }
}
