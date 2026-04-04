/**
 * 插件入口文件
 * 负责插件的激活、命令注册和生命周期管理
 */
import * as vscode from 'vscode';
import { initLogger, disposeLogger, info } from './logger';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { executeCommand } from './commands/handler';
import type { CommandType } from './commands/handler';

/**
 * 插件激活时调用
 * VS Code 在用户首次触发插件命令或侧边栏可见时自动调用此函数
 */
export function activate(context: vscode.ExtensionContext): void {
  // 初始化日志
  initLogger();
  info('AI 编程助手插件已激活');

  // 注册 Webview 聊天面板
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
  );
  info('聊天面板已注册');

  // 批量注册 AI 功能命令（选中代码 → Prompt → API → 流式回复）
  const commandTypes: CommandType[] = ['explain', 'fix', 'optimize', 'complete', 'test'];
  for (const type of commandTypes) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`my-ai-plugin.${type}`, () => {
        executeCommand(type, chatProvider);
      })
    );
  }

  // 注册命令：清空对话
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.clearChat', () => {
      info('用户触发：清空对话');
      chatProvider.clearHistory();
      chatProvider.postMessage({ type: 'clearChat' });
    })
  );

  info('所有命令注册完成');
}

/**
 * 插件停用时调用
 * 负责清理资源
 */
export function deactivate(): void {
  info('AI 编程助手插件已停用');
  disposeLogger();
}
