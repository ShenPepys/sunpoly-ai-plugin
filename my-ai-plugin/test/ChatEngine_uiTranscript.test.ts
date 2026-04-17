/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatEngine } from '../src/webview/ChatEngine';
import { SessionStore } from '../src/webview/SessionStore';
import * as configModule from '../src/config';
import * as requestExecutionModule from '../src/webview/ChatViewProvider_p_requestExecution';
import type { IChatHost } from '../src/webview/IChatHost';
import type { ExtensionMessage, ChatSession, PersistedUiEntry, PersistedUiMessageEntry } from '../src/webview/messageTypes';
import { rememberRetryableRequest } from '../src/webview/ChatViewProvider_i_retryRequests';
import type { RetryableRequestState } from '../src/webview/ChatViewProvider_i_retryRequests';

// ==================== 最小 Mock 工具 ====================

/**
 * 内存版 Memento，模拟 vscode.Memento
 * 用于在测试中替代 globalState
 */
class MockMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.data.keys()];
  }

  setInitialData(key: string, value: unknown): void {
    this.data.set(key, value);
  }
}

/**
 * 创建最小 IChatHost mock
 * 捕获所有 postMessage 调用以供断言
 */
function createMockHost(): IChatHost & { messages: ExtensionMessage[] } {
  const messages: ExtensionMessage[] = [];
  return {
    messages,
    postMessage(message: ExtensionMessage): void {
      messages.push(message);
    },
    getWebview() {
      return undefined;
    },
    getExtensionUri() {
      return { fsPath: '' } as any;
    },
    getGlobalState() {
      return new MockMemento() as any;
    },
    reveal() {},
  };
}

/**
 * 创建包含预置会话的 ChatEngine + Store
 * 返回 engine、host（可检查消息）、store（可检查会话数据）
 */
function createTestEngine(options?: {
  sessions?: ChatSession[];
  activeSessionId?: string;
}): { engine: ChatEngine; host: IChatHost & { messages: ExtensionMessage[] }; store: SessionStore; memento: MockMemento } {
  const memento = new MockMemento();

  const sessions = options?.sessions ?? [
    {
      id: 'session-a',
      name: '会话 A',
      createdAt: 100,
      updatedAt: 100,
      history: [],
      displayHistory: [],
    },
  ];
  const activeSessionId = options?.activeSessionId ?? sessions[0]?.id ?? '';

  memento.setInitialData('chatSessions', sessions);
  memento.setInitialData('activeSessionId', activeSessionId);

  const store = new SessionStore(memento as any);
  const host = createMockHost();
  const engine = new ChatEngine(host, store);

  return { engine, host, store, memento };
}

/** 从 store.sessions 中获取指定会话的 uiTranscript */
function getSessionTranscript(store: SessionStore, sessionId: string): PersistedUiEntry[] {
  const session = store.sessions.find(session => session.id === sessionId);
  return session?.uiTranscript ?? [];
}

/** 在 uiTranscript 中查找指定 messageId 的 message entry */
function findMessageEntry(transcript: PersistedUiEntry[], messageId: string): PersistedUiMessageEntry | undefined {
  return transcript.find((entry): entry is PersistedUiMessageEntry => {
    return entry.type === 'message' && entry.messageId === messageId;
  });
}

function createRetryableRequestState(overrides?: Partial<RetryableRequestState>): RetryableRequestState {
  return {
    requestId: overrides?.requestId ?? 'request-1',
    sessionId: overrides?.sessionId ?? 'session-a',
    text: overrides?.text ?? '重试文本',
    userContent: overrides?.userContent ?? '重试文本',
    images: overrides?.images ?? [],
    requestMode: overrides?.requestMode ?? 'code',
  };
}

// ==================== uiTranscript 捕获测试 ====================

test('postMessage(addMessage) 会将用户消息捕获到 uiTranscript', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'user',
    content: '你好',
    messageId: 'user-1',
    createdAt: 1000,
  });

  const transcript = getSessionTranscript(store, 'session-a');
  assert.equal(transcript.length, 1, 'uiTranscript 应有 1 条记录');

  const entry = findMessageEntry(transcript, 'user-1');
  assert.ok(entry, 'uiTranscript 应包含 user-1');
  assert.equal(entry.role, 'user');
  assert.equal(entry.content, '你好');
  assert.equal(entry.createdAt, 1000);
});

