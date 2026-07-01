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
  /** read_file 读取起始行（1-indexed，含） */
  readStartLine?: number;
  /** read_file 读取结束行（1-indexed，含） */
  readEndLine?: number;
  /** list_dir 是否递归列出子目录 */
  listRecursive?: boolean;
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
const BARE_TOOL_CALL_QUICK_CHECK_REGEX = /<(?:read_file|write_file|edit_file|list_dir|ast_edit|search_file|grep_code|run_command)(?:\s|>)/;
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
  // 自闭合标签使用更宽松的匹配（兼容截断的 /> 或 "）
  result = result.replace(/<(?:read_file|list_dir)\s+path\s*=\s*"[^"]+"(?:\s+[a-z_]+\s*=\s*"[^"]*")*\s*\/?>/g, '');
  result = result.replace(/<write_file\s+path\s*=\s*"[^"]+">[\s\S]*<\/write_file>/g, '');
  result = result.replace(/<edit_file\s+path\s*=\s*"[^"]+"(?:\s+[a-z_]+\s*=\s*"[^"]*")*>[\s\S]*<\/edit_file>/g, '');
  result = result.replace(/<ast_edit\s+path\s*=\s*"[^"]+"\s+action\s*=\s*"[^"]+">[\s\S]*<\/ast_edit>/g, '');
  result = result.replace(/<search_file\s+pattern\s*=\s*"[^"]+"(?:\s+[a-z_]+\s*=\s*"[^"]*")*\s*\/?>/g, '');
  result = result.replace(/<grep_code(?:\s+[a-z_]+\s*=\s*"[^"]*")*\s*\/?>/g, '');
  result = result.replace(/<run_command(?:\s+[a-z_]+\s*=\s*"[^"]*")*>([\s\S]*)<\/run_command>/g, '');
  result = result.replace(/\]+\s*>\s*<\/edit_file>\s*$/u, '');
  result = result.replace(/<\/edit_file>\s*$/u, '');
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
        matchedRanges.push([start, end]);
      }
    }

    // --- Lenient pass: 对最后一个完整匹配之后的尾部做宽松解析，捕获截断标签 ---
    if (matchedRanges.length > 0) {
      const lastEnd = Math.max(...matchedRanges.map(([, e]) => e));
      const tail = segment.slice(lastEnd);
      if (tail.length > 0) {
        for (const parser of LENIENT_PARSERS) {
          const lenientResult = parser(tail);
          if (lenientResult) {
            results.push(lenientResult);
            break;
          }
        }
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
  const fullTextResults = parseToolCallsFromSegments([text]);
  if (fullTextResults.length > 0) {
    return fullTextResults;
  }

  // 标准解析和代码块回退均失败，尝试所有工具的宽松解析
  for (const parser of LENIENT_PARSERS) {
    const result = parser(text);
    if (result) {
      return [result];
    }
  }
  return [];
}

/**
 * 宽松解析 run_command：兼容缺少闭合标签或 tool_call 包裹不完整的情况。
 */
function tryParseLenientRunCommand(text: string): ParsedToolCall | null {
  const openTag = '<run_command';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) {
    return null;
  }

  const openEnd = text.indexOf('>', openIdx);
  if (openEnd === -1) {
    return null;
  }

  const closeTag = '</run_command>';
  const closeIdx = text.indexOf(closeTag, openEnd);
  const command = (closeIdx === -1
    ? text.slice(openEnd + 1)
    : text.slice(openEnd + 1, closeIdx)
  ).trim();

  if (!command) {
    return null;
  }

  const rawEnd = closeIdx === -1 ? text.length : closeIdx + closeTag.length;
  return {
    type: 'run_command',
    command,
    rawMatch: text.slice(openIdx, rawEnd),
  };
}

/**
 * 宽松解析 edit_file：兼容流式截断、未闭合的 <new>、或尾部残留 ]]></edit_file> 等情况。
 */
