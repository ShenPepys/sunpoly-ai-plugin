/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasToolCalls, parseToolCalls, stripToolCalls } from '../src/tools/toolParser';

test('parseToolCalls 会忽略 fenced code block 中的工具 XML，只解析代码块外调用', () => {
  const content = [
    '先展示一个示例：',
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
    '',
    '<tool_call><read_file path="src/real.ts" /></tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'read_file');
  assert.equal(parsed[0].path, 'src/real.ts');
});

test('hasToolCalls 在工具 XML 只存在于 fenced code block 中时返回 false', () => {
  const content = [
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
  ].join('\n');

  assert.equal(hasToolCalls(content), false);
});

test('stripToolCalls 会保留 fenced code block 中的示例 XML，只剥离代码块外调用', () => {
  const content = [
    '先展示一个示例：',
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
    '',
    '下面执行真实调用：',
    '<tool_call><read_file path="src/real.ts" /></tool_call>',
  ].join('\n');

  const stripped = stripToolCalls(content);

  assert.match(stripped, /<tool_call><read_file path="demo\/example\.ts" \/><\/tool_call>/);
  assert.match(stripped, /```xml/);
  assert.doesNotMatch(stripped, /src\/real\.ts/);
});

// ─── ast_edit 解析测试 ────────────────────────────────────

test('parseToolCalls 能解析 JSON 格式的 ast_edit 工具调用', () => {
  const content = [
    '<tool_call>',
    '<ast_edit path="src/demo.ts" action="add_import">',
    '{"modulePath": "./utils", "namedImports": ["foo", "bar"]}',
    '</ast_edit>',
    '</tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'ast_edit');
  assert.equal(parsed[0].path, 'src/demo.ts');
  assert.equal(parsed[0].astAction, 'add_import');
  assert.deepEqual(parsed[0].astParams, {
    modulePath: './utils',
    namedImports: ['foo', 'bar'],
  });
});

test('parseToolCalls 能解析 <param> 标签格式的 ast_edit 工具调用', () => {
  const content = [
    '<ast_edit path="src/demo.ts" action="add_import">',
    '<param name="modulePath">./utils</param>',
    '<param name="namedImports">foo,bar</param>',
    '</ast_edit>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'ast_edit');
  assert.equal(parsed[0].astAction, 'add_import');
  assert.equal((parsed[0].astParams as Record<string, unknown>)['modulePath'], './utils');
  assert.deepEqual((parsed[0].astParams as Record<string, unknown>)['namedImports'], ['foo', 'bar']);
});

test('parseToolCalls 解析 ast_edit 的 rename_symbol（JSON 含数字参数）', () => {
  const content = [
    '<tool_call>',
    '<ast_edit path="src/demo.ts" action="rename_symbol">',
    '{"oldName": "foo", "newName": "bar", "line": 10, "column": 5}',
    '</ast_edit>',
    '</tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].astAction, 'rename_symbol');
  const params = parsed[0].astParams as Record<string, unknown>;
  assert.equal(params['oldName'], 'foo');
  assert.equal(params['newName'], 'bar');
  assert.equal(params['line'], 10);
  assert.equal(params['column'], 5);
});

test('hasToolCalls 能检测 ast_edit 标签', () => {
  assert.equal(hasToolCalls('<ast_edit path="x" action="add_import">{"modulePath":"y"}</ast_edit>'), true);
});

test('stripToolCalls 能清除 ast_edit 标签', () => {
  const content = '一些文字\n<ast_edit path="x" action="add_import">{"modulePath":"y"}</ast_edit>\n结束';
  const stripped = stripToolCalls(content);
  assert.doesNotMatch(stripped, /ast_edit/);
  assert.match(stripped, /一些文字/);
  assert.match(stripped, /结束/);
});
