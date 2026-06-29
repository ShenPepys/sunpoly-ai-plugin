/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getShell,
  WINDOWS_POWERSHELL_7_PATH,
  WINDOWS_POWERSHELL_LEGACY_PATH,
} from '../src/terminal/shell';
import {
  getWindowsPowerShellCandidates,
  resetPowerShellResolverCacheForTesting,
  resolveWindowsPowerShellExecutable,
  setPowerShellProbeForTesting,
} from '../src/terminal/powershell';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

type Platform = NodeJS.Platform;

function mockVsCodeConfig(
  platformKey: 'windows' | 'osx' | 'linux',
  defaultProfileName: string | null,
  profiles: Record<string, unknown>,
): void {
  vscode.workspace.getConfiguration = () => ({
    get: (key: string) => {
      if (key === `defaultProfile.${platformKey}`) {
        return defaultProfileName;
      }
      if (key === `profiles.${platformKey}`) {
        return profiles;
      }
      return undefined;
    },
  });
}

function withPlatform(platform: Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

test('getShell 在 Windows 下返回非空字符串', () => {
  withPlatform('win32', () => {
    mockVsCodeConfig('windows', 'PowerShell', {
      PowerShell: { path: WINDOWS_POWERSHELL_7_PATH },
    });
    const shell = getShell();
    assert.ok(shell.length > 0);
    assert.equal(shell, WINDOWS_POWERSHELL_7_PATH);
  });
});

test('getShell 在 Windows 默认 Command Prompt profile 时返回 cmd.exe', () => {
  withPlatform('win32', () => {
    mockVsCodeConfig('windows', 'Command Prompt', { 'Command Prompt': {} });
    assert.equal(getShell(), 'C:\\Windows\\System32\\cmd.exe');
  });
});

test('getShell 对 legacy PowerShell profile 使用 Windows PowerShell 5.x 路径', () => {
  withPlatform('win32', () => {
    mockVsCodeConfig('windows', 'PowerShell', { PowerShell: {} });
    assert.equal(getShell(), WINDOWS_POWERSHELL_LEGACY_PATH);
  });
});

test('getWindowsPowerShellCandidates 包含 pwsh 与 legacy 路径', () => {
  const candidates = getWindowsPowerShellCandidates();
  assert.ok(candidates.includes(WINDOWS_POWERSHELL_7_PATH));
  assert.ok(candidates.includes(WINDOWS_POWERSHELL_LEGACY_PATH));
  assert.ok(candidates.includes('pwsh.exe'));
});

test('resolveWindowsPowerShellExecutable 使用探测结果选择第一个可用候选', async () => {
  resetPowerShellResolverCacheForTesting();
  setPowerShellProbeForTesting(async (candidate) => candidate.endsWith('pwsh.exe'));

  try {
    const resolved = await resolveWindowsPowerShellExecutable();
    assert.ok(resolved.endsWith('pwsh.exe'));
  } finally {
    resetPowerShellResolverCacheForTesting();
  }
});

test('resolveWindowsPowerShellExecutable 在无可用候选时回退 legacy 路径', async () => {
  resetPowerShellResolverCacheForTesting();
  setPowerShellProbeForTesting(async () => false);

  try {
    const resolved = await resolveWindowsPowerShellExecutable();
    assert.equal(resolved, WINDOWS_POWERSHELL_LEGACY_PATH);
  } finally {
    resetPowerShellResolverCacheForTesting();
  }
});
