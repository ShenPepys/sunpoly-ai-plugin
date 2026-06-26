/**
 * 工具调用解析器
 * 
 * 解析 AI 回复中的工具调用标签，
 * 提取出文件操作指令（read_file, write_file, edit_file, list_dir, ast_edit）。
 * 
 * 支持两种格式：
 * 1. 带包裹：<tool_call><read_file path="..." /></tool_call>
 * 2. 裸标签：<read_file path="..." />
 * 兼容不同模型对格式指令的遵循程度差异。
 */

import type { AstEditAction } from './astEditorTypes';

/** 工具调用类型 */
export type ToolCallType = 'read_file' | 'write_file' | 'edit_file' | 'list_dir' | 'ast_edit' | 'search_file' | 'grep_code' | 'run_command';

/** 解析后的工具调用结构 */
export interface ParsedToolCall {
  /** 工具类型 */
  type: ToolCallType;
  /** 文件/目录路径 */
  path?: string;
  /** 写入内容（仅 write_file） */
  content?: string;
  /** 旧内容（仅 edit_file） */
  oldContent?: string;
  /** 新内容（仅 edit_file） */
  newContent?: string;
  /** AST 操作类型（仅 ast_edit） */
  astAction?: AstEditAction;
  /** AST 操作参数的 JSON 对象（仅 ast_edit） */
  astParams?: Record<string, unknown>;
  /** 是否替换所有匹配（仅 edit_file，默认 false） */
  replaceAll?: boolean;
  /** 行号编辑模式：替换起始行（1-indexed，含）（仅 edit_file） */
  startLine?: number;
  /** 行号编辑模式：替换结束行（1-indexed，含）（仅 edit_file） */
  endLine?: number;
  /** AST 绕过标记：为 true 时允许 edit_file 编辑 AST 支持的文件（仅 edit_file） */
  astBypass?: boolean;
  /** 搜索模式（仅 search_file） */
  pattern?: string;
  /** 正则表达式（仅 grep_code） */
  regex?: string;
  /** 包含模式（仅 grep_code） */
  includePattern?: string;
  /** 是否区分大小写（仅 grep_code） */
  caseSensitive?: boolean;
  /** 要执行的命令（仅 run_command） */
  command?: string;
  /** 命令超时毫秒数（仅 run_command） */
  timeout?: number;
  /** 原始匹配文本（用于在回复中替换为执行结果） */
  rawMatch: string;
}

type TextRange = [number, number];

const WRAPPED_TOOL_CALL_REGEX_SOURCE = '<tool_call>([\\s\\S]*?)</tool_call>';
const BARE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir', 'ast_edit', 'search_file', 'grep_code', 'run_command'];
const BARE_TOOL_CALL_REGEX_SOURCE = `<(${BARE_TOOL_NAMES.join('|')})[\\s>][\\s\\S]*?(?:\\/>|<\\/\\1>)`;
const BARE_TOOL_CALL_QUICK_CHECK_REGEX = /<(?:read_file|write_file|edit_file|list_dir|ast_edit|search_file|grep_code|run_command)\s/;
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
  result = result.replace(/<edit_file\s+path\s*=\s*"[^"]+"(?:\s+[a-z_]+\s*=\s*"[^"]*")*>[\s\S]*?<\/edit_file>/g, '');
  result = result.replace(/<ast_edit\s+path\s*=\s*"[^"]+"\s+action\s*=\s*"[^"]+">[\s\S]*?<\/ast_edit>/g, '');
  result = result.replace(/<search_file\s+pattern\s*=\s*"[^"]+"\s*\/>/g, '');
  result = result.replace(/<grep_code\s+regex\s*=\s*"[^"]+"(?:\s+[a-z_]+\s*=\s*"[^"]*")*\s*\/>/g, '');
  result = result.replace(/<run_command(?:\s+[a-z_]+\s*=\s*"[^"]*")*>([\s\S]*?)<\/run_command>/g, '');
  return result;
}

/**
 * 在给定的文本段中解析工具调用（不区分代码块）
 */
