/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunCommandStepDescription,
  buildRunCommandStepResultDescription,
  getToolStepDescription,
} from '../src/webview/fileChanges';
import type { ParsedToolCall } from '../src/tools/toolParser';

test('getToolStepDescription search_file 使用 pattern 而非 path', () => {
  const toolCall: ParsedToolCall = {
    type: 'search_file',
    pattern: '*ffc_test*',
    rawMatch: '<search_file pattern="*ffc_test*" />',
  };

  const description = getToolStepDescription(toolCall);
  assert.match(description, /Searching/);
  assert.match(description, /ffc_test/);
});

test('getToolStepDescription grep_code 使用 regex 而非 path', () => {
  const toolCall: ParsedToolCall = {
    type: 'grep_code',
    regex: 'ffc_test',
    rawMatch: '<grep_code regex="ffc_test" />',
  };

  const description = getToolStepDescription(toolCall);
  assert.match(description, /Grep searching/);
  assert.match(description, /ffc_test/);
});

test('getToolStepDescription run_command 含命令前缀', () => {
  const toolCall: ParsedToolCall = {
    type: 'run_command',
    command: 'npm test',
    rawMatch: '<run_command>npm test</run_command>',
  };

  const description = getToolStepDescription(toolCall);
  assert.match(description, /^Running command: /);
  assert.match(description, /npm test/);
});

test('buildRunCommandStepResultDescription 成功时附带输出摘要', () => {
  const description = buildRunCommandStepResultDescription('echo hello', true, 'hello\n');
  assert.match(description, /^Running command: echo hello/);
  assert.match(description, /hello/);
});

test('buildRunCommandStepResultDescription 失败时附带错误摘要', () => {
  const description = buildRunCommandStepResultDescription('false', false, 'exit code 1');
  assert.match(description, /^Running command: false/);
  assert.match(description, /exit code 1/);
});
