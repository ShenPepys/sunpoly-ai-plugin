/** 危险命令模式（拒绝执行） */
export const DANGEROUS_PATTERNS = [
  /^\s*rm\s+(-[a-zA-Z]*\s+)*\//,
  /^\s*rm\s+(-[a-zA-Z]*\s+)*~/,
  /^\s*format\s+[a-zA-Z]:/,
  /^\s*del\s+\/[fFsS]/,
  /^\s*:\(\)\s*\{/,
  /^\s*mkfs\./,
  /^\s*dd\s+.*of=\/dev\//,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}
