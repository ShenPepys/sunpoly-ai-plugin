import type { WorkMode } from './messageTypes';

export type RequestImageAttachment = {
  id: string;
  dataUrl: string;
  fileName: string;
  mimeType: string;
  sizeKB: number;
};

export type RetryableRequestState = {
  requestId: string;
  sessionId: string;
  text: string;
  userContent: string;
  images: RequestImageAttachment[];
  requestMode: WorkMode;
};

export function createRetryRequestId(): string {
  return `retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneRequestImages(images?: RequestImageAttachment[]): RequestImageAttachment[] {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  return images.map(image => ({ ...image }));
}

export function rememberRetryableRequest(
  retryableRequests: Map<string, RetryableRequestState>,
  requestState: RetryableRequestState,
  maxSize: number = 20,
): void {
  retryableRequests.set(requestState.requestId, {
    ...requestState,
    images: cloneRequestImages(requestState.images),
  });

  while (retryableRequests.size > maxSize) {
    const oldestKey = retryableRequests.keys().next().value;
    if (!oldestKey) {
      break;
    }

    retryableRequests.delete(oldestKey);
  }
}

export function clearRetryableRequestsForSession(
  retryableRequests: Map<string, RetryableRequestState>,
  sessionId: string,
): void {
  if (!sessionId || retryableRequests.size === 0) {
    return;
  }

  for (const [requestId, requestState] of retryableRequests.entries()) {
    if (requestState.sessionId === sessionId) {
      retryableRequests.delete(requestId);
    }
  }
}

export function getRetryableRequest(
  retryableRequests: Map<string, RetryableRequestState>,
  requestId: string,
  activeSessionId: string,
): { ok: true; request: RetryableRequestState } | { ok: false; errorMessage: string } {
  if (!requestId) {
    return {
      ok: false,
      errorMessage: '找不到可重试的请求',
    };
  }

  const retryableRequest = retryableRequests.get(requestId);
  if (!retryableRequest) {
    return {
      ok: false,
      errorMessage: '找不到可重试的请求快照，请重新发送一次消息。',
    };
  }

  if (retryableRequest.sessionId !== activeSessionId) {
    return {
      ok: false,
      errorMessage: '当前不在原始会话中，请切回对应会话后再重试。',
    };
  }

  return {
    ok: true,
    request: {
      ...retryableRequest,
      images: cloneRequestImages(retryableRequest.images),
    },
  };
}

export type RetryRequestReplayPlan =
  | {
    kind: 'blocked';
    errorMessage: string;
  }
  | {
    kind: 'retry';
    request: RetryableRequestState;
  };

export function planRetryRequestReplay(options: {
  hasRunningTask: boolean;
  retryableRequests: Map<string, RetryableRequestState>;
  requestId: string;
  activeSessionId: string;
}): RetryRequestReplayPlan {
  if (options.hasRunningTask) {
    return {
      kind: 'blocked',
      errorMessage: '当前仍在生成，请先停止当前任务后再重试。',
    };
  }

  const retryLookup = getRetryableRequest(
    options.retryableRequests,
    options.requestId,
    options.activeSessionId,
  );
  if (!retryLookup.ok) {
    return {
      kind: 'blocked',
      errorMessage: retryLookup.errorMessage,
    };
  }

  return {
    kind: 'retry',
    request: retryLookup.request,
  };
}
