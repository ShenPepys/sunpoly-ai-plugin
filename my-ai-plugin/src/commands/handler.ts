/**
 * 命令处理器
 * 
 * 将右键菜单和快捷键命令连接到完整的处理链路：
 * 获取编辑器上下文 → 构建 Prompt → 调用 AI API（流式）→ 推送到聊天面板
 */
import * as vscode from 'vscode';
import { info } from '../logger';
import { getModelConfig } from '../config';
import { getEditorContext, getDiagnostics, getCursorContext } from '../utils/editor';
import { getEnvContext } from '../utils/context';
import { buildExplainPrompt } from '../prompts/explain';
import { buildFixPrompt } from '../prompts/fix';
import { buildOptimizePrompt } from '../prompts/optimize';
import { buildCompletePrompt } from '../prompts/complete';
import { buildTestPrompt } from '../prompts/test';
import type { WorkMode } from '../webview/messageTypes';
import type { ChatViewProvider } from '../webview/ChatViewProvider';

/**
 * 命令类型枚举
 * 与 package.json 中注册的命令一一对应
 */
export type CommandType = 'explain' | 'fix' | 'optimize' | 'complete' | 'test';

export type CommandExecutionRequest = {
  displayText: string;
  userMessage: string;
  requestMode: WorkMode;
};

export function buildCommandRequest(type: CommandType): CommandExecutionRequest | null {
  const editorCtx = getEditorContext();
  if (!editorCtx || !editorCtx.selectedCode) {
    vscode.window.showWarningMessage('请先选中代码，再使用此功能');
    return null;
  }

  info(`执行命令: ${type}，文件: ${editorCtx.fileName}`);

  const modelConfig = getModelConfig();
  const envContext = getEnvContext();

  let userMessage: string;
  let commandLabel: string;
  let requestMode: WorkMode;

  switch (type) {
    case 'explain': {
      const result = buildExplainPrompt(editorCtx, envContext, modelConfig);
      userMessage = result.userMessage;
      commandLabel = '解释代码';
      requestMode = 'ask';
      break;
    }
    case 'fix': {
      const diagnostics = getDiagnostics();
      const result = buildFixPrompt(editorCtx, envContext, modelConfig, diagnostics);
      userMessage = result.userMessage;
      commandLabel = '修复代码';
      requestMode = 'code';
      break;
    }
    case 'optimize': {
      const result = buildOptimizePrompt(editorCtx, envContext, modelConfig);
      userMessage = result.userMessage;
      commandLabel = '优化代码';
      requestMode = 'code';
      break;
    }
    case 'complete': {
      const cursorCtx = getCursorContext(30);
      if (!cursorCtx) {
        vscode.window.showWarningMessage('无法获取光标上下文');
        return null;
      }
      const result = buildCompletePrompt(
        envContext, modelConfig,
        editorCtx.fileName, editorCtx.fileLanguage,
        cursorCtx.before, cursorCtx.after, cursorCtx.cursorLine,
      );
      userMessage = result.userMessage;
      commandLabel = '续写代码';
      requestMode = 'code';
      break;
    }
    case 'test': {
      const result = buildTestPrompt(editorCtx, envContext, modelConfig);
      userMessage = result.userMessage;
      commandLabel = '生成单测';
      requestMode = 'code';
      break;
    }
  }

  return {
    displayText: `/${type} — ${commandLabel}\n\n选中代码：\`${editorCtx.fileName}\` 第 ${editorCtx.startLine}~${editorCtx.endLine} 行`,
    userMessage,
    requestMode,
  };
}

/**
 * 执行 AI 命令的统一入口
 * 
 * @param type 命令类型
 * @param chatProvider 聊天面板提供者，用于推送消息到 Webview
 */
export async function executeCommand(
  type: CommandType,
  chatProvider: ChatViewProvider,
): Promise<void> {
  const commandRequest = buildCommandRequest(type);
  if (!commandRequest) {
    return;
  }

  await chatProvider.runCommandRequest(commandRequest);
}
