/**
 * Prompt 模块统一导出入口
 * 
 * 所有 Prompt 构建函数和类型从这里统一导出，
 * 其他模块只需 import from './prompts' 即可。
 */

// 类型导出
export type {
  EditorContext,
  EnvContext,
  ModelConfig,
  ChatMessage,
  PromptPayload,
} from './types';

// 系统提示词
export { buildSystemPrompt } from './system';

// 各功能 Prompt
export { buildExplainPrompt } from './explain';
export { buildFixPrompt } from './fix';
export { buildOptimizePrompt } from './optimize';
export { buildCompletePrompt } from './complete';
export { buildTestPrompt } from './test';
export { buildChatPrompt } from './chat';
