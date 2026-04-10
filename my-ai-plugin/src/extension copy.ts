/**
 * 插件入口文件
 * 负责插件的激活、命令注册和生命周期管理
 */
import * as vscode from 'vscode';
import { initLogger, disposeLogger, info } from './logger';
import { setExtensionPath, getAllModels, getActiveModelIndex } from './config';
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
  info('AI 助理插件已激活');

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
      `AI 助理：当前模型 "${activeModel.name}" 未配置 API Key，请在设置中配置。`,
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
      chatProvider.clearCurrentSession();
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
      await vscode.commands.executeCommand('my-ai-plugin.chatView.focus');
      chatProvider.openSessionLauncher();
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

  // 注册命令：Ctrl+Shift+P 搜索 "AI: 打开设置"
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'myAiPlugin');
      info('用户触发：打开插件设置');
    })
  );

  // 注册命令：Ctrl+Shift+P 搜索 "AI: 编辑模型配置 (JSON)"
  context.subscriptions.push(
    vscode.commands.registerCommand('my-ai-plugin.editModels', async () => {
      const config = vscode.workspace.getConfiguration('myAiPlugin');
      const currentModels = config.get<Array<{ name: string; modelId: string; baseUrl: string; apiKey: string }>>('models', []);
      const hasValidKey = currentModels.some(m => m.apiKey && m.apiKey !== '' && !m.apiKey.startsWith('填写'));

      // 如果没有有效的模型配置，自动写入模板方便用户填写
      if (!hasValidKey) {
        const templateModels = [
          {
            name: '填写模型显示名称，如 DeepSeek Chat、GPT-4o、豆包',
            modelId: '填写模型 ID，如 deepseek-chat、gpt-4o、doubao-pro-32k',
            baseUrl: '填写 API 地址，如 https://api.deepseek.com',
            apiKey: '填写你的 API Key',
          },
        ];
        await config.update('models', templateModels, vscode.ConfigurationTarget.Global);
        info('已写入模型配置模板到 settings.json');
      }

      // 打开用户级 settings.json
      await vscode.commands.executeCommand('workbench.action.openSettingsJson');

      // 提示用户找到并修改 apiKey
      if (!hasValidKey) {
        vscode.window.showInformationMessage(
          '已在 settings.json 中插入模型配置模板，请搜索 "myAiPlugin.models"，将 name、modelId、baseUrl、apiKey 四项全部替换为你的真实配置。'
        );
      }

      info('用户触发：编辑模型配置 JSON');
    })
  );

  info('所有命令注册完成');
}

/**
 * 插件停用时调用
 * 负责清理资源
 */
export function deactivate(): void {
  info('AI 助理插件已停用');
  disposeLogger();
}
