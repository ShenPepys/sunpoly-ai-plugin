/**
 * 命令处理器
 * 
 * 将右键菜单和快捷键命令连接到完整的处理链路：
 * 获取编辑器上下文 → 构建 Prompt → 调用 AI API（流式）→ 推送到聊天面板
 */
import * as vscode from 'vscode';
import { info, error } from '../logger';
import { getModelConfig, ensureApiKey, getMaxTokens, getTemperature } from '../config';
import { sendStreamRequest } from '../api/client';
import type { ApiClientConfig } from '../api/client';
import type { ChatMessageParam } from '../api/types';
import { getEditorContext, getDiagnostics, getCursorContext } from '../utils/editor';
import { getEnvContext } from '../utils/context';
import { buildExplainPrompt } from '../prompts/explain';
import { buildFixPrompt } from '../prompts/fix';
import { buildOptimizePrompt } from '../prompts/optimize';
import { buildCompletePrompt } from '../prompts/complete';
import { buildTestPrompt } from '../prompts/test';
import type { ChatViewProvider } from '../webview/ChatViewProvider';

/**
 * 命令类型枚举
 * 与 package.json 中注册的命令一一对应
 */
export type CommandType = 'explain' | 'fix' | 'optimize' | 'complete' | 'test';

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
  // 获取编辑器上下文
  const editorCtx = getEditorContext();
  if (!editorCtx || !editorCtx.selectedCode) {
    vscode.window.showWarningMessage('请先选中代码，再使用此功能');
    return;
  }

  info(`执行命令: ${type}，文件: ${editorCtx.fileName}`);

  // 确保 API Key 已配置
  const apiKey = await ensureApiKey();
  if (!apiKey) {
    return;
  }

  // 获取配置
  const modelConfig = getModelConfig();
  const envContext = getEnvContext();

  // 根据命令类型构建对应的 Prompt
  let systemPrompt: string;
  let userMessage: string;
  let commandLabel: string;

  switch (type) {
    case 'explain': {
      const result = buildExplainPrompt(editorCtx, envContext, modelConfig);
      systemPrompt = result.systemPrompt;
      userMessage = result.userMessage;
      commandLabel = '解释代码';
      break;
    }
    case 'fix': {
      const diagnostics = getDiagnostics();
      const result = buildFixPrompt(editorCtx, envContext, modelConfig, diagnostics);
      systemPrompt = result.systemPrompt;
      userMessage = result.userMessage;
      commandLabel = '修复代码';
      break;
    }
    case 'optimize': {
      const result = buildOptimizePrompt(editorCtx, envContext, modelConfig);
      systemPrompt = result.systemPrompt;
      userMessage = result.userMessage;
      commandLabel = '优化代码';
      break;
    }
    case 'complete': {
      const cursorCtx = getCursorContext(30);
      if (!cursorCtx) {
        vscode.window.showWarningMessage('无法获取光标上下文');
        return;
      }
      const result = buildCompletePrompt(
        envContext, modelConfig,
        editorCtx.fileName, editorCtx.fileLanguage,
        cursorCtx.before, cursorCtx.after, cursorCtx.cursorLine,
      );
      systemPrompt = result.systemPrompt;
      userMessage = result.userMessage;
      commandLabel = '续写代码';
      break;
    }
    case 'test': {
      const result = buildTestPrompt(editorCtx, envContext, modelConfig);
      systemPrompt = result.systemPrompt;
      userMessage = result.userMessage;
      commandLabel = '生成单测';
      break;
    }
  }

  // 打开聊天面板并显示用户指令
  chatProvider.reveal();

  const userMsgId = `user-${Date.now()}`;
  chatProvider.postMessage({
    type: 'addMessage',
    role: 'user',
    content: `**/${type}** — ${commandLabel}\n\n选中代码：\`${editorCtx.fileName}\` 第 ${editorCtx.startLine}~${editorCtx.endLine} 行`,
    messageId: userMsgId,
  });

  chatProvider.postMessage({ type: 'setLoading', loading: true });

  // 构建 API 配置
  const apiConfig: ApiClientConfig = {
    baseUrl: modelConfig.baseUrl,
    apiKey,
    modelId: modelConfig.modelId,
    maxTokens: getMaxTokens(),
    temperature: getTemperature(),
  };

  // 构建消息列表（命令模式不带历史对话，每次独立执行）
  const messages: ChatMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  // 发起流式请求
  const assistantMsgId = `assistant-${Date.now()}`;

  sendStreamRequest(
    apiConfig,
    messages,
    (chunk) => {
      chatProvider.postMessage({
        type: 'streamChunk',
        chunk,
        messageId: assistantMsgId,
      });
    },
    (fullContent) => {
      chatProvider.postMessage({
        type: 'streamDone',
        messageId: assistantMsgId,
      });
      info(`命令 ${type} 执行完成，回复长度: ${fullContent.length}`);
    },
    (errorMessage) => {
      chatProvider.postMessage({ type: 'setLoading', loading: false });
      chatProvider.postMessage({
        type: 'showError',
        message: errorMessage,
      });
      error(`命令 ${type} 执行失败:`, errorMessage);
    },
  );
}
