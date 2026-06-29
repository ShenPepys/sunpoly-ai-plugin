/**
 * ripgrep 封装：优先 bundled @vscode/ripgrep，其次系统 PATH 中的 rg。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { info } from '../logger';

export const DEFAULT_RIPGREP_MAX_MATCHES = 500;

export interface RipgrepGrepOptions {
  regex: string;
  workspaceRoot: string;
  includePattern?: string;
  caseSensitive?: boolean;
  maxMatches?: number;
}

export interface RipgrepGrepMatch {
  file: string;
  line: number;
  text: string;
}

export type SpawnRipgrepFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ChildProcess;

type RipgrepPathResolver = () => Promise<string>;

const DEFAULT_EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
];

const DEFAULT_INCLUDE_GLOBS = [
  '**/*.{ts,tsx,js,jsx}',
  '**/*.{py,java,c,cs,hpp,h}',
  '**/*.{vue,html,css,scss,sass}',
  '**/*.{md,json,yaml,yml,toml,xml}',
];

const defaultSpawnRipgrep: SpawnRipgrepFn = (command, args, options) =>
  spawn(command, args, options ?? {}) as ChildProcess;

let spawnRipgrepImpl: SpawnRipgrepFn = defaultSpawnRipgrep;
let resolveRipgrepPathImpl: RipgrepPathResolver = resolveRipgrepPathInternal;

export function setRipgrepSpawnForTesting(impl: SpawnRipgrepFn | null): void {
  spawnRipgrepImpl = impl ?? defaultSpawnRipgrep;
}

export function setRipgrepPathResolverForTesting(impl: RipgrepPathResolver | null): void {
  resolveRipgrepPathImpl = impl ?? resolveRipgrepPathInternal;
}

export async function resolveRipgrepPath(): Promise<string> {
  return resolveRipgrepPathImpl();
}

export async function isRipgrepAvailable(): Promise<boolean> {
  try {
    await resolveRipgrepPath();
    return true;
  } catch {
    return false;
  }
}

async function resolveRipgrepPathInternal(): Promise<string> {
  const bundled = getBundledRipgrepPath();
  if (bundled && await isExecutable(bundled)) {
    return bundled;
  }

  const systemCandidates = getSystemRipgrepCandidates();
  for (const candidate of systemCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error('ripgrep binary not found');
}

function getBundledRipgrepPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ripgrep = require('@vscode/ripgrep') as { rgPath?: string };
    if (ripgrep?.rgPath) {
      return ripgrep.rgPath;
    }
  } catch {
    // optional at runtime in tests
  }
  return null;
}

function getSystemRipgrepCandidates(): string[] {
  if (process.platform === 'win32') {
    return ['rg.exe'];
  }
  return ['rg', '/usr/bin/rg', '/opt/homebrew/bin/rg', '/usr/local/bin/rg'];
}

async function isExecutable(filePath: string): Promise<boolean> {
  if (!filePath || filePath === 'rg' || filePath === 'rg.exe') {
    return true;
  }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function buildRipgrepArgs(options: RipgrepGrepOptions): string[] {
  const args = [
    '--json',
    '--line-number',
    '--no-heading',
    '--color=never',
    '--max-columns',
    '2000',
  ];

  if (!options.caseSensitive) {
    args.push('-i');
  }

  args.push('-e', options.regex);

  const includeGlobs = options.includePattern
    ? [options.includePattern]
    : DEFAULT_INCLUDE_GLOBS;

  for (const glob of includeGlobs) {
    args.push('-g', glob);
  }

  for (const glob of DEFAULT_EXCLUDE_GLOBS) {
    args.push('-g', glob);
  }

  args.push(options.workspaceRoot);
  return args;
}

export function parseRipgrepJsonLine(
  line: string,
  workspaceRoot: string,
): RipgrepGrepMatch | null {
  let parsed: {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
    };
  };

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed.type !== 'match' || !parsed.data?.path?.text || !parsed.data.line_number) {
    return null;
  }

  const absolutePath = parsed.data.path.text;
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const normalized = relativePath.split(path.sep).join('/');

  return {
    file: normalized,
    line: parsed.data.line_number,
    text: (parsed.data.lines?.text ?? '').replace(/\r?\n$/, '').trim(),
  };
}

export async function grepWithRipgrep(options: RipgrepGrepOptions): Promise<RipgrepGrepMatch[]> {
  const rgPath = await resolveRipgrepPath();
  const args = buildRipgrepArgs(options);
  const maxMatches = options.maxMatches ?? DEFAULT_RIPGREP_MAX_MATCHES;

  return new Promise((resolve, reject) => {
    const matches: RipgrepGrepMatch[] = [];
    let stderr = '';
    let settled = false;

    const rgProcess = spawnRipgrepImpl(rgPath, args, {
      cwd: options.workspaceRoot,
      windowsHide: true,
    });

    let exitCode: number | null = null;
    let rl: readline.Interface | null = null;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      rl?.close();
      if (error) {
        reject(error);
        return;
      }
      resolve(matches);
    };

    if (!rgProcess.stdout) {
      finish(new Error('ripgrep stdout unavailable'));
      return;
    }

    rl = readline.createInterface({ input: rgProcess.stdout });

    rl.on('line', (line) => {
      if (matches.length >= maxMatches) {
        rgProcess.kill();
        return;
      }

      const match = parseRipgrepJsonLine(line, options.workspaceRoot);
      if (match) {
        matches.push(match);
      }
    });

    rgProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    rgProcess.on('close', (code) => {
      exitCode = code;
    });

    rl.on('close', () => {
      queueMicrotask(() => {
        if (matches.length > 0 || exitCode === 0 || exitCode === 1) {
          finish();
          return;
        }

        const message = stderr.trim() || `ripgrep exited with code ${exitCode ?? 'unknown'}`;
        finish(new Error(message));
      });
    });

    rgProcess.on('error', (error) => {
      finish(new Error(`ripgrep failed to spawn: ${error.message}`));
    });
  });
}

export async function tryGrepWithRipgrep(
  options: RipgrepGrepOptions,
): Promise<RipgrepGrepMatch[] | null> {
  try {
    const matches = await grepWithRipgrep(options);
    info(`grep_code: ripgrep 找到 ${matches.length} 个匹配`);
    return matches;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    info(`grep_code: ripgrep 不可用或失败，将 fallback JS: ${message}`);
    return null;
  }
}
