import * as vscode from 'vscode';
import type { AbortStreamFn } from '../api/client';
import {
  executeUndoAllWriteBackupsFlow,
  executeUndoSingleWriteBackupFlow,
} from './ChatViewProvider_d_fileChanges';
import type { WriteBackupEntry } from './ChatViewProvider_d_fileChanges';
import {
  discoverWorkflows,
  pickContextFiles,
  searchWorkspaceFiles as searchWorkspaceFilesHelper,
} from './ChatViewProvider_e_workspaceContext';
import {
  planRetryRequestReplay,
} from './ChatViewProvider_i_retryRequests';
import type {
  RequestImageAttachment,
  RetryableRequestState,
} from './ChatViewProvider_i_retryRequests';
import {
  buildTerminalErrorAnalysisPrompt,
  openFilesInIde as openFilesInIdeHelper,
  selectWorkflowToRun,
} from './ChatViewProvider_j_ideActions';
import {
  consumeStopGenerationRequest,
} from './ChatViewProvider_k_runtimeState';
import type {
  AddContextFileRequest,
  AnalyzeTerminalErrorRequest,
  ClearChatRequest,
  ContextActionRequest,
  CreateSessionRequest,
  DeleteSessionRequest,
  ExportChatRequest,
  OpenFilesInIdeRequest,
  RegenerateRequest,
  RenameSessionRequest,
  RetryRequestRequest,
  SearchWorkspaceFilesRequest,
  SendMessageRequest,
  StopGenerationRequest,
  SwitchSessionRequest,
  UndoAllChangesRequest,
  UndoFileChangeRequest,
  ExtensionMessage,
  HistoryProcessSummary,
  WorkMode,
  WebviewMessage,
} from './messageTypes';

export type RemainingWebviewMessageRoutingOptions = {
  onSendMessage: (message: SendMessageRequest) => Promise<void>;
  onClearChat: (message: ClearChatRequest) => void;
  onContextAction: (message: ContextActionRequest) => Promise<void>;
  onSearchWorkspaceFiles: (message: SearchWorkspaceFilesRequest) => Promise<void>;
  onExportChat: (message: ExportChatRequest) => Promise<void>;
  onCreateSession: (message: CreateSessionRequest) => void;
  onSwitchSession: (message: SwitchSessionRequest) => void;
  onDeleteSession: (message: DeleteSessionRequest) => void;
  onRenameSession: (message: RenameSessionRequest) => void;
  onAnalyzeTerminalError: (message: AnalyzeTerminalErrorRequest) => Promise<void>;
  onRegenerate: (message: RegenerateRequest) => Promise<void>;
  onRetryRequest: (message: RetryRequestRequest) => Promise<void>;
  onOpenFilesInIde: (message: OpenFilesInIdeRequest) => Promise<void>;
  onStopGeneration: (message: StopGenerationRequest) => Promise<void> | void;
  onUndoAllChanges: (message: UndoAllChangesRequest) => Promise<void>;
  onUndoFileChange: (message: UndoFileChangeRequest) => Promise<void>;
};

export async function tryRouteRemainingWebviewMessage(
  message: WebviewMessage,
  options: RemainingWebviewMessageRoutingOptions,
): Promise<boolean> {
  switch (message.type) {
    case 'sendMessage':
      await options.onSendMessage(message);
      return true;

    case 'clearChat':
      options.onClearChat(message);
      return true;

    case 'contextAction':
      await options.onContextAction(message);
      return true;

    case 'searchWorkspaceFiles':
      await options.onSearchWorkspaceFiles(message);
      return true;

    case 'exportChat':
      await options.onExportChat(message);
      return true;

    case 'createSession':
      options.onCreateSession(message);
      return true;

    case 'switchSession':
      options.onSwitchSession(message);
      return true;

    case 'deleteSession':
      options.onDeleteSession(message);
      return true;

    case 'renameSession':
      options.onRenameSession(message);
      return true;

    case 'analyzeTerminalError':
      await options.onAnalyzeTerminalError(message);
      return true;

    case 'regenerate':
      await options.onRegenerate(message);
      return true;

    case 'retryRequest':
      await options.onRetryRequest(message);
      return true;

    case 'openFilesInIde':
      await options.onOpenFilesInIde(message);
      return true;

    case 'stopGeneration':
      await options.onStopGeneration(message);
      return true;

    case 'undoAllChanges':
      await options.onUndoAllChanges(message);
      return true;

    case 'undoFileChange':
      await options.onUndoFileChange(message);
      return true;

    default:
      return false;
  }
}

type HandleUserMessageRequestOptions = {
  userContentOverride?: string;
  retryRequestId?: string;
  requestMode?: WorkMode;
};