function tryParseLenientEditFile(text: string): ParsedToolCall | null {
  const openTag = '<edit_file';
  const openIdx = text.lastIndexOf(openTag);
  if (openIdx === -1) {
    return null;
  }

  const tail = text.slice(openIdx);
  const headerMatch = tail.match(
    /^<edit_file\s+path\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)>/,
  );
  if (!headerMatch) {
    return null;
  }

  const path = headerMatch[1];
  const editAttrs = headerMatch[2] ?? '';
  const bodyStart = openIdx + headerMatch[0].length;
  const closeIdx = text.indexOf('</edit_file>', bodyStart);
  let body = closeIdx === -1 ? text.slice(bodyStart) : text.slice(bodyStart, closeIdx);
  body = body.replace(/\[\]+\s*$/u, '').trimEnd();

  const startLineAttr = editAttrs.match(/\bstart_line\s*=\s*"(\d+)"/);
  const endLineAttr = editAttrs.match(/\bend_line\s*=\s*"(\d+)"/);
  const astBypassAttr = editAttrs.match(/\bast_bypass\s*=\s*"([^"]*)"/);
  const replaceAllAttr = editAttrs.match(/\breplace_all\s*=\s*"([^"]*)"/);

  const rawEnd = closeIdx === -1 ? text.length : closeIdx + '</edit_file>'.length;
  const rawMatch = text.slice(openIdx, rawEnd);

  if (startLineAttr) {
    const newMatch = body.match(/<new>([\s\S]*)/);
    const newContent = (newMatch ? newMatch[1] : body).trim();
    if (!newContent) {
      return null;
    }

    return {
      type: 'edit_file',
      path,
      newContent,
      startLine: Number.parseInt(startLineAttr[1], 10),
      endLine: endLineAttr ? Number.parseInt(endLineAttr[1], 10) : undefined,
      astBypass: astBypassAttr ? astBypassAttr[1] === 'true' : undefined,
      rawMatch,
    };
  }

  const oldMatch = body.match(/<old>([\s\S]*?)(?:<\/old>|$)/);
  const newMatch = body.match(/<new>([\s\S]*)/);
  if (!oldMatch || !newMatch) {
    return null;
  }

  const oldContent = oldMatch[1].trim();
  const newContent = newMatch[1].trim();
  if (!oldContent || !newContent) {
    return null;
  }

  return {
    type: 'edit_file',
    path,
    oldContent,
    newContent,
    replaceAll: replaceAllAttr ? replaceAllAttr[1] === 'true' : undefined,
    astBypass: astBypassAttr ? astBypassAttr[1] === 'true' : undefined,
    rawMatch,
  };
}

/**
 * 宽松解析 read_file：兼容缺少闭合 /> 的截断标签。
 */
function tryParseLenientReadFile(text: string): ParsedToolCall | null {
  const openTag = '<read_file';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const pathMatch = tail.match(/^<read_file\s+path\s*=\s*"([^"]+)"/);
  if (!pathMatch) { return null; }
  const attrs = tail.match(/^<read_file\s+([^>]*)/);
  const attrStr = attrs ? attrs[1] : '';
  const startLineAttr = attrStr.match(/\bstart_line\s*=\s*"(\d+)"/);
  const endLineAttr = attrStr.match(/\bend_line\s*=\s*"(\d+)"/);
  const rawEnd = tail.indexOf('/>') !== -1 ? openIdx + tail.indexOf('/>') + 2 : text.length;
  return {
    type: 'read_file',
    path: pathMatch[1],
    readStartLine: startLineAttr ? Number.parseInt(startLineAttr[1], 10) : undefined,
    readEndLine: endLineAttr ? Number.parseInt(endLineAttr[1], 10) : undefined,
    rawMatch: text.slice(openIdx, rawEnd),
  };
}

/**
 * 宽松解析 list_dir：兼容缺少闭合 /> 的截断标签。
 */
