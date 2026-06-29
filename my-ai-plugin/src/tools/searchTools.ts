/**
 * 文件搜索工具
 *
 * 提供两种搜索能力：
 * 1. search_file: 按文件名 glob 模式搜索（如 *.ts）
 * 2. grep_code: 按正则表达式搜索文件内容（优先 ripgrep，fallback JS 逐文件）
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { workspace } from 'vscode';
import { info, error } from '../logger';
import {
  getWorkspaceRootPaths,
  isPathWithinAnyWorkspaceFolder,
  isPathWithinRoot,
  toWorkspaceRelativePath,
} from '../utils/workspaceRoot';
import {
  DEFAULT_RIPGREP_MAX_MATCHES,
  grepWithRipgrep,
  tryGrepWithRipgrep,
  type RipgrepGrepMatch,
} from './ripgrep';

// ==================== 类型定义 ====================

export interface SearchFileResult {
  success: boolean;
  /** 匹配的文件列表（相对路径） */
  files?: string[];
  /** 错误信息 */
  content?: string;
}

export interface GrepCodeResult {
  success: boolean;
  /** 匹配结果列表 */
  matches?: GrepMatch[];
  /** 错误信息 */
  content?: string;
}

export interface GrepMatch {
  /** 文件路径（相对路径） */
  file: string;
  /** 行号（1-indexed） */
  line: number;
  /** 匹配的文本行 */
  text: string;
  /** 匹配的上下文（前后各 2 行） */
  context?: string;
}

const JS_FALLBACK_MAX_MATCHES = 100;

// ==================== 辅助函数 ====================

function toRelativePath(absolutePath: string): string {
  return toWorkspaceRelativePath(absolutePath);
}

function isWithinWorkspace(filePath: string): boolean {
  return isPathWithinAnyWorkspaceFolder(filePath);
}

function prefixMatchFilePath(
  folder: { name: string },
  relativeFile: string,
  multiRoot: boolean,
): string {
  if (!multiRoot) {
    return relativeFile;
  }
  return relativeFile ? `${folder.name}/${relativeFile}` : folder.name;
}

function validateRegex(regex: string, caseSensitive: boolean): RegExp | { error: string } {
  try {
    return new RegExp(regex, caseSensitive ? 'g' : 'gi');
  } catch {
    return { error: `无效的正则表达式: ${regex}` };
  }
}

function toGrepMatchesFromRipgrep(
  rawMatches: RipgrepGrepMatch[],
): GrepMatch[] {
  return rawMatches.map((match) => ({
    file: match.file,
    line: match.line,
    text: match.text,
    context: `${match.line}: ${match.text}`,
  }));
}

// ==================== search_file: 按文件名搜索 ====================

export async function searchFile(pattern: string): Promise<SearchFileResult> {
  try {
    const roots = getWorkspaceRootPaths();
    if (roots.length === 0) {
      return { success: false, content: '未打开工作区' };
    }

    const includePattern = pattern;
    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**';

    const uris = await workspace.findFiles(includePattern, excludePattern);

    if (uris.length === 0) {
      return { success: true, files: [] };
    }

    const files = uris
      .map((uri) => uri.fsPath)
      .filter((p) => isWithinWorkspace(p))
      .map((p) => toRelativePath(p))
      .sort();

    info(`search_file: 找到 ${files.length} 个匹配文件（模式: ${pattern}）`);
    return { success: true, files };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`search_file 失败: ${msg}`);
    return { success: false, content: `搜索失败: ${msg}` };
  }
}

// ==================== grep_code: 按内容搜索 ====================

