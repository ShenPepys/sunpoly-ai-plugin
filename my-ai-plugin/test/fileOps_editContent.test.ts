/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEditedContent } from '../src/tools/fileOps';

// ==================== CRLF 鲁棒性测试 ====================

test('buildEditedContent: CRLF 文件 + LF old_string 仍能匹配并正确替换', () => {
  const fileContent = 'line1\r\nline2\r\nline3\r\n';
  const oldContent = 'line2\n';
  const newContent = 'LINE2_REPLACED\n';

  const result = buildEditedContent(fileContent, oldContent, newContent);

  assert.equal(result.success, true);
  if (!result.success) { return; }
  // 替换后应保持 CRLF（因为原文件是 CRLF）
  assert.equal(result.usedNormalizedMatch, true);
  assert.ok(result.updatedContent.includes('LINE2_REPLACED'), '替换内容应出现在结果中');
  assert.ok(!result.updatedContent.includes('line2'), '原始内容应被替换');
});

test('buildEditedContent: LF 文件 + CRLF old_string 仍能匹配', () => {
  const fileContent = 'line1\nline2\nline3\n';
  const oldContent = 'line2\r\n';
  const newContent = 'LINE2_REPLACED\n';

  const result = buildEditedContent(fileContent, oldContent, newContent);

  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.usedNormalizedMatch, true);
  assert.ok(result.updatedContent.includes('LINE2_REPLACED'));
});

test('buildEditedContent: 精确匹配（同为 CRLF）不走归一化路径', () => {
  const fileContent = 'aaa\r\nbbb\r\nccc\r\n';
  const oldContent = 'bbb\r\n';
  const newContent = 'BBB\r\n';

  const result = buildEditedContent(fileContent, oldContent, newContent);

  assert.equal(result.success, true);
  if (!result.success) { return; }
  // 精确匹配应不走归一化
  assert.equal(result.usedNormalizedMatch, false);
  assert.ok(result.updatedContent.includes('BBB'));
});

test('buildEditedContent: CRLF 多行片段精确匹配后替换保持 CRLF', () => {
  const fileContent = 'function foo() {\r\n  return 1;\r\n}\r\n';
  const oldContent = '  return 1;\r\n';
  const newContent = '  return 2;\n';

  const result = buildEditedContent(fileContent, oldContent, newContent);

  assert.equal(result.success, true);
  if (!result.success) { return; }
  // 原文件是 CRLF，new_content 应被适配为 CRLF
  assert.ok(result.updatedContent.includes('return 2;\r\n'), 'new_content 应保持文件原有 CRLF');
});

test('buildEditedContent: old_string 为空时返回 missing-old', () => {
  const result = buildEditedContent('any content', '', 'new');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'missing-old');
});

test('buildEditedContent: old_string 不存在（无论归一化与否）返回 not-found', () => {
  const result = buildEditedContent('hello world', 'no match here', 'new');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'not-found');
});

test('buildEditedContent: old_string 出现多次返回 not-unique', () => {
  const fileContent = 'aaa\nbbb\naaa\n';
  const result = buildEditedContent(fileContent, 'aaa\n', 'ccc\n');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'not-unique');
  assert.equal(result.matchCount, 2);
});

test('buildEditedContent: CRLF 归一化后出现多次也返回 not-unique', () => {
  const fileContent = 'aaa\r\nbbb\r\naaa\r\n';
  const oldContent = 'aaa\n';
  const result = buildEditedContent(fileContent, oldContent, 'ccc\n');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'not-unique');
  assert.equal(result.matchCount, 2);
});

test('buildEditedContent: 混合换行（\\r 单独出现）也能归一化匹配', () => {
  const fileContent = 'line1\rline2\rline3\r';
  const oldContent = 'line2\n';
  const newContent = 'LINE2\n';

  const result = buildEditedContent(fileContent, oldContent, newContent);

  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.usedNormalizedMatch, true);
  assert.ok(result.updatedContent.includes('LINE2'));
});