export type HandleRemainingWebviewMessageOptions = {
  message: WebviewMessage;
  currentMode: WorkMode;
  activeSessionId: string;
  retryableRequests: Map<string, RetryableRequestState>;
  writeBackups: Map<string, WriteBackupEntry>;
  activeRunId: string | null;
  abortStream: AbortStreamFn | null;
  getContextFiles: () => string[];
  setContextFiles: (filePaths: string[]) => void;
  hasRunningTask: () => boolean;
  handleUserMessage: (
    text: string,
    images?: RequestImageAttachment[],
    requestOptions?: HandleUserMessageRequestOptions,
  ) => Promise<void>;
  clearCurrentSession: () => void;
  exportChatToMarkdown: () => Promise<void>;
  openSessionLauncher: () => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  handleRegenerate: (assistantMessageId: string) => Promise<void>;
  setActiveRunId: (runId: string | null) => void;
  setAbortStream: (abortStream: AbortStreamFn | null) => void;
  setToolCallsInProgress: (value: boolean) => void;
  setStepSequence: (stepSequence: number) => void;
  setToolCallRound: (toolCallRound: number) => void;
  setActiveHistoryProcessSummary: (summary: HistoryProcessSummary | null) => void;
  rollbackPendingRegenerateState: (runId: string) => boolean;
  postMessage: (message: ExtensionMessage) => void;
  logInfo: (message: string, payload?: unknown) => void;
};

export async function handleRemainingWebviewMessage(
  options: HandleRemainingWebviewMessageOptions,
): Promise<boolean> {
  return tryRouteRemainingWebviewMessage(options.message, {
    onSendMessage: async request => {
      options.logInfo('收到用户消息:', request.text);
      options.logInfo('收到 sendMessage 模式快照', {
        uiMode: request.mode,
        currentMode: options.currentMode,
      });
      await options.handleUserMessage(request.text, request.images, { requestMode: request.mode });
    },
    onClearChat: () => {
      options.logInfo('用户清空对话');
      options.clearCurrentSession();
    },
    onContextAction: async request => {
      switch (request.action) {
        case 'mentions': {
          const pickResult = await pickContextFiles(options.getContextFiles());
          options.setContextFiles(pickResult.nextFilePaths);
          for (const message of pickResult.addedMessages) {
            options.postMessage(message);
            options.logInfo(`添加上下文文件: ${message.fileName}`);
          }
          return;
        }

        case 'workflow': {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const workflows = discoverWorkflows(workspaceRoot);
          const selected = await selectWorkflowToRun(workflows);
          if (!selected) {
            return;
          }

          options.logInfo(`触发工作流: ${selected.label}`);
          await options.handleUserMessage(selected.promptContent);
          return;
        }

        case 'upload':
          return;
      }
    },
    onSearchWorkspaceFiles: async request => {
      try {
        const files = await searchWorkspaceFilesHelper(request.keyword);
        options.postMessage({ type: 'workspaceFiles', files });
      } catch (err) {
        options.postMessage({ type: 'workspaceFiles', files: [] });
      }
    },
    onExportChat: async () => {
      await options.exportChatToMarkdown();
    },
    onCreateSession: () => {
      options.openSessionLauncher();
    },
    onSwitchSession: request => {
      options.switchSession(request.sessionId);
    },
    onDeleteSession: request => {
      options.deleteSession(request.sessionId);
    },
    onRenameSession: request => {
      options.renameSession(request.sessionId, request.name);
    },
    onAnalyzeTerminalError: async () => {
      const prompt = await buildTerminalErrorAnalysisPrompt();
      if (!prompt) {
        return;
      }

      await options.handleUserMessage(prompt);
    },
    onRegenerate: async request => {
      await options.handleRegenerate(request.assistantMessageId);
    },
    onRetryRequest: async request => {
      const retryPlan = planRetryRequestReplay({
        hasRunningTask: options.hasRunningTask(),
        retryableRequests: options.retryableRequests,
        requestId: request.requestId,
        activeSessionId: options.activeSessionId,
      });
      if (retryPlan.kind === 'blocked') {
        options.postMessage({ type: 'showError', message: retryPlan.errorMessage });
        return;
      }

      await options.handleUserMessage(
        retryPlan.request.text,
        retryPlan.request.images,
        {
          userContentOverride: retryPlan.request.userContent,
          retryRequestId: retryPlan.request.requestId,
          requestMode: retryPlan.request.requestMode,
        },
      );
    },
    onOpenFilesInIde: async request => {
      await openFilesInIdeHelper(request.files);
    },
    onStopGeneration: () => {
      const stopResult = consumeStopGenerationRequest({
        activeRunId: options.activeRunId,
        abortStream: options.abortStream,
      });
      options.setActiveRunId(stopResult.nextActiveRunId);
      options.setAbortStream(stopResult.nextAbortStream);
      options.setToolCallsInProgress(stopResult.nextToolCallsInProgress);
      options.setStepSequence(stopResult.nextStepSequence);
      options.setToolCallRound(stopResult.nextToolCallRound);
      options.setActiveHistoryProcessSummary(stopResult.nextActiveHistoryProcessSummary);
      if (stopResult.abortStreamToStop) {
        options.logInfo('用户主动停止生成');
        (stopResult.abortStreamToStop as AbortStreamFn)();
      }
      if (stopResult.stoppedRunId) {
        options.rollbackPendingRegenerateState(stopResult.stoppedRunId);
      }
      options.postMessage({ type: 'generationStopped' });
      options.postMessage({ type: 'setLoading', loading: false });
    },
    onUndoAllChanges: async request => {
      executeUndoAllWriteBackupsFlow({
        writeBackups: options.writeBackups,
        summaryId: request.summaryId,
        postMessage: message => options.postMessage(message),
      });
    },
    onUndoFileChange: async request => {
      executeUndoSingleWriteBackupFlow({
        writeBackups: options.writeBackups,
        filePath: request.filePath,
        summaryId: request.summaryId,
        postMessage: message => options.postMessage(message),
      });
    },
  });
}
