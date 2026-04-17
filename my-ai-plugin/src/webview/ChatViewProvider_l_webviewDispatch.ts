import * as vscode from 'vscode';
import { getAllModels, setActiveModelIndex } from '../config';
import { info } from '../logger';
import type { CommandType } from '../commands/handler';
import type { WebviewMessage, WorkMode } from './messageTypes';

export type LightweightWebviewDispatchOptions = {
  sendModelList: () => void;
  pushTokenCount: () => void;
  applyModeChange: (mode: WorkMode) => void;
  insertCodeToEditor: (code: string) => Promise<boolean>;
  getContextFiles: () => string[];
  setContextFiles: (filePaths: string[]) => void;
  resolveCommandType: (command: string) => CommandType | null;
  handleSlashCommand: (type: CommandType) => Promise<void>;
  onModelSwitch?: (modelName: string) => void;
};

export async function tryHandleLightweightWebviewMessage(
  message: WebviewMessage,
  options: LightweightWebviewDispatchOptions,
): Promise<boolean> {
  switch (message.type) {
    case 'copyCode':
      await vscode.env.clipboard.writeText(message.code);
      vscode.window.showInformationMessage('代码已复制到剪贴板');
      return true;

    case 'insertCode':
      await options.insertCodeToEditor(message.code);
      return true;

    case 'requestModels':
      options.sendModelList();
      return true;

    case 'switchModel': {
      const models = getAllModels();
      const normalizedIndex = Number.isFinite(message.index) ? Math.trunc(message.index) : 0;
      const safeIndex = Math.max(0, Math.min(normalizedIndex, models.length - 1));
      if (safeIndex !== message.index) {
        info(`用户切换模型索引越界，已修正: ${message.index} -> ${safeIndex}`);
      } else {
        info(`用户切换模型到索引: ${safeIndex}`);
      }

      await setActiveModelIndex(safeIndex);
      options.sendModelList();
      options.pushTokenCount();
      if (options.onModelSwitch && models[safeIndex]) {
        options.onModelSwitch(models[safeIndex].name);
      }
      return true;
    }

    case 'switchMode':
      info(`用户切换工作模式: ${message.mode}`);
      options.applyModeChange(message.mode);
      return true;

    case 'removeContextFile': {
      const nextFiles = options.getContextFiles().filter(filePath => filePath !== message.filePath);
      options.setContextFiles(nextFiles);
      info(`移除上下文文件: ${message.filePath}，剩余 ${nextFiles.length} 个`);
      return true;
    }

    case 'addContextFile': {
      const currentFiles = options.getContextFiles();
      if (!currentFiles.includes(message.filePath)) {
        options.setContextFiles([...currentFiles, message.filePath]);
        info(`@ mention 添加上下文文件: ${message.filePath}`);
      }
      return true;
    }

    case 'openSettings':
      await vscode.commands.executeCommand('my-ai-plugin.editModels');
      return true;

    case 'createNativeTab':
      await vscode.commands.executeCommand('my-ai-plugin.newChatTab');
      return true;

    case 'executeCommand': {
      const cmdType = options.resolveCommandType(message.command);
      if (cmdType) {
        info(`Slash 命令执行（走消息流）: ${cmdType}`);
        await options.handleSlashCommand(cmdType);
      } else {
        info(`Slash 命令执行（直接调用）: ${message.command}`);
        await vscode.commands.executeCommand(message.command);
      }
      return true;
    }

    default:
      return false;
  }
}
