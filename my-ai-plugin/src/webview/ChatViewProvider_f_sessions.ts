import { getUserDisplayContent, isToolFeedbackMessage } from './ChatViewProvider_c_displayHistory';
import type {
  ChatSession,
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
  ExtensionMessage,
  UpdateSessionsResponse,
} from './messageTypes';

export type LoadSessionsStateOptions = {
  savedSessions?: ChatSession[];
  savedActiveId?: string;
  oldHistory?: Array<{ role: string; content: unknown }>;
  normalizeHistoryMessages: (history: ChatSessionHistoryMessage[]) => ChatSessionHistoryMessage[];
  sanitizeDisplayHistory: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
};

export type LoadSessionsStateResult = {
  sessions: ChatSession[];
  activeSessionId: string;
  shouldResave: boolean;
};

type SessionMessageIdFactory = (role: 'user' | 'assistant', timestamp?: number) => string;

type SessionDisplayHistorySanitizer = (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];

type SessionDisplayHistoryBuilder = (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];

function createSessionId(now: number): string {
  return `session-${now}-${Math.random().toString(36).slice(2, 7)}`;
}

export function buildSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '新对话';
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}...`;
}

export function extractSessionTitleFromHistory(
  history: Array<{ role: string; content: unknown; displayContent?: string }>,
): string {
  const firstUserMessage = history.find(message => {
    return message.role === 'user' && !isToolFeedbackMessage(message);
  });

  if (!firstUserMessage) {
    return '历史会话';
  }

  const displayText = getUserDisplayContent(firstUserMessage.content, firstUserMessage.displayContent);
  if (!displayText.trim()) {
    return '历史会话';
  }

  return buildSessionTitle(displayText);
}

export function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return right.createdAt - left.createdAt;
  });
}

export function createSessionObject(name: string, now: number = Date.now()): ChatSession {
  return {
    id: createSessionId(now),
    name,
    createdAt: now,
    updatedAt: now,
    history: [],
    displayHistory: [],
  };
}

export function loadSessionsState(options: LoadSessionsStateOptions): LoadSessionsStateResult {
  let shouldResave = false;

  if (options.savedSessions && options.savedSessions.length > 0) {
    const sessions = options.savedSessions.map(session => {
      const history = options.normalizeHistoryMessages(Array.isArray(session.history) ? session.history : []);
      const updatedAt = typeof session.updatedAt === 'number'
        ? session.updatedAt
        : (typeof session.createdAt === 'number' ? session.createdAt : Date.now());
      const displayHistory = Array.isArray(session.displayHistory)
        ? options.sanitizeDisplayHistory(session.displayHistory)
        : options.buildDisplayHistoryFromRawHistory(history);

      if (typeof session.updatedAt !== 'number') {
        shouldResave = true;
      }
      if (!Array.isArray(session.history) || !Array.isArray(session.displayHistory)) {
        shouldResave = true;
      }
      if (Array.isArray(session.history) && history !== session.history) {
        shouldResave = true;
      }
      if (Array.isArray(session.displayHistory) && displayHistory !== session.displayHistory) {
        shouldResave = true;
      }

      return {
        ...session,
        history,
        updatedAt,
        displayHistory,
      };
    });

    const sortedSessions = sortSessionsByUpdatedAt(sessions);
    const hasValidActiveSession = Boolean(
      options.savedActiveId && sortedSessions.some(session => session.id === options.savedActiveId),
    );

    return {
      sessions: sortedSessions,
      activeSessionId: hasValidActiveSession ? options.savedActiveId! : (sortedSessions[0]?.id ?? ''),
      shouldResave,
    };
  }

  if (options.oldHistory && options.oldHistory.length > 0) {
    const normalizedOldHistory = options.normalizeHistoryMessages(options.oldHistory as ChatSessionHistoryMessage[]);
    const firstSession = createSessionObject(extractSessionTitleFromHistory(normalizedOldHistory));
    firstSession.history = normalizedOldHistory;
    firstSession.displayHistory = options.buildDisplayHistoryFromRawHistory(normalizedOldHistory);
    firstSession.updatedAt = Date.now();

    return {
      sessions: [firstSession],
      activeSessionId: firstSession.id,
      shouldResave: true,
    };
  }

  return {
    sessions: [],
    activeSessionId: '',
    shouldResave: false,
  };
}

export function buildSessionListItems(sessions: ChatSession[]): UpdateSessionsResponse['sessions'] {
  return sessions.map(session => ({
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.displayHistory)
      ? session.displayHistory.length
      : 0,
  }));
}

export function buildUpdateSessionsResponse(
  sessions: ChatSession[],
  activeSessionId: string,
): UpdateSessionsResponse {
  return {
    type: 'updateSessions',
    sessions: buildSessionListItems(sessions),
    activeSessionId,
  };
}

export function getActiveSession(
  sessions: ChatSession[],
  activeSessionId: string,
): ChatSession | undefined {
  return sessions.find(session => session.id === activeSessionId);
}

export function resolveSessionDisplayHistory(options: {
  session?: ChatSession;
  sanitizeDisplayHistory: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
}): ChatSessionDisplayMessage[] {
  const session = options.session;
  if (!session) {
    return [];
  }

  const displayHistory = Array.isArray(session.displayHistory)
    ? options.sanitizeDisplayHistory(session.displayHistory)
    : options.buildDisplayHistoryFromRawHistory(session.history);

  session.displayHistory = displayHistory;
  return displayHistory;
}

export function setSessionDisplayHistory(
  session: ChatSession | undefined,
  displayHistory: ChatSessionDisplayMessage[],
  sanitizeDisplayHistory: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[],
): void {
  if (!session) {
    return;
  }

  session.displayHistory = sanitizeDisplayHistory(displayHistory);
}

export function getSessionDisplayHistoryForExport(options: {
  session?: ChatSession;
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
}): ChatSessionDisplayMessage[] {
  const session = options.session;
  if (!session) {
    return [];
  }

  if (Array.isArray(session.displayHistory)) {
    return session.displayHistory;
  }

  return options.buildDisplayHistoryFromRawHistory(session.history);
}

export function prepareActiveSessionForSave(options: {
  session?: ChatSession;
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
  now?: number;
}): void {
  const session = options.session;
  if (!session) {
    return;
  }

  if (!Array.isArray(session.displayHistory)) {
    session.displayHistory = options.buildDisplayHistoryFromRawHistory(session.history);
  }

  session.updatedAt = options.now ?? Date.now();
}

export function buildRestoreSessionHistoryMessages(
  displayHistory: ChatSessionDisplayMessage[],
  createDisplayMessageId: SessionMessageIdFactory,
): ExtensionMessage[] {
  const messages: ExtensionMessage[] = [];

  for (const restoredMessage of displayHistory) {
    const messageId = restoredMessage.messageId || createDisplayMessageId(restoredMessage.role, restoredMessage.timestamp);
    messages.push({
      type: 'addMessage',
      role: restoredMessage.role,
      content: restoredMessage.content,
      messageId,
      createdAt: restoredMessage.timestamp,
      readOnly: true,
    });

    if (restoredMessage.role === 'assistant' && restoredMessage.processSummary) {
      messages.push({
        type: 'showHistoryProcessSummary',
        messageId,
        summary: restoredMessage.processSummary,
      });
    }
  }

  return messages;
}

export function buildEnterSessionMessages(
  displayHistory: ChatSessionDisplayMessage[],
  createDisplayMessageId: SessionMessageIdFactory,
): ExtensionMessage[] {
  return [
    { type: 'clearChat' },
    { type: 'setSessionLauncher', visible: false },
    ...buildRestoreSessionHistoryMessages(displayHistory, createDisplayMessageId),
  ];
}

export function buildShowSessionLauncherMessages(): ExtensionMessage[] {
  return [
    { type: 'clearChat' },
    { type: 'setSessionLauncher', visible: true },
  ];
}

export function buildOpenSessionLauncherMessages(): ExtensionMessage[] {
  return [
    { type: 'setSessionLauncher', visible: true },
    { type: 'clearChat' },
    { type: 'focusInput' },
  ];
}

export type InitialSessionRenderPlan =
  | {
    kind: 'launcher';
    messages: ExtensionMessage[];
  }
  | {
    kind: 'restore';
    messages: ExtensionMessage[];
    restoredDisplayHistoryCount: number;
    restoredRawHistoryCount: number;
  };

export function planInitialSessionRender(options: {
  sessionLauncherVisible: boolean;
  displayHistory: ChatSessionDisplayMessage[];
  rawHistoryCount: number;
  createDisplayMessageId: SessionMessageIdFactory;
}): InitialSessionRenderPlan {
  if (options.sessionLauncherVisible) {
    return {
      kind: 'launcher',
      messages: buildShowSessionLauncherMessages(),
    };
  }

  return {
    kind: 'restore',
    messages: buildRestoreSessionHistoryMessages(options.displayHistory, options.createDisplayMessageId),
    restoredDisplayHistoryCount: options.displayHistory.length,
    restoredRawHistoryCount: options.rawHistoryCount,
  };
}

export type InitialSessionBootstrapPlan =
  | {
    kind: 'launcher';
    sessionListResponse: UpdateSessionsResponse;
    renderMessages: ExtensionMessage[];
  }
  | {
    kind: 'restore';
    sessionListResponse: UpdateSessionsResponse;
    renderMessages: ExtensionMessage[];
    restoredDisplayHistoryCount: number;
    restoredRawHistoryCount: number;
  };

export function planInitialSessionBootstrap(options: {
  sessions: ChatSession[];
  activeSessionId: string;
  sessionLauncherVisible: boolean;
  displayHistory: ChatSessionDisplayMessage[];
  rawHistoryCount: number;
  createDisplayMessageId: SessionMessageIdFactory;
}): InitialSessionBootstrapPlan {
  const sessionListResponse = buildUpdateSessionsResponse(options.sessions, options.activeSessionId);
  const initialRenderPlan = planInitialSessionRender({
    sessionLauncherVisible: options.sessionLauncherVisible,
    displayHistory: options.displayHistory,
    rawHistoryCount: options.rawHistoryCount,
    createDisplayMessageId: options.createDisplayMessageId,
  });

  if (initialRenderPlan.kind === 'launcher') {
    return {
      kind: 'launcher',
      sessionListResponse,
      renderMessages: initialRenderPlan.messages,
    };
  }

  return {
    kind: 'restore',
    sessionListResponse,
    renderMessages: initialRenderPlan.messages,
    restoredDisplayHistoryCount: initialRenderPlan.restoredDisplayHistoryCount,
    restoredRawHistoryCount: initialRenderPlan.restoredRawHistoryCount,
  };
}

export function clearSessionConversation(session: ChatSession | undefined, now: number = Date.now()): void {
  if (!session) {
    return;
  }

  session.history = [];
  session.displayHistory = [];
  session.updatedAt = now;
}

export type OpenSessionLauncherPlan =
  | {
    kind: 'blocked';
    errorMessage: string;
  }
  | {
    kind: 'open';
    nextSessionLauncherVisible: true;
    sessionListResponse: UpdateSessionsResponse;
    messages: ExtensionMessage[];
  };

export function planOpenSessionLauncher(options: {
  hasRunningTask: boolean;
  sessions: ChatSession[];
  activeSessionId: string;
}): OpenSessionLauncherPlan {
  if (options.hasRunningTask) {
    return {
      kind: 'blocked',
      errorMessage: '当前会话仍在生成或等待确认，请先停止当前任务后再新建对话。',
    };
  }

  return {
    kind: 'open',
    nextSessionLauncherVisible: true,
    sessionListResponse: buildUpdateSessionsResponse(options.sessions, options.activeSessionId),
    messages: buildOpenSessionLauncherMessages(),
  };
}

export type ClearCurrentSessionPlan =
  | {
    kind: 'blocked';
    errorMessage: string;
  }
  | {
    kind: 'clear';
    clearRetryableSessionId: string;
    messages: ExtensionMessage[];
  };

export function planClearCurrentSession(options: {
  sessionLauncherVisible: boolean;
  activeSessionId: string;
}): ClearCurrentSessionPlan {
  if (options.sessionLauncherVisible) {
    return {
      kind: 'blocked',
      errorMessage: '当前处于新建对话状态，无需清空对话。',
    };
  }

  return {
    kind: 'clear',
    clearRetryableSessionId: options.activeSessionId,
    messages: [{ type: 'clearChat' }],
  };
}

export type CreateSessionPlan = {
  nextSessions: ChatSession[];
  nextActiveSessionId: string;
  nextSessionLauncherVisible?: false;
  messages: ExtensionMessage[];
  createdSession: ChatSession;
};

export function planCreateSession(options: {
  sessions: ChatSession[];
  name: string;
  now?: number;
}): CreateSessionPlan {
  const createdSession = createSessionObject(options.name, options.now);
  return {
    nextSessions: [...options.sessions, createdSession],
    nextActiveSessionId: createdSession.id,
    nextSessionLauncherVisible: false,
    messages: [
      { type: 'clearChat' },
      { type: 'setSessionLauncher', visible: false },
    ],
    createdSession,
  };
}

export type RenameSessionPlan =
  | {
    kind: 'noop';
  }
  | {
    kind: 'rename';
    nextSessions: ChatSession[];
    renamedSessionId: string;
    renamedSessionName: string;
  };

export function planRenameSession(options: {
  sessions: ChatSession[];
  targetSessionId: string;
  name: string;
}): RenameSessionPlan {
  const trimmedName = options.name.trim();
  if (!trimmedName) {
    return {
      kind: 'noop',
    };
  }

  const targetIndex = options.sessions.findIndex(session => session.id === options.targetSessionId);
  if (targetIndex === -1) {
    return {
      kind: 'noop',
    };
  }

  const nextSessions = [...options.sessions];
  nextSessions[targetIndex] = {
    ...nextSessions[targetIndex],
    name: trimmedName,
  };

  return {
    kind: 'rename',
    nextSessions,
    renamedSessionId: options.targetSessionId,
    renamedSessionName: trimmedName,
  };
}

export type SwitchSessionPlanOptions = {
  hasRunningTask: boolean;
  sessions: ChatSession[];
  activeSessionId: string;
  targetSessionId: string;
  sessionLauncherVisible: boolean;
  sanitizeDisplayHistory: SessionDisplayHistorySanitizer;
  buildDisplayHistoryFromRawHistory: SessionDisplayHistoryBuilder;
  createDisplayMessageId: SessionMessageIdFactory;
  now?: number;
};

export type SwitchSessionPlan =
  | {
    kind: 'blocked';
    errorMessage: string;
  }
  | {
    kind: 'noop';
  }
  | {
    kind: 'switch';
    nextSessions: ChatSession[];
    nextActiveSessionId: string;
    nextSessionLauncherVisible: false;
    clearRetryableSessionId?: string;
    messages: ExtensionMessage[];
    sessionName: string;
  };

export function planSwitchSession(options: SwitchSessionPlanOptions): SwitchSessionPlan {
  if (options.hasRunningTask) {
    return {
      kind: 'blocked',
      errorMessage: '当前会话仍在生成或等待确认，请先停止当前任务后再继续其他会话。',
    };
  }

  if (options.targetSessionId === options.activeSessionId && !options.sessionLauncherVisible) {
    return {
      kind: 'noop',
    };
  }

  const targetIndex = options.sessions.findIndex(session => session.id === options.targetSessionId);
  if (targetIndex === -1) {
    return {
      kind: 'noop',
    };
  }

  const nextSessions = [...options.sessions];
  const targetSession = {
    ...nextSessions[targetIndex],
  };
  const targetDisplayHistory = resolveSessionDisplayHistory({
    session: targetSession,
    sanitizeDisplayHistory: options.sanitizeDisplayHistory,
    buildDisplayHistoryFromRawHistory: options.buildDisplayHistoryFromRawHistory,
  });
  targetSession.updatedAt = options.now ?? Date.now();
  nextSessions[targetIndex] = targetSession;

  const clearRetryableSessionId = options.activeSessionId && options.activeSessionId !== options.targetSessionId
    ? options.activeSessionId
    : undefined;

  return {
    kind: 'switch',
    nextSessions,
    nextActiveSessionId: options.targetSessionId,
    nextSessionLauncherVisible: false,
    clearRetryableSessionId,
    messages: buildEnterSessionMessages(targetDisplayHistory, options.createDisplayMessageId),
    sessionName: targetSession.name,
  };
}

export type DeleteSessionPlanOptions = {
  hasRunningTask: boolean;
  sessions: ChatSession[];
  activeSessionId: string;
  targetSessionId: string;
};

export type DeleteSessionPlan =
  | {
    kind: 'blocked';
    errorMessage: string;
  }
  | {
    kind: 'noop';
  }
  | {
    kind: 'delete';
    nextSessions: ChatSession[];
    nextActiveSessionId: string;
    nextSessionLauncherVisible?: boolean;
    shouldResetSessionRuntime: boolean;
    clearRetryableSessionId: string;
    messages: ExtensionMessage[];
    deletedSessionId: string;
  };

export function planDeleteSession(options: DeleteSessionPlanOptions): DeleteSessionPlan {
  if (options.hasRunningTask && options.activeSessionId === options.targetSessionId) {
    return {
      kind: 'blocked',
      errorMessage: '当前会话仍在生成或等待确认，请先停止当前任务后再删除该会话。',
    };
  }

  const targetIndex = options.sessions.findIndex(session => session.id === options.targetSessionId);
  if (targetIndex === -1) {
    return {
      kind: 'noop',
    };
  }

  const nextSessions = options.sessions.filter((_, index) => index !== targetIndex);
  const deletedActiveSession = options.activeSessionId === options.targetSessionId;
  const shouldShowSessionLauncher = deletedActiveSession
    || (!options.activeSessionId && nextSessions.length > 0);

  return {
    kind: 'delete',
    nextSessions,
    nextActiveSessionId: deletedActiveSession ? '' : options.activeSessionId,
    nextSessionLauncherVisible: shouldShowSessionLauncher ? true : undefined,
    shouldResetSessionRuntime: shouldShowSessionLauncher,
    clearRetryableSessionId: options.targetSessionId,
    messages: shouldShowSessionLauncher ? buildShowSessionLauncherMessages() : [],
    deletedSessionId: options.targetSessionId,
  };
}
