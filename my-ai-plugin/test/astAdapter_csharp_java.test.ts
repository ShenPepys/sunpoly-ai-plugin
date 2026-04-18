/// <reference types="node" />
/**
 * 阶段七 TASK-AST-7.7: C# 和 Java 适配器测试
 *
 * 覆盖：
 * - supportsFile 扩展名判断
 * - 运行时不可用时的降级行为
 * - 有运行时时的 worker 通信测试（条件跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

import { csharpAdapter } from '../src/tools/astAdapter_csharp';
import { javaAdapter } from '../src/tools/astAdapter_java';

// ─── 检测运行时可用性 ────────────────────────────────────

function isDotnetAvailable(): boolean {
  try {
    const out = execSync('dotnet --version', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function isJavaAvailable(): boolean {
  try {
    const out = execSync('java -version 2>&1', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

const hasDotnet = isDotnetAvailable();
const hasJava = isJavaAvailable();

// ═══════════════════════════════════════════════════════════
//  C# 适配器测试
// ═══════════════════════════════════════════════════════════

test('csharpAdapter.supportsFile 对 .cs 返回 true', () => {
  assert.ok(csharpAdapter.supportsFile('src/Program.cs'));
  assert.ok(csharpAdapter.supportsFile('Models/User.cs'));
});

test('csharpAdapter.supportsFile 对非 .cs 文件返回 false', () => {
  assert.equal(csharpAdapter.supportsFile('src/main.ts'), false);
  assert.equal(csharpAdapter.supportsFile('app.py'), false);
  assert.equal(csharpAdapter.supportsFile('Main.java'), false);
});

test('csharpAdapter.execute 在 .NET 不可用时返回失败', {
  skip: hasDotnet ? '当前环境有 .NET SDK，跳过此测试' : false,
}, async () => {
  const result = await csharpAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/Test.cs',
      action: 'add_import',
      params: { modulePath: 'System.Linq' },
    } as any,
    'using System;\n\nclass Test {}\n',
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /csharp|不可用|运行时/);
  }
});

test('csharpAdapter: add_import 操作', {
  skip: !hasDotnet ? '需要 .NET SDK' : false,
}, async () => {
  const result = await csharpAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/Test.cs',
      action: 'add_import',
      params: { modulePath: 'System.Linq' },
    } as any,
    'using System;\n\nnamespace App\n{\n    class Test { }\n}\n',
  );

  if (!result.success) {
    assert.fail(`add_import 失败：${result.reason}`);
  }
  const content = result.files[0].newContent;
  assert.match(content, /using\s+System\.Linq/);
  assert.match(content, /using\s+System;/);
});

test('csharpAdapter: rename_symbol 操作', {
  skip: !hasDotnet ? '需要 .NET SDK' : false,
}, async () => {
  const result = await csharpAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/Test.cs',
      action: 'rename_symbol',
      params: { oldName: 'Foo', newName: 'Bar' },
    } as any,
    'class Foo\n{\n    public void DoWork()\n    {\n        var f = new Foo();\n    }\n}\n',
  );

  if (!result.success) {
    assert.fail(`rename_symbol 失败：${result.reason}`);
  }
  const content = result.files[0].newContent;
  assert.doesNotMatch(content, /Foo/);
  assert.match(content, /class Bar/);
  assert.match(content, /new Bar/);
});

test('csharpAdapter: 操作不存在的方法返回失败', {
  skip: !hasDotnet ? '需要 .NET SDK' : false,
}, async () => {
  const result = await csharpAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/Test.cs',
      action: 'edit_function_body',
      params: { functionName: 'NonExistent', newBody: 'return 0;' },
    } as any,
    'class Test\n{\n    public int Get() { return 1; }\n}\n',
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /NonExistent/);
  }
});

test('csharpAdapter: dispose 不抛异常', () => {
  assert.doesNotThrow(() => csharpAdapter.dispose?.());
});

// ═══════════════════════════════════════════════════════════
//  Java 适配器测试
// ═══════════════════════════════════════════════════════════

test('javaAdapter.supportsFile 对 .java 返回 true', () => {
  assert.ok(javaAdapter.supportsFile('src/Main.java'));
  assert.ok(javaAdapter.supportsFile('com/app/Service.java'));
});

test('javaAdapter.supportsFile 对非 .java 文件返回 false', () => {
  assert.equal(javaAdapter.supportsFile('src/main.ts'), false);
  assert.equal(javaAdapter.supportsFile('app.py'), false);
  assert.equal(javaAdapter.supportsFile('Test.cs'), false);
});

test('javaAdapter.execute 在 JVM 不可用时返回失败', {
  skip: hasJava ? '当前环境有 JVM，跳过此测试' : false,
}, async () => {
  const result = await javaAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/Test.java',
      action: 'add_import',
      params: { modulePath: 'java.util.List' },
    } as any,
    'public class Test {}\n',
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /java|不可用|运行时/);
  }
});

test('javaAdapter: dispose 不抛异常', () => {
  assert.doesNotThrow(() => javaAdapter.dispose?.());
});
