/**
 * 插件入口文件
 * 负责插件的激活、命令注册和生命周期管理
 */
import * as vscode from 'vscode';
import { initLogger, disposeLogger, info } from './logger';
import { setExtensionPath, getAllModels, getActiveModelIndex, getPanelTitle } from './config';
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

  // 设置插件根目录路径，用于查找 .env 文件
  setExtensionPath(context.extensionUri.fsPath);
  info(`插件路径: ${context.extensionUri.fsPath}`);

  // 注册 Webview 聊天面板
  const chatProvider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
  );
  info('聊天面板已注册');

  // 启动时校验 API 配置：缺少 API Key 时提示用户
  const startupModels = getAllModels();
  const startupActiveIdx = getActiveModelIndex();
  const activeModel = startupModels[startupActiveIdx];
  if (activeModel && !activeModel.apiKey) {
    vscode.window.showWarningMessage(
      `AI 编程助手：当前模型 "${activeModel.name}" 未配置 API Key，请在设置中配置。`,
      '打开设置'
    ).then(choice => {
      if (choice === '打开设置') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'myAiPlugin.models');
      }
    });
  }

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

  // 状态栏模型指示器：显示当前 AI 模型名称
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'my-ai-plugin.focusChat';
  statusBarItem.tooltip = '点击聚焦 AI 聊天';
  const models = getAllModels();
  const activeIdx = getActiveModelIndex();
  statusBarItem.text = `$(hubot) ${models[activeIdx]?.name || 'AI'}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 模型切换时同步更新状态栏
  chatProvider.onModelSwitch = (modelName: string) => {
    statusBarItem.text = `$(hubot) ${modelName}`;
  };

  // 监听配置变更，更新状态栏模型名称
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('myAiPlugin')) {
        const m = getAllModels();
        const idx = getActiveModelIndex();
        statusBarItem.text = `$(hubot) ${m[idx]?.name || 'AI'}`;
        // 面板标题跟随配置动态更新
        chatProvider.updatePanelTitle(getPanelTitle());
      }
    })
  );

  // 注册命令：Ctrl+L 聚焦聊天输入框
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.focusChat', async () => {
      // 先显示侧边栏（如果隐藏了会自动展开）
      await vscode.commands.executeCommand('my-ai-plugin.chatView.focus');
      // 通知 Webview 聚焦输入框
      chatProvider.postMessage({ type: 'focusInput' } as any);
      info('用户触发：聚焦聊天输入框');
    })
  );

  // 注册命令：Ctrl+Shift+N 新建对话
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.newChat', async () => {
      chatProvider.clearHistory();
      chatProvider.postMessage({ type: 'clearChat' } as any);
      await vscode.commands.executeCommand('my-ai-plugin.chatView.focus');
      chatProvider.postMessage({ type: 'focusInput' } as any);
      info('用户触发：新建对话');
    })
  );

  // 注册命令：Ctrl+. 切换工作模式（code → ask → plan 循环）
  const modeOrder: Array<'code' | 'ask' | 'plan'> = ['code', 'ask', 'plan'];
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.switchMode', () => {
      const currentMode = chatProvider.getMode();
      const currentIndex = modeOrder.indexOf(currentMode);
      const nextMode = modeOrder[(currentIndex + 1) % modeOrder.length];
      chatProvider.switchMode(nextMode);
      info(`用户快捷键切换模式: ${currentMode} → ${nextMode}`);
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
