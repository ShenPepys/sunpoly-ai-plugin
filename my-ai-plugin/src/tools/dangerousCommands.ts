/**
 * 内置危险命令模式（单一来源，供 validateCommand / terminalExec 共用）
 */

/** 危险命令模式（拒绝执行） */
export const DANGEROUS_PATTERNS: RegExp[] = [
  // 删除系统根目录或 home
  /^\s*(?:sudo\s+)?rm\s+(?:-[a-zA-Z]+\s+)*\/(?:\s|$)/,
  /^\s*(?:sudo\s+)?rm\s+(?:-[a-zA-Z]+\s+)*~/,

  // 格式化磁盘（Windows / PowerShell）
  /^\s*format\s+[a-zA-Z]:/i,
  /^\s*Format-Volume\b/i,

  // Windows 强制递归删除
  /^\s*del\s+\/[fFsS]/i,
  /^\s*rmdir\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,

  // fork bomb
  /:\s*\(\s*\)\s*\{/,
  /:\(\)\s*\{[^}]*\|\s*:\s*&/,

  // 创建文件系统 / 低级格式化
  /^\s*mkfs\./i,

  // 向块设备写入
  /\bdd\s+.*\bof=\/dev\//i,
  /\bdd\s+.*\bof=\\\\\.\\/i,
  />\s*\/dev\/[a-z]/i,

  // diskpart 等分区破坏工具
  /^\s*diskpart\b/i,

  // 远程脚本直接管道执行
  /\bcurl\s+[^\s|]+\s*\|\s*(?:ba)?sh\b/i,
  /\bwget\s+[^\s|]+\s*\|\s*(?:ba)?sh\b/i,
  /\|\s*(?:ba)?sh\s*$/i,
];

/**
 * 检测单条命令片段是否匹配内置危险模式。
 * 链式命令应在调用方按段拆分后逐段校验（见 commandPermissions.validateCommand）。
 */
export function isDangerousCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed));
}