function tryParseLenientListDir(text: string): ParsedToolCall | null {
  const openTag = '<list_dir';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const pathMatch = tail.match(/^<list_dir\s+path\s*=\s*"([^"]+)"/);
  if (!pathMatch) { return null; }
  const attrs = tail.match(/^<list_dir\s+([^>]*)/);
  const attrStr = attrs ? attrs[1] : '';
  const recursiveAttr = attrStr.match(/\brecursive\s*=\s*"([^"]*)"/);
  const rawEnd = tail.indexOf('/>') !== -1 ? openIdx + tail.indexOf('/>') + 2 : text.length;
  return {
    type: 'list_dir',
    path: pathMatch[1],
    listRecursive: recursiveAttr ? recursiveAttr[1] === 'true' : undefined,
    rawMatch: text.slice(openIdx, rawEnd),
  };
}

/**
 * 宽松解析 search_file：兼容缺少闭合 /> 的截断标签。
 */
function tryParseLenientSearchFile(text: string): ParsedToolCall | null {
  const openTag = '<search_file';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const patternMatch = tail.match(/^<search_file\s+pattern\s*=\s*"([^"]+)"/);
  if (!patternMatch) { return null; }
  const rawEnd = tail.indexOf('/>') !== -1 ? openIdx + tail.indexOf('/>') + 2 : text.length;
  return {
    type: 'search_file',
    pattern: patternMatch[1],
    rawMatch: text.slice(openIdx, rawEnd),
  };
}

/**
 * 宽松解析 grep_code：兼容缺少闭合 /> 的截断标签。
 */
function tryParseLenientGrepCode(text: string): ParsedToolCall | null {
  const openTag = '<grep_code';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const headerMatch = tail.match(/^<grep_code((?:\s+[a-z_]+\s*=\s*"[^"]*")*)\s*\/?>/);
  if (!headerMatch) { return null; }
  const attrStr = headerMatch[1] ?? '';
  const regexAttr = attrStr.match(/\bregex\s*=\s*"([^"]+)"/);
  if (!regexAttr) { return null; }
  const includeAttr = attrStr.match(/\binclude_pattern\s*=\s*"([^"]*)"/);
  const caseAttr = attrStr.match(/\bcase_sensitive\s*=\s*"([^"]*)"/);
  const rawEnd = tail.indexOf('/>') !== -1 ? openIdx + tail.indexOf('/>') + 2 : text.length;
  return {
    type: 'grep_code',
    regex: regexAttr[1],
    includePattern: includeAttr ? includeAttr[1] : undefined,
    caseSensitive: caseAttr ? caseAttr[1] === 'true' : false,
    rawMatch: text.slice(openIdx, rawEnd),
  };
}

/**
 * 宽松解析 ast_edit：兼容缺少闭合标签或 JSON 参数不完整的情况。
 */
function tryParseLenientAstEdit(text: string): ParsedToolCall | null {
  const openTag = '<ast_edit';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const headerMatch = tail.match(/^<ast_edit\s+path\s*=\s*"([^"]+)"\s+action\s*=\s*"([^"]+)"/);
  if (!headerMatch) { return null; }
  const astPath = headerMatch[1];
  const astAction = headerMatch[2] as AstEditAction;
  const bodyStart = openIdx + headerMatch[0].length;
  const closeIdx = text.indexOf('</ast_edit>', bodyStart);
  let body = (closeIdx === -1 ? text.slice(bodyStart) : text.slice(bodyStart, closeIdx)).trim();
  body = body.replace(/^>/, '').trim();
  const astParams = parseAstParams(body);
  if (!astParams) { return null; }
  const rawEnd = closeIdx === -1 ? text.length : closeIdx + '</ast_edit>'.length;
  return { type: 'ast_edit', path: astPath, astAction, astParams, rawMatch: text.slice(openIdx, rawEnd) };
}

/**
 * 宽松解析 write_file：兼容流式截断、未闭合的 write_file 标签。
 */
