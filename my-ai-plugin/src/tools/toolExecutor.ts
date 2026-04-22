/**
 * 工具执行器
 * 
 * 接收解析后的工具调用，执行实际的文件操作，
 * 并返回执行结果，供 ChatViewProvider 将结果反馈给 AI。
 */
import * as fs from 'fs';
import { info, error } from '../logger';
import { readFile, writeFile, editFile, listDir } from './fileOps';
import { routeAstEdit } from './astRouter';
import { isToolReadOnly, getToolLabel } from './toolDefs';
import type { AstEditRequest } from './astEditorTypes';
import type { ParsedToolCall } from './toolParser';
import type { FileOpResult, AstAffectedFile } from './fileOps';
import type { WorkMode } from '../webview/messageTypes';

/** 单个工具调用的执行结果 */
export interface ToolExecutionResult {
  /** 工具调用信息 */
  toolCall: ParsedToolCall;
  /** 执行结果 */
  result: FileOpResult;
}

/**
 * 判断工具调用是否为只读操作（无副作用，可并行）
 * 委托到 toolDefs 统一注册表
 */
function isReadOnlyToolCall(toolCall: ParsedToolCall): boolean {
  return isToolReadOnly(toolCall.type);
}

/**
 * 批量执行工具调用
 * 策略：连续的只读操作（read_file/list_dir）并行执行，写操作串行执行
 * 按原始顺序返回结果，保证结果与输入一一对应
 * 
 * @param toolCalls 解析后的工具调用数组
 * @param mode 当前工作模式，用于权限控制
 * @returns 所有工具调用的执行结果
 */
export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  mode: WorkMode,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = new Array(toolCalls.length);

  // 将工具调用按"连续只读批次"和"单个写操作"分组，保留原始索引
  let i = 0;
  while (i < toolCalls.length) {
    // 收集连续的只读操作，组成一个可并行的批次
    const readBatchIndices: number[] = [];
    while (i < toolCalls.length && isReadOnlyToolCall(toolCalls[i])) {
      readBatchIndices.push(i);
      i++;
    }

    // 并行执行这批只读操作
    if (readBatchIndices.length > 0) {
      const readPromises = readBatchIndices.map(async (idx) => {
        const result = await executeSingleToolCall(toolCalls[idx], mode);
        return { idx, result };
      });
      const readResults = await Promise.all(readPromises);
      for (const { idx, result } of readResults) {
        results[idx] = { toolCall: toolCalls[idx], result };
      }
      info(`并行执行 ${readBatchIndices.length} 个只读工具调用`);
    }

    // 串行执行下一个写操作（如果有的话）
    if (i < toolCalls.length && !isReadOnlyToolCall(toolCalls[i])) {
      const result = await executeSingleToolCall(toolCalls[i], mode);
      results[i] = { toolCall: toolCalls[i], result };
      i++;
    }
  }

  return results;
}

/**
 * 执行单个工具调用
 * 根据工具类型分派到对应的文件操作函数
 */
async function executeSingleToolCall(
  toolCall: ParsedToolCall,
  mode: WorkMode,
): Promise<FileOpResult> {
  // 权限控制：Ask 和 Plan 模式下禁止写操作
  const isWriteOp = toolCall.type === 'write_file' || toolCall.type === 'edit_file' || toolCall.type === 'ast_edit';
  if (isWriteOp && mode !== 'code') {
    const modeName = mode === 'ask' ? 'Ask' : 'Plan';
    return {
      success: false,
      content: `当前处于 ${modeName} 模式，不允许修改文件。请切换到 Code 模式后重试。`,
    };
  }

  info(`执行工具调用: ${toolCall.type} → ${toolCall.path}`);

  switch (toolCall.type) {
    case 'read_file':
      return readFile(toolCall.path);

    case 'write_file':
      if (!toolCall.content && toolCall.content !== '') {
        return { success: false, content: '写入内容为空' };
      }
      return writeFile(toolCall.path, toolCall.content);

    case 'edit_file':
      if (!toolCall.oldContent || toolCall.newContent === undefined) {
        return { success: false, content: '编辑操作缺少 old 或 new 内容' };
      }
      return editFile(toolCall.path, toolCall.oldContent, toolCall.newContent, {
        replaceAll: toolCall.replaceAll,
      });

    case 'list_dir':
      return listDir(toolCall.path);

    case 'ast_edit':
      return executeAstEdit(toolCall);

    default:
      error(`未知的工具类型: ${toolCall.type}`);
      return { success: false, content: `未知的工具类型: ${toolCall.type}` };
  }
}

