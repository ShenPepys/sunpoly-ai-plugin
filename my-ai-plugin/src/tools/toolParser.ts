/**
 * 工具调用解析器
 * 
 * 解析 AI 回复中的工具调用标签，
 * 提取出文件操作指令（read_file, write_file, edit_file, list_dir）。
 * 
 * 支持两种格式：
 * 1. 带包裹：<tool_call><read_file path="..." /></tool_call>
 * 2. 裸标签：<read_file path="..." />
 * 兼容不同模型对格式指令的遵循程度差异。
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

type TextRange = [number, number];

const WRAPPED_TOOL_CALL_REGEX_SOURCE = '<tool_call>([\\s\\S]*?)</tool_call>';
const BARE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir'];
const BARE_TOOL_CALL_REGEX_SOURCE = `<(${BARE_TOOL_NAMES.join('|')})[\\s>][\\s\\S]*?(?:\\/>|<\\/\\1>)`;
const BARE_TOOL_CALL_QUICK_CHECK_REGEX = /<(?:read_file|write_file|edit_file|list_dir)\s/;
const FENCED_CODE_BLOCK_REGEX_SOURCE = '(^|\\r?\\n)(`{3,}|~{3,})[^\\n\\r]*\\r?\\n[\\s\\S]*?\\r?\\n\\2[^\\n\\r]*(?=\\r?\\n|$)';

function collectFencedCodeBlockRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const fenceRegex = new RegExp(FENCED_CODE_BLOCK_REGEX_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const start = match.index + prefix.length;
    const end = match.index + match[0].length;
    ranges.push([start, end]);
  }

  return ranges;
}

function buildOutsideFencedCodeSegments(text: string): string[] {
  const ranges = collectFencedCodeBlockRanges(text);
  if (ranges.length === 0) {
    return [text];
  }

  const segments: string[] = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    if (cursor < start) {
      segments.push(text.slice(cursor, start));
    }
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return segments;
}

function replaceToolCallsInPlainText(text: string): string {
  let result = text.replace(new RegExp(WRAPPED_TOOL_CALL_REGEX_SOURCE, 'g'), '');
  result = result.replace(/<(?:read_file|list_dir)\s+path\s*=\s*"[^"]+"\s*\/>/g, '');
  result = result.replace(/<write_file\s+path\s*=\s*"[^"]+">[\s\S]*?<\/write_file>/g, '');
  result = result.replace(/<edit_file\s+path\s*=\s*"[^"]+">[\s\S]*?<\/edit_file>/g, '');
  return result;
}

/**
 * 从 AI 回复文本中解析所有工具调用
 * 
 * 同时支持两种格式：
 * 1. 带包裹：<tool_call>...</tool_call>
 * 2. 裸标签：<read_file path="..." />
 * 
 * 解析顺序：先匹配带包裹的，再匹配裸标签，避免重复
 * 
 * @param text AI 回复的完整文本
 * @returns 解析出的工具调用数组
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const outsideSegments = buildOutsideFencedCodeSegments(text);

  for (const segment of outsideSegments) {
    const matchedRanges: Array<[number, number]> = [];
    const wrappedRegex = new RegExp(WRAPPED_TOOL_CALL_REGEX_SOURCE, 'g');
    let match: RegExpExecArray | null;

    while ((match = wrappedRegex.exec(segment)) !== null) {
      const rawMatch = match[0];
      const inner = match[1].trim();
      const parsed = parseSingleToolCall(inner, rawMatch);
      if (parsed) {
        results.push(parsed);
        matchedRanges.push([match.index, match.index + rawMatch.length]);
      }
    }

    const bareRegex = new RegExp(BARE_TOOL_CALL_REGEX_SOURCE, 'g');
    while ((match = bareRegex.exec(segment)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const isAlreadyMatched = matchedRanges.some(
        ([rStart, rEnd]) => start >= rStart && end <= rEnd,
      );
      if (isAlreadyMatched) { continue; }

      const rawMatch = match[0];
      const parsed = parseSingleToolCall(rawMatch, rawMatch);
      if (parsed) {
        results.push(parsed);
      }
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
 * 同时检测带包裹和裸标签两种格式
 */
export function hasToolCalls(text: string): boolean {
  const outsideSegments = buildOutsideFencedCodeSegments(text);
  return outsideSegments.some(segment => {
    return segment.includes('<tool_call>') || BARE_TOOL_CALL_QUICK_CHECK_REGEX.test(segment);
  });
}

/**
 * 从文本中移除所有工具调用标签（包含包裹和裸标签）
 * 用于在界面上只显示 AI 的文字部分，不暴露原始 XML 给用户
 */
export function stripToolCalls(text: string): string {
  const ranges = collectFencedCodeBlockRanges(text);
  if (ranges.length === 0) {
    return replaceToolCallsInPlainText(text).trim();
  }

  let result = '';
  let cursor = 0;

  for (const [start, end] of ranges) {
    result += replaceToolCallsInPlainText(text.slice(cursor, start));
    result += text.slice(start, end);
    cursor = end;
  }

  result += replaceToolCallsInPlainText(text.slice(cursor));
  return result.trim();
}
