/**
 * Prompt 模块的公共类型定义
 * 所有 Prompt 构建函数共享的接口和类型
 */

/** 编辑器上下文：描述用户当前在编辑器中的状态 */
export interface EditorContext {
  /** 用户选中的代码文本，未选中时为空字符串 */
  selectedCode: string;
  /** 当前文件的完整路径，如 d:\project\src\index.ts */
  filePath: string;
  /** 当前文件名，如 index.ts */
  fileName: string;
  /** 当前文件的编程语言标识，如 typescript、python */
  fileLanguage: string;
  /** 选中代码的起始行号（1-indexed） */
  startLine: number;
  /** 选中代码的结束行号（1-indexed） */
  endLine: number;
}

/** 环境上下文：描述用户的开发环境 */
export interface EnvContext {
  /** 工作区根目录路径 */
  workspaceFolder: string;
  /** 是否为 Git 仓库 */
  isGitRepo: boolean;
  /** 操作系统平台：win32 / darwin / linux */
  platform: string;
  /** Shell 路径 */
  shell: string;
  /** 操作系统版本 */
  osVersion: string;
}

/** 模型配置：用户选择的 AI 模型信息 */
export interface ModelConfig {
  /** 模型显示名称，如 DeepSeek Chat */
  modelName: string;
  /** 模型 API 标识，如 deepseek-chat */
  modelId: string;
  /** API 端点地址 */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 知识截止日期 */
  knowledgeCutoff: string;
}

/** 发送给 AI API 的消息格式（OpenAI 兼容） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Prompt 构建结果：包含系统提示词和用户消息 */
export interface PromptPayload {
  /** 系统提示词 */
  systemPrompt: string;
  /** 用户消息（包含代码和指令） */
  userMessage: string;
}
