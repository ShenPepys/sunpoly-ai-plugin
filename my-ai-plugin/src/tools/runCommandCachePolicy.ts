/**
 * run_command 成功后是否应清空 FileReadStateCache。
 * 只读命令（如 git diff）不应清空，避免模型反复 read_file。
 */
const READ_ONLY_COMMAND_PATTERNS: RegExp[] = [
  /\bgit\s+(diff|status|log|show|blame|branch|rev-parse|describe|diff-tree|shortlog|ls-files)\b/i,
  /\b(npm|pnpm|yarn)\s+(ls|list|view|outdated|why)\b/i,
  /^(dir|ls|type|cat|echo|pwd|cd|where|which|tree)\b/i,
  /\bfindstr\b/i,
  /\bselect-object\b/i,
  /\bget-content\b/i,
  /\bmore\b/i,
];

export function shouldInvalidateFileReadStateAfterCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }

  return !READ_ONLY_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}