export async function grepCodeWithJavaScript(
  regex: string,
  includePattern?: string,
  caseSensitive: boolean = false,
  workspaceRoot?: string,
): Promise<GrepCodeResult> {
  const folders = workspace.workspaceFolders ?? [];
  const roots = workspaceRoot
    ? [workspaceRoot]
    : folders.map((folder) => folder.uri.fsPath);
  if (roots.length === 0) {
    return { success: false, content: '未打开工作区' };
  }

  const validated = validateRegex(regex, caseSensitive);
  if ('error' in validated) {
    return { success: false, content: validated.error };
  }
  const re = validated;

  let filesToSearch: string[];
  if (includePattern) {
    const uris = await workspace.findFiles(includePattern, '**/node_modules/**,**/.git/**,**/dist/**,**/build/**');
    filesToSearch = uris
      .map((uri) => uri.fsPath)
      .filter((p) => isWithinWorkspace(p));
  } else {
    const commonPatterns = [
      '**/*.{ts,tsx,js,jsx}',
      '**/*.{py,java,c,cs,hpp,h}',
      '**/*.{vue,html,css,scss,sass}',
      '**/*.{md,json,yaml,yml,toml,xml}',
    ];

    const allUris: { fsPath: string }[] = [];
    for (const pattern of commonPatterns) {
      const uris = await workspace.findFiles(pattern, '**/node_modules/**,**/.git/**,**/dist/**,**/build/**');
      allUris.push(...uris);
    }

    filesToSearch = allUris
      .map((uri) => uri.fsPath)
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => isWithinWorkspace(p));
  }

  if (filesToSearch.length === 0) {
    return { success: true, matches: [] };
  }

  const scopedFiles = workspaceRoot
    ? filesToSearch.filter((filePath) => isPathWithinRoot(filePath, workspaceRoot))
    : filesToSearch;

  const matches: GrepMatch[] = [];
  const multiRoot = folders.length > 1;

  for (const filePath of scopedFiles) {
    if (matches.length >= JS_FALLBACK_MAX_MATCHES) {
      break;
    }

    const folder = folders.find((item) => isPathWithinAnyWorkspaceFolder(filePath, [item]));

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (re.test(line)) {
          const startLine = Math.max(0, i - 2);
          const endLine = Math.min(lines.length - 1, i + 2);
          const contextLines = lines.slice(startLine, endLine + 1);
          const relativeFile = folder
            ? path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/')
            : toRelativePath(filePath);

          matches.push({
            file: prefixMatchFilePath(folder ?? { name: '' }, relativeFile, multiRoot && !!folder),
            line: i + 1,
            text: line.trim(),
            context: contextLines.map((l, idx) => `${startLine + idx + 1}: ${l}`).join('\n'),
          });

          if (matches.length >= JS_FALLBACK_MAX_MATCHES) {
            break;
          }
        }

        re.lastIndex = 0;
      }
    } catch {
      continue;
    }
  }

  info(`grep_code(JS): 找到 ${matches.length} 个匹配（正则: ${regex}${includePattern ? `, 范围: ${includePattern}` : ''}）`);
  return { success: true, matches };
}

/**
 * 按正则表达式搜索文件内容
 */
export async function grepCode(
  regex: string,
  includePattern?: string,
  caseSensitive: boolean = false,
): Promise<GrepCodeResult> {
  try {
    const folders = workspace.workspaceFolders ?? [];
    const roots = getWorkspaceRootPaths(folders);
    if (roots.length === 0) {
      return { success: false, content: '未打开工作区' };
    }

    const validated = validateRegex(regex, caseSensitive);
    if ('error' in validated) {
      return { success: false, content: validated.error };
    }

    const multiRoot = folders.length > 1;
    const probe = await tryGrepWithRipgrep({
      regex,
      workspaceRoot: roots[0],
      includePattern,
      caseSensitive,
      maxMatches: DEFAULT_RIPGREP_MAX_MATCHES,
    });

    if (probe !== null) {
      const allMatches: GrepMatch[] = [];

      for (const folder of folders) {
        const rawMatches = folder.index === 0
          ? probe
          : await grepWithRipgrep({
            regex,
            workspaceRoot: folder.uri.fsPath,
            includePattern,
            caseSensitive,
            maxMatches: DEFAULT_RIPGREP_MAX_MATCHES - allMatches.length,
          });

        allMatches.push(
          ...toGrepMatchesFromRipgrep(rawMatches).map((match) => ({
            ...match,
            file: prefixMatchFilePath(folder, match.file, multiRoot),
          })),
        );

        if (allMatches.length >= DEFAULT_RIPGREP_MAX_MATCHES) {
          break;
        }
      }

      return {
        success: true,
        matches: allMatches.slice(0, DEFAULT_RIPGREP_MAX_MATCHES),
      };
    }

    if (folders.length === 1) {
      return grepCodeWithJavaScript(regex, includePattern, caseSensitive);
    }

    const mergedMatches: GrepMatch[] = [];
    for (const folder of folders) {
      const partial = await grepCodeWithJavaScript(
        regex,
        includePattern,
        caseSensitive,
        folder.uri.fsPath,
      );
      if (!partial.success) {
        return partial;
      }
      mergedMatches.push(...(partial.matches ?? []));
      if (mergedMatches.length >= JS_FALLBACK_MAX_MATCHES) {
        break;
      }
    }

    return {
      success: true,
      matches: mergedMatches.slice(0, JS_FALLBACK_MAX_MATCHES),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`grep_code 失败: ${msg}`);
    return { success: false, content: `搜索失败: ${msg}` };
  }
}