test('postMessage(addMessage) + streamChunk + streamDone 完整记录 AI 回复', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '',
    messageId: 'assistant-1',
    createdAt: 2000,
    partial: true,
  });

  engine.postMessage({
    type: 'streamChunk',
    messageId: 'assistant-1',
    chunk: '你好，',
  });

  engine.postMessage({
    type: 'streamChunk',
    messageId: 'assistant-1',
    chunk: '我是 AI',
  });

  engine.postMessage({
    type: 'streamDone',
    messageId: 'assistant-1',
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-1');
  assert.ok(entry, 'uiTranscript 应包含 assistant-1');
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.content, '你好，我是 AI');
  assert.equal(entry.partial, undefined, 'streamDone 后 partial 应被清除');
});

test('postMessage(showError) 会捕获错误到 uiTranscript', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'showError',
    message: '网络连接失败',
    retryable: true,
    createdAt: 3000,
  });

  const transcript = getSessionTranscript(store, 'session-a');
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].type, 'error');
  if (transcript[0].type === 'error') {
    assert.equal(transcript[0].message, '网络连接失败');
    assert.equal(transcript[0].retryable, true);
  }
});

test('postMessage(addStep/updateStep) 会作为事件捕获到 assistant message entry', () => {
  const { engine, store } = createTestEngine();

  // 先建立 assistant message entry
  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '正在处理',
    messageId: 'assistant-2',
    createdAt: 4000,
  });

  engine.postMessage({
    type: 'addStep',
    messageId: 'assistant-2',
    stepId: 'step-1',
    icon: 'file',
    description: '读取 src/main.ts',
    status: 'running',
  });

  engine.postMessage({
    type: 'updateStep',
    stepId: 'step-1',
    status: 'done',
    description: '读取 src/main.ts',
    elapsed: 150,
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-2');
  assert.ok(entry, 'uiTranscript 应包含 assistant-2');
  assert.ok(Array.isArray(entry.events), 'entry 应有 events 数组');
  assert.equal(entry.events!.length, 2, '应有 addStep + updateStep 两个事件');
  assert.equal(entry.events![0].type, 'addStep');
  assert.equal(entry.events![1].type, 'updateStep');
});

test('postMessage(showDiff) 会捕获 diff 事件到 uiTranscript', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '已修改文件',
    messageId: 'assistant-3',
    createdAt: 5000,
  });

  engine.postMessage({
    type: 'showDiff',
    messageId: 'assistant-3',
    stepId: 'step-2',
    summaryId: 'summary-1',
    filePath: 'src/demo.ts',
    language: 'typescript',
    additions: 3,
    deletions: 1,
    oldContent: 'old code',
    newContent: 'new code',
    needsConfirm: false,
    readOnly: false,
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-3');
  assert.ok(entry?.events?.length === 1);

  const diffEvent = entry.events![0];
  assert.equal(diffEvent.type, 'showDiff');
  if (diffEvent.type === 'showDiff') {
    assert.equal(diffEvent.filePath, 'src/demo.ts');
    assert.equal(diffEvent.additions, 3);
    assert.equal(diffEvent.deletions, 1);
  }
});

test('postMessage(showChangeSummary) 会捕获变更汇总事件', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '已完成修改',
    messageId: 'assistant-4',
    createdAt: 6000,
  });

  engine.postMessage({
    type: 'showChangeSummary',
    messageId: 'assistant-4',
    summaryId: 'summary-2',
    needsConfirm: true,
    files: [
      { path: 'src/a.ts', displayPath: 'src/a.ts', additions: 10, deletions: 2, status: 'modified' as const },
    ],
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-4');
  assert.ok(entry?.events?.length === 1);
  assert.equal(entry.events![0].type, 'showChangeSummary');
});

// ==================== restoreUiTranscriptToWebview 只读测试 ====================

