/**
 * Bug 修复 Prompt
 * 
 * 当用户选中代码并触发"修复代码"功能时，
 * 构建发送给 AI 的 user message。
 * 会自动附带 VS Code 诊断信息（如果有）。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 构建"修复代码"的完整 Prompt
 * 
 * @param editor 编辑器上下文（选中代码、文件名、语言等）
 * @param env 环境上下文
 * @param model 模型配置
 * @param diagnostics VS Code 诊断信息（错误/警告），可选
 * @param userDescription 用户额外描述的问题，可选
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildFixPrompt(
  editor: EditorContext,
  env: EnvContext,
  model: ModelConfig,
  diagnostics = '',
  userDescription = '',
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  // 拼接诊断信息段落（如果有）
  const diagnosticsSection = diagnostics
    ? `\n## IDE 诊断信息\n以下是 VS Code 检测到的错误和警告：\n\`\`\`\n${diagnostics}\n\`\`\``
    : '';

  // 拼接用户描述（如果有）
  const descriptionSection = userDescription
    ? `\n## 用户描述\n${userDescription}`
    : '';

  const userMessage = `请分析以下代码中的问题并提供修复方案。

## 修复规则
1. 先诊断根本原因，不要只处理表象
2. 修复应该是最小化的——只改必须改的地方，不要趁机重构或"改进"
3. 给出修复后的完整代码，用代码块包裹
4. 简要说明问题的原因和修复思路
5. 如果有多种修复方案，推荐最简单直接的那个

## 代码信息
- 文件：${editor.fileName}
- 语言：${editor.fileLanguage}
- 行号：第 ${editor.startLine} 行 ~ 第 ${editor.endLine} 行
${diagnosticsSection}${descriptionSection}

## 待修复代码
\`\`\`${editor.fileLanguage}
${editor.selectedCode}
\`\`\``;

  return { systemPrompt, userMessage };
}
