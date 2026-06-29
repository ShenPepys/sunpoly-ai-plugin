import * as vscode from 'vscode';
import { getShell } from './shell';

export interface TerminalInfo {
  terminal: vscode.Terminal;
  busy: boolean;
  lastCommand: string;
  id: number;
  shellPath?: string;
  lastActive: number;
  pendingCwdChange?: string;
  cwdResolved?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
}

export class TerminalRegistry {
  private static terminals: TerminalInfo[] = [];
  private static nextTerminalId = 0;

  static resetForTesting(): void {
    TerminalRegistry.terminals = [];
    TerminalRegistry.nextTerminalId = 0;
  }

  static createTerminal(cwd?: string, shellPath?: string): TerminalInfo {
    const terminalOptions: vscode.TerminalOptions = {
      cwd,
      name: 'AI Assistant',
      shellPath: shellPath ?? getShell(),
    };

    const terminal = vscode.window.createTerminal(terminalOptions);
    TerminalRegistry.nextTerminalId += 1;

    const info: TerminalInfo = {
      terminal,
      busy: false,
      lastCommand: '',
      id: TerminalRegistry.nextTerminalId,
      shellPath: terminalOptions.shellPath,
      lastActive: Date.now(),
    };

    TerminalRegistry.terminals.push(info);
    return info;
  }

  static getTerminal(id: number): TerminalInfo | undefined {
    const info = TerminalRegistry.terminals.find((item) => item.id === id);
    if (info && TerminalRegistry.isTerminalClosed(info.terminal)) {
      TerminalRegistry.removeTerminal(id);
      return undefined;
    }
    return info;
  }

  static updateTerminal(id: number, updates: Partial<TerminalInfo>): void {
    const terminal = TerminalRegistry.getTerminal(id);
    if (terminal) {
      Object.assign(terminal, updates);
    }
  }

  static removeTerminal(id: number): void {
    TerminalRegistry.terminals = TerminalRegistry.terminals.filter((item) => item.id !== id);
  }

  static getAllTerminals(): TerminalInfo[] {
    TerminalRegistry.terminals = TerminalRegistry.terminals.filter(
      (item) => !TerminalRegistry.isTerminalClosed(item.terminal),
    );
    return TerminalRegistry.terminals;
  }

  private static isTerminalClosed(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus !== undefined;
  }
}