/**
 * 将工具执行结果格式化为 AI 可理解的反馈文本
 * 用于追加到对话中，让 AI 知道操作结果
 */
export function formatToolResults(results: ToolExecutionResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const lines = results.map(({ toolCall, result }) => {
    const status = result.success ? '✅ 成功' : '❌ 失败';
    const typeLabel = getToolLabel(toolCall.type);
    const safeContent = formatToolResultContent(toolCall, result.content);
    return `### ${typeLabel} ${toolCall.path}\n**${status}**\n\`\`\`\n${safeContent}\n\`\`\``;
  });

  return lines.join('\n\n');
}

function formatToolResultContent(toolCall: ParsedToolCall, content: string): string {
  const maxChars = toolCall.type === 'read_file'
    ? 6000
    : toolCall.type === 'list_dir'
      ? 4000
      : 2000;

  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...(工具结果已截断，原始长度 ${content.length} 字符)`;
}

/**
 * 执行 AST 编辑工具调用。
 * 将 ParsedToolCall 中的 astAction/astParams 转换为 AstEditRequest，
 * 通过语言路由层分派到对应适配器。
 * 如果没有适配器支持该文件类型，返回失败提示。
 */
async function executeAstEdit(toolCall: ParsedToolCall): Promise<FileOpResult> {
  if (!toolCall.astAction) {
    return { success: false, content: 'ast_edit 缺少 action 字段' };
  }
  if (!toolCall.astParams) {
    return { success: false, content: 'ast_edit 缺少参数' };
  }

  // 构造 AstEditRequest，这里 workspaceRoot 用空字符串占位，
  // 上层 ChatViewProvider 会在执行前填充真实的工作区路径
  const request: AstEditRequest = {
    workspaceRoot: '',
    filePath: toolCall.path,
    action: toolCall.astAction,
    params: toolCall.astParams,
  } as AstEditRequest;

  // 读取文件当前内容
  const readResult = await readFile(toolCall.path);
  if (!readResult.success) {
    return readResult;
  }

  const routeResult = await routeAstEdit(request, readResult.content);

  // 无适配器支持该文件类型
  if ('supported' in routeResult) {
    return {
      success: false,
      content: `文件 ${toolCall.path} 的语言类型暂无 AST 适配器支持，请改用 edit_file 工具`,
    };
  }

  // 此处 routeResult 已被缩窄为 AstEditResult
  const editResult = routeResult;

  // AST 操作失败
  if (!editResult.success) {
    return { success: false, content: editResult.reason };
  }

  // 写入前先读取所有受影响文件的原始内容，用于上层备份和 diff
  const astAffectedFiles: AstAffectedFile[] = editResult.files.map((file) => {
    let originalContent = '';
    try {
      originalContent = fs.readFileSync(file.filePath, 'utf-8');
    } catch {
      // 文件可能不存在（新建场景），原始内容为空
    }
    return { filePath: file.filePath, originalContent, newContent: file.newContent };
  });

  // 将修改后的内容写回磁盘
  const writeErrors: string[] = [];
  for (const file of editResult.files) {
    const writeResult = await writeFile(file.filePath, file.newContent);
    if (!writeResult.success) {
      writeErrors.push(`${file.filePath}: ${writeResult.content}`);
    }
  }

  if (writeErrors.length > 0) {
    return {
      success: false,
      content: `AST 编辑成功但写入文件失败：\n${writeErrors.join('\n')}`,
    };
  }

  const filesSummary = editResult.files
    .map((f) => `${f.filePath}（${f.newContent.length} 字符）`)
    .join('\n');
  return {
    success: true,
    content: `AST 编辑成功，影响 ${editResult.files.length} 个文件：\n${filesSummary}`,
    astAffectedFiles,
  };
}