function parseToolCallsFromSegments(segments: string[]): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];

  for (const segment of segments) {
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
 * 检查给定文本段中是否存在工具调用
 */
function hasToolCallsInSegments(segments: string[]): boolean {
  return segments.some(segment => {
    return segment.includes('<tool_call>') || BARE_TOOL_CALL_QUICK_CHECK_REGEX.test(segment);
  });
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const outsideSegments = buildOutsideFencedCodeSegments(text);
  const outsideResults = parseToolCallsFromSegments(outsideSegments);

  // 代码块外找到了工具调用，直接返回（代码块内的视为示例）
  if (outsideResults.length > 0) {
    return outsideResults;
  }

  // 代码块外没有找到，回退到全文解析，兼容模型把真实调用包在代码块里
  return parseToolCallsFromSegments([text]);
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

  // edit_file: <edit_file path="xxx" replace_all="true"><old>旧</old><new>新</new></edit_file>
  // 也支持行号模式: <edit_file path="xxx" start_line="10" end_line="15"><new>新内容</new></edit_file>
  // replace_all / start_line / end_line 属性均可选
  const editMatch = inner.match(/<edit_file\s+path\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)>([\s\S]*?)<\/edit_file>/);
  if (editMatch) {
    const editAttrs = editMatch[2] || '';
    const editBody = editMatch[3];

    // 解析通用属性
    const replaceAllAttr = editAttrs.match(/\breplace_all\s*=\s*"([^"]*)"/);
    const replaceAll = replaceAllAttr ? replaceAllAttr[1] === 'true' : false;
    const astBypassAttr = editAttrs.match(/\bast_bypass\s*=\s*"([^"]*)"/);;
    const startLineAttr = editAttrs.match(/\bstart_line\s*=\s*"(\d+)"/);
    const endLineAttr = editAttrs.match(/\bend_line\s*=\s*"(\d+)"/);

    // 行号编辑模式：有 start_line 时只需 <new>，不需要 <old>
    if (startLineAttr) {
      const newMatch = editBody.match(/<new>([\s\S]*?)<\/new>/);
      if (newMatch) {
        return {
          type: 'edit_file',
          path: editMatch[1],
          newContent: newMatch[1],
          startLine: parseInt(startLineAttr[1], 10),
          endLine: endLineAttr ? parseInt(endLineAttr[1], 10) : undefined,
          astBypass: astBypassAttr ? astBypassAttr[1] === 'true' : undefined,
          rawMatch,
        };
      }
    }

    // 文本匹配编辑模式：需要 <old> + <new>
    const oldMatch = editBody.match(/<old>([\s\S]*?)<\/old>/);
    const newMatch = editBody.match(/<new>([\s\S]*?)<\/new>/);
    if (oldMatch && newMatch) {
      return {
        type: 'edit_file',
        path: editMatch[1],
        oldContent: oldMatch[1],
        newContent: newMatch[1],
        replaceAll: replaceAll || undefined, // false 时不设置，保持向后兼容
        astBypass: astBypassAttr ? astBypassAttr[1] === 'true' : undefined,
        rawMatch,
      };
    }
  }

  // ast_edit: <ast_edit path="xxx" action="add_import">{"modulePath": "./utils"}</ast_edit>
  const astMatch = inner.match(/<ast_edit\s+path\s*=\s*"([^"]+)"\s+action\s*=\s*"([^"]+)">((?:[\s\S]*?))<\/ast_edit>/);
  if (astMatch) {
    const astPath = astMatch[1];
    const astAction = astMatch[2] as AstEditAction;
    const astBody = astMatch[3].trim();
    const astParams = parseAstParams(astBody);
    if (astParams) {
      return { type: 'ast_edit', path: astPath, astAction, astParams, rawMatch };
    }
  }

  // search_file: <search_file pattern="*.ts" />
  const searchMatch = inner.match(/<search_file\s+pattern\s*=\s*"([^"]+)"\s*\/>/);
  if (searchMatch) {
    return { type: 'search_file', pattern: searchMatch[1], rawMatch };
  }

  // grep_code: <grep_code regex="func\\s+test" include_pattern="*.ts" case_sensitive="false" />
  const grepMatch = inner.match(/<grep_code\s+regex\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)\s*\/>/);
  if (grepMatch) {
    const grepAttrs = grepMatch[2] || '';
    const includePatternAttr = grepAttrs.match(/\binclude_pattern\s*=\s*"([^"]*)"/);
    const caseSensitiveAttr = grepAttrs.match(/\bcase_sensitive\s*=\s*"([^"]*)"/);
    return {
      type: 'grep_code',
      regex: grepMatch[1],
      includePattern: includePatternAttr ? includePatternAttr[1] : undefined,
      caseSensitive: caseSensitiveAttr ? caseSensitiveAttr[1] === 'true' : false,
      rawMatch,
    };
  }

  // run_command: <run_command timeout="30000">npm install</run_command>
  const cmdMatch = inner.match(/<run_command((?:\s+[a-z_]+\s*=\s*"[^"]*")*)>([\s\S]*?)<\/run_command>/);
  if (cmdMatch) {
    const cmdAttrs = cmdMatch[1] || '';
    const cmdBody = cmdMatch[2].trim();
    const timeoutAttr = cmdAttrs.match(/\btimeout\s*=\s*"(\d+)"/);
    return {
      type: 'run_command',
      command: cmdBody,
      timeout: timeoutAttr ? parseInt(timeoutAttr[1], 10) : undefined,
      rawMatch,
    };
  }

  return null;
}

/**
 * 解析 ast_edit 标签体内的参数。
 * 支持两种格式：
 * 1. JSON 格式：{"modulePath": "./utils", "namedImports": ["foo"]}
 * 2. <param> 标签格式：<param name="modulePath">./utils</param>
 */
function parseAstParams(body: string): Record<string, unknown> | null {
  // 优先尝试 JSON 格式
  if (body.startsWith('{')) {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      // JSON 解析失败，继续尝试 param 标签格式
    }
  }

  // <param name="key">value</param> 格式
  const paramRegex = /<param\s+name\s*=\s*"([^"]+)">((?:[\s\S]*?))<\/param>/g;
  let paramMatch: RegExpExecArray | null;
  const params: Record<string, unknown> = {};
  let foundAny = false;

  while ((paramMatch = paramRegex.exec(body)) !== null) {
    foundAny = true;
    const key = paramMatch[1];
    const rawValue = paramMatch[2].trim();
    params[key] = parseParamValue(rawValue);
  }

  return foundAny ? params : null;
}

