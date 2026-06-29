/**
 * 命令权限控制器：allow/deny glob、链式命令分段校验、重定向检测。
 */
import { getCommandPermissionsSettingValue } from '../config';
import { isDangerousCommand } from './terminalExecSafety';

export interface CommandPermissionsConfig {
  allow?: string[];
  deny?: string[];
  allowRedirects?: boolean;
}

export interface CommandValidationResult {
  allowed: boolean;
  reason?: string;
}

const CHAIN_OPERATORS = ['&&', '||', '|', ';'] as const;

const REDIRECT_PATTERN = /(^|\s)(?:\d*>>?|\d*<|&>)/;

let permissionsConfigOverride: CommandPermissionsConfig | null = null;

export function setCommandPermissionsForTesting(config: CommandPermissionsConfig | null): void {
  permissionsConfigOverride = config;
}

export function parseCommandPermissionsConfig(raw: unknown): CommandPermissionsConfig {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const source = raw as Record<string, unknown>;
  const allow = normalizePatternList(source.allow);
  const deny = normalizePatternList(source.deny);
  const allowRedirects = typeof source.allowRedirects === 'boolean'
    ? source.allowRedirects
    : undefined;

  return {
    allow: allow.length > 0 ? allow : undefined,
    deny: deny.length > 0 ? deny : undefined,
    allowRedirects,
  };
}

function normalizePatternList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function loadCommandPermissionsConfig(): CommandPermissionsConfig {
  if (permissionsConfigOverride) {
    return permissionsConfigOverride;
  }

  return parseCommandPermissionsConfig(getCommandPermissionsSettingValue());
}

export function globPatternToRegExp(pattern: string): RegExp {
  let regexBody = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      regexBody += '.*';
    } else if (ch === '?') {
      regexBody += '.';
    } else {
      regexBody += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regexBody}$`, 'i');
}

export function matchesCommandGlob(pattern: string, segment: string): boolean {
  const normalized = segment.trim();
  if (!normalized) {
    return false;
  }
  return globPatternToRegExp(pattern).test(normalized);
}

export function hasShellRedirect(segment: string): boolean {
  return REDIRECT_PATTERN.test(segment);
}

/**
 * 将链式命令拆分为逐段校验的子命令（忽略引号内的运算符）。
 */
export function splitCommandChain(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const rest = command.slice(i);
    const operator = CHAIN_OPERATORS.find((op) => rest.startsWith(op));
    if (operator) {
      const trimmed = current.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
      current = '';
      i += operator.length - 1;
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    segments.push(tail);
  }

  return segments;
}

function matchesAnyPattern(patterns: string[] | undefined, segment: string): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => matchesCommandGlob(pattern, segment));
}

export function validateCommandSegment(
  segment: string,
  config: CommandPermissionsConfig,
): CommandValidationResult {
  const trimmed = segment.trim();
  if (!trimmed) {
    return { allowed: false, reason: '命令片段为空' };
  }

  if (isDangerousCommand(trimmed)) {
    return { allowed: false, reason: '检测到内置危险命令模式' };
  }

  if (!config.allowRedirects && hasShellRedirect(trimmed)) {
    return { allowed: false, reason: '当前权限策略禁止 shell 重定向（>、<、>>）' };
  }

  if (matchesAnyPattern(config.deny, trimmed)) {
    return { allowed: false, reason: `命令匹配 deny 规则: ${trimmed}` };
  }

  if (config.allow && config.allow.length > 0 && !matchesAnyPattern(config.allow, trimmed)) {
    return { allowed: false, reason: `命令不在 allow 白名单内: ${trimmed}` };
  }

  return { allowed: true };
}

/**
 * 校验整条命令（含链式分段）；任一段失败则整体拒绝。
 */
export function validateCommand(
  command: string,
  config: CommandPermissionsConfig = loadCommandPermissionsConfig(),
): CommandValidationResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: '命令为空' };
  }

  const segments = splitCommandChain(trimmed);
  if (segments.length === 0) {
    return { allowed: false, reason: '命令为空' };
  }

  for (const segment of segments) {
    const result = validateCommandSegment(segment, config);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}
