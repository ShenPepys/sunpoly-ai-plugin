/**
 * 终端命令执行工具
 *
 * 在工作区中执行 shell 命令，优先走 VS Code 集成终端，fallback 到安全 spawn 子进程。
 */

import { workspace } from 'vscode';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_CHARS,
} from '../terminal/constants';
import {
  runTerminalCommand,
  truncateCommandOutput,
} from '../terminal/terminalCommandRunner';
import { info, error as logError } from '../logger';
import { isDangerousCommand } from './terminalExecSafety';
import type { ExecCommandResult } from './terminalExecTypes';

export type { ExecCommandResult } from './terminalExecTypes';
export {
  DEFAULT_COMMAND_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_CHARS as MAX_OUTPUT_CHARS,
} from '../terminal/constants';

export { isDangerousCommand, DANGEROUS_PATTERNS } from './terminalExecSafety';

/**
 * 在工作区根目录下执行 shell 命令
 */
export async function execCommand(
  command: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
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

  const result = await runTerminalCommand(command, cwd, timeoutMs);
  let output = result.output;

  if (!result.success && output && !output.includes('命令执行超时') && !output.includes('命令执行失败')) {
    logError(`终端命令失败 (exit ${result.exitCode ?? 'unknown'}, via ${result.via}): ${command}`);
  }

  if (!output && !result.success) {
    output = `命令执行失败 (exit code: ${result.exitCode ?? 'unknown'})`;
  }

  return {
    success: result.success,
    content: truncateCommandOutput(output, MAX_COMMAND_OUTPUT_CHARS),
  };
}

function getWorkspaceRoot(): string | undefined {
  const folders = workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
