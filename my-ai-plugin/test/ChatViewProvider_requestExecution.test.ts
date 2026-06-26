/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggressivelyTrimMessagesAfterContextError,
  executeToolCallBatchRound,
  isContextLengthError,
} from '../src/webview/ChatViewProvider_requestExecution';
import type { HistoryProcessSummary, ChatSessionHistoryMessage } from '../src/webview/messageTypes';
import type { ParsedToolCall } from '../src/tools';
import type { ApiClientConfig } from '../src/api/client';
import type { ChatMessageParam } from '../src/api/types';

function createHistoryProcessSummary(): HistoryProcessSummary {
  return {
    totalSteps: 0,
    readCount: 0,
    listCount: 0,
    modifyCount: 0,
    createCount: 0,
    failedCount: 0,
    changedFiles: [],
  };
}

function createApiConfig(): ApiClientConfig {
  return {
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    modelId: 'test-model',
    apiPath: '/v1/chat/completions',
    maxTokens: 1024,
    temperature: 0,
  };
}

test('executeToolCallBatchRound 在写失败后直接 halted，不再进入 follow-up', async () => {
  const toolCalls: ParsedToolCall[] = [
    {
      type: 'write_file',
      path: 'src/demo.ts',
      content: 'console.log("demo");',
      rawMatch: '<write_file path="src/demo.ts">console.log("demo");</write_file>',
    },
  ];
  const postedMessages: unknown[] = [];
  const chatHistory: ChatSessionHistoryMessage[] = [];

  const result = await executeToolCallBatchRound({
    toolCalls,
    requestMode: 'ask',
    messageId: 'message-1',
    apiConfig: createApiConfig(),
    stepSequenceStart: 1,
    writeBackups: new Map(),
    turnWriteFiles: [],
    turnWriteRounds: 0,
    recoverableWriteFailRounds: 0,
    activeHistoryProcessSummary: null,
    chatHistory,
    historyForFollowUp: [],
    postMessage: message => {
      postedMessages.push(message);
    },
    canContinue: () => true,
    getActiveRunId: () => 'message-1',
    saveChatHistory: () => {},
    createHistoryProcessSummary,
    toDisplayPath: filePath => filePath,
  });

  assert.equal(result.kind, 'halted');
  assert.equal(result.shouldFinalizeStoppedRun, true);
  assert.equal(chatHistory.length, 0, '写失败后不应再把工具反馈压入 chatHistory 做 follow-up');

  const updateStepMessage = postedMessages.find(message => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && (message as { type?: string }).type === 'updateStep';
  }) as { status?: string; description?: string } | undefined;

  assert.ok(updateStepMessage, '应发出失败步骤更新消息');
  assert.equal(updateStepMessage?.status, 'error');
  assert.match(updateStepMessage?.description || '', /当前处于 Ask 模式，不允许修改文件/);
});

// ─── Context-Length 400 自动重试 ─ 辅助函数单元测试 ────────────────

test('isContextLengthError 能识别 OpenAI 风格的 400 错误信息', () => {
  const errorMessage = "This model's maximum context length is 16384 tokens. However, you requested 16744 tokens. Please reduce the length of the messages or completion.";
  assert.equal(isContextLengthError(errorMessage), true);
});

test('isContextLengthError 能识别 context length exceeded 文本变体', () => {
  assert.equal(isContextLengthError('Context length exceeded the maximum'), true);
  assert.equal(isContextLengthError('The context-length is too long for the model'), true);
});

test('isContextLengthError 能识别中文描述的上下文超限', () => {
  assert.equal(isContextLengthError('请求的上下文长度超出模型限制'), true);
  assert.equal(isContextLengthError('token 数超出最大值'), true);
  assert.equal(isContextLengthError('提示词 token 过长'), true);
});

test('isContextLengthError 对无关错误返回 false', () => {
  assert.equal(isContextLengthError(''), false);
  assert.equal(isContextLengthError('API Key 无效或已过期'), false);
  assert.equal(isContextLengthError('API 请求频率过高，请 30 秒后重试'), false);
  assert.equal(isContextLengthError('连接 AI 服务失败: ECONNREFUSED'), false);
});

test('aggressivelyTrimMessagesAfterContextError 会保留 system 和最后一条 user，并从中间丢掉 30%', () => {
  const messages: ChatMessageParam[] = [
    { role: 'system', content: '你是一个 AI 助手' },
    { role: 'user', content: '第 1 条提问' },
    { role: 'assistant', content: '第 1 条回答' },
    { role: 'user', content: '第 2 条提问' },
    { role: 'assistant', content: '第 2 条回答' },
    { role: 'user', content: '第 3 条提问' },
    { role: 'assistant', content: '第 3 条回答' },
    { role: 'user', content: '第 4 条提问' },
    { role: 'assistant', content: '第 4 条回答' },
    { role: 'user', content: '当前最新提问' },
  ];

  const trimmed = aggressivelyTrimMessagesAfterContextError(messages);

  // 首条 system 和最后一条 user 必须保留
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed[trimmed.length - 1].content, '当前最新提问');
  // 10 条消息：去掉 system 后 9 条，中间历史 8 条，30% = 2 条被丢掉
  // 保留：system + 6 条中间 + 最后 user = 8 条
  assert.equal(trimmed.length, 8);
  // 第一条被丢掉，"第 1 条提问" 不应再出现
  const trimmedTexts = trimmed.map(message => message.content);
  assert.equal(trimmedTexts.includes('第 1 条提问'), false);
});

test('aggressivelyTrimMessagesAfterContextError 至少丢掉 1 条（即使总数很少）', () => {
  const messages: ChatMessageParam[] = [
    { role: 'system', content: '你是一个 AI 助手' },
    { role: 'user', content: '旧提问' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '当前提问' },
  ];

  const trimmed = aggressivelyTrimMessagesAfterContextError(messages);

  // 4 条：去掉 system 后 3 条，中间历史 2 条，30% = 0，但至少丢 1 条
  assert.equal(trimmed.length, 3);
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed[trimmed.length - 1].content, '当前提问');
});

test('aggressivelyTrimMessagesAfterContextError 在消息太少时直接返回原数组（无法再裁）', () => {
  const onlyUser: ChatMessageParam[] = [{ role: 'user', content: '单条提问' }];
  assert.equal(aggressivelyTrimMessagesAfterContextError(onlyUser), onlyUser);

  const systemAndUser: ChatMessageParam[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '当前提问' },
  ];
  assert.equal(aggressivelyTrimMessagesAfterContextError(systemAndUser), systemAndUser);
});

test('aggressivelyTrimMessagesAfterContextError 没有 system 时也能正确裁剪', () => {
  const messages: ChatMessageParam[] = [
    { role: 'user', content: '旧提问 1' },
    { role: 'assistant', content: '旧回答 1' },
    { role: 'user', content: '旧提问 2' },
    { role: 'assistant', content: '旧回答 2' },
    { role: 'user', content: '当前提问' },
  ];

  const trimmed = aggressivelyTrimMessagesAfterContextError(messages);

  // 没有 system，5 条消息，中间历史 4 条，30% = 1 条被丢掉
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[trimmed.length - 1].content, '当前提问');
  // 第一条被丢掉
  const trimmedTexts = trimmed.map(message => message.content);
  assert.equal(trimmedTexts.includes('旧提问 1'), false);
});