test('initializeWebviewState 恢复 uiTranscript 时，消息带 readOnly: true', () => {
  // 预置一个带 uiTranscript 的会话
  const presetTranscript: PersistedUiEntry[] = [
    {
      type: 'message',
      messageId: 'user-100',
      role: 'user',
      createdAt: 1000,
      content: '用户消息',
      events: [],
    },
    {
      type: 'message',
      messageId: 'assistant-100',
      role: 'assistant',
      createdAt: 2000,
      content: 'AI 回复',
      events: [
        {
          type: 'showDiff',
          stepId: 'step-r1',
          summaryId: 'summary-r1',
          filePath: 'src/test.ts',
          language: 'typescript',
          additions: 5,
          deletions: 0,
          oldContent: '',
          newContent: 'new code',
          needsConfirm: false,
        },
        {
          type: 'showChangeSummary',
          summaryId: 'summary-r1',
          needsConfirm: false,
          files: [{ path: 'src/test.ts', displayPath: 'src/test.ts', additions: 5, deletions: 0, status: 'modified' as const }],
        },
      ],
    },
    {
      type: 'error',
      createdAt: 3000,
      message: '历史错误',
      retryable: true,
    },
  ];

  const { engine, host } = createTestEngine({
    sessions: [{
      id: 'session-restore',
      name: '恢复测试',
      createdAt: 100,
      updatedAt: 100,
      history: [],
      displayHistory: [],
      uiTranscript: presetTranscript,
    }],
    activeSessionId: 'session-restore',
  });

  // 清空构造时产生的消息，模拟 webview 就绪
  host.messages.length = 0;

  // 触发 webview 初始化（恢复历史）
  engine.initializeWebviewState();

  // 检查恢复消息中的 readOnly 标记
  const addMessages = host.messages.filter(message => message.type === 'addMessage');
  assert.ok(addMessages.length >= 2, '应至少恢复 2 条消息（user + assistant）');

  for (const message of addMessages) {
    if (message.type === 'addMessage') {
      assert.equal(message.readOnly, true, `恢复消息 ${message.messageId} 应为 readOnly`);
    }
  }

  // 检查 showDiff 恢复是否带 readOnly
  const showDiffMessages = host.messages.filter(message => message.type === 'showDiff');
  for (const message of showDiffMessages) {
    if (message.type === 'showDiff') {
      assert.equal(message.readOnly, true, `恢复 diff ${message.filePath} 应为 readOnly`);
    }
  }

  // 检查 showChangeSummary 恢复是否带 readOnly
  const showChangeSummaryMessages = host.messages.filter(message => message.type === 'showChangeSummary');
  for (const message of showChangeSummaryMessages) {
    if (message.type === 'showChangeSummary') {
      assert.equal(message.readOnly, true, `恢复 changeSummary ${message.summaryId} 应为 readOnly`);
    }
  }

  // 检查 showError 恢复是否带 readOnly
  const showErrorMessages = host.messages.filter(message => message.type === 'showError');
  for (const message of showErrorMessages) {
    if (message.type === 'showError') {
      assert.equal(message.readOnly, true, '恢复错误应为 readOnly');
    }
  }
});

// ==================== 会话运行时隔离测试 ====================

test('不同 sessionId 的 SessionRuntimeState 互相独立', () => {
  const { engine, store } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  // 在会话 A 中 post 消息 → A 的 uiTranscript 有记录
  engine.postMessage({
    type: 'addMessage',
    role: 'user',
    content: 'A 的消息',
    messageId: 'user-a1',
    createdAt: 1000,
  });

  const transcriptA = getSessionTranscript(store, 'session-a');
  const transcriptB = getSessionTranscript(store, 'session-b');

  assert.equal(transcriptA.length, 1, '会话 A 应有 1 条 transcript');
  assert.equal(transcriptB.length, 0, '会话 B 不应有 transcript（未在 B 上 post）');
});

test('postMessage 只在 activeSession 上捕获 uiTranscript', () => {
  const { engine, store } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  // postMessage 使用 activeSessionId（session-a）
  engine.postMessage({
    type: 'addMessage',
    role: 'user',
    content: '消息 1',
    messageId: 'user-msg-1',
    createdAt: 1000,
  });

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '回复 1',
    messageId: 'assistant-msg-1',
    createdAt: 2000,
  });

  const transcriptA = getSessionTranscript(store, 'session-a');
  const transcriptB = getSessionTranscript(store, 'session-b');

  assert.equal(transcriptA.length, 2, '会话 A 应有 2 条 transcript');
  assert.equal(transcriptB.length, 0, '会话 B 不应受影响');

  // 检查消息内容正确
  const userEntry = findMessageEntry(transcriptA, 'user-msg-1');
  assert.ok(userEntry);
  assert.equal(userEntry.content, '消息 1');

  const assistantEntry = findMessageEntry(transcriptA, 'assistant-msg-1');
  assert.ok(assistantEntry);
  assert.equal(assistantEntry.content, '回复 1');
});

