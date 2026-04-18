/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { disposeAll, listRegisteredAdapters, registerAdapter, routeAstEdit, unregisterAdapter } from '../src/tools/astRouter';
import type { AstLanguageAdapter } from '../src/tools/astEditorTypes';

test('astRouter: routeAstEdit 会路由到首个支持目标文件的适配器', async () => {
  const calls: string[] = [];

  const unsupportedAdapter: AstLanguageAdapter = {
    id: 'unsupported-adapter',
    supportsFile: () => false,
    execute: async () => {
      calls.push('unsupported');
      return { success: false, reason: 'should not execute' };
    },
  };

  const tsAdapter: AstLanguageAdapter = {
    id: 'ts-adapter',
    supportsFile: (filePath) => filePath.endsWith('.ts'),
    execute: async (request, fileContent) => {
      calls.push(`${request.action}:${fileContent}`);
      return {
        success: true,
        files: [
          {
            filePath: request.filePath,
            newContent: fileContent + '\n// updated',
          },
        ],
      };
    },
  };

  disposeAll();
  registerAdapter(unsupportedAdapter);
  registerAdapter(tsAdapter);

  const result = await routeAstEdit(
    {
      workspaceRoot: 'workspace',
      filePath: 'src/demo.ts',
      action: 'add_import',
      params: {
        modulePath: './helper',
      },
    },
    'export const value = 1;',
  );

  assert.deepEqual(calls, ['add_import:export const value = 1;']);
  assert.deepEqual(listRegisteredAdapters(), ['unsupported-adapter', 'ts-adapter']);
  if ('supported' in result) {
    assert.fail('应命中 TS 适配器，而不是返回 unsupported');
    return;
  }
  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  assert.equal(result.files[0]?.filePath, 'src/demo.ts');
  assert.match(result.files[0]?.newContent ?? '', /updated/);

  disposeAll();
});

test('astRouter: 无匹配适配器时返回 supported false', async () => {
  disposeAll();

  const result = await routeAstEdit(
    {
      workspaceRoot: 'workspace',
      filePath: 'README.md',
      action: 'add_import',
      params: {
        modulePath: './helper',
      },
    },
    '# demo',
  );

  assert.deepEqual(result, { supported: false });
});

test('astRouter: registerAdapter 会按 id 替换已存在适配器，unregisterAdapter 会触发 dispose', () => {
  const disposedAdapters: string[] = [];

  const firstAdapter: AstLanguageAdapter = {
    id: 'replaceable',
    supportsFile: () => false,
    execute: async () => ({ success: false, reason: 'unused' }),
    dispose: () => {
      disposedAdapters.push('first');
    },
  };

  const secondAdapter: AstLanguageAdapter = {
    id: 'replaceable',
    supportsFile: () => false,
    execute: async () => ({ success: false, reason: 'unused' }),
    dispose: () => {
      disposedAdapters.push('second');
    },
  };

  disposeAll();
  registerAdapter(firstAdapter);
  registerAdapter(secondAdapter);

  assert.deepEqual(listRegisteredAdapters(), ['replaceable']);
  assert.deepEqual(disposedAdapters, ['first']);
  unregisterAdapter('replaceable');
  assert.deepEqual(disposedAdapters, ['first', 'second']);
  assert.deepEqual(listRegisteredAdapters(), []);
});