/**
 * 将 param 标签的文本值转换为合适的 JS 类型。
 * 逗号分隔的值会被解析为数组，数字和布尔值会被自动转换。
 */
function parseParamValue(raw: string): unknown {
  // 先尝试作为 JSON（支持数组、对象、数字、布尔等）
  try {
    return JSON.parse(raw);
  } catch {
    // 不是合法 JSON，继续
  }

  // 逗号分隔 → 字符串数组
  if (raw.includes(',')) {
    return raw.split(',').map(s => s.trim()).filter(s => s !== '');
  }

  return raw;
}

/**
 * 检查文本中是否包含工具调用
 * 同时检测带包裹和裸标签两种格式
 */
export function hasToolCalls(text: string): boolean {
  const outsideSegments = buildOutsideFencedCodeSegments(text);
  // 代码块外有工具调用则直接返回 true
  if (hasToolCallsInSegments(outsideSegments)) {
    return true;
  }

  // 代码块外没有，回退到全文检测
  return hasToolCallsInSegments([text]);
}

/**
 * 清理剥离工具调用后遗留的空代码块围栏
 * 例如 ```xml\n``` 或 ```\n  \n``` 等只剩围栏没有实际内容的代码块
 */
function cleanupEmptyCodeFences(text: string): string {
  return text.replace(/```\w*\n\s*```/g, '');
}

/**
 * 从文本中移除所有工具调用标签（包含包裹和裸标签）
 * 用于在界面上只显示 AI 的文字部分，不暴露原始 XML 给用户
 */
export function stripToolCalls(text: string): string {
  const ranges = collectFencedCodeBlockRanges(text);
  if (ranges.length === 0) {
    return cleanupEmptyCodeFences(replaceToolCallsInPlainText(text)).trim();
  }

  // 先检查代码块外是否有工具调用
  const outsideSegments = buildOutsideFencedCodeSegments(text);
  const hasOutsideCalls = hasToolCallsInSegments(outsideSegments);

  // 代码块外有调用：只剥离代码块外的，保留代码块内（示例）
  if (hasOutsideCalls) {
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

  // 代码块外没有调用：全文剥离（模型把真实调用包在代码块里）
  return cleanupEmptyCodeFences(replaceToolCallsInPlainText(text)).trim();
}
