/**
 * 子进程 fallback 命令执行（Shell Integration 不可用时使用）。
 * Windows PowerShell 显式绕过 Profile 与 ExecutionPolicy。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getShell } from './shell';

export interface SpawnCommandResult {
  success: boolean;
  output: string;
  exitCode: number | null;
}

export interface SpawnCommandOptions {
  cwd: string;
  shellPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 判断 shell 路径是否为 PowerShell / pwsh */
export function isPowerShellShell(shellPath: string): boolean {
  const lower = shellPath.toLowerCase();
  return lower.includes('powershell') || lower.includes('pwsh');
}

/**
 * 根据 shell 类型生成 spawn 参数。
 * Windows PowerShell：-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command
 * Windows cmd：/c
 * Unix：-l -c
 */
export function getShellArgs(shellPath: string, command: string): string[] {
  if (process.platform === 'win32') {
    if (isPowerShellShell(shellPath)) {
      return [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command,
      ];
    }
    return ['/c', command];
  }

  return ['-l', '-c', command];
}

export class SpawnTerminalProcess extends EventEmitter {
  private childProcess: ChildProcess | null = null;

  async run(
    command: string,
    options: SpawnCommandOptions,
  ): Promise<SpawnCommandResult> {
    const shellPath = options.shellPath ?? getShell();
    const args = getShellArgs(shellPath, command);
    const timeoutMs = options.timeoutMs ?? 30_000;

    return await new Promise<SpawnCommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: SpawnCommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.emit('completed', result);
        resolve(result);
      };

      const isCmdOnWindows =
        process.platform === 'win32' &&
        shellPath.toLowerCase().includes('cmd') &&
        !isPowerShellShell(shellPath);

      this.childProcess = isCmdOnWindows
        ? spawn('cmd.exe', args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          shell: true,
          windowsHide: true,
        })
        : spawn(shellPath, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        });

      const emitLine = (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) {
            this.emit('line', line);
          }
        }
      };

      this.childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        emitLine(text);
      });

      this.childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        emitLine(text);
      });

      this.childProcess.on('error', (error) => {
        this.emit('error', error);
        finish({
          success: false,
          output: error.message,
          exitCode: null,
        });
      });

      this.childProcess.on('close', (code) => {
        const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
        finish({
          success: code === 0,
          output: output || (code === 0 ? '' : `命令执行失败 (exit code: ${code ?? 'unknown'})`),
          exitCode: code,
        });
      });

      const timer = setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGTERM');
        }
        const partial = [stdout, stderr].filter(Boolean).join('\n');
        finish({
          success: false,
          output: partial
            ? `${partial}\n\n[命令执行超时 ${timeoutMs}ms]`
            : `命令执行超时（${timeoutMs}ms）`,
          exitCode: null,
        });
      }, timeoutMs);
    });
  }

  terminate(): void {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }
}

/** 一次性子进程执行（无事件流） */
export async function execCommandViaSpawn(
  command: string,
  options: SpawnCommandOptions,
): Promise<SpawnCommandResult> {
  const process = new SpawnTerminalProcess();
  return process.run(command, options);
}
