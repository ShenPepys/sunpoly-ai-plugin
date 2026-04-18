/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { typescriptAdapter } from '../src/tools/astAdapter_typescript';
import { disposeProject } from '../src/tools/astContext';
import type { AstEditRequest, AstEditResult } from '../src/tools/astEditorTypes';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建临时工作区，写入测试文件，返回工作区根路径和文件绝对路径 */
function setupWorkspace(fileName: string, content: string): { root: string; filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-adapter-'));
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { root, filePath };
}

function cleanWorkspace(root: string): void {
  disposeProject();
  fs.rmSync(root, { recursive: true, force: true });
}

async function run(request: AstEditRequest): Promise<AstEditResult> {
  const content = fs.readFileSync(request.filePath, 'utf-8');
  return typescriptAdapter.execute(request, content);
}

function assertSuccess(result: AstEditResult): asserts result is Extract<AstEditResult, { success: true }> {
  if (!result.success) {
    assert.fail(`期望成功但失败了：${result.reason}`);
  }
}

function getNewContent(result: AstEditResult, index = 0): string {
  assertSuccess(result);
  return result.files[index].newContent;
}

// ─── add_import ───────────────────────────────────────────

test('add_import: 新增一条 import 声明', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const x = 1;\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_import',
      params: { modulePath: './helper', namedImports: ['foo', 'bar'] },
    });
    const content = getNewContent(result);
    assert.match(content, /import\s*\{\s*foo,\s*bar\s*\}\s*from\s*["']\.\/helper["']/);
  } finally {
    cleanWorkspace(root);
  }
});

test('add_import: 合并到已有 import', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'import { foo } from "./helper";\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_import',
      params: { modulePath: './helper', namedImports: ['bar'] },
    });
    const content = getNewContent(result);
    assert.match(content, /foo/);
    assert.match(content, /bar/);
    // 应该只有一条 import 声明
    const importCount = (content.match(/import\s/g) || []).length;
    assert.equal(importCount, 1, '应合并为一条 import');
  } finally {
    cleanWorkspace(root);
  }
});

// ─── remove_import ────────────────────────────────────────

test('remove_import: 删除指定命名导入，剩余不删', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'import { foo, bar } from "./helper";\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'remove_import',
      params: { modulePath: './helper', namedImports: ['foo'] },
    });
    const content = getNewContent(result);
    assert.doesNotMatch(content, /foo/);
    assert.match(content, /bar/);
  } finally {
    cleanWorkspace(root);
  }
});

test('remove_import: 不指定具体名称时删除整条', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'import { foo } from "./helper";\nconst x = 1;\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'remove_import',
      params: { modulePath: './helper' },
    });
    const content = getNewContent(result);
    assert.doesNotMatch(content, /import/);
    assert.match(content, /const x/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── insert_function ──────────────────────────────────────

test('insert_function: 在指定函数后面插入', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'function alpha() { return 1; }\nfunction gamma() { return 3; }\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'insert_function',
      params: { functionCode: 'function beta() { return 2; }', insertAfter: 'alpha' },
    });
    const content = getNewContent(result);
    const alphaIdx = content.indexOf('alpha');
    const betaIdx = content.indexOf('beta');
    const gammaIdx = content.indexOf('gamma');
    assert.ok(betaIdx > alphaIdx, 'beta 应在 alpha 之后');
    assert.ok(betaIdx < gammaIdx, 'beta 应在 gamma 之前');
  } finally {
    cleanWorkspace(root);
  }
});

test('insert_function: 默认追加到文件末尾', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const x = 1;\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'insert_function',
      params: { functionCode: 'function newFunc() { return 42; }' },
    });
    const content = getNewContent(result);
    assert.match(content, /newFunc/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── edit_function_body ───────────────────────────────────

test('edit_function_body: 替换具名函数体', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'function greet(name: string) {\n  return "hi";\n}\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'edit_function_body',
      params: { functionName: 'greet', newBody: 'return `hello ${name}`;' },
    });
    const content = getNewContent(result);
    assert.match(content, /hello \$\{name\}/);
    assert.doesNotMatch(content, /"hi"/);
  } finally {
    cleanWorkspace(root);
  }
});

test('edit_function_body: 替换箭头函数体', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const add = (a: number, b: number) => a + b;\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'edit_function_body',
      params: { functionName: 'add', newBody: 'return a * b;' },
    });
    const content = getNewContent(result);
    assert.match(content, /a \* b/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── add_function_param ───────────────────────────────────

test('add_function_param: 在末尾追加参数', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'function calc(a: number) { return a; }\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_function_param',
      params: { functionName: 'calc', paramCode: 'b?: string' },
    });
    const content = getNewContent(result);
    assert.match(content, /a:\s*number,\s*b\?:\s*string/);
  } finally {
    cleanWorkspace(root);
  }
});

