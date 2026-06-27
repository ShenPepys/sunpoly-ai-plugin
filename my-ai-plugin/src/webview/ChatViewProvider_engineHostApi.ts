import * as vscode from 'vscode';
import { getAllModels, getActiveModelIndex, getModelConfig, getPanelTitle } from '../config';
import { info } from '../logger';
import type { CommandExecutionRequest } from '../commands/handler';
import type {
  ChatSession,
  ChatSessionDisplayMessage,
  ExtensionMessage,
  WorkMode,
} from './messageTypes';
import type { ChatMessageParam } from '../api/types';
import { buildChatViewHtml } from './ChatViewProvider_html';
import { createDisplayMessageId as createDisplayMessageIdHelper } from './ChatViewProvider_displayHistory';
import {
  buildUpdateModelsResponse,
} from './ChatViewProvider_modelAndSession';
import {
  clearSessionConversation,
  getActiveSession as getActiveSessionHelper,
  planClearCurrentSession,
  planInitialSessionBootstrap,
} from './ChatViewProvider_sessions';
import { clearRetryableRequestsForSession as clearRetryableRequestsForSessionHelper } from './ChatViewProvider_retryRequests';
import type { RetryableRequestState } from './ChatViewProvider_retryRequests';
import { clearSummaryCache } from './ChatViewProvider_contextSummary';
import { buildUpdateSessionsResponse } from './ChatViewProvider_sessions';
import type { IChatHost } from './IChatHost';

export function getEngineActiveModelName(): string {
  const models = getAllModels();
  const activeIndex = getActiveModelIndex();
  const safeIndex = Math.max(0, Math.min(activeIndex, models.length - 1));
  return models[safeIndex]?.name || 'AI';
}

export function sendEngineModelList(postMessage: (message: ExtensionMessage) => void): void {
  const models = getAllModels();
  const activeIndex = getActiveModelIndex();
  const safeIndex = Math.max(0, Math.min(activeIndex, models.length - 1));
  const modelConfig = getModelConfig();
  info(`发送模型列表到前端: ${models.length} 个模型, activeIndex=${safeIndex}, 当前模型=${modelConfig.modelName}`);
  postMessage(buildUpdateModelsResponse({
    models,
    activeIndex: safeIndex,
    supportsVision: modelConfig.supportsVision ?? false,
  }));
}

export function switchEngineMode(
  mode: WorkMode,
  setMode: (mode: WorkMode) => void,
  postMessage: (message: ExtensionMessage) => void,
): void {
  setMode(mode);
  postMessage({ type: 'updateMode', mode });
}

export type EngineHostApiDeps = {
  postMessage: (message: ExtensionMessage) => void;
  hostPostMessage: (message: ExtensionMessage) => void;
  getSessions: () => ChatSession[];
  getActiveSessionId: () => string;
  setActiveSessionId: (sessionId: string) => void;
  getSessionLauncherVisible: () => boolean;
  setSessionLauncherVisible: (visible: boolean) => void;
  getDisplayHistory: () => ChatSessionDisplayMessage[];
  getChatHistory: () => ChatMessageParam[];
  getUiTranscript: () => { length: number };
  syncActiveSessionTransientState: () => void;
  resetUiRuntimeState: () => void;
  pushTokenCount: () => void;
  syncHostTitle: () => void;
  restoreUiTranscriptToWebview: () => boolean;
  persistUiTranscript: () => void;
  saveSessions: () => ExtensionMessage;
  resetSessionScopedRuntimeState: () => void;
  clearFileReadStateCache: () => void;
  clearRetryableForSession: (sessionId: string) => void;
  hasRunningTask: () => boolean;
  isSessionRunningInOtherTab: (sessionId: string) => boolean;
  hostReveal: () => void;
  handleUserMessage: (
    text: string,
    images: undefined,
    requestOptions: { userContentOverride: string; requestMode: WorkMode },
  ) => Promise<void>;
  getContextFiles: () => string[];
  setContextFiles: (filePaths: string[]) => void;
  getHost: () => IChatHost;
};

export function syncEngineActiveSessionTransientState(deps: Pick<EngineHostApiDeps, 'hostPostMessage' | 'getContextFiles'> & {
  getMode: () => WorkMode;
}): void {
  deps.hostPostMessage({ type: 'updateMode', mode: deps.getMode() });
  deps.hostPostMessage({ type: 'clearContextFiles' });

  for (const filePath of deps.getContextFiles()) {
    deps.hostPostMessage({
      type: 'addContextFile',
      filePath,
      fileName: filePath.split(/[\\/]/).pop() || filePath,
    });
  }
}

