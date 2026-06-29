import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { stripAnsi } from './ansiUtils';
import {
  NO_SHELL_INTEGRATION_WAIT_MS,
  SHELL_INTEGRATION_STREAM_TIMEOUT_MS,
  MAX_FULL_OUTPUT_SIZE,
} from './constants';
import { getLatestTerminalOutput } from './getLatestTerminalOutput';

type ShellIntegrationCapableTerminal = vscode.Terminal & {
  shellIntegration?: {
    cwd?: vscode.Uri;
    executeCommand?: (command: string) => {
      read: () => AsyncIterable<string>;
    };
  };
};

function getShellIntegration(terminal: vscode.Terminal): ShellIntegrationCapableTerminal['shellIntegration'] {
  return (terminal as ShellIntegrationCapableTerminal).shellIntegration;
}

export interface TerminalCompletionDetails {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export class VscodeTerminalProcess extends EventEmitter {
  waitForShellIntegration = true;
  private isListening = true;
  private buffer = '';
  private fullOutput = '';
  isHot = false;
  private exitCode: number | null | undefined = undefined;
  streamTimeoutMs = SHELL_INTEGRATION_STREAM_TIMEOUT_MS;

  async run(
    terminal: vscode.Terminal,
    command: string,
    streamTimeoutMs?: number,
  ): Promise<void> {
    this.exitCode = undefined;
    const timeout = streamTimeoutMs ?? this.streamTimeoutMs;

    const appendFallbackSnapshot = async (): Promise<void> => {
      try {
        const snapshot = await getLatestTerminalOutput();
        if (snapshot.trim()) {
          const message =
            `The command's output could not be captured via shell integration. ` +
            `Terminal snapshot:\n\n${snapshot}`;
          this.emit('line', message);
          this.fullOutput += message;
        }
      } catch {
        // 忽略剪贴板 fallback 失败
      }
    };

    const shellIntegration = getShellIntegration(terminal);
    if (shellIntegration?.executeCommand) {
      const execution = shellIntegration.executeCommand(command);
      const stream = execution.read();
      let streamAborted = false;
      const streamTimeoutHandle = setTimeout(() => {
        streamAborted = true;
      }, timeout);

      try {
        for await (const chunk of stream) {
          if (streamAborted) {
            break;
          }

          const completionMatch = chunk.match(/\]633;D(?:;(-?\d+))?/);
          if (completionMatch?.[1] !== undefined) {
            const parsed = Number.parseInt(completionMatch[1], 10);
            if (Number.isInteger(parsed)) {
              this.exitCode = parsed;
            }
          }

          const data = stripAnsi(chunk);
          this.fullOutput += data;
          if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
            this.fullOutput = this.fullOutput.slice(-MAX_FULL_OUTPUT_SIZE / 2);
          }
          if (this.isListening) {
            this.emitIfEol(data);
          }
        }
      } finally {
        clearTimeout(streamTimeoutHandle);
      }

      this.emitRemainingBuffer();
      if (!this.fullOutput.trim() || streamAborted) {
        await appendFallbackSnapshot();
      }

      this.emit('completed', this.getCompletionDetails());
      this.emit('continue');
      return;
    }

    this.emit('no_shell_integration');
    terminal.sendText(command, true);
    await new Promise((resolve) => setTimeout(resolve, NO_SHELL_INTEGRATION_WAIT_MS));
    await appendFallbackSnapshot();
    this.emit('completed', this.getCompletionDetails());
    this.emit('continue');
  }

  private emitIfEol(chunk: string): void {
    this.buffer += chunk;
    let lineEndIndex: number;
    while ((lineEndIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, lineEndIndex).trimEnd();
      this.emit('line', line);
      this.buffer = this.buffer.slice(lineEndIndex + 1);
    }
  }

  private emitRemainingBuffer(): void {
    if (this.buffer && this.isListening) {
      const remaining = this.buffer.trimEnd();
      if (remaining) {
        this.emit('line', remaining);
      }
      this.buffer = '';
    }
  }

  getCompletionDetails(): TerminalCompletionDetails {
    return {
      exitCode: this.exitCode,
      signal: null,
    };
  }
}

export type TerminalProcessResultPromise = VscodeTerminalProcess & Promise<void>;

export function mergePromise(
  process: VscodeTerminalProcess,
  promise: Promise<void>,
): TerminalProcessResultPromise {
  const nativePromisePrototype = (async () => {})().constructor.prototype;
  const descriptors = ['then', 'catch', 'finally'] as const;
  for (const property of descriptors) {
    const descriptor = Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property);
    if (descriptor?.value) {
      const value = descriptor.value.bind(promise);
      Reflect.defineProperty(process, property, { ...descriptor, value });
    }
  }
  return process as TerminalProcessResultPromise;
}
