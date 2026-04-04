/**
 * 上下文构建工具函数
 * 负责收集环境信息、构建发送给 AI 的上下文
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { EnvContext, ModelConfig } from '../prompts/types';

/**
 * 获取当前开发环境上下文
 * 包括工作区路径、操作系统、Git 状态等
 */
export function getEnvContext(): EnvContext {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '未知';

  // 检测是否为 Git 仓库
  let isGitRepo = false;
  if (workspaceFolder !== '未知') {
    const gitDir = path.join(workspaceFolder, '.git');
    isGitRepo = fs.existsSync(gitDir);
  }

  return {
    workspaceFolder,
    isGitRepo,
    platform: process.platform,
    shell: vscode.env.shell,
    osVersion: `${os.type()} ${os.release()}`,
  };
}

/**
 * 从 VS Code 用户设置中读取模型配置
 * 设置项前缀为 myAiPlugin.*
 */
export function getModelConfig(): ModelConfig {
  const config = vscode.workspace.getConfiguration('myAiPlugin');

  const modelId = config.get<string>('modelId', 'deepseek-chat');

  return {
    modelName: config.get<string>('modelName', 'DeepSeek Chat'),
    modelId,
    baseUrl: config.get<string>('baseUrl', 'https://api.deepseek.com'),
    apiKey: config.get<string>('apiKey', ''),
    knowledgeCutoff: getKnowledgeCutoff(modelId),
  };
}

/**
 * 根据模型 ID 返回知识截止日期
 * 新增模型时在此表中添加对应条目即可
 */
function getKnowledgeCutoff(modelId: string): string {
  const cutoffMap: Record<string, string> = {
    'deepseek-chat': '2025年3月',
    'deepseek-coder': '2025年3月',
    'gpt-4o': '2024年10月',
    'gpt-4o-mini': '2024年10月',
    'gpt-4-turbo': '2024年4月',
    'doubao-pro-32k': '2025年1月',
    'doubao-lite-32k': '2025年1月',
  };
  return cutoffMap[modelId] ?? '未知';
}

/**
 * 获取用户偏好语言
 * 默认返回中文
 */
export function getLanguagePreference(): string {
  const config = vscode.workspace.getConfiguration('myAiPlugin');
  return config.get<string>('language', '中文');
}
