/**
 * 工具调用解析器
 * 
 * 解析 AI 回复中的 <tool_call>...</tool_call> XML 标签，
 * 提取出文件操作指令（read_file, write_file, edit_file, list_dir）。
 */

/** 工具调用类型 */
export type ToolCallType = 'read_file' | 'write_file' | 'edit_file' | 'list_dir';

/** 解析后的工具调用结构 */
export interface ParsedToolCall {
  /** 工具类型 */
  type: ToolCallType;
  /** 文件/目录路径 */
  path: string;
  /** 写入内容（仅 write_file） */
  content?: string;
  /** 旧内容（仅 edit_file） */
  oldContent?: string;
  /** 新内容（仅 edit_file） */
  newContent?: string;
  /** 原始匹配文本（用于在回复中替换为执行结果） */
  rawMatch: string;
}

/**
 * 从 AI 回复文本中解析所有工具调用
 * 
 * 支持的格式：
 * - <tool_call><read_file path="路径" /></tool_call>
 * - <tool_call><write_file path="路径">内容</write_file></tool_call>
 * - <tool_call><edit_file path="路径"><old>旧内容</old><new>新内容</new></edit_file></tool_call>
 * - <tool_call><list_dir path="路径" /></tool_call>
 * 
 * @param text AI 回复的完整文本
 * @returns 解析出的工具调用数组
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];

  // 匹配所有 <tool_call>...</tool_call> 块
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = toolCallRegex.exec(text)) !== null) {
    const rawMatch = match[0];
    const inner = match[1].trim();

    const parsed = parseSingleToolCall(inner, rawMatch);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * 解析单个工具调用的内部 XML
 */
function parseSingleToolCall(inner: string, rawMatch: string): ParsedToolCall | null {
  // read_file: <read_file path="xxx" />
  const readMatch = inner.match(/<read_file\s+path\s*=\s*"([^"]+)"\s*\/>/);
  if (readMatch) {
    return { type: 'read_file', path: readMatch[1], rawMatch };
  }

  // list_dir: <list_dir path="xxx" />
  const listMatch = inner.match(/<list_dir\s+path\s*=\s*"([^"]+)"\s*\/>/);
  if (listMatch) {
    return { type: 'list_dir', path: listMatch[1], rawMatch };
  }

  // write_file: <write_file path="xxx">内容</write_file>
  const writeMatch = inner.match(/<write_file\s+path\s*=\s*"([^"]+)">([\s\S]*?)<\/write_file>/);
  if (writeMatch) {
    return { type: 'write_file', path: writeMatch[1], content: writeMatch[2], rawMatch };
  }

  // edit_file: <edit_file path="xxx"><old>旧</old><new>新</new></edit_file>
  const editMatch = inner.match(/<edit_file\s+path\s*=\s*"([^"]+)">([\s\S]*?)<\/edit_file>/);
  if (editMatch) {
    const editBody = editMatch[2];
    const oldMatch = editBody.match(/<old>([\s\S]*?)<\/old>/);
    const newMatch = editBody.match(/<new>([\s\S]*?)<\/new>/);
    if (oldMatch && newMatch) {
      return {
        type: 'edit_file',
        path: editMatch[1],
        oldContent: oldMatch[1],
        newContent: newMatch[1],
        rawMatch,
      };
    }
  }

  return null;
}

/**
 * 检查文本中是否包含工具调用
 * 用于快速判断是否需要解析（避免不必要的正则匹配）
 */
export function hasToolCalls(text: string): boolean {
  return text.includes('<tool_call>');
}

/**
 * 从文本中移除所有 <tool_call>...</tool_call> 标签
 * 用于在界面上只显示 AI 的文字部分，不暴露原始 XML 给用户
 */
export function stripToolCalls(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}
