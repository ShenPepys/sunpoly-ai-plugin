/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToolCalls, hasToolCalls, stripToolCalls } from '../src/tools/toolParser';

// ==================== search_file 解析 ====================

test('parseToolCalls 能解析 search_file 工具调用', () => {
  const text = '<search_file pattern="*.ts" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'search_file');
  assert.equal(calls[0].pattern, '*.ts');
});

test('parseToolCalls 能解析复杂 glob 模式的 search_file', () => {
  const text = '<search_file pattern="src/**/*.vue" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pattern, 'src/**/*.vue');
});

// ==================== grep_code 解析 ====================

test('parseToolCalls 能解析基本 grep_code 工具调用', () => {
  const text = '<grep_code regex="function\\s+test" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'grep_code');
  assert.equal(calls[0].regex, 'function\\s+test');
  assert.equal(calls[0].includePattern, undefined);
  assert.equal(calls[0].caseSensitive, false);
});

test('parseToolCalls 能解析带 include_pattern 的 grep_code', () => {
  const text = '<grep_code regex="console\\.log" include_pattern="*.ts" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].regex, 'console\\.log');
  assert.equal(calls[0].includePattern, '*.ts');
});

test('parseToolCalls 能解析带 case_sensitive 的 grep_code', () => {
  const text = '<grep_code regex="ERROR" case_sensitive="true" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].regex, 'ERROR');
  assert.equal(calls[0].caseSensitive, true);
});

test('parseToolCalls 能解析完整参数的 grep_code', () => {
  const text = '<grep_code regex="export\\s+class" include_pattern="**/*.ts" case_sensitive="false" />';
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].regex, 'export\\s+class');
  assert.equal(calls[0].includePattern, '**/*.ts');
  assert.equal(calls[0].caseSensitive, false);
});

// ==================== hasToolCalls 检测 ====================

test('hasToolCalls 能检测 search_file 标签', () => {
  const text = '<search_file pattern="*.js" />';
  assert.equal(hasToolCalls(text), true);
});

test('hasToolCalls 能检测 grep_code 标签', () => {
  const text = '<grep_code regex="func" />';
  assert.equal(hasToolCalls(text), true);
});

// ==================== stripToolCalls 剥离 ====================

test('stripToolCalls 能清除 search_file 标签', () => {
  const text = 'Some text <search_file pattern="*.ts" /> more text';
  const result = stripToolCalls(text);
  assert.equal(result.trim(), 'Some text  more text');
});

test('stripToolCalls 能清除 grep_code 标签', () => {
  const text = 'Text <grep_code regex="test" /> end';
  const result = stripToolCalls(text);
  assert.equal(result.trim(), 'Text  end');
});

test('stripToolCalls 能清除带多个属性的 grep_code 标签', () => {
  const text = '<grep_code regex="x" include_pattern="*.ts" case_sensitive="true" />';
  const result = stripToolCalls(text);
  assert.equal(result.trim(), '');
});

// ==================== 混合场景 ====================

test('parseToolCalls 能同时解析 search_file 和 grep_code', () => {
  const text = `
<search_file pattern="*.ts" />
<grep_code regex="export" include_pattern="*.ts" />
`;
  const calls = parseToolCalls(text);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'search_file');
  assert.equal(calls[1].type, 'grep_code');
});

test('parseToolCalls 在代码块外有 search_file/grep_code 时忽略代码块内', () => {
  const text = `
Here is the call:
<search_file pattern="*.vue" />

And here is an example in code block:
\`\`\`xml
<search_file pattern="example.ts" />
\`\`\`
`;
  const calls = parseToolCalls(text);

  // 只应解析代码块外的
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pattern, '*.vue');
});
