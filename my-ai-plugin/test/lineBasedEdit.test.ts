/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLineBasedEditContent, buildEditedContent } from '../src/tools/fileOps';
import { parseToolCalls, stripToolCalls } from '../src/tools/toolParser';

// ==================== buildLineBasedEditContent 测试 ====================

test('行号编辑：替换单行', () => {
  const file = 'line1\nline2\nline3\nline4\n';
  const result = buildLineBasedEditContent(file, 2, 2, 'REPLACED');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'line1\nREPLACED\nline3\nline4\n');
});

test('行号编辑：替换多行范围', () => {
  const file = 'line1\nline2\nline3\nline4\nline5\n';
  const result = buildLineBasedEditContent(file, 2, 4, 'NEW_2\nNEW_3');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'line1\nNEW_2\nNEW_3\nline5\n');
});

test('行号编辑：省略 endLine 时等于 startLine', () => {
  const file = 'aaa\nbbb\nccc\n';
  const result = buildLineBasedEditContent(file, 2, undefined, 'BBB');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'aaa\nBBB\nccc\n');
});

test('行号编辑：替换第一行', () => {
  const file = 'first\nsecond\nthird\n';
  const result = buildLineBasedEditContent(file, 1, 1, 'FIRST');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'FIRST\nsecond\nthird\n');
});

test('行号编辑：替换最后一行', () => {
  const file = 'first\nsecond\nthird';
  const result = buildLineBasedEditContent(file, 3, 3, 'THIRD');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'first\nsecond\nTHIRD');
});

test('行号编辑：endLine 超出文件末尾自动截断', () => {
  const file = 'line1\nline2\nline3\n';
  const result = buildLineBasedEditContent(file, 2, 100, 'TAIL');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  // 行 2~4（截断到 4）全部替换
  assert.equal(result.updatedContent, 'line1\nTAIL');
});

test('行号编辑：startLine 超出文件总行数返回失败', () => {
  const file = 'line1\nline2\n';
  const result = buildLineBasedEditContent(file, 10, 12, 'x');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'invalid-range');
  assert.match(result.message, /超出文件总行数/);
});

test('行号编辑：startLine < 1 返回失败', () => {
  const file = 'line1\nline2\n';
  const result = buildLineBasedEditContent(file, 0, 1, 'x');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'invalid-range');
});

test('行号编辑：endLine < startLine 返回失败', () => {
  const file = 'line1\nline2\nline3\n';
  const result = buildLineBasedEditContent(file, 3, 1, 'x');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'invalid-range');
});

test('行号编辑：CRLF 文件保持 CRLF 换行风格', () => {
  const file = 'line1\r\nline2\r\nline3\r\n';
  const result = buildLineBasedEditContent(file, 2, 2, 'REPLACED');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'line1\r\nREPLACED\r\nline3\r\n');
});

test('行号编辑：用多行内容替换单行（插入扩展）', () => {
  const file = 'a\nb\nc\n';
  const result = buildLineBasedEditContent(file, 2, 2, 'b1\nb2\nb3');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.updatedContent, 'a\nb1\nb2\nb3\nc\n');
});

// ==================== toolParser 行号模式解析测试 ====================

test('parseToolCalls 解析带 start_line/end_line 的行号模式 edit_file', () => {
  const content = '<tool_call><edit_file path="pages/login.vue" start_line="75" end_line="78"><new>replacement code</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'edit_file');
  assert.equal(calls[0].path, 'pages/login.vue');
  assert.equal(calls[0].startLine, 75);
  assert.equal(calls[0].endLine, 78);
  assert.equal(calls[0].newContent, 'replacement code');
  assert.equal(calls[0].oldContent, undefined);
});

test('parseToolCalls 解析只有 start_line（无 end_line）的行号模式', () => {
  const content = '<edit_file path="a.vue" start_line="10"><new>single line</new></edit_file>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].startLine, 10);
  assert.equal(calls[0].endLine, undefined);
  assert.equal(calls[0].newContent, 'single line');
});

test('parseToolCalls 行号模式下无 old 标签不影响解析', () => {
  const content = '<tool_call><edit_file path="x.js" start_line="5" end_line="10"><new>new code</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].oldContent, undefined);
  assert.equal(calls[0].replaceAll, undefined);
});

test('parseToolCalls 文本匹配模式仍然正常工作（不含行号属性）', () => {
  const content = '<tool_call><edit_file path="a.ts"><old>foo</old><new>bar</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].oldContent, 'foo');
  assert.equal(calls[0].newContent, 'bar');
  assert.equal(calls[0].startLine, undefined);
  assert.equal(calls[0].endLine, undefined);
});

test('stripToolCalls 能清除带行号属性的 edit_file 标签', () => {
  const content = '修改文件：\n<edit_file path="a.vue" start_line="10" end_line="20"><new>code</new></edit_file>\n完成';
  const stripped = stripToolCalls(content);
  assert.doesNotMatch(stripped, /edit_file/);
  assert.match(stripped, /修改文件/);
  assert.match(stripped, /完成/);
});

// ==================== 编辑规模限制测试（通过 buildEditedContent 验证文本长度不影响功能） ====================

// ==================== ast_bypass 属性解析测试 ====================

test('parseToolCalls 解析带 ast_bypass="true" 的 edit_file', () => {
  const content = '<tool_call><edit_file path="src/app.ts" ast_bypass="true" start_line="5" end_line="8"><new>new code</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'edit_file');
  assert.equal(calls[0].astBypass, true);
  assert.equal(calls[0].startLine, 5);
});

test('parseToolCalls 文本匹配模式也能解析 ast_bypass', () => {
  const content = '<edit_file path="utils.js" ast_bypass="true"><old>foo</old><new>bar</new></edit_file>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].astBypass, true);
  assert.equal(calls[0].oldContent, 'foo');
});

test('parseToolCalls 不带 ast_bypass 时 astBypass 为 undefined', () => {
  const content = '<edit_file path="a.ts" start_line="1"><new>x</new></edit_file>';
  const calls = parseToolCalls(content);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].astBypass, undefined);
});

// ==================== 编辑规模限制测试（通过 buildEditedContent 验证文本长度不影响功能） ====================

test('buildEditedContent：30 行以内的 old 内容正常匹配', () => {
  // 构造一个 25 行的文件
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
  const file = lines.join('\n');
  // old 包含行 5-15（11 行，在限制内）
  const old = lines.slice(4, 15).join('\n');
  const result = buildEditedContent(file, old, 'REPLACED');
  assert.equal(result.success, true);
});
