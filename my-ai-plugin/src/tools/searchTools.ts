/**
 * 文件搜索工具
 * 
 * 提供两种搜索能力：
 * 1. search_file: 按文件名 glob 模式搜索（如 *.ts）
 * 2. grep_code: 按正则表达式搜索文件内容（如 function\\s+handleAuth）
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { workspace } from 'vscode';
import { info, error } from '../logger';

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

// ==================== 辅助函数 ====================

/**
 * 获取工作区根目录
 */
function getWorkspaceRoot(): string | null {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return folders[0].uri.fsPath;
}

/**
 * 将绝对路径转换为相对于工作区的路径
 */
function toRelativePath(absolutePath: string): string {
  const root = getWorkspaceRoot();
  if (!root) {
    return absolutePath;
  }
  return path.relative(root, absolutePath);
}

/**
 * 验证路径是否在工作区内
 */
function isWithinWorkspace(filePath: string): boolean {
  const root = getWorkspaceRoot();
  if (!root) {
    return false;
  }
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRoot = path.resolve(root);
  return normalizedFilePath.startsWith(normalizedRoot + path.sep) || normalizedFilePath === normalizedRoot;
}

// ==================== search_file: 按文件名搜索 ====================

/**
 * 按文件名 glob 模式搜索文件
 * @param pattern - glob 模式，例如 "*.ts"
 * @returns 匹配的文件列表（相对路径）
 */
export async function searchFile(pattern: string): Promise<SearchFileResult> {
  try {
    const root = getWorkspaceRoot();
    if (!root) {
      return { success: false, content: '未打开工作区' };
    }

    // 使用 VS Code 的 findFiles API
    const includePattern = pattern;
    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**';
    
    const uris = await workspace.findFiles(includePattern, excludePattern);
    
    if (uris.length === 0) {
      return { success: true, files: [] };
    }

    // 过滤出工作区内的文件并转换为相对路径
    const files = uris
      .map(uri => uri.fsPath)
      .filter(p => isWithinWorkspace(p))
      .map(p => toRelativePath(p))
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

/**
 * 按正则表达式搜索文件内容
 * @param regex - 正则表达式字符串（不含 / 包裹），如 function\\s+handleAuth
 * @param includePattern - 可选的文件名 glob 模式，限制搜索范围，如 *.ts
 * @param caseSensitive - 是否区分大小写，默认 false
 * @returns 匹配结果列表（含行号和上下文）
 */
export async function grepCode(
  regex: string,
  includePattern?: string,
  caseSensitive: boolean = false,
): Promise<GrepCodeResult> {
  try {
    const root = getWorkspaceRoot();
    if (!root) {
      return { success: false, content: '未打开工作区' };
    }

    // 编译正则表达式
    let re: RegExp;
    try {
      re = new RegExp(regex, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return { success: false, content: `无效的正则表达式: ${regex}` };
    }

    // 确定要搜索的文件
    let filesToSearch: string[];
    if (includePattern) {
      const uris = await workspace.findFiles(includePattern, '**/node_modules/**,**/.git/**,**/dist/**,**/build/**');
      filesToSearch = uris
        .map(uri => uri.fsPath)
        .filter(p => isWithinWorkspace(p));
    } else {
      // 无 includePattern 时搜索所有常见代码文件
      const commonPatterns = [
        '**/*.{ts,tsx,js,jsx}',
        '**/*.{py,java,c,cs,hpp,h}',
        '**/*.{vue,html,css,scss,sass}',
        '**/*.{md,json,yaml,yml,toml,xml}',
      ];
      
      const allUris: any[] = [];
      for (const pattern of commonPatterns) {
        const uris = await workspace.findFiles(pattern, '**/node_modules/**,**/.git/**,**/dist/**,**/build/**');
        allUris.push(...uris);
      }
      
      filesToSearch = allUris
        .map(uri => uri.fsPath)
        .filter((p, i, arr) => arr.indexOf(p) === i) // 去重
        .filter(p => isWithinWorkspace(p));
    }

    if (filesToSearch.length === 0) {
      return { success: true, matches: [] };
    }

    // 逐文件搜索
    const matches: GrepMatch[] = [];
    const MAX_MATCHES = 100; // 限制最大返回数，避免过多

    for (const filePath of filesToSearch) {
      if (matches.length >= MAX_MATCHES) {
        break;
      }

      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (re.test(line)) {
            // 提取上下文（前后各 2 行）
            const startLine = Math.max(0, i - 2);
            const endLine = Math.min(lines.length - 1, i + 2);
            const contextLines = lines.slice(startLine, endLine + 1);
            
            matches.push({
              file: toRelativePath(filePath),
              line: i + 1, // 1-indexed
              text: line.trim(),
              context: contextLines.map((l, idx) => `${startLine + idx + 1}: ${l}`).join('\n'),
            });

            if (matches.length >= MAX_MATCHES) {
              break;
            }
          }
          
          // 重置正则 lastIndex（因为使用了 /g 标志）
          re.lastIndex = 0;
        }
      } catch (err) {
        // 跳过无法读取的文件
        continue;
      }
    }

    info(`grep_code: 找到 ${matches.length} 个匹配（正则: ${regex}${includePattern ? `, 范围: ${includePattern}` : ''}）`);
    return { success: true, matches };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`grep_code 失败: ${msg}`);
    return { success: false, content: `搜索失败: ${msg}` };
  }
}
