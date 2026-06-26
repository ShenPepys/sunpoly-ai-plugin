/**
 * 文件操作模块
 * 
 * 提供 AI 可调用的文件操作能力：读取、写入、编辑、列出目录。
 * 所有操作均限制在工作区范围内，防止越权访问。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { info, error } from '../logger';

/**
 * 应跳过的文件名（精确匹配）
 * 这些文件对理解代码逻辑没有帮助，读取它们只会浪费模型上下文
 */
const SKIP_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * 应跳过的文件扩展名（二进制或无意义文件）
 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.map', '.min.js', '.min.css',
  '.pyc', '.class', '.o', '.obj',
]);

/** 单个文件返回给模型的最大字符数，超出部分截断 */
const MAX_CONTENT_CHARS = 8192;

/**
 * 为文件内容添加行号。
 * 格式：右对齐行号 + tab + 代码行，例如 "  1\timport { foo } from 'bar';"
 * 行号列宽根据总行数自动计算（如 100 行文件用 3 位列宽）。
 *
 * @param content 原始文件内容（不含行号）
 * @returns 带行号的内容
 */
export function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const width = String(totalLines).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}\t${line}`)
    .join('\n');
}

/**
 * 获取工作区根目录路径
 * 如果没有打开工作区则返回 undefined
 */
function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

/**
 * 安全校验：确保目标路径在工作区范围内
 * 防止 AI 越权访问工作区外的文件（如系统文件）
 * 
 * @param targetPath 待校验的文件/目录路径
 * @returns 规范化后的绝对路径，如果不安全则返回 undefined
 */
export function resolveAndValidatePath(targetPath: string): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return null;
  }

  // 将相对路径转为绝对路径（基于工作区根目录）
  const absolutePath = path.resolve(workspaceFolder.uri.fsPath, targetPath);
  const normalizedWorkspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
  const compareAbsolutePath = process.platform === 'win32'
    ? absolutePath.toLowerCase()
    : absolutePath;
  const compareWorkspaceRoot = process.platform === 'win32'
    ? normalizedWorkspaceRoot.toLowerCase()
    : normalizedWorkspaceRoot;
  const workspacePrefix = compareWorkspaceRoot.endsWith(path.sep)
    ? compareWorkspaceRoot
    : compareWorkspaceRoot + path.sep;

  // 安全检查：必须在工作区目录内
  const isSameDirectory = compareAbsolutePath === compareWorkspaceRoot;
  const isChildDirectory = compareAbsolutePath.startsWith(workspacePrefix);
  if (!isSameDirectory && !isChildDirectory) {
    error(`文件路径越权: ${absolutePath} 不在工作区 ${workspaceFolder.uri.fsPath} 内`);
    return null;
  }

  return absolutePath;
}

/** AST 编辑影响的单个文件信息（仅 ast_edit 操作使用） */
export interface AstAffectedFile {
  filePath: string;
  originalContent: string;
  newContent: string;
}

/** 文件操作结果 */
export interface FileOpResult {
  /** 操作是否成功 */
  success: boolean;
  /** 操作结果内容（文件内容、目录列表等） */
  content: string;
  /** AST 编辑影响的文件列表，含原始与修改后的内容（仅 ast_edit 操作使用） */
  astAffectedFiles?: AstAffectedFile[];
  /** 编辑成功后 LSP 诊断的文本摘要（仅写操作成功后可能存在） */
  diagnosticsSummary?: string;
}

function countExactOccurrences(source: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  while (true) {
    const matchIndex = source.indexOf(search, startIndex);
    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = matchIndex + search.length;
  }
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildNormalizedTextPositionMap(source: string): { normalizedText: string; positionMap: number[] } {
  let normalizedText = '';
  const positionMap: number[] = [];
  let index = 0;

  while (index < source.length) {
    const currentChar = source[index];
    if (currentChar === '\r') {
      positionMap.push(index);
      normalizedText += '\n';
      if (source[index + 1] === '\n') {
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    positionMap.push(index);
    normalizedText += currentChar;
    index += 1;
  }

  positionMap.push(source.length);
  return { normalizedText, positionMap };
}

function detectPreferredLineEnding(...parts: string[]): '\r\n' | '\n' {
  for (const part of parts) {
    if (part.includes('\r\n')) {
      return '\r\n';
    }
  }

  return '\n';
}

function applyPreferredLineEnding(source: string, preferredLineEnding: '\r\n' | '\n'): string {
  const normalizedSource = normalizeLineEndings(source);
  if (preferredLineEnding === '\n') {
    return normalizedSource;
  }

  return normalizedSource.replace(/\n/g, '\r\n');
}

/**
 * Level 3 容错：忽略行首空白差异的逐行匹配
 * 当精确匹配和换行归一化匹配均失败时，尝试 trimStart 逐行比对
 * 只接受唯一匹配，避免误替换
 * @returns 替换后的完整文件内容，若不匹配或不唯一则返回 null
 */
function tryWhitespaceNormalizedLineMatch(
  fileContent: string,
  oldContent: string,
  newContent: string,
): string | null {
  const lineEnding = detectPreferredLineEnding(fileContent);
  const fileLines = normalizeLineEndings(fileContent).split('\n');
  const rawOldLines = normalizeLineEndings(oldContent).split('\n');

  // 去掉 old 首尾空行（模型经常多带空行）
  while (rawOldLines.length > 0 && rawOldLines[rawOldLines.length - 1].trim() === '') {
    rawOldLines.pop();
  }
  while (rawOldLines.length > 0 && rawOldLines[0].trim() === '') {
    rawOldLines.shift();
  }

  if (rawOldLines.length === 0) {
    return null;
  }

  const trimmedOldLines = rawOldLines.map(l => l.trimStart());

  // 在文件中查找所有连续匹配位置
  const matchIndices: number[] = [];
  for (let i = 0; i <= fileLines.length - trimmedOldLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < trimmedOldLines.length; j++) {
      if (fileLines[i + j].trimStart() !== trimmedOldLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      matchIndices.push(i);
    }
  }

  // 只接受唯一匹配
  if (matchIndices.length !== 1) {
    return null;
  }

  const matchStart = matchIndices[0];
  const matchEnd = matchStart + trimmedOldLines.length;
  const newLines = normalizeLineEndings(newContent).split('\n');

  const updatedLines = [
    ...fileLines.slice(0, matchStart),
    ...newLines,
    ...fileLines.slice(matchEnd),
  ];

  return applyPreferredLineEnding(updatedLines.join('\n'), lineEnding);
}

/**
 * 模糊匹配：在文件内容中找到与 old 最接近的连续行片段。
 * 当三级容错匹配全部失败时，用于自动降级为行号替换。
 *
 * 算法：滑动窗口（窗口大小 = old 行数），逐窗口计算 trimStart 后的行匹配率，
 * 返回匹配率最高的窗口。只有匹配率 > 40% 才认为找到了。
 *
 * @param fileContent 文件当前内容
 * @param oldContent 模型给出的“要替换的内容”（可能不准确）
 * @returns 最接近的匹配信息，或 null（未找到足够接近的内容）
 */
export function findClosestMatch(
  fileContent: string,
  oldContent: string,
): { startLine: number; endLine: number; matchRate: number } | null {
  const fileLines = normalizeLineEndings(fileContent).split('\n');
  let oldLines = normalizeLineEndings(oldContent).split('\n');

  // 去掉 old 首尾空行
  while (oldLines.length > 0 && oldLines[oldLines.length - 1].trim() === '') {
    oldLines.pop();
  }
  while (oldLines.length > 0 && oldLines[0].trim() === '') {
    oldLines.shift();
  }

  if (oldLines.length === 0 || oldLines.length > fileLines.length) {
    return null;
  }

  const trimmedOldLines = oldLines.map(l => l.trimStart());
  const windowSize = trimmedOldLines.length;
  let bestStart = -1;
  let bestScore = 0;

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    let matchCount = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fileLines[i + j].trimStart() === trimmedOldLines[j]) {
        matchCount += 1;
      }
    }
    if (matchCount > bestScore) {
      bestScore = matchCount;
      bestStart = i;
    }
  }

  const matchRate = bestScore / windowSize;
  if (matchRate < 0.4 || bestStart < 0) {
    return null;
  }

  return {
    startLine: bestStart + 1,       // 1-indexed
    endLine: bestStart + windowSize, // 1-indexed, inclusive
    matchRate,
  };
}

export function buildEditedContent(
  fileContent: string,
  oldContent: string,
  newContent: string,
  options?: { replaceAll?: boolean },
):
  | { success: true; updatedContent: string; usedNormalizedMatch: boolean; replacedCount?: number }
  | { success: false; reason: 'missing-old' | 'not-found' | 'not-unique'; matchCount?: number } {
  if (!oldContent) {
    return { success: false, reason: 'missing-old' };
  }

  const replaceAll = options?.replaceAll ?? false;
  const exactMatchCount = countExactOccurrences(fileContent, oldContent);
  const preferredLineEnding = detectPreferredLineEnding(fileContent, oldContent, newContent);
  const replacementContent = applyPreferredLineEnding(newContent, preferredLineEnding);

  if (exactMatchCount === 1) {
    const matchIndex = fileContent.indexOf(oldContent);
    return {
      success: true,
      updatedContent: fileContent.slice(0, matchIndex) + replacementContent + fileContent.slice(matchIndex + oldContent.length),
      usedNormalizedMatch: false,
    };
  }

  if (exactMatchCount > 1) {
    // replaceAll 模式：替换所有精确匹配
    if (replaceAll) {
      const updatedContent = fileContent.split(oldContent).join(replacementContent);
      return {
        success: true,
        updatedContent,
        usedNormalizedMatch: false,
        replacedCount: exactMatchCount,
      };
    }
    return { success: false, reason: 'not-unique', matchCount: exactMatchCount };
  }

  const { normalizedText: normalizedFileContent, positionMap } = buildNormalizedTextPositionMap(fileContent);
  const normalizedOldContent = normalizeLineEndings(oldContent);
  const normalizedMatchCount = countExactOccurrences(normalizedFileContent, normalizedOldContent);
  if (normalizedMatchCount === 0) {
    // Level 3：行首空白容错匹配 — 忽略缩进差异，逐行 trimStart 比对
    const wsResult = tryWhitespaceNormalizedLineMatch(fileContent, oldContent, newContent);
    if (wsResult) {
      return { success: true, updatedContent: wsResult, usedNormalizedMatch: true };
    }
    return { success: false, reason: 'not-found' };
  }

  if (normalizedMatchCount > 1) {
    // replaceAll 模式：替换所有归一化匹配
    if (replaceAll) {
      const updatedContent = normalizedFileContent.split(normalizedOldContent).join(replacementContent);
      // 归一化模式下 replaceAll 后统一使用文件原有换行风格
      const finalContent = applyPreferredLineEnding(updatedContent, preferredLineEnding);
      return {
        success: true,
        updatedContent: finalContent,
        usedNormalizedMatch: true,
        replacedCount: normalizedMatchCount,
      };
    }
    return { success: false, reason: 'not-unique', matchCount: normalizedMatchCount };
  }

  const normalizedMatchIndex = normalizedFileContent.indexOf(normalizedOldContent);
  const matchStartIndex = positionMap[normalizedMatchIndex];
  const matchEndIndex = positionMap[normalizedMatchIndex + normalizedOldContent.length];
  return {
    success: true,
    updatedContent: fileContent.slice(0, matchStartIndex) + replacementContent + fileContent.slice(matchEndIndex),
    usedNormalizedMatch: true,
  };
}

/**
 * 行号定位编辑：替换指定行范围的内容
 *
 * 相比文本匹配编辑，行号定位不需要模型精确复现原始文本，
 * 只需记住 read_file 返回的行号即可，显著降低编辑失败率。
 *
 * @param fileContent 文件当前内容
 * @param startLine 替换起始行（1-indexed，含）
 * @param endLine 替换结束行（1-indexed，含）；省略时等于 startLine
 * @param newContent 替换后的新内容
 */
export function buildLineBasedEditContent(
  fileContent: string,
  startLine: number,
  endLine: number | undefined,
  newContent: string,
):
  | { success: true; updatedContent: string }
  | { success: false; reason: 'invalid-range'; message: string } {

  const effectiveEndLine = endLine ?? startLine;

  // 基本校验
  if (startLine < 1 || effectiveEndLine < startLine) {
    return {
      success: false,
      reason: 'invalid-range',
      message: `无效的行号范围: start_line=${startLine}, end_line=${effectiveEndLine}。start_line 必须 >= 1，end_line 必须 >= start_line`,
    };
  }

  // 保留文件原有的换行风格
  const lineEnding = detectPreferredLineEnding(fileContent);
  const lines = normalizeLineEndings(fileContent).split('\n');

  if (startLine > lines.length) {
    return {
      success: false,
      reason: 'invalid-range',
      message: `start_line=${startLine} 超出文件总行数 ${lines.length}。请重新读取文件确认行号`,
    };
  }

  // 容许 endLine 超出文件末尾（自动截断到最后一行）
  const clampedEndLine = Math.min(effectiveEndLine, lines.length);

  // 0-indexed
  const startIdx = startLine - 1;
  const endIdx = clampedEndLine; // slice 不含 endIdx，正好对应 1-indexed 的“含”语义

  const newLines = normalizeLineEndings(newContent).split('\n');
  const updatedLines = [
    ...lines.slice(0, startIdx),
    ...newLines,
    ...lines.slice(endIdx),
  ];

  const updatedContent = applyPreferredLineEnding(updatedLines.join('\n'), lineEnding);
  return { success: true, updatedContent };
}

/**
 * 读取文件内容
 * @param filePath 文件路径（绝对路径或相对于工作区的路径）
 */
export async function readFile(filePath: string): Promise<FileOpResult> {
  const safePath = resolveAndValidatePath(filePath);
  if (!safePath) {
    return { success: false, content: `无法访问文件: ${filePath}（路径不在工作区范围内或未打开工作区）` };
  }

  try {
    try {
      await fsp.access(safePath);
    } catch {
      return { success: false, content: `文件不存在: ${safePath}` };
    }

    const stat = await fsp.stat(safePath);
    // 限制读取大小，防止读取超大文件导致内存溢出
    const MAX_SIZE = 512 * 1024; // 512KB
    if (stat.size > MAX_SIZE) {
      return { success: false, content: `文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过 512KB 限制: ${safePath}` };
    }

    // 根据文件名和扩展名判断是否应跳过
    const fileName = path.basename(safePath);
    const fileExt = path.extname(safePath).toLowerCase();

    if (SKIP_FILE_NAMES.has(fileName)) {
      info(`跳过无意义文件: ${safePath}`);
      return { success: true, content: `[已跳过] ${fileName} 是依赖锁定/系统文件，不含有用代码信息` };
    }
    if (SKIP_EXTENSIONS.has(fileExt)) {
      info(`跳过二进制/无意义扩展名文件: ${safePath}`);
      return { success: true, content: `[已跳过] ${fileName} 是二进制或编译产物文件` };
    }

    const content = await fsp.readFile(safePath, 'utf-8');

    // 超长文件截断，避免单个文件占用过多模型上下文
    if (content.length > MAX_CONTENT_CHARS) {
      const truncated = content.slice(0, MAX_CONTENT_CHARS);
      info(`读取文件(截断): ${safePath} (原 ${content.length} 字符 → ${MAX_CONTENT_CHARS} 字符)`);
      return {
        success: true,
        content: truncated + `\n\n[文件已截断，仅显示前 ${MAX_CONTENT_CHARS} 字符，原始长度 ${content.length} 字符]`,
      };
    }

    info(`读取文件: ${safePath} (${content.length} 字符)`);
    return { success: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, content: `读取文件失败: ${msg}` };
  }
}

/**
 * 写入文件（创建或覆盖）
 * @param filePath 文件路径
 * @param content 要写入的内容
 */
export async function writeFile(filePath: string, content: string): Promise<FileOpResult> {
  const safePath = resolveAndValidatePath(filePath);
  if (!safePath) {
    return { success: false, content: `无法写入文件: ${filePath}（路径不在工作区范围内或未打开工作区）` };
  }

  try {
    // 自动创建父目录
    const dir = path.dirname(safePath);
    await fsp.mkdir(dir, { recursive: true });

    await fsp.writeFile(safePath, content, 'utf-8');
    info(`写入文件: ${safePath} (${content.length} 字符)`);
    return { success: true, content: `文件已写入: ${safePath}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, content: `写入文件失败: ${msg}` };
  }
}

