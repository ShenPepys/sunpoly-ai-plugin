/**
 * 工作区项目统计分析工具
 *
 * 递归扫描多层级目录结构，统计文件类型分布、代码行数、目录深度等信息。
 * 帮助 AI 快速了解项目整体规模和结构。
 *
 * 功能：
 * 1. 按扩展名分类统计文件数量和行数
 * 2. 计算目录最大深度和总文件数
 * 3. 自动跳过常见无关目录（node_modules, .git, dist 等）
 * 4. 支持自定义排除规则和最大深度限制
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { workspace } from 'vscode';
import { info, error } from '../logger';

// ==================== 类型定义 ====================

/** 单个文件类型的统计数据 */
export interface FileStats {
  /** 该类型的文件数量 */
  count: number;
  /** 该类型文件的总行数 */
  lines: number;
  /** 该类型文件的总字节数 */
  bytes: number;
}

/** 目录节点统计 */
export interface DirStats {
  /** 目录名 */
  name: string;
  /** 相对路径（相对于工作区根目录） */
  relativePath: string;
  /** 该目录下的直接子文件数量 */
  fileCount: number;
  /** 该目录下的直接子目录数量 */
  dirCount: number;
  /** 最大嵌套深度（0 = 当前层） */
  maxDepth: number;
}

/** 整体工作区统计结果 */
export interface WorkspaceStats {
  /** 是否成功 */
  success: boolean;
  /** 工作区根目录的绝对路径 */
  rootPath?: string;
  /** 按扩展名分类的文件统计 */
  byExtension?: Record<string, FileStats>;
  /** 总文件数 */
  totalFiles?: number;
  /** 总行数（仅文本文件） */
  totalLines?: number;
  /** 总字节数 */
  totalBytes?: number;
  /** 最大目录深度 */
  maxDepth?: number;
  /** 各目录的统计信息（扁平列表） */
  directories?: DirStats[];
  /** 最大的 N 个文件 */
  largestFiles?: Array<{ path: string; bytes: number; lines: number }>;
  /** 扫描耗时（毫秒） */
  scanTimeMs?: number;
  /** 错误信息 */
  errorMessage?: string;
}

// ==================== 配置常量 ====================

/**
 * 默认跳过的目录名（精确匹配）
 * 这些目录通常包含生成文件、依赖或缓存，对项目分析没有意义
 */
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.vscode',
  '.idea',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  'target',
  'bin',
  'obj',
  '.test-dist',
  '.vscode-test',
  'coverage',
  '.nyc_output',
]);

/**
 * 默认跳过的文件扩展名（二进制或生成文件）
 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.map', '.pyc', '.class', '.o', '.obj',
  '.vsix',
]);

/** 单个文件读取行数时的最大字节数（超过此大小只记录字节数不统计行数） */
const MAX_BYTES_FOR_LINE_COUNT = 512 * 1024; // 512 KB

/** 返回的最大文件列表数量 */
const TOP_LARGEST_FILES = 10;

// ==================== 核心实现 ====================

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
 * 安全校验：确保目标路径在工作区范围内
 */
function safePath(rootDir: string, targetPath: string): string | null {
  const resolved = path.resolve(rootDir, targetPath);
  const normalizedRoot = path.resolve(rootDir);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return null;
  }
  return resolved;
}

/**
 * 统计文本文件的行数
 * 对大文件跳过行数统计以避免性能问题
 */
async function countLines(filePath: string, fileSize: number): Promise<number> {
  if (fileSize > MAX_BYTES_FOR_LINE_COUNT) {
    return 0;
  }

  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    // 空文件算 0 行，非空文件行数 = 换行符数 + 1（如果最后一行没有换行）
    if (content.length === 0) {
      return 0;
    }
    const newlineCount = content.split('\n').length;
    // split('\n') 对 "a\nb\n" 返回 ["a","b",""] 长度 3，实际 2 行
    return content.endsWith('\n') ? newlineCount - 1 : newlineCount;
  } catch {
    // 二进制文件读取为 UTF-8 可能失败，返回 0 行
    return 0;
  }
}

/**
 * 获取扩展名（统一小写），无扩展名返回 '(no ext)'
 */
function getExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext || '(no ext)';
}

/**
 * 递归扫描目录，收集统计数据
 *
 * @param absDir 当前扫描目录的绝对路径
 * @param rootDir 工作区根目录的绝对路径
 * @param currentDepth 当前深度（0 = 根目录）
 * @param maxScanDepth 最大扫描深度（-1 表示无限制）
 * @param skipDirs 需要跳过的目录名集合
 * @param stats 累积统计结果（按引用传递）
 * @param dirStatsList 目录统计列表（按引用传递）
 * @param fileList 所有文件信息列表（按引用传递）
 */
