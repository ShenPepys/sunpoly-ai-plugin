/// <reference types="node" />
/**
 * 阶段六 TASK-AST-6.6: Python 适配器测试
 *
 * 覆盖：
 * - supportsFile 扩展名判断
 * - Python 不可用时的降级行为（在当前环境中可测试）
 * - Python worker 通信测试（需要 Python 3 + libcst，条件跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

import { pythonAdapter } from '../src/tools/astAdapter_python';

// ─── 检测 Python 可用性 ───────────────────────────────────

function isPythonAvailable(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'python' : 'python3';
    const out = execSync(`${cmd} -c "import libcst; print('ok')"`, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() === 'ok';
  } catch {
    return false;
  }
}

const hasPython = isPythonAvailable();

// ─── supportsFile 扩展名判断 ──────────────────────────────

test('pythonAdapter.supportsFile 对 .py 返回 true', () => {
  assert.ok(pythonAdapter.supportsFile('src/main.py'));
  assert.ok(pythonAdapter.supportsFile('tests/test_utils.py'));
});

test('pythonAdapter.supportsFile 对非 .py 文件返回 false', () => {
  assert.equal(pythonAdapter.supportsFile('src/main.ts'), false);
  assert.equal(pythonAdapter.supportsFile('src/app.js'), false);
  assert.equal(pythonAdapter.supportsFile('config.json'), false);
  assert.equal(pythonAdapter.supportsFile('README.md'), false);
});

// ─── Python 不可用时的降级 ────────────────────────────────

test('pythonAdapter.execute 在 Python 不可用时返回失败', { skip: hasPython ? '当前环境有 Python，跳过此测试' : false }, async () => {
  const result = await pythonAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/test.py',
      action: 'add_import',
      params: { modulePath: 'os' },
    } as any,
    'import sys\n',
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /Python|libcst|不可用/);
  }
});

// ─── Python worker 通信测试（需要 Python 3 + libcst） ────

test('pythonAdapter: add_import 操作', { skip: !hasPython ? '需要 Python 3 + libcst' : false }, async () => {
  const result = await pythonAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/test.py',
      action: 'add_import',
      params: { modulePath: 'os', namedImports: ['path', 'getcwd'] },
    } as any,
    'import sys\n\nx = 1\n',
  );

  if (!result.success) {
    assert.fail(`add_import 失败：${result.reason}`);
  }
  const content = result.files[0].newContent;
  assert.match(content, /from\s+os\s+import\s+path/);
  assert.match(content, /getcwd/);
  assert.match(content, /import sys/);
});

test('pythonAdapter: rename_symbol 操作', { skip: !hasPython ? '需要 Python 3 + libcst' : false }, async () => {
  const result = await pythonAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/test.py',
      action: 'rename_symbol',
      params: { oldName: 'foo', newName: 'bar' },
    } as any,
    'def foo():\n    pass\n\nresult = foo()\n',
  );

  if (!result.success) {
    assert.fail(`rename_symbol 失败：${result.reason}`);
  }
  const content = result.files[0].newContent;
  assert.doesNotMatch(content, /foo/);
  assert.match(content, /def bar/);
  assert.match(content, /result = bar/);
});

test('pythonAdapter: insert_function 操作', { skip: !hasPython ? '需要 Python 3 + libcst' : false }, async () => {
  const result = await pythonAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/test.py',
      action: 'insert_function',
      params: {
        functionCode: 'def greet(name):\n    return f"Hello, {name}"',
        insertAfter: 'main',
      },
    } as any,
    'def main():\n    pass\n\ndef cleanup():\n    pass\n',
  );

  if (!result.success) {
    assert.fail(`insert_function 失败：${result.reason}`);
  }
  const content = result.files[0].newContent;
  const mainIdx = content.indexOf('def main');
  const greetIdx = content.indexOf('def greet');
  const cleanupIdx = content.indexOf('def cleanup');
  assert.ok(greetIdx > mainIdx, 'greet 应在 main 之后');
  assert.ok(greetIdx < cleanupIdx, 'greet 应在 cleanup 之前');
});

test('pythonAdapter: 操作不存在的函数返回失败', { skip: !hasPython ? '需要 Python 3 + libcst' : false }, async () => {
  const result = await pythonAdapter.execute(
    {
      workspaceRoot: '/tmp',
      filePath: '/tmp/test.py',
      action: 'edit_function_body',
      params: { functionName: 'nonexistent', newBody: 'pass' },
    } as any,
    'def main():\n    pass\n',
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /nonexistent/);
  }
});

// ─── 清理 ─────────────────────────────────────────────────

test('pythonAdapter: dispose 不抛异常', () => {
  // 调用 dispose 不应崩溃（即使没有启动过 worker）
  assert.doesNotThrow(() => pythonAdapter.dispose?.());
});
