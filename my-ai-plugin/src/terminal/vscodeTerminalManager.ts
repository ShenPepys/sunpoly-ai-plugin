import * as vscode from 'vscode';
import { SHELL_INTEGRATION_WAIT_TIMEOUT_MS } from './constants';
import { arePathsEqual } from './pathUtils';
import { getShell } from './shell';
import {
  mergePromise,
  TerminalProcessResultPromise,
  VscodeTerminalProcess,
} from './vscodeTerminalProcess';
import { TerminalInfo, TerminalRegistry } from './vscodeTerminalRegistry';

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

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getShellIntegration(terminal)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !!getShellIntegration(terminal);
}

export class VscodeTerminalManager {
  private terminalIds = new Set<number>();
  private processes = new Map<number, VscodeTerminalProcess>();
  private shellIntegrationTimeout = SHELL_INTEGRATION_WAIT_TIMEOUT_MS;
  private shellIntegrationStreamTimeout = 10_000;
  private terminalReuseEnabled = true;

  setShellIntegrationTimeout(timeoutMs: number): void {
    this.shellIntegrationTimeout = timeoutMs;
  }

  setShellIntegrationStreamTimeout(timeoutMs: number): void {
    this.shellIntegrationStreamTimeout = timeoutMs;
  }

  setTerminalReuseEnabled(enabled: boolean): void {
    this.terminalReuseEnabled = enabled;
  }

  runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise {
    terminalInfo.busy = true;
    terminalInfo.lastCommand = command;

    const process = new VscodeTerminalProcess();
    this.processes.set(terminalInfo.id, process);
    this.terminalIds.add(terminalInfo.id);

    process.once('completed', () => {
      terminalInfo.busy = false;
    });

    process.once('no_shell_integration', () => {
      TerminalRegistry.removeTerminal(terminalInfo.id);
      this.terminalIds.delete(terminalInfo.id);
      this.processes.delete(terminalInfo.id);
    });

    const promise = new Promise<void>((resolve, reject) => {
      process.once('continue', () => resolve());
      process.once('error', (error) => reject(error));
    });

    const start = async (): Promise<void> => {
      if (process.waitForShellIntegration && !getShellIntegration(terminalInfo.terminal)) {
        await waitForShellIntegration(terminalInfo.terminal, this.shellIntegrationTimeout);
      }
      await process.run(terminalInfo.terminal, command, this.shellIntegrationStreamTimeout);
    };

    void start().catch((error) => {
      terminalInfo.busy = false;
      process.emit('error', error instanceof Error ? error : new Error(String(error)));
    });

    return mergePromise(process, promise);
  }

  async getOrCreateTerminal(cwd: string): Promise<TerminalInfo> {
    const expectedShellPath = getShell();
    const terminals = TerminalRegistry.getAllTerminals();

    const matchingTerminal = terminals.find((item) => {
      if (item.busy) {
        return false;
      }
      if (item.shellPath && item.shellPath !== expectedShellPath) {
        return false;
      }
      const terminalCwd = getShellIntegration(item.terminal)?.cwd?.fsPath;
      if (!terminalCwd) {
        return false;
      }
      return arePathsEqual(terminalCwd, cwd);
    });

    if (matchingTerminal) {
      this.terminalIds.add(matchingTerminal.id);
      return matchingTerminal;
    }

    if (this.terminalReuseEnabled) {
      const availableTerminal = terminals.find((item) => !item.busy && item.shellPath === expectedShellPath);
      if (availableTerminal) {
        const cdProcess = this.runCommand(availableTerminal, `cd "${cwd}"`);
        await cdProcess;
        await waitForShellIntegration(availableTerminal.terminal, this.shellIntegrationTimeout);
        this.terminalIds.add(availableTerminal.id);
        return availableTerminal;
      }
    }

    const newTerminal = TerminalRegistry.createTerminal(cwd, expectedShellPath);
    this.terminalIds.add(newTerminal.id);
    await waitForShellIntegration(newTerminal.terminal, this.shellIntegrationTimeout);
    return newTerminal;
  }

  dispose(): void {
    this.terminalIds.clear();
    this.processes.clear();
  }
}
