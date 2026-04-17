/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCallBatchRound } from '../src/webview/ChatViewProvider_p_requestExecution';
import type { HistoryProcessSummary, ChatSessionHistoryMessage } from '../src/webview/messageTypes';
import type { ParsedToolCall } from '../src/tools';
import type { ApiClientConfig } from '../src/api/client';

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