async function scanDirectory(
  absDir: string,
  rootDir: string,
  currentDepth: number,
  maxScanDepth: number,
  skipDirs: Set<string>,
  stats: Record<string, FileStats>,
  dirStatsList: DirStats[],
  fileList: Array<{ absPath: string; relPath: string; bytes: number; lines: number }>,
): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    // 权限不足或目录不存在，跳过
    return 0;
  }

  const relativePath = path.relative(rootDir, absDir) || '.';
  let fileCount = 0;
  let dirCount = 0;
  let maxChildDepth = 0;

  // 先处理文件（同步收集，异步统计行数）
  const lineCountPromises: Promise<void>[] = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      const fileName = entry.name;
      const ext = getExtension(fileName);

      // 跳过不需要的文件类型
      if (SKIP_EXTENSIONS.has(ext)) {
        continue;
      }

      const absPath = path.join(absDir, fileName);
      fileCount++;

      lineCountPromises.push(
        (async () => {
          try {
            const stat = await fsp.stat(absPath);
            const lines = await countLines(absPath, stat.size);
            const relPath = path.relative(rootDir, absPath);

            // 累积扩展名统计
            if (!stats[ext]) {
              stats[ext] = { count: 0, lines: 0, bytes: 0 };
            }
            stats[ext].count++;
            stats[ext].lines += lines;
            stats[ext].bytes += stat.size;

            // 记录文件信息（用于 Top N 最大文件）
            fileList.push({ absPath, relPath, bytes: stat.size, lines });
          } catch {
            // 文件可能已被删除或无法访问，忽略
          }
        })(),
      );
    }
  }

  // 等待所有文件的行数统计完成
  await Promise.all(lineCountPromises);

  // 递归处理子目录
  if (maxScanDepth === -1 || currentDepth < maxScanDepth) {
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirName = entry.name;

        // 跳过配置的忽略目录和隐藏目录（以 . 开头的目录，除了 .gitignore 等配置文件）
        if (skipDirs.has(dirName)) {
          continue;
        }

        dirCount++;
        const childAbsPath = path.join(absDir, dirName);
        const childDepth = await scanDirectory(
          childAbsPath,
          rootDir,
          currentDepth + 1,
          maxScanDepth,
          skipDirs,
          stats,
          dirStatsList,
          fileList,
        );
        maxChildDepth = Math.max(maxChildDepth, childDepth + 1);
      }
    }
  }

  // 记录目录统计
  dirStatsList.push({
    name: path.basename(absDir),
    relativePath,
    fileCount,
    dirCount,
    maxDepth: maxChildDepth,
  });

  return maxChildDepth;
}

// ==================== 公开 API ====================

/**
 * 分析工作区项目的统计信息
 *
 * @param targetDir 目标目录的相对路径（默认 '.' 即工作区根目录）
 * @param maxScanDepth 最大扫描深度（-1 = 无限制，默认 5）
 * @param extraSkipDirs 额外需要跳过的目录名
 * @returns 工作区统计结果
 */
