/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  disposeProject,
  getOrCreateProject,
  getSourceFile,
  refreshSourceFile,
} from '../src/tools/astContext';

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function removeDirectory(directoryPath: string): void {
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

test('astContext: getOrCreateProject 会复用同一工作区的 Project，并能解析 import/function/class', () => {
  const workspaceRoot = createTempWorkspace('ast-context-tsconfig-');
  const filePath = path.join(workspaceRoot, 'src', 'sample.ts');

  try {
    writeTextFile(
      path.join(workspaceRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          target: 'ES2021',
        },
        include: ['src/**/*.ts'],
      }),
    );

    writeTextFile(
      filePath,
      [
        "import { readFileSync } from 'fs';",
        '',
        'export function loadText(filePath: string): string {',
        '  return readFileSync(filePath, \"utf-8\");',
        '}',
        '',
        'export class DemoService {}',
      ].join('\n'),
    );

    const firstProject = getOrCreateProject(workspaceRoot);
    const secondProject = getOrCreateProject(workspaceRoot);
    const sourceFile = getSourceFile(filePath);

    assert.equal(firstProject, secondProject);
    assert.ok(sourceFile, '应能获取 SourceFile');
    assert.equal(sourceFile?.getImportDeclarations().length, 1);
    assert.ok(sourceFile?.getFunction('loadText'));
    assert.ok(sourceFile?.getClass('DemoService'));
  } finally {
    disposeProject(workspaceRoot);
    removeDirectory(workspaceRoot);
  }
});

test('astContext: refreshSourceFile 会重新读取磁盘上的最新内容', () => {
  const workspaceRoot = createTempWorkspace('ast-context-refresh-');
  const filePath = path.join(workspaceRoot, 'src', 'refresh.ts');

  try {
    writeTextFile(
      path.join(workspaceRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          target: 'ES2021',
        },
        include: ['src/**/*.ts'],
      }),
    );

    writeTextFile(
      filePath,
      [
        'export function getValue(): number {',
        '  return 1;',
        '}',
      ].join('\n'),
    );

    getOrCreateProject(workspaceRoot);
    const initialSourceFile = getSourceFile(filePath);
    assert.ok(initialSourceFile, '应能加载初始 SourceFile');
    assert.match(initialSourceFile?.getFullText() ?? '', /return 1;/);

    writeTextFile(
      filePath,
      [
        'export function getValue(): number {',
        '  return 2;',
        '}',
      ].join('\n'),
    );

    const refreshedSourceFile = refreshSourceFile(filePath);
    assert.match(refreshedSourceFile.getFullText(), /return 2;/);
  } finally {
    disposeProject(workspaceRoot);
    removeDirectory(workspaceRoot);
  }
});

test('astContext: 没有 tsconfig 时也会使用默认配置加载 JS 文件', () => {
  const workspaceRoot = createTempWorkspace('ast-context-default-');
  const filePath = path.join(workspaceRoot, 'plain.js');

  try {
    writeTextFile(
      filePath,
      [
        'function hello(name) {',
        '  return `hello ${name}`;',
        '}',
        '',
        'class Greeter {}',
      ].join('\n'),
    );

    getOrCreateProject(workspaceRoot);
    const sourceFile = getSourceFile(filePath);

    assert.ok(sourceFile, '默认配置下也应能加载 JS 文件');
    assert.ok(sourceFile?.getFunction('hello'));
    assert.ok(sourceFile?.getClass('Greeter'));
  } finally {
    disposeProject(workspaceRoot);
    removeDirectory(workspaceRoot);
  }
});

test('astContext: disposeProject 会清空缓存，后续重新创建得到新 Project', () => {
  const workspaceRoot = createTempWorkspace('ast-context-dispose-');
  const filePath = path.join(workspaceRoot, 'src', 'dispose.ts');

  try {
    writeTextFile(
      path.join(workspaceRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          target: 'ES2021',
        },
        include: ['src/**/*.ts'],
      }),
    );

    writeTextFile(filePath, 'export const value = 1;');

    const firstProject = getOrCreateProject(workspaceRoot);
    assert.ok(getSourceFile(filePath));

    disposeProject(workspaceRoot);
    assert.equal(getSourceFile(filePath), undefined);

    const secondProject = getOrCreateProject(workspaceRoot);
    assert.notEqual(firstProject, secondProject);
  } finally {
    disposeProject(workspaceRoot);
    removeDirectory(workspaceRoot);
  }
});
