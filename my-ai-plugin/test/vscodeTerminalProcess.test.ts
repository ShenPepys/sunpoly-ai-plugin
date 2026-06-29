/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGetLatestTerminalOutputForTesting } from '../src/terminal/getLatestTerminalOutput';
import { TerminalRegistry } from '../src/terminal/vscodeTerminalRegistry';
import { VscodeTerminalProcess } from '../src/terminal/vscodeTerminalProcess';
import { VscodeTerminalManager } from '../src/terminal/vscodeTerminalManager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

type MockTerminal = {
  shellIntegration?: {
    cwd?: { fsPath: string };
    executeCommand?: (command: string) => {
      read: () => AsyncIterable<string>;
    };
  };
  sendText: (command: string, addNewLine?: boolean) => void;
  exitStatus?: { code: number };
};

function createMockStream(lines: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield `${line}\n`;
      }
    },
  };
}

function createMockTerminal(options: {
  withShellIntegration?: boolean;
  streamLines?: string[];
  cwd?: string;
}): MockTerminal {
  const terminal: MockTerminal = {
    sendText: () => undefined,
  };

  if (options.withShellIntegration) {
    terminal.shellIntegration = {
      cwd: options.cwd ? { fsPath: options.cwd } : undefined,
      executeCommand: () => ({
        read: () => createMockStream(options.streamLines ?? ['output-line']),
      }),
    };
  }

  return terminal;
}

let createdTerminalCount = 0;

function setupVscodeMocks(): void {
  createdTerminalCount = 0;
  TerminalRegistry.resetForTesting();

  vscode.window.createTerminal = () => {
    createdTerminalCount += 1;
    return createMockTerminal({
      withShellIntegration: true,
      cwd: 'C:\\workspace',
      streamLines: ['created-terminal'],
    });
  };

  vscode.Uri = {
    file: (fsPath: string) => ({ fsPath }),
  };
}

test('VscodeTerminalProcess 在 Shell Integration 可用时 emit line 与 completed', async () => {
  const lines: string[] = [];
  const completed: unknown[] = [];
  const terminal = createMockTerminal({
    withShellIntegration: true,
    streamLines: ['hello', 'world'],
  });

  const process = new VscodeTerminalProcess();
  process.on('line', (line) => lines.push(line));
  process.on('completed', (details) => completed.push(details));

  await process.run(terminal as never, 'echo test');

  assert.ok(lines.some((line) => line.includes('hello')));
  assert.equal(completed.length, 1);
});

test('VscodeTerminalProcess 无 Shell Integration 时 emit no_shell_integration 并 fallback', async () => {
  setGetLatestTerminalOutputForTesting(async () => 'terminal snapshot text');

  const events: string[] = [];
  const lines: string[] = [];
  const terminal = createMockTerminal({ withShellIntegration: false });
  let sentCommand = '';
  terminal.sendText = (command: string) => {
    sentCommand = command;
  };

  const process = new VscodeTerminalProcess();
  process.on('no_shell_integration', () => events.push('no_shell_integration'));
  process.on('line', (line) => lines.push(line));

  await process.run(terminal as never, 'echo fallback');

  assert.ok(events.includes('no_shell_integration'));
  assert.equal(sentCommand, 'echo fallback');
  assert.ok(lines.some((line) => line.includes('terminal snapshot text')));

  setGetLatestTerminalOutputForTesting(null);
});

test('VscodeTerminalManager.runCommand 返回可 await 的 process 并 emit 事件', async () => {
  setupVscodeMocks();

  const terminalInfo = TerminalRegistry.createTerminal('C:\\workspace');
  const manager = new VscodeTerminalManager();
  const lines: string[] = [];

  const process = manager.runCommand(terminalInfo, 'echo manager');
  process.on('line', (line) => lines.push(line));

  await process;

  assert.ok(lines.length > 0);
  assert.equal(terminalInfo.busy, false);
});

test('VscodeTerminalManager.getOrCreateTerminal 复用相同 cwd 的非 busy 终端', async () => {
  setupVscodeMocks();

  const manager = new VscodeTerminalManager();
  const cwd = 'C:\\workspace';

  const first = await manager.getOrCreateTerminal(cwd);
  const second = await manager.getOrCreateTerminal(cwd);

  assert.equal(first.id, second.id);
  assert.equal(createdTerminalCount, 1);
});

test('VscodeTerminalManager 等待 Shell Integration 就绪后再执行命令', async () => {
  let shellIntegrationReady = false;
  const terminal = createMockTerminal({
    withShellIntegration: false,
    streamLines: ['delayed'],
  });

  const terminalInfo = {
    id: 99,
    terminal,
    busy: false,
    lastCommand: '',
    shellPath: 'powershell.exe',
    lastActive: Date.now(),
  };

  setTimeout(() => {
    terminal.shellIntegration = {
      cwd: { fsPath: 'C:\\workspace' },
      executeCommand: () => ({
        read: () => createMockStream(['ready-output']),
      }),
    };
    shellIntegrationReady = true;
  }, 120);

  const manager = new VscodeTerminalManager();
  manager.setShellIntegrationTimeout(500);

  const process = manager.runCommand(terminalInfo as never, 'echo delayed');
  await process;

  assert.equal(shellIntegrationReady, true);
});
