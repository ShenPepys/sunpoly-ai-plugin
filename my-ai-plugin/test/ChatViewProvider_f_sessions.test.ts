import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestoreSessionHistoryMessages,
  loadSessionsState,
  planClearCurrentSession,
  planDeleteSession,
  planSwitchSession,
} from '../src/webview/ChatViewProvider_f_sessions';
import type {
  ChatSession,
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  HistoryProcessSummary,
} from '../src/webview/messageTypes';

function sanitizeDisplayHistory(displayHistory: ChatSessionDisplayMessage[]): ChatSessionDisplayMessage[] {
  return displayHistory.map(message => ({ ...message }));
}

function buildDisplayHistoryFromRawHistory(history: ChatSessionHistoryMessage[]): ChatSessionDisplayMessage[] {
  return history
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role as 'user' | 'assistant',
      content: typeof message.displayContent === 'string'
        ? message.displayContent
        : typeof message.content === 'string'
          ? message.content
          : '',
      timestamp: message.timestamp,
    }));
}

function normalizeHistoryMessages(history: ChatSessionHistoryMessage[]): ChatSessionHistoryMessage[] {
  return history.map(message => ({ ...message }));
}

function createDisplayMessageId(role: 'user' | 'assistant', timestamp?: number): string {
  return `${role}-${timestamp ?? 0}`;
}

function createSession(overrides?: Partial<ChatSession>): ChatSession {
  return {
    id: overrides?.id ?? 'session-a',
    name: overrides?.name ?? '会话 A',
    createdAt: overrides?.createdAt ?? 100,
    updatedAt: overrides?.updatedAt ?? 100,
    history: overrides?.history ?? [],
    displayHistory: overrides?.displayHistory,
    uiTranscript: overrides?.uiTranscript,
  };
}

test('loadSessionsState 会为旧会话回填 displayHistory，并在活跃会话失效时回退到最新会话', () => {
  const savedSessions: ChatSession[] = [
    createSession({
      id: 'session-old',
      name: '旧会话',
      createdAt: 10,
      updatedAt: 20,
      history: [
        { role: 'user', content: '旧消息', timestamp: 11 },
        { role: 'assistant', content: '旧回复', timestamp: 12 },
      ],
    }),
    createSession({
      id: 'session-new',
      name: '新会话',
      createdAt: 30,
      updatedAt: 40,
      history: [
        { role: 'user', content: '新消息', timestamp: 31 },
      ],
      displayHistory: [
        { role: 'user', content: '新消息', timestamp: 31 },
      ],
    }),
  ];

  const state = loadSessionsState({
    savedSessions,
    savedActiveId: 'missing-session',
    normalizeHistoryMessages,
    sanitizeDisplayHistory,
    buildDisplayHistoryFromRawHistory,
  });

  assert.equal(state.activeSessionId, 'session-new');
  assert.equal(state.shouldResave, true);
  assert.equal(state.sessions[0].id, 'session-new');
  assert.equal(state.sessions[1].id, 'session-old');
  assert.deepEqual(state.sessions[1].displayHistory, [
    { role: 'user', content: '旧消息', timestamp: 11 },
    { role: 'assistant', content: '旧回复', timestamp: 12 },
  ]);
});

test('buildRestoreSessionHistoryMessages 会恢复消息并为 AI 回复补过程摘要消息', () => {
  const processSummary: HistoryProcessSummary = {
    totalSteps: 2,
    readCount: 1,
    listCount: 0,
    modifyCount: 0,
    createCount: 0,
    failedCount: 0,
    changedFiles: ['src/demo.ts'],
  };

  const messages = buildRestoreSessionHistoryMessages([
    { role: 'user', content: '你好', timestamp: 101 },
    { role: 'assistant', content: '已完成', timestamp: 102, messageId: 'assistant-102', processSummary },
  ], createDisplayMessageId);

  assert.deepEqual(messages, [
    {
      type: 'addMessage',
      role: 'user',
      content: '你好',
      messageId: 'user-101',
      createdAt: 101,
      readOnly: true,
    },
    {
      type: 'addMessage',
      role: 'assistant',
      content: '已完成',
      messageId: 'assistant-102',
      createdAt: 102,
      readOnly: true,
    },
    {
      type: 'showHistoryProcessSummary',
      messageId: 'assistant-102',
      summary: processSummary,
    },
  ]);
});

