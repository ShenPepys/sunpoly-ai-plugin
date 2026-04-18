/// <reference types="node" />
/**
 * 阶段五 TASK-AST-5.1: 真实场景端到端验收测试
 *
 * 用接近真实项目的代码结构验证 AST 编辑的完整链路：
 * - 解析 XML → ParsedToolCall → 执行器 → AST 适配器 → 新内容
 * - 覆盖多文件引用、JS 文件、复杂嵌套结构等场景
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { typescriptAdapter } from '../src/tools/astAdapter_typescript';
import { parseToolCalls } from '../src/tools/toolParser';
import { disposeProject } from '../src/tools/astContext';
import type { AstEditRequest, AstEditResult } from '../src/tools/astEditorTypes';

// ─── 辅助函数 ─────────────────────────────────────────────

function setupWorkspace(files: Record<string, string>): { root: string; paths: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-e2e-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    paths[name] = filePath;
  }
  return { root, paths };
}

function cleanWorkspace(root: string): void {
  disposeProject();
  fs.rmSync(root, { recursive: true, force: true });
}

async function runAst(request: AstEditRequest): Promise<AstEditResult> {
  const content = fs.readFileSync(request.filePath, 'utf-8');
  return typescriptAdapter.execute(request, content);
}

function assertSuccess(result: AstEditResult): asserts result is Extract<AstEditResult, { success: true }> {
  if (!result.success) {
    assert.fail(`期望成功但失败了：${result.reason}`);
  }
}

function getContent(result: AstEditResult, index = 0): string {
  assertSuccess(result);
  return result.files[index].newContent;
}

// ─── 真实场景 1：多文件类结构 —— 给 class 添加方法 ─────────

const SERVICE_CODE = `import { Logger } from './logger';

export class UserService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async getUser(id: string) {
    this.logger.info(\`Getting user \${id}\`);
    return { id, name: 'test' };
  }

  async deleteUser(id: string) {
    this.logger.warn(\`Deleting user \${id}\`);
    return true;
  }
}
`;

test('E2E: 给真实 class 添加方法（insertAfter 锚点）', async () => {
  const { root, paths } = setupWorkspace({ 'src/userService.ts': SERVICE_CODE });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/userService.ts'],
      action: 'add_class_member',
      params: {
        className: 'UserService',
        memberCode: `async updateUser(id: string, data: Partial<{ name: string }>) {\n    this.logger.info(\`Updating user \${id}\`);\n    return { id, ...data };\n  }`,
        insertAfter: 'getUser',
      },
    });
    const content = getContent(result);
    // updateUser 在 getUser 之后、deleteUser 之前
    const getUserIdx = content.indexOf('getUser');
    const updateUserIdx = content.indexOf('updateUser');
    const deleteUserIdx = content.indexOf('deleteUser');
    assert.ok(updateUserIdx > getUserIdx, 'updateUser 应在 getUser 之后');
    assert.ok(updateUserIdx < deleteUserIdx, 'updateUser 应在 deleteUser 之前');
    // 方法体内容完整
    assert.match(content, /Updating user/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 2：给函数添加可选参数 ──────────────────────

const UTIL_CODE = `/**
 * 格式化日期
 */
export function formatDate(date: Date, locale: string): string {
  return date.toLocaleDateString(locale);
}

export function parseId(raw: string): number {
  return parseInt(raw, 10);
}
`;

test('E2E: 给已有函数末尾追加可选参数', async () => {
  const { root, paths } = setupWorkspace({ 'src/utils.ts': UTIL_CODE });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/utils.ts'],
      action: 'add_function_param',
      params: { functionName: 'formatDate', paramCode: 'options?: Intl.DateTimeFormatOptions' },
    });
    const content = getContent(result);
    assert.match(content, /locale:\s*string,\s*options\?:\s*Intl\.DateTimeFormatOptions/);
    // JSDoc 注释保留
    assert.match(content, /格式化日期/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 3：合并到现有 import ───────────────────────

const APP_CODE = `import { createApp } from 'vue';
import { store } from './store';