// ==================== thinkingComplete / showHistoryProcessSummary 捕获测试 ====================

test('postMessage(thinkingComplete) 和 showHistoryProcessSummary 作为事件正确捕获', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '完成分析',
    messageId: 'assistant-5',
    createdAt: 7000,
  });

  engine.postMessage({
    type: 'thinkingComplete',
    messageId: 'assistant-5',
    elapsed: 3200,
    isExecutionMessage: false,
  });

  engine.postMessage({
    type: 'showHistoryProcessSummary',
    messageId: 'assistant-5',
    summary: {
      totalSteps: 3,
      readCount: 2,
      listCount: 0,
      modifyCount: 1,
      createCount: 0,
      failedCount: 0,
      changedFiles: ['src/main.ts'],
    },
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-5');
  assert.ok(entry);
  assert.equal(entry.events!.length, 2);
  assert.equal(entry.events![0].type, 'thinkingComplete');
  assert.equal(entry.events![1].type, 'showHistoryProcessSummary');

  if (entry.events![0].type === 'thinkingComplete') {
    assert.equal(entry.events![0].elapsed, 3200);
  }

  if (entry.events![1].type === 'showHistoryProcessSummary') {
    assert.equal(entry.events![1].summary.totalSteps, 3);
    assert.deepEqual(entry.events![1].summary.changedFiles, ['src/main.ts']);
  }
});

// ==================== updateChangeSummary 捕获测试 ====================

test('postMessage(updateChangeSummary) 记录状态变更事件到正确的 message entry', () => {
  const { engine, store } = createTestEngine();

  engine.postMessage({
    type: 'addMessage',
    role: 'assistant',
    content: '修改完成',
    messageId: 'assistant-6',
    createdAt: 8000,
  });

  // 先添加 showChangeSummary，让 summaryToMessageId 索引建立
  engine.postMessage({
    type: 'showChangeSummary',
    messageId: 'assistant-6',
    summaryId: 'summary-3',
    needsConfirm: true,
    files: [{ path: 'src/x.ts', displayPath: 'src/x.ts', additions: 1, deletions: 0, status: 'modified' as const }],
  });

  // 再发 updateChangeSummary
  engine.postMessage({
    type: 'updateChangeSummary',
    summaryId: 'summary-3',
    status: 'undone',
    text: '✓ Undone',
  });

  const transcript = getSessionTranscript(store, 'session-a');
  const entry = findMessageEntry(transcript, 'assistant-6');
  assert.ok(entry);

  const updateEvent = entry.events!.find(event => event.type === 'updateChangeSummary');
  assert.ok(updateEvent, 'should have updateChangeSummary event');
  if (updateEvent?.type === 'updateChangeSummary') {
    assert.equal(updateEvent.summaryId, 'summary-3');
    assert.equal(updateEvent.status, 'undone');
  }
});

test('后台会话写入 uiTranscript 时不会覆盖持久化 activeSessionId', async () => {
  const { engine, host, store, memento } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  (engine as any).postSessionMessage('session-b', {
    type: 'showError',
    message: '后台会话错误',
    createdAt: 9000,
  });

  await store.flushPendingPersists();

  assert.equal(host.messages.length, 0);
  const transcriptB = getSessionTranscript(store, 'session-b');
  assert.equal(transcriptB.length, 1);
  assert.equal(memento.get('activeSessionId'), 'session-a');

  const persistedSessions = memento.get<ChatSession[]>('chatSessions') ?? [];
  const persistedSessionB = persistedSessions.find(session => session.id === 'session-b');
  assert.equal(persistedSessionB?.uiTranscript?.length ?? 0, 1);
});

test('switchSession 会清理旧会话 retryableRequests', () => {
  const { engine } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  const retryableRequests = (engine as any).retryableRequests as Map<string, RetryableRequestState>;
  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-a', sessionId: 'session-a' }));
  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-b', sessionId: 'session-b' }));

  (engine as any).switchSession('session-b');

  assert.deepEqual([...retryableRequests.keys()], ['request-b']);
});

