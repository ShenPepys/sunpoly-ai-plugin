/**
 * Windows PowerShell 可执行文件探测与解析。
 */
import { spawn } from 'node:child_process';
import {
  WINDOWS_POWERSHELL_7_PATH,
  WINDOWS_POWERSHELL_LEGACY_PATH,
} from './shell';

const POWERSHELL_PROBE_TIMEOUT_MS = 1200;

let resolvedPowerShellPromise: Promise<string> | null = null;
let probeWindowsExecutableImpl: (
  candidate: string,
  timeoutMs?: number,
) => Promise<boolean> = probeWindowsExecutable;

function uniquePreserveOrder(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getFallbackWindowsPowerShellPath(): string {
  return WINDOWS_POWERSHELL_LEGACY_PATH;
}

export function getWindowsPowerShellCandidates(): string[] {
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';

  const envAbsoluteCandidates = [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${programFiles}\\PowerShell\\6\\pwsh.exe`,
    WINDOWS_POWERSHELL_7_PATH,
    WINDOWS_POWERSHELL_LEGACY_PATH,
  ];

  const commandNameFallbacks = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'];

  return uniquePreserveOrder([...envAbsoluteCandidates, ...commandNameFallbacks]);
}

export function resetPowerShellResolverCacheForTesting(): void {
  resolvedPowerShellPromise = null;
  probeWindowsExecutableImpl = probeWindowsExecutable;
}

export function setPowerShellProbeForTesting(
  probeFn: ((candidate: string, timeoutMs?: number) => Promise<boolean>) | null,
): void {
  probeWindowsExecutableImpl = probeFn ?? probeWindowsExecutable;
}

export async function probeWindowsExecutable(
  candidate: string,
  timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      candidate,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion'],
      {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      },
    );

    let settled = false;

    const finish = (isAvailable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(isAvailable);
    };

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      finish(false);
    }, timeoutMs);

    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

export async function resolveWindowsPowerShellExecutable(): Promise<string> {
  if (!resolvedPowerShellPromise) {
    resolvedPowerShellPromise = (async () => {
      const candidates = getWindowsPowerShellCandidates();

      for (const candidate of candidates) {
        if (await probeWindowsExecutableImpl(candidate)) {
          return candidate;
        }
      }

      return getFallbackWindowsPowerShellPath();
    })();
  }

  return resolvedPowerShellPromise;
}