const app = createApp({});
app.use(store);
`;

test('E2E: 合并新命名导入到已有 import', async () => {
  const { root, paths } = setupWorkspace({ 'src/app.ts': APP_CODE });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/app.ts'],
      action: 'add_import',
      params: { modulePath: 'vue', namedImports: ['ref', 'computed'] },
    });
    const content = getContent(result);
    // createApp + ref + computed 都在同一条 import 里
    assert.match(content, /createApp/);
    assert.match(content, /ref/);
    assert.match(content, /computed/);
    // 只有一条来自 vue 的 import
    const vueImports = content.match(/from\s+['"]vue['"]/g) || [];
    assert.equal(vueImports.length, 1, '应合并为一条 import');
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 4：向嵌套配置对象追加属性 ─────────────────

const CONFIG_CODE = `export const config = {
  server: {
    host: 'localhost',
    port: 3000,
  },
  database: {
    url: 'postgres://localhost:5432/mydb',
  },
};
`;

test('E2E: 向嵌套对象追加属性', async () => {
  const { root, paths } = setupWorkspace({ 'src/config.ts': CONFIG_CODE });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/config.ts'],
      action: 'add_object_property',
      params: {
        objectLocator: { variableName: 'config', propertyPath: ['database'] },
        propertyCode: 'poolSize: 10',
      },
    });
    const content = getContent(result);
    assert.match(content, /poolSize:\s*10/);
    // 原有属性保留
    assert.match(content, /url:\s*'postgres/);
    assert.match(content, /host:\s*'localhost'/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 5：从 XML 输入到 ParsedToolCall 解析 ──────

test('E2E: XML 解析 → ast_edit ParsedToolCall 结构正确', () => {
  const xml = [
    '我来帮你添加一个 import：',
    '',
    '<tool_call>',
    '<ast_edit path="src/app.ts" action="add_import">',
    '{"modulePath": "./router", "namedImports": ["createRouter", "RouteConfig"]}',
    '</ast_edit>',
    '</tool_call>',
    '',
    '然后修改函数体：',
    '',
    '<tool_call>',
    '<ast_edit path="src/service.ts" action="edit_function_body">',
    '{"functionName": "init", "newBody": "await this.connect();\\nthis.ready = true;"}',
    '</ast_edit>',
    '</tool_call>',
  ].join('\n');

  const calls = parseToolCalls(xml);

  assert.equal(calls.length, 2);

  // 第一个调用
  assert.equal(calls[0].type, 'ast_edit');
  assert.equal(calls[0].path, 'src/app.ts');
  assert.equal(calls[0].astAction, 'add_import');
  assert.deepEqual(calls[0].astParams, {
    modulePath: './router',
    namedImports: ['createRouter', 'RouteConfig'],
  });

  // 第二个调用
  assert.equal(calls[1].type, 'ast_edit');
  assert.equal(calls[1].path, 'src/service.ts');
  assert.equal(calls[1].astAction, 'edit_function_body');
  assert.equal((calls[1].astParams as Record<string, unknown>)['functionName'], 'init');
});

// ─── 真实场景 6：JS 文件支持 ────────────────────────────

const JS_CODE = `const express = require('express');

function createServer(port) {
  const app = express();
  app.listen(port);
  return app;
}

module.exports = { createServer };
`;

test('E2E: JavaScript 文件的 AST 编辑', async () => {
  const { root, paths } = setupWorkspace({ 'src/server.js': JS_CODE });
  try {
    // 验证 supportsFile
    assert.ok(typescriptAdapter.supportsFile('src/server.js'));

    // 在 createServer 后插入新函数
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/server.js'],
      action: 'insert_function',
      params: {
        functionCode: 'function createMiddleware(name) {\n  return (req, res, next) => { next(); };\n}',
        insertAfter: 'createServer',
      },
    });
    const content = getContent(result);
    assert.match(content, /createMiddleware/);
    const serverIdx = content.indexOf('createServer');
    const middlewareIdx = content.indexOf('createMiddleware');
    assert.ok(middlewareIdx > serverIdx, 'createMiddleware 应在 createServer 之后');
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 7：JSX 文件支持 ───────────────────────────

const JSX_CODE = `import React from 'react';

function App() {
  return <div>Hello</div>;
}

