/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseToolCalls } from '../src/tools/toolParser';
import {
  ListDirIgnoreMatcher,
  createListDirIgnoreMatcher,
  listDir,
} from '../src/tools/fileOps';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

async function createListDirFixture(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'list-dir-ignore-'));

  const dirs = [
    'src',
    path.join('src', 'nested'),
    'node_modules',
    path.join('node_modules', 'pkg'),
    'ignored',
    path.join('ignored', 'inner'),
    'build',
  ];
  for (const dir of dirs) {
    await fsp.mkdir(path.join(tmpDir, dir), { recursive: true });
  }

  const files: Record<string, string> = {
    '.gitignore': ['ignored/', 'build/', '*.tmp', ''].join('\n'),
    [path.join('src', 'visible.ts')]: 'export const ok = 1;\n',
    [path.join('src', 'nested', 'deep.ts')]: 'export const deep = 2;\n',
    [path.join('node_modules', 'pkg', 'index.js')]: 'module.exports = {};\n',
    [path.join('ignored', 'secret.txt')]: 'secret\n',
    [path.join('build', 'out.js')]: 'console.log("out");\n',
    'cache.tmp': 'temp\n',
    'README.md': '# demo\n',
  };
  for (const [relPath, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(tmpDir, relPath), content, 'utf-8');
  }

  return tmpDir;
}

function setMockWorkspace(rootPath: string): void {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: rootPath } }];
}

function clearMockWorkspace(): void {
  vscode.workspace.workspaceFolders = undefined;
}

test('parseToolCalls 识别 list_dir 的 recursive 属性', () => {
  const calls = parseToolCalls('<list_dir path="src" recursive="true" />');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'list_dir');
  assert.equal(calls[0].path, 'src');
  assert.equal(calls[0].listRecursive, true);
});

test('ListDirIgnoreMatcher 尊重 .gitignore 规则', () => {
  const matcher = new ListDirIgnoreMatcher();
  matcher.addGitignoreContent('ignored/\nbuild/\n*.tmp\n');

  assert.equal(matcher.isIgnored('ignored', true), true);
  assert.equal(matcher.isIgnored('ignored/secret.txt', false), true);
  assert.equal(matcher.isIgnored('build/out.js', false), true);
  assert.equal(matcher.isIgnored('cache.tmp', false), true);
  assert.equal(matcher.isIgnored('src/visible.ts', false), false);
});

test('createListDirIgnoreMatcher 默认跳过 node_modules', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-dir-matcher-'));
  try {
    const matcher = createListDirIgnoreMatcher(tmpDir);
    assert.equal(matcher.isIgnored('node_modules', true), true);
    assert.equal(matcher.isIgnored('node_modules/pkg/index.js', false), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('listDir 非递归时跳过 node_modules 与 gitignore 目录', async () => {
  const tmpDir = await createListDirFixture();
  setMockWorkspace(tmpDir);

  try {
    const result = await listDir('.');
    assert.equal(result.success, true);

    const content = result.content ?? '';
    assert.doesNotMatch(content, /node_modules/);
    assert.doesNotMatch(content, /ignored/);
    assert.doesNotMatch(content, /build/);
    assert.doesNotMatch(content, /cache\.tmp/);
    assert.match(content, /\[DIR\] src/);
    assert.match(content, /\[FILE\] README\.md/);
  } finally {
    clearMockWorkspace();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('listDir recursive=true 深度列出并仍跳过忽略项', async () => {
  const tmpDir = await createListDirFixture();
  setMockWorkspace(tmpDir);

  try {
    const result = await listDir('.', { recursive: true });
    assert.equal(result.success, true);

    const content = result.content ?? '';
    assert.match(content, /\[FILE\] src\/visible\.ts/);
    assert.match(content, /\[FILE\] src\/nested\/deep\.ts/);
    assert.doesNotMatch(content, /node_modules/);
    assert.doesNotMatch(content, /ignored/);
    assert.doesNotMatch(content, /build\/out\.js/);
    assert.doesNotMatch(content, /cache\.tmp/);
  } finally {
    clearMockWorkspace();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
