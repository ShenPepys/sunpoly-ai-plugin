/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeAssistantResponseDisplay } from '../src/webview/ChatViewProvider_displayHistory';

test('analyzeAssistantResponseDisplay: 长分析 + 尾部残缺标签保留正文不报错', () => {
  const body = 'x'.repeat(600);
  const content = `${body}\n| 表格 |\n]]></edit_file>`;
  const analysis = analyzeAssistantResponseDisplay(content);

  assert.equal(analysis.kind, 'plain');
  assert.match(analysis.displayContent, /^x{600}/);
  assert.doesNotMatch(analysis.displayContent, /edit_file/);
});

test('analyzeAssistantResponseDisplay: 可恢复的 edit_file 走 tool-calls', () => {
  const content = [
    '更新报告：',
    '<edit_file path="BUG.md" start_line="1" end_line="50"><new>',
    '# Bugs',
    ']]></edit_file>',
  ].join('\n');
  const analysis = analyzeAssistantResponseDisplay(content);

  assert.equal(analysis.kind, 'tool-calls');
  if (analysis.kind === 'tool-calls') {
    assert.equal(analysis.parsedToolCalls[0].type, 'edit_file');
    assert.equal(analysis.parsedToolCalls[0].path, 'BUG.md');
  }
});