export default App;
`;

test('E2E: JSX 文件的 AST 编辑', async () => {
  const { root, paths } = setupWorkspace({ 'src/App.jsx': JSX_CODE });
  try {
    assert.ok(typescriptAdapter.supportsFile('src/App.jsx'));

    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/App.jsx'],
      action: 'add_import',
      params: { modulePath: 'react', namedImports: ['useState'] },
    });
    const content = getContent(result);
    assert.match(content, /useState/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 8：不支持的文件类型 ───────────────────────

test('E2E: 不支持的文件类型正确拒绝', () => {
  assert.equal(typescriptAdapter.supportsFile('config.json'), false);
  assert.equal(typescriptAdapter.supportsFile('README.md'), false);
  assert.equal(typescriptAdapter.supportsFile('style.css'), false);
  assert.equal(typescriptAdapter.supportsFile('index.html'), false);
  assert.equal(typescriptAdapter.supportsFile('.env'), false);
});

// ─── 真实场景 9：箭头函数 body 替换（表达式体） ─────────

const ARROW_CODE = `export const multiply = (a: number, b: number) => a * b;

export const greet = (name: string) => {
  return \`Hello, \${name}!\`;
};
`;

test('E2E: 箭头函数表达式体和块体都能替换', async () => {
  const { root, paths } = setupWorkspace({ 'src/math.ts': ARROW_CODE });
  try {
    // 表达式体箭头函数
    const r1 = await runAst({
      workspaceRoot: root,
      filePath: paths['src/math.ts'],
      action: 'edit_function_body',
      params: { functionName: 'multiply', newBody: 'return a * b * 2;' },
    });
    const c1 = getContent(r1);
    assert.match(c1, /a \* b \* 2/);

    // 块体箭头函数
    const r2 = await runAst({
      workspaceRoot: root,
      filePath: paths['src/math.ts'],
      action: 'edit_function_body',
      params: { functionName: 'greet', newBody: 'const msg = `Hi ${name}`;\nreturn msg;' },
    });
    const c2 = getContent(r2);
    assert.match(c2, /Hi \$\{name\}/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 10：rename_symbol 跨引用更新 ──────────────

test('E2E: rename_symbol 更新同文件所有引用', async () => {
  const code = `function processData(items: string[]) {
  return items.map(item => item.trim());
}

const result = processData(['a', 'b']);
console.log(processData([]));
`;
  const { root, paths } = setupWorkspace({ 'src/data.ts': code });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/data.ts'],
      action: 'rename_symbol',
      params: { oldName: 'processData', newName: 'transformData' },
    });
    const content = getContent(result);
    // 所有引用都应被更新
    assert.doesNotMatch(content, /processData/);
    const occurrences = (content.match(/transformData/g) || []).length;
    assert.equal(occurrences, 3, '函数定义 + 两处调用 = 3 次出现');
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 11：remove_import 部分移除 ────────────────

test('E2E: 移除部分命名导入，保留其余', async () => {
  const code = `import { ref, computed, watch, onMounted } from 'vue';

const count = ref(0);
const doubled = computed(() => count.value * 2);
`;
  const { root, paths } = setupWorkspace({ 'src/composable.ts': code });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/composable.ts'],
      action: 'remove_import',
      params: { modulePath: 'vue', namedImports: ['watch', 'onMounted'] },
    });
    const content = getContent(result);
    assert.match(content, /ref/);
    assert.match(content, /computed/);
    assert.doesNotMatch(content, /watch/);
    assert.doesNotMatch(content, /onMounted/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 真实场景 12：错误恢复 —— 操作不存在的目标 ──────────

test('E2E: 操作不存在的 class 返回清晰错误', async () => {
  const { root, paths } = setupWorkspace({ 'src/demo.ts': 'const x = 1;\n' });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/demo.ts'],
      action: 'add_class_member',
      params: { className: 'NonExistentClass', memberCode: 'foo() {}' },
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.reason, /NonExistentClass/);
    }
  } finally {
    cleanWorkspace(root);
  }
});

test('E2E: rename 不存在的符号返回清晰错误', async () => {
  const { root, paths } = setupWorkspace({ 'src/demo.ts': 'const x = 1;\n' });
  try {
    const result = await runAst({
      workspaceRoot: root,
      filePath: paths['src/demo.ts'],
      action: 'rename_symbol',
      params: { oldName: 'nonExistent', newName: 'something' },
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.reason, /nonExistent/);
    }
  } finally {
    cleanWorkspace(root);
  }
});
