/**
 * 代码续写 Prompt
 * 
 * 当用户在光标位置触发"续写代码"功能时，
 * 获取光标前后的上下文，让 AI 生成后续代码。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 构建"续写代码"的完整 Prompt
 * 
 * @param env 环境上下文
 * @param model 模型配置
 * @param fileName 当前文件名
 * @param fileLanguage 当前文件语言
 * @param codeBefore 光标前的代码
 * @param codeAfter 光标后的代码
 * @param cursorLine 光标所在行号
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildCompletePrompt(
  env: EnvContext,
  model: ModelConfig,
  fileName: string,
  fileLanguage: string,
  codeBefore: string,
  codeAfter: string,
  cursorLine: number,
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  // 光标后的代码可能为空（在文件末尾续写）
  const afterSection = codeAfter.trim()
    ? `\n## 光标之后的代码（供参考上下文）\n\`\`\`${fileLanguage}\n${codeAfter}\n\`\`\``
    : '';

  const userMessage = `请根据上下文续写代码。

## 续写规则
1. 只输出需要新增的代码，不要重复已有的代码
2. 续写的代码要与上下文风格保持一致（缩进、命名、注释风格）
3. 续写内容应该是逻辑上的自然延续，不要跳跃
4. 用代码块包裹输出，标注语言类型
5. 不需要额外解释，直接给出代码

## 代码信息
- 文件：${fileName}
- 语言：${fileLanguage}
- 光标位置：第 ${cursorLine} 行

## 光标之前的代码
\`\`\`${fileLanguage}
${codeBefore}
\`\`\`
${afterSection}

请从光标位置开始续写：`;

  return { systemPrompt, userMessage };
}
