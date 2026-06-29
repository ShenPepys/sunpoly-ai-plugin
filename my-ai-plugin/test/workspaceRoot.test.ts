/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isPathWithinAnyWorkspaceFolder,
  isPathWithinRoot,
  resolvePathInWorkspaceFolder,
  resolveWorkspaceFolderForPath,
  toWorkspaceRelativePath,
} from '../src/utils/workspaceRoot';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

type MockFolder = { uri: { fsPath: string }; name: string; index: number };

function setWorkspaceFolders(folders: MockFolder[]): void {
  vscode.workspace.workspaceFolders = folders;
}

function clearWorkspaceFolders(): void {
  vscode.workspace.workspaceFolders = undefined;
}

test('resolveWorkspaceFolderForPath 单根工作区返回唯一 folder', () => {
  const root = path.join('C:', 'workspace', 'app');
  setWorkspaceFolders([{ uri: { fsPath: root }, name: 'app', index: 0 }]);

  try {
    const folder = resolveWorkspaceFolderForPath('src/index.ts');
    assert.equal(folder?.uri.fsPath, root);
    assert.equal(resolvePathInWorkspaceFolder('src/index.ts', folder!), path.join(root, 'src', 'index.ts'));
  } finally {
    clearWorkspaceFolders();
  }
});

test('resolveWorkspaceFolderForPath 多根时按路径前缀匹配 workspace folder 名称', () => {
  const frontend = path.join('C:', 'ws', 'frontend');
  const backend = path.join('C:', 'ws', 'backend');
  setWorkspaceFolders([
    { uri: { fsPath: frontend }, name: 'frontend', index: 0 },
    { uri: { fsPath: backend }, name: 'backend', index: 1 },
  ]);

  try {
    const backendFolder = resolveWorkspaceFolderForPath('backend/src/app.ts');
    assert.equal(backendFolder?.name, 'backend');
    assert.equal(
      resolvePathInWorkspaceFolder('backend/src/app.ts', backendFolder!),
      path.join(backend, 'src', 'app.ts'),
    );

    const frontendFolder = resolveWorkspaceFolderForPath('frontend/pages/home.vue');
    assert.equal(frontendFolder?.name, 'frontend');
  } finally {
    clearWorkspaceFolders();
  }
});

test('resolveWorkspaceFolderForPath 多根时优先选择磁盘上存在的路径', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
  const rootA = path.join(tmpDir, 'root-a');
  const rootB = path.join(tmpDir, 'root-b');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootA, 'src', 'only-here.ts'), 'export const x = 1;\n', 'utf-8');

  setWorkspaceFolders([
    { uri: { fsPath: rootA }, name: 'root-a', index: 0 },
    { uri: { fsPath: rootB }, name: 'root-b', index: 1 },
  ]);

  try {
    const folder = resolveWorkspaceFolderForPath('src/only-here.ts');
    assert.equal(folder?.name, 'root-a');
    assert.equal(
      resolvePathInWorkspaceFolder('src/only-here.ts', folder!),
      path.join(rootA, 'src', 'only-here.ts'),
    );
  } finally {
    clearWorkspaceFolders();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceFolderForPath 绝对路径落在对应 root 内', () => {
  const frontend = path.join('C:', 'ws', 'frontend');
  const backend = path.join('C:', 'ws', 'backend');
  setWorkspaceFolders([
    { uri: { fsPath: frontend }, name: 'frontend', index: 0 },
    { uri: { fsPath: backend }, name: 'backend', index: 1 },
  ]);

  try {
    const absPath = path.join(backend, 'pkg', 'main.ts');
    const folder = resolveWorkspaceFolderForPath(absPath);
    assert.equal(folder?.name, 'backend');
    assert.equal(isPathWithinAnyWorkspaceFolder(absPath), true);
  } finally {
    clearWorkspaceFolders();
  }
});

test('toWorkspaceRelativePath 多根时带 workspace folder 名称前缀', () => {
  const frontend = path.join('C:', 'ws', 'frontend');
  const backend = path.join('C:', 'ws', 'backend');
  setWorkspaceFolders([
    { uri: { fsPath: frontend }, name: 'frontend', index: 0 },
    { uri: { fsPath: backend }, name: 'backend', index: 1 },
  ]);

  try {
    const rel = toWorkspaceRelativePath(path.join(backend, 'src', 'app.ts'));
    assert.equal(rel, 'backend/src/app.ts');
  } finally {
    clearWorkspaceFolders();
  }
});

test('isPathWithinRoot 在 Windows 路径大小写下仍正确', () => {
  const root = path.join('C:', 'Workspace', 'App');
  const child = path.join(root, 'src', 'index.ts');
  assert.equal(isPathWithinRoot(child, root), true);
  if (process.platform === 'win32') {
    assert.equal(
      isPathWithinRoot(child.replace('Workspace', 'workspace'), root),
      true,
    );
  }
});
