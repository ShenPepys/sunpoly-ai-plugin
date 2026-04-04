/**
 * 通用聊天 Prompt
 * 
 * 当用户在聊天面板直接输入问题（不使用快捷指令）时使用。
 * 如果用户在编辑器中选中了代码，会自动附带代码上下文。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 构建通用聊天的完整 Prompt
 * 
 * @param userInput 用户在聊天面板中输入的文本
 * @param env 环境上下文
 * @param model 模型配置
 * @param editor 编辑器上下文，可选（如果用户选中了代码则传入）
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildChatPrompt(
  userInput: string,
  env: EnvContext,
  model: ModelConfig,
  editor?: EditorContext | null,
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  // 如果用户选中了代码，自动附带到消息中
  let codeSection = '';
  if (editor && editor.selectedCode) {
    codeSection = `

## 当前选中的代码
- 文件：${editor.fileName}
- 语言：${editor.fileLanguage}
- 行号：第 ${editor.startLine} 行 ~ 第 ${editor.endLine} 行

\`\`\`${editor.fileLanguage}
${editor.selectedCode}
\`\`\`
`;
  }

  const userMessage = `${userInput}${codeSection}`;

  return { systemPrompt, userMessage };
}
