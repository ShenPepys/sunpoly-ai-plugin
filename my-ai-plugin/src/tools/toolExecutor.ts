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
 * 批量执行工具调用
 * 按顺序依次执行，收集所有结果
 * 
 * @param toolCalls 解析后的工具调用数组
 * @param mode 当前工作模式，用于权限控制
 * @returns 所有工具调用的执行结果
 */
export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  mode: WorkMode,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  for (const toolCall of toolCalls) {
    const result = await executeSingleToolCall(toolCall, mode);
    results.push({ toolCall, result });
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
    return `### ${typeLabel} ${toolCall.path}\n**${status}**\n\`\`\`\n${result.content}\n\`\`\``;
  });

  return lines.join('\n\n');
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
