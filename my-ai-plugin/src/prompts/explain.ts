/**
 * 代码解释 Prompt
 * 
 * 当用户选中代码并触发"解释代码"功能时，
 * 构建发送给 AI 的 user message。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 构建"解释代码"的完整 Prompt
 * 
 * @param editor 编辑器上下文（选中代码、文件名、语言等）
 * @param env 环境上下文
 * @param model 模型配置
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildExplainPrompt(
  editor: EditorContext,
  env: EnvContext,
  model: ModelConfig,
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  const userMessage = `请解释以下代码的功能和逻辑。

## 要求
1. 先用一两句话概括这段代码的整体作用
2. 逐步解释关键逻辑，说明"为什么这样做"而不只是"做了什么"
3. 如果有复杂的算法或设计模式，简要说明其原理
4. 如果有潜在的问题或值得注意的地方，顺带指出
5. 使用通俗易懂的语言，避免过于学术化的表述

## 代码信息
- 文件：${editor.fileName}
- 语言：${editor.fileLanguage}
- 行号：第 ${editor.startLine} 行 ~ 第 ${editor.endLine} 行

## 代码内容
\`\`\`${editor.fileLanguage}
${editor.selectedCode}
\`\`\``;

  return { systemPrompt, userMessage };
}
