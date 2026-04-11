/**
 * 文件操作模块
 * 
 * 提供 AI 可调用的文件操作能力：读取、写入、编辑、列出目录。
 * 所有操作均限制在工作区范围内，防止越权访问。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { info, error } from '../logger';

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

/** 文件操作结果 */
export interface FileOpResult {
  /** 操作是否成功 */
  success: boolean;
  /** 操作结果内容（文件内容、目录列表等） */
  content: string;
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
    if (!fs.existsSync(safePath)) {
      return { success: false, content: `文件不存在: ${safePath}` };
    }

    const stat = fs.statSync(safePath);
    // 限制读取大小，防止读取超大文件导致内存溢出
    const MAX_SIZE = 512 * 1024; // 512KB
    if (stat.size > MAX_SIZE) {
      return { success: false, content: `文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过 512KB 限制: ${safePath}` };
    }

    const content = fs.readFileSync(safePath, 'utf-8');
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
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(safePath, content, 'utf-8');
    info(`写入文件: ${safePath} (${content.length} 字符)`);
    return { success: true, content: `文件已写入: ${safePath}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, content: `写入文件失败: ${msg}` };
  }
}

/**
 * 编辑文件：查找并替换指定内容
 * @param filePath 文件路径
 * @param oldContent 要被替换的原始内容
 * @param newContent 替换后的新内容
 */
export async function editFile(filePath: string, oldContent: string, newContent: string): Promise<FileOpResult> {
  const safePath = resolveAndValidatePath(filePath);
  if (!safePath) {
    return { success: false, content: `无法编辑文件: ${filePath}（路径不在工作区范围内或未打开工作区）` };
  }

  try {
    if (!fs.existsSync(safePath)) {
      return { success: false, content: `文件不存在: ${safePath}` };
    }

    const fileContent = fs.readFileSync(safePath, 'utf-8');

    if (!fileContent.includes(oldContent)) {
      return { success: false, content: `未找到要替换的内容，文件未修改: ${safePath}` };
    }

    const matchCount = countExactOccurrences(fileContent, oldContent);
    if (matchCount > 1) {
      return {
        success: false,
        content: `要替换的内容在文件中出现了 ${matchCount} 次，请提供更精确的 old 内容以唯一定位: ${safePath}`,
      };
    }

    const updatedContent = fileContent.replace(oldContent, newContent);
    fs.writeFileSync(safePath, updatedContent, 'utf-8');
    info(`编辑文件: ${safePath} (替换 ${oldContent.length} → ${newContent.length} 字符)`);
    return { success: true, content: `文件已编辑: ${safePath}` };
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
    if (!fs.existsSync(safePath)) {
      return { success: false, content: `目录不存在: ${safePath}` };
    }

    const stat = fs.statSync(safePath);
    if (!stat.isDirectory()) {
      return { success: false, content: `不是目录: ${safePath}` };
    }

    const entries = fs.readdirSync(safePath, { withFileTypes: true });

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