test('deleteSession 会清理被删会话的 SessionRuntimeState', () => {
  const { engine, store } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  const runtimeState = (engine as any).getSessionRuntimeState('session-b');
  runtimeState.currentMode = 'plan';
  runtimeState.contextFiles = ['src/b.ts'];

  const runtimeMap = (engine as any).sessionRuntimeBySessionId as Map<string, unknown>;
  assert.equal(runtimeMap.has('session-b'), true);

  (engine as any).deleteSession('session-b');

  assert.equal(runtimeMap.has('session-b'), false);
  assert.equal(store.sessions.some(session => session.id === 'session-b'), false);
});

test('switchSession 会恢复目标会话的 mode 和 contextFiles', () => {
  const { engine, host } = createTestEngine({
    sessions: [
      { id: 'session-a', name: 'A', createdAt: 100, updatedAt: 100, history: [], displayHistory: [] },
      { id: 'session-b', name: 'B', createdAt: 200, updatedAt: 200, history: [], displayHistory: [] },
    ],
    activeSessionId: 'session-a',
  });

  engine.switchMode('ask');
  (engine as any).contextFiles = ['src/a.ts'];

  const sessionBRuntime = (engine as any).getSessionRuntimeState('session-b');
  sessionBRuntime.currentMode = 'plan';
  sessionBRuntime.contextFiles = ['src/b.ts'];

  host.messages.length = 0;
  (engine as any).switchSession('session-b');

  assert.equal(engine.getMode(), 'plan');
  assert.deepEqual((engine as any).contextFiles, ['src/b.ts']);
  assert.ok(host.messages.some(message => message.type === 'updateMode' && message.mode === 'plan'));
  assert.ok(host.messages.some(message => message.type === 'addContextFile' && message.filePath === 'src/b.ts'));

  host.messages.length = 0;
  (engine as any).switchSession('session-a');

  assert.equal(engine.getMode(), 'ask');
  assert.deepEqual((engine as any).contextFiles, ['src/a.ts']);
  assert.ok(host.messages.some(message => message.type === 'updateMode' && message.mode === 'ask'));
  assert.ok(host.messages.some(message => message.type === 'addContextFile' && message.filePath === 'src/a.ts'));
});

test('handleRegenerate 在启动异常时会回滚 pendingRegenerateState 并恢复会话内容', async () => {
  const { engine, host, store } = createTestEngine({
    sessions: [
      {
        id: 'session-a',
        name: 'A',
        createdAt: 100,
        updatedAt: 100,
        history: [
          { role: 'user', content: '用户问题', timestamp: 1000 },
          { role: 'assistant', content: 'AI 原始回复', timestamp: 2000 },
        ],
        displayHistory: [
          { role: 'user', content: '用户问题', timestamp: 1000, messageId: 'user-1' },
          { role: 'assistant', content: 'AI 原始回复', timestamp: 2000, messageId: 'assistant-1' },
        ],
        uiTranscript: [
          { type: 'message', messageId: 'user-1', role: 'user', createdAt: 1000, content: '用户问题', events: [] },
          { type: 'message', messageId: 'assistant-1', role: 'assistant', createdAt: 2000, content: 'AI 原始回复', events: [] },
        ],
      },
    ],
    activeSessionId: 'session-a',
  });

  const originalEnsureApiKey = (configModule as any).ensureApiKey;
  const originalPrepareChatRequestExecution = (requestExecutionModule as any).prepareChatRequestExecution;

  (configModule as any).ensureApiKey = async () => 'test-key';
  (requestExecutionModule as any).prepareChatRequestExecution = () => {
    throw new Error('prepare failed');
  };

  try {
    await (engine as any).handleRegenerate('assistant-1');
  } finally {
    (configModule as any).ensureApiKey = originalEnsureApiKey;
    (requestExecutionModule as any).prepareChatRequestExecution = originalPrepareChatRequestExecution;
  }

  const runtimeState = (engine as any).getSessionRuntimeState('session-a');
  assert.equal(runtimeState.activeRunId, null);
  assert.equal(runtimeState.pendingRegenerateState, null);

  const session = store.sessions.find(item => item.id === 'session-a');
  assert.ok(session);
  assert.equal(session?.history.length, 2);
  assert.equal(session?.displayHistory?.length, 2);
  assert.equal(session?.uiTranscript?.length, 3);
  assert.ok(host.messages.some(message => message.type === 'showError' && message.message.startsWith('重新生成启动失败：')));
});