test('add_function_param: 在指定位置插入参数', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'function calc(a: number, c: boolean) { return a; }\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_function_param',
      params: { functionName: 'calc', paramCode: 'b: string', position: 1 },
    });
    const content = getNewContent(result);
    // 顺序应为 a, b, c
    const aIdx = content.indexOf('a:');
    const bIdx = content.indexOf('b:');
    const cIdx = content.indexOf('c:');
    assert.ok(aIdx < bIdx && bIdx < cIdx, '参数顺序应为 a, b, c');
  } finally {
    cleanWorkspace(root);
  }
});

// ─── add_object_property ──────────────────────────────────

test('add_object_property: 向对象字面量追加属性', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const config = { enabled: true };\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_object_property',
      params: {
        objectLocator: { variableName: 'config' },
        propertyCode: 'mode: "production"',
      },
    });
    const content = getNewContent(result);
    assert.match(content, /mode:\s*"production"/);
    assert.match(content, /enabled:\s*true/);
  } finally {
    cleanWorkspace(root);
  }
});

test('add_object_property: 通过属性路径向嵌套对象追加', async () => {
  const src = 'const config = { db: { host: "localhost" } };\n';
  const { root, filePath } = setupWorkspace('demo.ts', src);
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_object_property',
      params: {
        objectLocator: { variableName: 'config', propertyPath: ['db'] },
        propertyCode: 'port: 5432',
      },
    });
    const content = getNewContent(result);
    assert.match(content, /port:\s*5432/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── add_class_member ─────────────────────────────────────

test('add_class_member: 在指定成员后插入', async () => {
  const src = 'class Service {\n  alpha() { return 1; }\n  gamma() { return 3; }\n}\n';
  const { root, filePath } = setupWorkspace('demo.ts', src);
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_class_member',
      params: { className: 'Service', memberCode: 'beta() { return 2; }', insertAfter: 'alpha' },
    });
    const content = getNewContent(result);
    const alphaIdx = content.indexOf('alpha');
    const betaIdx = content.indexOf('beta');
    const gammaIdx = content.indexOf('gamma');
    assert.ok(betaIdx > alphaIdx && betaIdx < gammaIdx, 'beta 应在 alpha 和 gamma 之间');
  } finally {
    cleanWorkspace(root);
  }
});

test('add_class_member: 默认追加到类末尾', async () => {
  const src = 'class Service {\n  run() { return 1; }\n}\n';
  const { root, filePath } = setupWorkspace('demo.ts', src);
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'add_class_member',
      params: { className: 'Service', memberCode: 'stop() { return 0; }' },
    });
    const content = getNewContent(result);
    assert.match(content, /stop\(\)/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── rename_symbol ────────────────────────────────────────

test('rename_symbol: 按名称重命名函数', async () => {
  const src = 'function oldName() { return 1; }\nconst x = oldName();\n';
  const { root, filePath } = setupWorkspace('demo.ts', src);
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'rename_symbol',
      params: { oldName: 'oldName', newName: 'newName' },
    });
    const content = getNewContent(result);
    assert.doesNotMatch(content, /oldName/);
    assert.match(content, /newName/);
    // 调用处也应被更新
    assert.match(content, /newName\(\)/);
  } finally {
    cleanWorkspace(root);
  }
});

// ─── 错误场景 ─────────────────────────────────────────────

test('错误场景: 操作不存在的函数返回失败', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const x = 1;\n');
  try {
    const result = await run({
      workspaceRoot: root,
      filePath,
      action: 'edit_function_body',
      params: { functionName: 'nonExistent', newBody: 'return 0;' },
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.reason, /nonExistent/);
    }
  } finally {
    cleanWorkspace(root);
  }
});

test('错误场景: 不支持的文件扩展名', () => {
  assert.equal(typescriptAdapter.supportsFile('readme.md'), false);
  assert.equal(typescriptAdapter.supportsFile('style.css'), false);
  assert.equal(typescriptAdapter.supportsFile('demo.ts'), true);
  assert.equal(typescriptAdapter.supportsFile('demo.tsx'), true);
  assert.equal(typescriptAdapter.supportsFile('demo.js'), true);
  assert.equal(typescriptAdapter.supportsFile('demo.jsx'), true);
});

// ─── 回滚验证 ─────────────────────────────────────────────

test('执行后内存 AST 回滚，不污染后续操作', async () => {
  const { root, filePath } = setupWorkspace('demo.ts', 'const x = 1;\n');
  try {
    // 第一次操作
    const r1 = await run({
      workspaceRoot: root,
      filePath,
      action: 'insert_function',
      params: { functionCode: 'function first() {}' },
    });
    assertSuccess(r1);

    // 第二次操作：因为内存已回滚，不应包含第一次插入的函数
    const r2 = await run({
      workspaceRoot: root,
      filePath,
      action: 'insert_function',
      params: { functionCode: 'function second() {}' },
    });
    const content = getNewContent(r2);
    assert.doesNotMatch(content, /first/, '回滚失败：第一次操作残留在内存中');
    assert.match(content, /second/);
  } finally {
    cleanWorkspace(root);
  }
});
