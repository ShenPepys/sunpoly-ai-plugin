/**
 * 统一终端命令执行：优先 VS Code 集成终端，无 Shell Integration 时 fallback 到 spawn。
 */
import { execCommandViaSpawn } from './spawnTerminalProcess';
import { VscodeTerminalManager } from './vscodeTerminalManager';
import type { TerminalCompletionDetails } from './vscodeTerminalProcess';
import { getTerminalExecutionConfig } from '../config';

export type TerminalCommandRunResult = {
  success: boolean;
  output: string;
  exitCode: number | null;
  via: 'integrated' | 'spawn';
};

let sharedManager: VscodeTerminalManager | null = null;

function applyTerminalSettings(manager: VscodeTerminalManager): void {
  const settings = getTerminalExecutionConfig();
  manager.setShellIntegrationTimeout(settings.shellIntegrationTimeoutSeconds * 1000);
  manager.setShellIntegrationStreamTimeout(
    Math.max(settings.shellIntegrationTimeoutSeconds * 2500, 10_000),
  );
  manager.setTerminalReuseEnabled(settings.reuseTerminal);
}

export function getVscodeTerminalManager(): VscodeTerminalManager {
  if (!sharedManager) {
    sharedManager = new VscodeTerminalManager();
  }
  applyTerminalSettings(sharedManager);
  return sharedManager;
}

export function resetVscodeTerminalManagerForTesting(): void {
  sharedManager?.dispose();
  sharedManager = null;
}

async function runViaIntegratedTerminal(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<TerminalCommandRunResult> {
  const manager = getVscodeTerminalManager();
  const terminalInfo = await manager.getOrCreateTerminal(cwd);
  const terminalSettings = getTerminalExecutionConfig();
  if (terminalSettings.showTerminalOnRun) {
    terminalInfo.terminal.show();
  }

  const lines: string[] = [];
  let exitCode: number | null = null;
  let noShellIntegration = false;

  const process = manager.runCommand(terminalInfo, command);
  process.on('line', (line: string) => lines.push(line));
  process.on('no_shell_integration', () => {
    noShellIntegration = true;
  });
  process.on('completed', (details: TerminalCompletionDetails) => {
    exitCode = details.exitCode ?? null;
  });

  await Promise.race([
    process,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('INTEGRATED_TIMEOUT')), timeoutMs);
    }),
  ]);

  if (noShellIntegration) {
    throw new Error('NO_SHELL_INTEGRATION');
  }

  const output = lines.join('\n');
  const success = exitCode === 0 || exitCode === null;
  return {
    success,
    output,
    exitCode,
    via: 'integrated',
  };
}

async function runTerminalCommandInternal(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<TerminalCommandRunResult> {
  try {
    return await runViaIntegratedTerminal(command, cwd, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'INTEGRATED_TIMEOUT') {
      return {
        success: false,
        output: `命令执行超时（${timeoutMs}ms）`,
        exitCode: null,
        via: 'integrated',
      };
    }

    if (message === 'NO_SHELL_INTEGRATION') {
      const spawnResult = await execCommandViaSpawn(command, { cwd, timeoutMs });
      return {
        success: spawnResult.success,
        output: spawnResult.output,
        exitCode: spawnResult.exitCode,
        via: 'spawn',
      };
    }

    const spawnResult = await execCommandViaSpawn(command, { cwd, timeoutMs });
    return {
      success: spawnResult.success,
      output: spawnResult.output,
      exitCode: spawnResult.exitCode,
      via: 'spawn',
    };
  }
}

type RunTerminalCommandFn = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<TerminalCommandRunResult>;

let runTerminalCommandImpl: RunTerminalCommandFn = runTerminalCommandInternal;

export function setRunTerminalCommandForTesting(impl: RunTerminalCommandFn | null): void {
  runTerminalCommandImpl = impl ?? runTerminalCommandInternal;
}

export async function runTerminalCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<TerminalCommandRunResult> {
  return runTerminalCommandImpl(command, cwd, timeoutMs);
}

/** 截断过长命令输出 */
export function truncateCommandOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  return `${output.slice(0, maxChars)}\n\n[输出已截断，原始长度 ${output.length} 字符]`;
}
