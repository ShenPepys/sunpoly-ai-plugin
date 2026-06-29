/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { execCommand } from '../src/tools/terminalExec';
import { isDangerousCommand } from '../src/tools/terminalExecSafety';
import { MAX_COMMAND_OUTPUT_CHARS } from '../src/terminal/constants';
import {
  runTerminalCommand,
  setRunTerminalCommandForTesting,
  truncateCommandOutput,
} from '../src/terminal/terminalCommandRunner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

test('terminalExec.ts 通过 terminal 模块执行命令而非 child_process.exec', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile('src/tools/terminalExec.ts', 'utf8'),
  );
  const withoutComments = source.replace(/\/\/.*$/gm, '');
  assert.match(withoutComments, /from ['"].*terminal/);
  assert.doesNotMatch(withoutComments, /child_process['"].*exec\(/);
});

test('isDangerousCommand 拒绝 rm -rf /', () => {
  assert.equal(isDangerousCommand('rm -rf /'), true);
  assert.equal(isDangerousCommand('echo hello'), false);
});

test('execCommand 对空命令返回失败', async () => {
  const result = await execCommand('   ');
  assert.equal(result.success, false);
  assert.match(result.content ?? '', /命令为空/);
});

test('execCommand 拒绝危险命令', async () => {
  const result = await execCommand('rm -rf /');
  assert.equal(result.success, false);
  assert.match(result.content ?? '', /命令被拒绝/);
});

test('execCommand 成功时返回 runner 输出', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];

  setRunTerminalCommandForTesting(async () => ({
    success: true,
    output: 'hello-world',
    exitCode: 0,
    via: 'spawn',
  }));

  try {
    const result = await execCommand('echo hello');
    assert.equal(result.success, true);
    assert.equal(result.content, 'hello-world');
  } finally {
    setRunTerminalCommandForTesting(null);
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('execCommand 失败时返回 runner 错误输出', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];

  setRunTerminalCommandForTesting(async () => ({
    success: false,
    output: '命令执行失败 (exit code: 1)',
    exitCode: 1,
    via: 'spawn',
  }));

  try {
    const result = await execCommand('false');
    assert.equal(result.success, false);
    assert.match(result.content ?? '', /exit code: 1/);
  } finally {
    setRunTerminalCommandForTesting(null);
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('execCommand 超时时返回超时信息', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];

  setRunTerminalCommandForTesting(async () => ({
    success: false,
    output: '命令执行超时（5000ms）',
    exitCode: null,
    via: 'integrated',
  }));

  try {
    const result = await execCommand('sleep 10', 5000);
    assert.equal(result.success, false);
    assert.match(result.content ?? '', /超时/);
  } finally {
    setRunTerminalCommandForTesting(null);
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('truncateCommandOutput 截断过长输出', () => {
  const long = 'x'.repeat(MAX_COMMAND_OUTPUT_CHARS + 100);
  const truncated = truncateCommandOutput(long, MAX_COMMAND_OUTPUT_CHARS);
  assert.ok(truncated.length < long.length);
  assert.match(truncated, /输出已截断/);
});

test('runTerminalCommand 可被测试注入替换', async () => {
  let called = false;
  setRunTerminalCommandForTesting(async () => {
    called = true;
    return { success: true, output: 'ok', exitCode: 0, via: 'spawn' };
  });

  try {
    const result = await runTerminalCommand('echo ok', process.cwd(), 1000);
    assert.equal(called, true);
    assert.equal(result.output, 'ok');
  } finally {
    setRunTerminalCommandForTesting(null);
  }
});