function tryParseLenientWriteFile(text: string): ParsedToolCall | null {
  const openTag = '<write_file';
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) { return null; }
  const tail = text.slice(openIdx);
  const pathMatch = tail.match(/^<write_file\s+path\s*=\s*"([^"]+)"/);
  if (!pathMatch) { return null; }
  const closeTag = '</write_file>';
  const closeIdx = text.indexOf(closeTag, openIdx + pathMatch[0].length);
  if (closeIdx !== -1) {
    const content = text.slice(openIdx + pathMatch[0].length, closeIdx);
    return { type: 'write_file', path: pathMatch[1], content, rawMatch: text.slice(openIdx, closeIdx + closeTag.length) };
  }
  const openEnd = text.indexOf('>', openIdx);
  if (openEnd === -1) { return null; }
  const content = text.slice(openEnd + 1).trim();
  if (!content) { return null; }
  return { type: 'write_file', path: pathMatch[1], content, rawMatch: text.slice(openIdx) };
}

/** 所有工具的宽松解析器列表，按优先级排序 */
const LENIENT_PARSERS: Array<(text: string) => ParsedToolCall | null> = [
  tryParseLenientWriteFile,
  tryParseLenientEditFile,
  tryParseLenientAstEdit,
  tryParseLenientReadFile,
  tryParseLenientListDir,
  tryParseLenientSearchFile,
  tryParseLenientGrepCode,
  tryParseLenientRunCommand,
];

/**
 * 剥离尾部残缺工具标签（如 ]]></edit_file>、未闭合的 <edit_file...）。
 * 覆盖所有 8 种工具类型。
 */
export function stripMalformedToolCallTail(text: string): string {
  let result = text;

  // --- edit_file / write_file 特定残留清理 ---
  result = result.replace(/\]+\s*>\s*<\/edit_file>\s*$/u, '');
  result = result.replace(/\]+\s*>\s*<\/write_file>\s*$/u, '');
  result = result.replace(/\]+\s*<\/edit_file>\s*$/u, '');
  result = result.replace(/\]+\s*<\/write_file>\s*$/u, '');
  result = result.replace(/>\s*<\/edit_file>\s*$/u, '');
  result = result.replace(/>\s*<\/write_file>\s*$/u, '');
  result = result.replace(/\]+\s*$/u, '');
  result = result.replace(/<\/edit_file>\s*$/u, '');
  result = result.replace(/<\/write_file>\s*$/u, '');

  // --- edit_file / write_file 未闭合开标签 ---
  const openIdx = result.lastIndexOf('<edit_file');
  if (openIdx !== -1) {
    const tail = result.slice(openIdx);
    if (!tail.includes('</edit_file>') && /<edit_file\s+path\s*=\s*"[^"]+"/.test(tail)) {
      result = result.slice(0, openIdx).trimEnd();
    }
  }

  const writeOpenIdx = result.lastIndexOf('<write_file');
  if (writeOpenIdx !== -1) {
    const tail = result.slice(writeOpenIdx);
    if (!tail.includes('</write_file>') && /<write_file\s+path\s*=\s*"[^"]+"/.test(tail)) {
      result = result.slice(0, writeOpenIdx).trimEnd();
    }
  }

  // --- 自闭合标签（read_file / list_dir / search_file / grep_code）未闭合 ---
  const selfClosingTagNames = ['read_file', 'list_dir', 'search_file', 'grep_code'] as const;
  for (const tagName of selfClosingTagNames) {
    const tagOpen = `<${tagName}`;
    const lastOpen = result.lastIndexOf(tagOpen);
    if (lastOpen !== -1) {
      const afterOpen = result.slice(lastOpen);
      if (!afterOpen.includes('/>') && new RegExp(`<${tagName}\\s+`).test(afterOpen)) {
        result = result.slice(0, lastOpen).trimEnd();
      }
    }
  }

  // --- 成对标签（run_command / ast_edit）缺少闭合标签 ---
  const pairTagNames = ['run_command', 'ast_edit'] as const;
  for (const tagName of pairTagNames) {
    const closeTag = `</${tagName}>`;
    const openTag = `<${tagName}`;
    const lastOpen = result.lastIndexOf(openTag);
    if (lastOpen !== -1 && !result.slice(lastOpen).includes(closeTag)) {
      result = result.slice(0, lastOpen).trimEnd();
    }
  }

  return result.trimEnd();
}

/**
 * 解析单个工具调用的内部 XML
 */
