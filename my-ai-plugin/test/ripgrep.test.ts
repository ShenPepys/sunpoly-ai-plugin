/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import {
  buildRipgrepArgs,
  grepWithRipgrep,
  isRipgrepAvailable,
  parseRipgrepJsonLine,
  setRipgrepPathResolverForTesting,
  setRipgrepSpawnForTesting,
} from '../src/tools/ripgrep';
import type { ChildProcess } from 'node:child_process';
import { grepCode, grepCodeWithJavaScript } from '../src/tools/searchTools';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

function createMockRipgrepProcess(stdoutLines: string[], exitCode = 0): ChildProcess {
  const stdout = Readable.from(stdoutLines.join('\n') + (stdoutLines.length ? '\n' : ''));
  const stderr = new Readable({ read() { this.push(null); } });
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: () => void;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = () => undefined;
  stdout.on('end', () => {
    queueMicrotask(() => proc.emit('close', exitCode));
  });
  return proc as unknown as ChildProcess;
}

test('buildRipgrepArgs 包含 pattern、glob 与工作区路径', () => {
  const args = buildRipgrepArgs({
    regex: 'export\\s+class',
    workspaceRoot: 'C:\\workspace',
    includePattern: '*.ts',
    caseSensitive: true,
  });

  assert.ok(args.includes('-e'));
  assert.ok(args.includes('export\\s+class'));
  assert.ok(args.includes('-g'));
  assert.ok(args.includes('*.ts'));
  assert.ok(args.includes('C:\\workspace'));
  assert.equal(args.includes('-i'), false);
});

test('buildRipgrepArgs 默认不区分大小写时添加 -i', () => {
  const args = buildRipgrepArgs({
    regex: 'error',
    workspaceRoot: '/workspace',
    caseSensitive: false,
  });

  assert.ok(args.includes('-i'));
});

test('parseRipgrepJsonLine 解析 match 行', () => {
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'C:\\workspace\\src\\foo.ts' },
      lines: { text: 'export class Foo {\n' },
      line_number: 12,
    },
  });

  const match = parseRipgrepJsonLine(line, 'C:\\workspace');
  assert.ok(match);
  assert.equal(match?.file, 'src/foo.ts');
  assert.equal(match?.line, 12);
  assert.match(match?.text ?? '', /export class Foo/);
});

test('grepWithRipgrep 使用 mock spawn 返回匹配', async () => {
  setRipgrepPathResolverForTesting(async () => 'C:\\rg\\rg.exe');
  setRipgrepSpawnForTesting(() => createMockRipgrepProcess([
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'C:\\workspace\\src\\a.ts' },
        lines: { text: 'const answer = 42\n' },
        line_number: 3,
      },
    }),
  ], 0));

  try {
    const matches = await grepWithRipgrep({
      regex: 'answer',
      workspaceRoot: 'C:\\workspace',
      caseSensitive: false,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].file, 'src/a.ts');
    assert.equal(matches[0].line, 3);
  } finally {
    setRipgrepPathResolverForTesting(null);
    setRipgrepSpawnForTesting(null);
  }
});

test('grepWithRipgrep spawn 失败时抛出可捕获错误', async () => {
  setRipgrepPathResolverForTesting(async () => 'C:\\rg\\rg.exe');
  setRipgrepSpawnForTesting(() => {
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    proc.stdout = new Readable({ read() { this.push(null); } });
    proc.stderr = new Readable({ read() { this.push(null); } });
    proc.kill = () => undefined;
    queueMicrotask(() => proc.emit('error', new Error('spawn failed')));
    return proc as unknown as ChildProcess;
  });

  try {
    await assert.rejects(
      () => grepWithRipgrep({
        regex: 'test',
        workspaceRoot: 'C:\\workspace',
      }),
      /spawn failed/,
    );
  } finally {
    setRipgrepPathResolverForTesting(null);
    setRipgrepSpawnForTesting(null);
  }
});

test('isRipgrepAvailable 在 resolver 失败时返回 false', async () => {
  setRipgrepPathResolverForTesting(async () => {
    throw new Error('missing');
  });

  try {
    assert.equal(await isRipgrepAvailable(), false);
  } finally {
    setRipgrepPathResolverForTesting(null);
  }
});

test('grepCode 在 ripgrep 可用时优先走 ripgrep', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];

  setRipgrepPathResolverForTesting(async () => 'C:\\rg\\rg.exe');
  setRipgrepSpawnForTesting(() => createMockRipgrepProcess([
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'C:\\workspace\\src\\main.ts' },
        lines: { text: 'function main() {}\n' },
        line_number: 1,
      },
    }),
  ], 0));

  try {
    const result = await grepCode('function\\s+main');
    assert.equal(result.success, true);
    assert.equal(result.matches?.length, 1);
    assert.equal(result.matches?.[0].file, 'src/main.ts');
  } finally {
    setRipgrepPathResolverForTesting(null);
    setRipgrepSpawnForTesting(null);
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('grepCode 在 ripgrep 不可用时 fallback JS 且不抛未捕获异常', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];

  setRipgrepPathResolverForTesting(async () => {
    throw new Error('no rg');
  });

  const originalFindFiles = vscode.workspace.findFiles;
  vscode.workspace.findFiles = async () => [];

  try {
    const result = await grepCode('not-found-pattern-xyz');
    assert.equal(result.success, true);
    assert.deepEqual(result.matches, []);
  } finally {
    setRipgrepPathResolverForTesting(null);
    vscode.workspace.findFiles = originalFindFiles;
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('grepCode 无效正则返回失败', async () => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];

  try {
    const result = await grepCode('[invalid');
    assert.equal(result.success, false);
    assert.match(result.content ?? '', /无效的正则表达式/);
  } finally {
    vscode.workspace.workspaceFolders = undefined;
  }
});

test('grepCodeWithJavaScript 无工作区时返回失败', async () => {
  vscode.workspace.workspaceFolders = undefined;
  const result = await grepCodeWithJavaScript('test');
  assert.equal(result.success, false);
  assert.match(result.content ?? '', /未打开工作区/);
});
