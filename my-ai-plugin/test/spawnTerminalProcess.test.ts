/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getShellArgs,
  isPowerShellShell,
  SpawnTerminalProcess,
} from '../src/terminal/spawnTerminalProcess';
import {
  WINDOWS_POWERSHELL_7_PATH,
  WINDOWS_POWERSHELL_LEGACY_PATH,
} from '../src/terminal/shell';

test('isPowerShellShell 识别 pwsh 与 powershell', () => {
  assert.equal(isPowerShellShell(WINDOWS_POWERSHELL_7_PATH), true);
  assert.equal(isPowerShellShell(WINDOWS_POWERSHELL_LEGACY_PATH), true);
  assert.equal(isPowerShellShell('C:\\Windows\\System32\\cmd.exe'), false);
});

test('getShellArgs 对 PowerShell 7 返回 NoProfile 与 ExecutionPolicy Bypass', () => {
  const args = getShellArgs(WINDOWS_POWERSHELL_7_PATH, 'echo ok');

  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  assert.ok(args.includes('-ExecutionPolicy'));
  assert.ok(args.includes('Bypass'));
  assert.ok(args.includes('-Command'));
  assert.equal(args[args.length - 1], 'echo ok');
});

test('getShellArgs 对 legacy PowerShell 返回相同安全参数', () => {
  const args = getShellArgs(WINDOWS_POWERSHELL_LEGACY_PATH, 'Get-ChildItem');

  assert.deepEqual(args.slice(0, 5), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
  ]);
  assert.equal(args[5], 'Get-ChildItem');
});

test('getShellArgs 对 cmd 使用 /c', () => {
  const args = getShellArgs('C:\\Windows\\System32\\cmd.exe', 'echo ok');
  assert.deepEqual(args, ['/c', 'echo ok']);
});

test('getShellArgs 对非 Windows 平台使用 login shell -l -c', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });

  try {
    const args = getShellArgs('/bin/bash', 'echo ok');
    assert.deepEqual(args, ['-l', '-c', 'echo ok']);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('SpawnTerminalProcess 能执行简单命令并返回输出', async () => {
  const proc = new SpawnTerminalProcess();
  const lines: string[] = [];
  proc.on('line', (line: string) => lines.push(line));

  const shellPath = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\cmd.exe'
    : '/bin/sh';
  const command = process.platform === 'win32' ? 'echo spawn-ok' : 'echo spawn-ok';

  const result = await proc.run(command, {
    cwd: process.cwd(),
    shellPath,
    timeoutMs: 10_000,
  });

  assert.equal(result.success, true);
  assert.match(result.output, /spawn-ok/);
});
