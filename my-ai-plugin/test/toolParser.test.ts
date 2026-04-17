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
