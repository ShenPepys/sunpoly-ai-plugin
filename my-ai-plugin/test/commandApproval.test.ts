/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  confirmRunCommand,
  COMMAND_DENIED_MESSAGE,
  setConfirmRunCommandForTesting,
} from '../src/tools/commandApproval';
import { executeToolCalls } from '../src/tools/toolExecutor';
import { setRunTerminalCommandForTesting } from '../src/terminal/terminalCommandRunner';
import type { ParsedToolCall } from '../src/tools/toolParser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

test('confirmRunCommand 用户确认时返回 true', async () => {
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => '执行';

  try {
    setConfirmRunCommandForTesting(null);
    assert.equal(await confirmRunCommand('echo hello'), true);
  } finally {
    vscode.window.showWarningMessage = original;
    setConfirmRunCommandForTesting(null);
  }
});

test('confirmRunCommand 用户取消时返回 false', async () => {
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => undefined;

  try {
    setConfirmRunCommandForTesting(null);
    assert.equal(await confirmRunCommand('echo hello'), false);
  } finally {
    vscode.window.showWarningMessage = original;
    setConfirmRunCommandForTesting(null);
  }
});

test('confirmRunCommand 空命令返回 false', async () => {
  setConfirmRunCommandForTesting(null);
  try {
    assert.equal(await confirmRunCommand('   '), false);
  } finally {
    setConfirmRunCommandForTesting(null);
  }
});

test('executeToolCalls 拒绝 run_command 时不调用终端执行层', async () => {
  let runCalled = false;
  setConfirmRunCommandForTesting(async () => false);
  setRunTerminalCommandForTesting(async () => {
    runCalled = true;
    return { success: true, output: 'should-not-run', exitCode: 0, via: 'spawn' };
  });

  const toolCall: ParsedToolCall = {
    type: 'run_command',
    command: 'echo should-not-run',
    rawMatch: '<run_command>echo should-not-run</run_command>',
  };

  try {
    const results = await executeToolCalls([toolCall], 'code');
    assert.equal(runCalled, false);
    assert.equal(results[0].result.success, false);
    assert.equal(results[0].result.content, COMMAND_DENIED_MESSAGE);
  } finally {
    setConfirmRunCommandForTesting(null);
    setRunTerminalCommandForTesting(null);
  }
});

test('executeToolCalls 批准 run_command 后调用终端执行层', async () => {
  let runCalled = false;
  setConfirmRunCommandForTesting(async () => true);
  setRunTerminalCommandForTesting(async () => {
    runCalled = true;
    return { success: true, output: 'ok', exitCode: 0, via: 'spawn' };
  });

  const toolCall: ParsedToolCall = {
    type: 'run_command',
    command: 'echo ok',
    rawMatch: '<run_command>echo ok</run_command>',
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mockVscode = require('vscode');
  const originalFolders = mockVscode.workspace.workspaceFolders;
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];

  try {
    const results = await executeToolCalls([toolCall], 'code');
    assert.equal(runCalled, true);
    assert.equal(results[0].result.success, true);
    assert.equal(results[0].result.content, 'ok');
  } finally {
    setConfirmRunCommandForTesting(null);
    setRunTerminalCommandForTesting(null);
    mockVscode.workspace.workspaceFolders = originalFolders;
  }
});
