/**
 * 单元测试生成 Prompt
 * 
 * 当用户选中函数/类并触发"生成单测"功能时，
 * 构建发送给 AI 的 user message。
 * 会根据文件语言自动推荐测试框架。
 */
import type { EditorContext, PromptPayload } from './types';
import type { EnvContext, ModelConfig } from './types';
import { buildSystemPrompt } from './system';

/**
 * 根据编程语言推荐默认测试框架
 * 用户也可以在聊天中指定其他框架
 */
function getDefaultTestFramework(language: string): string {
  const frameworkMap: Record<string, string> = {
    'typescript': 'Jest',
    'javascript': 'Jest',
    'typescriptreact': 'Jest + React Testing Library',
    'javascriptreact': 'Jest + React Testing Library',
    'python': 'pytest',
    'java': 'JUnit 5',
    'csharp': 'xUnit',
    'go': 'Go 内置 testing 包',
    'rust': 'Rust 内置 #[test]',
    'ruby': 'RSpec',
    'php': 'PHPUnit',
    'swift': 'XCTest',
    'kotlin': 'JUnit 5',
    'dart': 'flutter_test',
    'vue': 'Vitest',
  };
  return frameworkMap[language] ?? 'Jest';
}

/**
 * 构建"生成单测"的完整 Prompt
 * 
 * @param editor 编辑器上下文（选中的函数/类代码）
 * @param env 环境上下文
 * @param model 模型配置
 * @param customFramework 用户指定的测试框架，可选
 * @returns 包含 systemPrompt 和 userMessage 的对象
 */
export function buildTestPrompt(
  editor: EditorContext,
  env: EnvContext,
  model: ModelConfig,
  customFramework = '',
): PromptPayload {
  const systemPrompt = buildSystemPrompt(env, model);

  const framework = customFramework || getDefaultTestFramework(editor.fileLanguage);

  const userMessage = `请为以下代码生成单元测试。

## 测试规则
1. 使用 ${framework} 测试框架
2. 覆盖以下场景：
   - 正常输入的预期行为（happy path）
   - 边界值（空值、零值、极大值、极小值）
   - 异常输入的错误处理（如果代码中有的话）
3. 每个测试用例的描述要清晰说明"测什么"
4. 测试代码应该可以直接运行，不要遗漏 import
5. 使用 AAA 模式组织测试：Arrange（准备）→ Act（执行）→ Assert（断言）
6. 如果被测代码有外部依赖（API 调用、数据库等），使用 mock 隔离

## 代码信息
- 文件：${editor.fileName}
- 语言：${editor.fileLanguage}
- 行号：第 ${editor.startLine} 行 ~ 第 ${editor.endLine} 行

## 待测试代码
\`\`\`${editor.fileLanguage}
${editor.selectedCode}
\`\`\``;

  return { systemPrompt, userMessage };
}