export function initializeEngineWebviewState(deps: EngineHostApiDeps): void {
  sendEngineModelList(deps.postMessage);
  deps.syncActiveSessionTransientState();
  deps.resetUiRuntimeState();

  const activeSession = getActiveSessionHelper(deps.getSessions(), deps.getActiveSessionId());
  const hasUiTranscript = Array.isArray(activeSession?.uiTranscript) && activeSession.uiTranscript.length > 0;

  if (!deps.getSessionLauncherVisible() && hasUiTranscript) {
    deps.postMessage(buildUpdateSessionsResponse(deps.getSessions(), deps.getActiveSessionId()));
    deps.pushTokenCount();
    deps.restoreUiTranscriptToWebview();
    deps.syncHostTitle();
    return;
  }

  const initialSessionBootstrapPlan = planInitialSessionBootstrap({
    sessions: deps.getSessions(),
    activeSessionId: deps.getActiveSessionId(),
    sessionLauncherVisible: deps.getSessionLauncherVisible(),
    displayHistory: deps.getDisplayHistory(),
    rawHistoryCount: deps.getChatHistory().length,
    createDisplayMessageId: createDisplayMessageIdHelper,
  });
  deps.postMessage(initialSessionBootstrapPlan.sessionListResponse);
  deps.pushTokenCount();

  if (initialSessionBootstrapPlan.kind === 'restore') {
    info(`恢复 ${initialSessionBootstrapPlan.restoredDisplayHistoryCount} 条历史消息到界面（原始 ${initialSessionBootstrapPlan.restoredRawHistoryCount} 条）`);
  }
  for (const message of initialSessionBootstrapPlan.renderMessages) {
    deps.postMessage(message);
  }

  if (!deps.getSessionLauncherVisible() && !hasUiTranscript && deps.getUiTranscript().length > 0) {
    deps.persistUiTranscript();
  }

  deps.syncHostTitle();
}

export function buildEngineHtml(deps: Pick<EngineHostApiDeps, 'getHost' | 'getSessionLauncherVisible' | 'getDisplayHistory' | 'getUiTranscript'>): string {
  const webview = deps.getHost().getWebview();
  if (!webview) {
    return '';
  }

  return buildChatViewHtml({
    webview,
    extensionUri: deps.getHost().getExtensionUri(),
    panelTitle: getPanelTitle(),
    shouldShowWelcomeOnInitialRender: !deps.getSessionLauncherVisible()
      && deps.getDisplayHistory().length === 0
      && deps.getUiTranscript().length === 0,
  });
}

export async function runEngineCommandRequest(
  commandRequest: CommandExecutionRequest,
  deps: Pick<EngineHostApiDeps, 'hasRunningTask' | 'postMessage' | 'hostReveal' | 'handleUserMessage'>,
): Promise<void> {
  if (deps.hasRunningTask()) {
    const message = '当前仍在生成，请先停止当前任务后再执行新的命令。';
    deps.postMessage({ type: 'showError', message });
    vscode.window.showWarningMessage(message);
    return;
  }

  deps.hostReveal();
  await deps.handleUserMessage(commandRequest.displayText, undefined, {
    userContentOverride: commandRequest.userMessage,
    requestMode: commandRequest.requestMode,
  });
}

export function executeClearCurrentSession(deps: EngineHostApiDeps): void {
  if (deps.hasRunningTask()) {
    deps.postMessage({
      type: 'showError',
      message: '当前会话仍在生成，请先停止当前任务后再清空对话。',
    });
    return;
  }

  if (deps.isSessionRunningInOtherTab(deps.getActiveSessionId())) {
    deps.postMessage({
      type: 'showError',
      message: '当前会话正在其他聊天 Tab 中生成，请先停止当前任务后再清空对话。',
    });
    return;
  }

  const clearPlan = planClearCurrentSession({
    sessionLauncherVisible: deps.getSessionLauncherVisible(),
    activeSessionId: deps.getActiveSessionId(),
  });

  if (clearPlan.kind === 'blocked') {
    deps.postMessage({
      type: 'showError',
      message: clearPlan.errorMessage,
    });
    return;
  }

  deps.resetSessionScopedRuntimeState();
  deps.clearFileReadStateCache();
  clearSummaryCache();
  clearSessionConversation(getActiveSessionHelper(deps.getSessions(), deps.getActiveSessionId()));
  const sessionListResponse = deps.saveSessions();
  deps.postMessage(sessionListResponse);
  deps.syncHostTitle();
  info('对话历史已清空');

  deps.clearRetryableForSession(clearPlan.clearRetryableSessionId);
  for (const message of clearPlan.messages) {
    deps.postMessage(message);
  }
}

export function executeOpenSessionLauncher(deps: EngineHostApiDeps): void {
  deps.setActiveSessionId('');
  deps.setSessionLauncherVisible(true);
  deps.setContextFiles([]);
  const sessionListResponse = deps.saveSessions();
  deps.hostPostMessage(sessionListResponse);
  deps.syncActiveSessionTransientState();
  deps.hostPostMessage({ type: 'setSessionLauncher', visible: true });
  deps.hostPostMessage({ type: 'clearChat' });
  deps.hostPostMessage({ type: 'setLoading', loading: false });
  deps.hostPostMessage({ type: 'focusInput' });
  deps.syncHostTitle();
}