function parseSingleToolCall(inner: string, rawMatch: string): ParsedToolCall | null {
  // read_file: <read_file path="xxx" start_line="1" end_line="200" />
  const readMatch = inner.match(/<read_file\s+path\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)\s*\/>/);
  if (readMatch) {
    const readAttrs = readMatch[2] ?? '';
    const startLineAttr = readAttrs.match(/\bstart_line\s*=\s*"(\d+)"/);
    const endLineAttr = readAttrs.match(/\bend_line\s*=\s*"(\d+)"/);
    return {
      type: 'read_file',
      path: readMatch[1],
      readStartLine: startLineAttr ? Number.parseInt(startLineAttr[1], 10) : undefined,
      readEndLine: endLineAttr ? Number.parseInt(endLineAttr[1], 10) : undefined,
      rawMatch,
    };
  }

  // list_dir: <list_dir path="xxx" recursive="true" />
  const listMatch = inner.match(/<list_dir\s+path\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)\s*\/>/);
  if (listMatch) {
    const listAttrs = listMatch[2] ?? '';
    const recursiveAttr = listAttrs.match(/\brecursive\s*=\s*"([^"]*)"/);
    const recursive = recursiveAttr ? recursiveAttr[1] === 'true' : false;
    return {
      type: 'list_dir',
      path: listMatch[1],
      listRecursive: recursive || undefined,
      rawMatch,
    };
  }

  // write_file: <write_file path="xxx">内容</write_file>
  // 使用更健壮的正则：匹配从 <write_file 到 </write_file> 的完整块
  const writeMatch = inner.match(/<write_file\s+path\s*=\s*"([^"]+)">([\s\S]*)<\/write_file>/);
  if (writeMatch) {
    return { type: 'write_file', path: writeMatch[1], content: writeMatch[2], rawMatch };
  }

  // edit_file: <edit_file path="xxx" replace_all="true"><old>旧</old><new>新</new></edit_file>
  // 也支持行号模式: <edit_file path="xxx" start_line="10" end_line="15"><new>新内容</new></edit_file>
  // replace_all / start_line / end_line 属性均可选
  // 使用更健壮的正则：匹配从 <edit_file 到 </edit_file> 的完整块
  const editMatch = inner.match(/<edit_file\s+path\s*=\s*"([^"]+)"((?:\s+[a-z_]+\s*=\s*"[^"]*")*)>([\s\S]*)<\/edit_file>/);
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
  // 使用更健壮的正则：匹配从 <ast_edit 到 </ast_edit> 的完整块
  const astMatch = inner.match(/<ast_edit\s+path\s*=\s*"([^"]+)"\s+action\s*=\s*"([^"]+)">([\s\S]*)<\/ast_edit>/);
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
  // 属性顺序无关：先匹配完整开标签，再逐个提取属性
  const grepMatch = inner.match(/<grep_code((?:\s+[a-z_]+\s*=\s*"[^"]*")*)\s*\/>/);
  if (grepMatch) {
    const grepAttrs = grepMatch[1] || '';
    const regexAttr = grepAttrs.match(/\bregex\s*=\s*"([^"]+)"/);
    if (regexAttr) {
      const includePatternAttr = grepAttrs.match(/\binclude_pattern\s*=\s*"([^"]*)"/);
      const caseSensitiveAttr = grepAttrs.match(/\bcase_sensitive\s*=\s*"([^"]*)"/);
      return {
        type: 'grep_code',
        regex: regexAttr[1],
        includePattern: includePatternAttr ? includePatternAttr[1] : undefined,
        caseSensitive: caseSensitiveAttr ? caseSensitiveAttr[1] === 'true' : false,
        rawMatch,
      };
    }
  }

  // run_command: <run_command timeout="30000">npm install</run_command>
  // 使用更健壮的正则：匹配从 <run_command 到 </run_command> 的完整块
  const cmdMatch = inner.match(/<run_command((?:\s+[a-z_]+\s*=\s*"[^"]*")*)>([\s\S]*)<\/run_command>/);
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
