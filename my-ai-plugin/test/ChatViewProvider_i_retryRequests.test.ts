import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRetryableRequestsForSession,
  getRetryableRequest,
  planRetryRequestReplay,
  rememberRetryableRequest,
  type RetryableRequestState,
} from '../src/webview/ChatViewProvider_i_retryRequests';

function createRetryableRequestState(overrides?: Partial<RetryableRequestState>): RetryableRequestState {
  return {
    requestId: overrides?.requestId ?? 'request-1',
    sessionId: overrides?.sessionId ?? 'session-a',
    text: overrides?.text ?? '测试消息',
    userContent: overrides?.userContent ?? '测试消息',
    images: overrides?.images ?? [
      {
        id: 'image-1',
        dataUrl: 'data:image/png;base64,AAA',
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeKB: 12,
      },
    ],
    requestMode: overrides?.requestMode ?? 'code',
  };
}

test('rememberRetryableRequest 会复制图片并按上限淘汰最旧请求', () => {
  const retryableRequests = new Map<string, RetryableRequestState>();
  const firstRequest = createRetryableRequestState({ requestId: 'request-1' });
  const secondRequest = createRetryableRequestState({ requestId: 'request-2' });
  const thirdRequest = createRetryableRequestState({ requestId: 'request-3' });

  rememberRetryableRequest(retryableRequests, firstRequest, 2);
  rememberRetryableRequest(retryableRequests, secondRequest, 2);
  firstRequest.images[0].fileName = 'mutated.png';
  rememberRetryableRequest(retryableRequests, thirdRequest, 2);

  assert.equal(retryableRequests.size, 2);
  assert.equal(retryableRequests.has('request-1'), false);
  assert.equal(retryableRequests.get('request-2')?.images[0].fileName, 'image.png');
  assert.equal(retryableRequests.get('request-3')?.images[0].fileName, 'image.png');
});

test('clearRetryableRequestsForSession 只清理目标会话的重试快照', () => {
  const retryableRequests = new Map<string, RetryableRequestState>();

  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-1', sessionId: 'session-a' }));
  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-2', sessionId: 'session-b' }));
  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-3', sessionId: 'session-a' }));

  clearRetryableRequestsForSession(retryableRequests, 'session-a');

  assert.deepEqual([...retryableRequests.keys()], ['request-2']);
});

test('getRetryableRequest 会阻止跨会话重试，并返回图片副本', () => {
  const retryableRequests = new Map<string, RetryableRequestState>();
  const storedRequest = createRetryableRequestState({ requestId: 'request-1', sessionId: 'session-a' });
  rememberRetryableRequest(retryableRequests, storedRequest);

  const crossSessionLookup = getRetryableRequest(retryableRequests, 'request-1', 'session-b');
  assert.deepEqual(crossSessionLookup, {
    ok: false,
    errorMessage: '当前不在原始会话中，请切回对应会话后再重试。',
  });

  const sameSessionLookup = getRetryableRequest(retryableRequests, 'request-1', 'session-a');
  assert.equal(sameSessionLookup.ok, true);
  if (!sameSessionLookup.ok) {
    assert.fail('同会话重试请求应成功');
  }

  sameSessionLookup.request.images[0].fileName = 'changed.png';
  assert.equal(retryableRequests.get('request-1')?.images[0].fileName, 'image.png');
});

test('planRetryRequestReplay 会优先阻止运行中重试，并在空闲时返回重试计划', () => {
  const retryableRequests = new Map<string, RetryableRequestState>();
  rememberRetryableRequest(retryableRequests, createRetryableRequestState({ requestId: 'request-1', sessionId: 'session-a' }));

  const blockedPlan = planRetryRequestReplay({
    hasRunningTask: true,
    retryableRequests,
    requestId: 'request-1',
    activeSessionId: 'session-a',
  });
  assert.deepEqual(blockedPlan, {
    kind: 'blocked',
    errorMessage: '当前仍在生成，请先停止当前任务后再重试。',
  });

  const retryPlan = planRetryRequestReplay({
    hasRunningTask: false,
    retryableRequests,
    requestId: 'request-1',
    activeSessionId: 'session-a',
  });

  assert.equal(retryPlan.kind, 'retry');
  if (retryPlan.kind !== 'retry') {
    assert.fail('空闲状态下应返回 retry 计划');
  }

  assert.equal(retryPlan.request.requestId, 'request-1');
  assert.equal(retryPlan.request.sessionId, 'session-a');
});
