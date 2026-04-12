/**
 * 工具执行器
 * 
 * 接收解析后的工具调用，执行实际的文件操作，
 * 并返回执行结果，供 ChatViewProvider 将结果反馈给 AI。
 */
import { info, error } from '../logger';
import { readFile, writeFile, editFile, listDir } from './fileOps';
import type { ParsedToolCall } from './toolParser';
import type { FileOpResult } from './fileOps';
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
 */
function isReadOnlyToolCall(toolCall: ParsedToolCall): boolean {
  return toolCall.type === 'read_file' || toolCall.type === 'list_dir';
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
  const isWriteOp = toolCall.type === 'write_file' || toolCall.type === 'edit_file';
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
      return editFile(toolCall.path, toolCall.oldContent, toolCall.newContent);

    case 'list_dir':
      return listDir(toolCall.path);

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
    const typeLabel = getToolTypeLabel(toolCall.type);
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

/** 工具类型的中文标签 */
function getToolTypeLabel(type: string): string {
  switch (type) {
    case 'read_file': return '📖 读取文件';
    case 'write_file': return '📝 写入文件';
    case 'edit_file': return '✏️ 编辑文件';
    case 'list_dir': return '📁 列出目录';
    default: return type;
  }
}