/**
 * 编辑文件：支持文本匹配模式和行号定位模式
 * @param filePath 文件路径
 * @param oldContent 要被替换的原始内容（文本模式必填，行号模式不需要）
 * @param newContent 替换后的新内容
 * @param options.replaceAll 是否替换所有匹配（默认 false，仅替换唯一匹配）
 * @param options.startLine 行号模式：替换起始行（1-indexed）
 * @param options.endLine 行号模式：替换结束行（1-indexed）
 */
export async function editFile(
  filePath: string,
  oldContent: string,
  newContent: string,
  options?: { replaceAll?: boolean; startLine?: number; endLine?: number },
): Promise<FileOpResult> {
  const safePath = resolveAndValidatePath(filePath);
  if (!safePath) {
    return { success: false, content: `无法编辑文件: ${filePath}（路径不在工作区范围内或未打开工作区）` };
  }

  try {
    try {
      await fsp.access(safePath);
    } catch {
      return { success: false, content: `文件不存在: ${safePath}` };
    }

    const fileContent = await fsp.readFile(safePath, 'utf-8');

    // 行号定位模式：用 start_line/end_line 直接替换指定行
    if (options?.startLine !== undefined) {
      const lineResult = buildLineBasedEditContent(fileContent, options.startLine, options.endLine, newContent);
      if (!lineResult.success) {
        return { success: false, content: `${lineResult.message}: ${safePath}` };
      }
      await fsp.writeFile(safePath, lineResult.updatedContent, 'utf-8');
      const rangeDesc = options.endLine ? `L${options.startLine}-L${options.endLine}` : `L${options.startLine}`;
      info(`编辑文件(行号模式): ${safePath} (${rangeDesc})`);
      return { success: true, content: `文件已编辑(行号模式 ${rangeDesc}): ${safePath}` };
    }

    // 文本匹配模式：原有逻辑
    const editResult = buildEditedContent(fileContent, oldContent, newContent, { replaceAll: options?.replaceAll });
    if (!editResult.success) {
      if (editResult.reason === 'missing-old') {
        return { success: false, content: `编辑操作缺少 old 内容: ${safePath}` };
      }

      if (editResult.reason === 'not-found') {
        // 自动降级：用模糊匹配找到最接近的位置，转换为行号模式完成编辑
        const closest = findClosestMatch(fileContent, oldContent);
        if (closest) {
          const lineResult = buildLineBasedEditContent(
            fileContent,
            closest.startLine,
            closest.endLine,
            newContent,
          );
          if (lineResult.success) {
            await fsp.writeFile(safePath, lineResult.updatedContent, 'utf-8');
            const pct = Math.round(closest.matchRate * 100);
            const rangeDesc = `L${closest.startLine}-L${closest.endLine}`;
            info(`编辑文件(自动降级行号模式 ${rangeDesc}, 匹配率 ${pct}%): ${safePath}`);
            return {
              success: true,
              content: `文件已编辑(自动转换为行号模式 ${rangeDesc}，匹配率 ${pct}%): ${safePath}`,
            };
          }
        }
        return { success: false, content: `未找到要替换的内容，文件未修改: ${safePath}` };
      }

      return {
        success: false,
        content: `要替换的内容在文件中出现了 ${editResult.matchCount} 次，请提供更精确的 old 内容以唯一定位: ${safePath}`,
      };
    }

    const replaceInfo = editResult.replacedCount
      ? `，共替换 ${editResult.replacedCount} 处`
      : '';
    await fsp.writeFile(safePath, editResult.updatedContent, 'utf-8');
    info(`编辑文件: ${safePath} (替换 ${oldContent.length} → ${newContent.length} 字符${editResult.usedNormalizedMatch ? '，已自动兼容换行差异' : ''}${replaceInfo})`);
    const resultMessage = editResult.replacedCount
      ? `文件已编辑: ${safePath}（已替换全部 ${editResult.replacedCount} 处匹配）`
      : `文件已编辑: ${safePath}`;
    return { success: true, content: resultMessage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, content: `编辑文件失败: ${msg}` };
  }
}

/**
 * 列出目录内容
 * @param dirPath 目录路径
 */
export async function listDir(dirPath: string): Promise<FileOpResult> {
  const safePath = resolveAndValidatePath(dirPath);
  if (!safePath) {
    return { success: false, content: `无法访问目录: ${dirPath}（路径不在工作区范围内或未打开工作区）` };
  }

  try {
    try {
      await fsp.access(safePath);
    } catch {
      return { success: false, content: `目录不存在: ${safePath}` };
    }

    const stat = await fsp.stat(safePath);
    if (!stat.isDirectory()) {
      return { success: false, content: `不是目录: ${safePath}` };
    }

    const entries = await fsp.readdir(safePath, { withFileTypes: true });

    // 格式化输出：目录用 📁 前缀，文件用 📄 前缀
    const lines = entries.map(entry => {
      const icon = entry.isDirectory() ? '[DIR]' : '[FILE]';
      return `${icon} ${entry.name}`;
    });

    info(`列出目录: ${safePath} (${entries.length} 项)`);
    return { success: true, content: lines.join('\n') || '(空目录)' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, content: `列出目录失败: ${msg}` };
  }
}
