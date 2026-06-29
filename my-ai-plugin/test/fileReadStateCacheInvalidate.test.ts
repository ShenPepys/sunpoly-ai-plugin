/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCallBatch } from '../src/webview/fileChanges';
import { FileReadStateCache } from '../src/tools/fileReadStateCache';
import { setConfirmRunCommandForTesting } from '../src/tools/commandApproval';
import { setRunTerminalCommandForTesting } from '../src/terminal/terminalCommandRunner';
import type { ParsedToolCall } from '../src/tools/toolParser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

function makeRunCommandToolCall(command: string): ParsedToolCall {
  return {
    type: 'run_command',
    command,
    rawMatch: `<run_command>${command}</run_command>`,
  };
}

test('run_command 成功后清空 FileReadStateCache', async () => {
  const cache = new FileReadStateCache();
  cache.set('/workspace/a.ts', { content: 'old-a', timestamp: Date.now() });
  cache.set('/workspace/b.ts', { content: 'old-b', timestamp: Date.now() });
  assert.equal(cache.size, 2);

  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];
  setConfirmRunCommandForTesting(async () => true);
  setRunTerminalCommandForTesting(async () => ({
    success: true,
    output: 'ok',
    exitCode: 0,
    via: 'spawn',
  }));

  try {
    const result = await executeToolCallBatch({
      toolCalls: [makeRunCommandToolCall('npm install')],
      requestMode: 'code',
      messageId: 'msg-run-command',
      summaryId: 'summary-1',
      stepSequenceStart: 1,
      writeBackups: new Map(),
      postMessage: () => {},
      fileReadStateCache: cache,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].result.success, true);
    assert.equal(cache.size, 0);
  } finally {
    vscode.workspace.workspaceFolders = originalFolders;
    setConfirmRunCommandForTesting(null);
    setRunTerminalCommandForTesting(null);
  }
});

test('run_command 失败时保留 FileReadStateCache', async () => {
  const cache = new FileReadStateCache();
  cache.set('/workspace/a.ts', { content: 'old-a', timestamp: Date.now() });
  assert.equal(cache.size, 1);

  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];
  setConfirmRunCommandForTesting(async () => true);
  setRunTerminalCommandForTesting(async () => ({
    success: false,
    output: 'command failed',
    exitCode: 1,
    via: 'spawn',
  }));

  try {
    const result = await executeToolCallBatch({
      toolCalls: [makeRunCommandToolCall('false')],
      requestMode: 'code',
      messageId: 'msg-run-command-fail',
      summaryId: 'summary-2',
      stepSequenceStart: 1,
      writeBackups: new Map(),
      postMessage: () => {},
      fileReadStateCache: cache,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.toolResults[0].result.success, false);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('/workspace/a.ts')?.content, 'old-a');
  } finally {
    vscode.workspace.workspaceFolders = originalFolders;
    setConfirmRunCommandForTesting(null);
    setRunTerminalCommandForTesting(null);
  }
});