export async function getWorkspaceStats(
  targetDir: string = '.',
  maxScanDepth: number = 5,
  extraSkipDirs?: string[],
): Promise<WorkspaceStats> {
  const startTime = Date.now();
  const rootDir = getWorkspaceRoot();

  if (!rootDir) {
    return { success: false, errorMessage: '未打开工作区，无法分析项目' };
  }

  const absTarget = safePath(rootDir, targetDir);
  if (!absTarget) {
    return { success: false, errorMessage: `路径 "${targetDir}" 不在工作区范围内` };
  }

  // 验证目标目录存在
  try {
    const dirStat = await fsp.stat(absTarget);
    if (!dirStat.isDirectory()) {
      return { success: false, errorMessage: `"${targetDir}" 不是目录` };
    }
  } catch {
    return { success: false, errorMessage: `目录 "${targetDir}" 不存在或无法访问` };
  }

  // 合并跳过目录集合
  const skipDirs = new Set(DEFAULT_SKIP_DIRS);
  if (extraSkipDirs) {
    for (const dir of extraSkipDirs) {
      skipDirs.add(dir);
    }
  }

  // 初始化累积变量
  const stats: Record<string, FileStats> = {};
  const dirStatsList: DirStats[] = [];
  const fileList: Array<{ absPath: string; relPath: string; bytes: number; lines: number }> = [];

  info(`[workspaceStats] 开始扫描: ${absTarget}, maxDepth=${maxScanDepth}`);

  try {
    const maxDepth = await scanDirectory(
      absTarget,
      absTarget,
      0,
      maxScanDepth,
      skipDirs,
      stats,
      dirStatsList,
      fileList,
    );

    // 计算总计
    let totalFiles = 0;
    let totalLines = 0;
    let totalBytes = 0;
    for (const ext of Object.keys(stats)) {
      totalFiles += stats[ext].count;
      totalLines += stats[ext].lines;
      totalBytes += stats[ext].bytes;
    }

    // 排序获取最大文件
    fileList.sort((a, b) => b.bytes - a.bytes);
    const largestFiles = fileList.slice(0, TOP_LARGEST_FILES).map(f => ({
      path: f.relPath,
      bytes: f.bytes,
      lines: f.lines,
    }));

    const scanTimeMs = Date.now() - startTime;
    info(`[workspaceStats] 扫描完成: ${totalFiles} 文件, ${totalLines} 行, ${scanTimeMs}ms`);

    return {
      success: true,
      rootPath: absTarget,
      byExtension: stats,
      totalFiles,
      totalLines,
      totalBytes,
      maxDepth,
      directories: dirStatsList,
      largestFiles,
      scanTimeMs,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    error(`[workspaceStats] 扫描失败: ${errMsg}`);
    return { success: false, errorMessage: `扫描失败: ${errMsg}` };
  }
}

/**
 * 将统计结果格式化为可读文本
 * 适合直接作为工具调用结果返回给 AI 模型
 */
export function formatWorkspaceStats(stats: WorkspaceStats): string {
  if (!stats.success) {
    return `❌ 统计失败: ${stats.errorMessage}`;
  }

  const lines: string[] = [];
  lines.push(`📊 工作区项目统计`);
  lines.push(`根目录: ${stats.rootPath}`);
  lines.push(`扫描耗时: ${stats.scanTimeMs}ms`);
  lines.push('');

  // 总览
  lines.push(`━━ 总览 ━━`);
  lines.push(`总文件数: ${stats.totalFiles}`);
  lines.push(`总代码行: ${stats.totalLines}`);
  lines.push(`总大小:   ${formatBytes(stats.totalBytes ?? 0)}`);
  lines.push(`最大目录深度: ${stats.maxDepth}`);
  lines.push('');

  // 按扩展名分类（按文件数降序）
  lines.push(`━━ 文件类型分布 ━━`);
  const sortedExts = Object.entries(stats.byExtension ?? {})
    .sort(([, a], [, b]) => b.count - a.count);

  lines.push(padRow('扩展名', '文件数', '行数', '大小'));
  lines.push('─'.repeat(50));
  for (const [ext, fileStats] of sortedExts) {
    lines.push(padRow(
      ext,
      String(fileStats.count),
      String(fileStats.lines),
      formatBytes(fileStats.bytes),
    ));
  }
  lines.push('');

  // Top 最大文件
  if (stats.largestFiles && stats.largestFiles.length > 0) {
    lines.push(`━━ 最大文件 Top ${stats.largestFiles.length} ━━`);
    for (let i = 0; i < stats.largestFiles.length; i++) {
      const f = stats.largestFiles[i];
      lines.push(`  ${i + 1}. ${f.path} (${formatBytes(f.bytes)}, ${f.lines} 行)`);
    }
    lines.push('');
  }

  // 目录结构概览（只显示有内容的目录）
  if (stats.directories && stats.directories.length > 0) {
    lines.push(`━━ 目录结构 (${stats.directories.length} 个目录) ━━`);
    // 按路径排序，深度优先
    const sorted = [...stats.directories].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
    for (const dir of sorted) {
      const indent = '  '.repeat(dir.relativePath.split(path.sep).length - 1);
      const prefix = dir.relativePath === '.' ? '' : indent;
      lines.push(`${prefix}📁 ${dir.name}/ (${dir.fileCount} 文件, ${dir.dirCount} 子目录, 深度 ${dir.maxDepth})`);
    }
  }

  return lines.join('\n');
}

// ==================== 辅助函数 ====================

/**
 * 格式化字节数为人类可读格式
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) { return '0 B'; }
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 填充行，用于表格对齐
 */
function padRow(col1: string, col2: string, col3: string, col4: string): string {
  return `  ${col1.padEnd(12)} ${col2.padStart(6)} ${col3.padStart(8)} ${col4.padStart(8)}`;
}
