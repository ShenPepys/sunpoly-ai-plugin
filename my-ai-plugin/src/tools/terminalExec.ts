/**
 * 终端命令执行工具
 *
 * 允许 AI 在工作区中执行 shell 命令（如 npm install、git status 等），
 * 并返回命令输出结果。使用 Node.js child_process 实现。
 */

import { exec } from 'node:child_process';
import { workspace } from 'vscode';
import { info, error as logError } from '../logger';

// ==================== 类型定义 ====================

export interface ExecCommandResult {
  success: boolean;
  /** 命令输出（stdout + stderr） */
  content?: string;
}

// ==================== 常量 ====================

/** 命令执行超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 输出最大字符数，超出则截断 */
const MAX_OUTPUT_CHARS = 8192;

/** 危险命令模式（拒绝执行） */
const DANGEROUS_PATTERNS = [
  /^\s*rm\s+(-[a-zA-Z]*\s+)*\//,         // rm -rf /
  /^\s*rm\s+(-[a-zA-Z]*\s+)*~/,         // rm -rf ~
  /^\s*format\s+[a-zA-Z]:/,              // format C:
  /^\s*del\s+\/[fFsS]/,                  // del /f
  /^\s*:\(\)\s*\{/,                       // fork bomb
  /^\s*mkfs\./,                           // mkfs.ext4
  /^\s*dd\s+.*of=\/dev\//,               // dd to device
];

// ==================== 工具函数 ====================

/**
 * 检查命令是否匹配危险模式
 */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * 获取工作区根目录
 */
function getWorkspaceRoot(): string | undefined {
  const folders = workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

// ==================== 核心函数 ====================

/**
 * 在工作区根目录下执行 shell 命令
 *
 * @param command 要执行的命令
 * @param timeoutMs 超时毫秒数（默认 30 秒）
 * @returns 命令执行结果
 */
export async function execCommand(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecCommandResult> {
  if (!command || !command.trim()) {
    return { success: false, content: '命令为空' };
  }

  if (isDangerousCommand(command.trim())) {
    return {
      success: false,
      content: `命令被拒绝：检测到危险操作。以下类型的命令不允许执行：\n- 删除系统目录（rm -rf /、rm -rf ~）\n- 格式化磁盘\n- 直接写入设备\n\n如果确实需要执行，请手动在终端中运行。`,
    };
  }

  const cwd = getWorkspaceRoot();
  if (!cwd) {
    return { success: false, content: '无法确定工作区根目录，请确保已打开一个工作区文件夹' };
  }

  info(`执行终端命令: ${command} (cwd: ${cwd})`);

  return new Promise<ExecCommandResult>((resolve) => {
    exec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB buffer
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      let output = '';

      if (stdout) { output += stdout; }
      if (stderr) { output += (output ? '\n' : '') + stderr; }

      if (err) {
        if (err.killed) {
          resolve({
            success: false,
            content: `命令执行超时（${timeoutMs}ms）：\n${output.slice(0, MAX_OUTPUT_CHARS)}`,
          });
          return;
        }

        const exitCode = err.code ?? 'unknown';
        logError(`终端命令失败 (exit ${exitCode}): ${command}`);

        if (!output) {
          output = `命令执行失败 (exit code: ${exitCode})`;
        }
      }

      // 截断过长输出
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出已截断，原始长度 ${output.length} 字符]`;
      }

      resolve({
        success: !err,
        content: output,
      });
    });
  });
}
