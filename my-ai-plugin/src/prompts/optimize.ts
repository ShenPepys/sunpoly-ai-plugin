/**
 * 代码优化 Prompt
 * 
 * 当用户选中代码并触发"优化代码"功能时，
 * 构建发送给 AI 的 user message。
 * 借鉴 Claude Code /simplify 技能的三维审查思路。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 构建"优化代码"的完整 Prompt
 * 
 * @param editor 编辑器上下文
 * @param env 环境上下文
 * @param model 模型配置
 * @param focusArea 用户指定的优化关注点，可选（如"性能"、"可读性"）
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildOptimizePrompt(
  editor: EditorContext,
  env: EnvContext,
  model: ModelConfig,
  focusArea = '',
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  // 如果用户指定了关注点，额外添加提示
  const focusSection = focusArea
    ? `\n## 用户指定的优化方向\n重点关注：${focusArea}\n`
    : '';

  const userMessage = `请从以下三个维度审查代码，并给出优化建议。
${focusSection}
## 审查维度

### 1. 代码复用
- 是否有可以用现有工具函数或库函数替代的手写逻辑
- 是否有重复代码可以抽取为共用函数
- 是否有标准库已经提供的功能被重新实现了

### 2. 代码质量
- 命名是否清晰表达意图
- 是否有冗余的状态或不必要的中间变量
- 是否有过深的嵌套可以通过提前返回简化
- 是否有可以用更清晰的写法替代的复杂表达式

### 3. 性能效率
- 是否有不必要的重复计算或重复 I/O
- 是否有可以并行执行的独立操作被顺序执行了
- 是否有内存泄漏或无界数据增长的风险

## 输出格式
1. 先列出发现的问题（按优先级从高到低）
2. 对每个问题给出优化后的代码
3. 如果代码已经足够好，直接说"代码质量良好，无需优化"

## 代码信息
- 文件：${editor.fileName}
- 语言：${editor.fileLanguage}
- 行号：第 ${editor.startLine} 行 ~ 第 ${editor.endLine} 行

## 待优化代码
\`\`\`${editor.fileLanguage}
${editor.selectedCode}
\`\`\``;

  return { systemPrompt, userMessage };
}