test('planSwitchSession 会恢复目标会话历史、更新时间，并清理旧会话重试快照', () => {
  const sessions = [
    createSession({ id: 'session-a', name: '会话 A', createdAt: 10, updatedAt: 20 }),
    createSession({
      id: 'session-b',
      name: '会话 B',
      createdAt: 30,
      updatedAt: 40,
      displayHistory: [
        { role: 'user', content: 'B 用户消息', timestamp: 301 },
        { role: 'assistant', content: 'B AI 回复', timestamp: 302 },
      ],
    }),
  ];

  const plan = planSwitchSession({
    hasRunningTask: false,
    sessions,
    activeSessionId: 'session-a',
    targetSessionId: 'session-b',
    sessionLauncherVisible: false,
    sanitizeDisplayHistory,
    buildDisplayHistoryFromRawHistory,
    createDisplayMessageId,
    now: 999,
  });

  assert.equal(plan.kind, 'switch');
  if (plan.kind !== 'switch') {
    assert.fail('切换会话应返回 switch 计划');
  }

  assert.equal(plan.nextActiveSessionId, 'session-b');
  assert.equal(plan.nextSessions[1].updatedAt, 999);
  assert.equal(plan.clearRetryableSessionId, 'session-a');
  assert.deepEqual(plan.messages, [
    { type: 'clearChat' },
    { type: 'setSessionLauncher', visible: false },
    {
      type: 'addMessage',
      role: 'user',
      content: 'B 用户消息',
      messageId: 'user-301',
      createdAt: 301,
      readOnly: true,
    },
    {
      type: 'addMessage',
      role: 'assistant',
      content: 'B AI 回复',
      messageId: 'assistant-302',
      createdAt: 302,
      readOnly: true,
    },
  ]);
});

test('planDeleteSession 删除当前活跃会话时会回到启动器并重置运行态', () => {
  const sessions = [
    createSession({ id: 'session-a', name: '会话 A' }),
    createSession({ id: 'session-b', name: '会话 B' }),
  ];

  const plan = planDeleteSession({
    hasRunningTask: false,
    sessions,
    activeSessionId: 'session-a',
    targetSessionId: 'session-a',
  });

  assert.equal(plan.kind, 'delete');
  if (plan.kind !== 'delete') {
    assert.fail('删除会话应返回 delete 计划');
  }

  assert.deepEqual(plan.nextSessions.map(session => session.id), ['session-b']);
  assert.equal(plan.nextActiveSessionId, '');
  assert.equal(plan.nextSessionLauncherVisible, true);
  assert.equal(plan.shouldResetSessionRuntime, true);
  assert.equal(plan.clearRetryableSessionId, 'session-a');
  assert.deepEqual(plan.messages, [
    { type: 'clearChat' },
    { type: 'setSessionLauncher', visible: true },
  ]);
});

test('planClearCurrentSession 会在启动器态阻止清空，在普通会话态返回 clear 计划', () => {
  const blockedPlan = planClearCurrentSession({
    sessionLauncherVisible: true,
    activeSessionId: 'session-a',
  });
  assert.deepEqual(blockedPlan, {
    kind: 'blocked',
    errorMessage: '当前处于新建对话状态，无需清空对话。',
  });

  const clearPlan = planClearCurrentSession({
    sessionLauncherVisible: false,
    activeSessionId: 'session-a',
  });
  assert.deepEqual(clearPlan, {
    kind: 'clear',
    clearRetryableSessionId: 'session-a',
    messages: [{ type: 'clearChat' }],
  });
});
