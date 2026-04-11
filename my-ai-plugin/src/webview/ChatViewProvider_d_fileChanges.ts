import * as fs from 'fs';
import * as vscode from 'vscode';
import { error, info } from '../logger';
import { executeToolCalls, readFile } from '../tools';
import type { ParsedToolCall, ToolCallType, ToolExecutionResult } from '../tools';
import { resolveAndValidatePath } from '../tools/fileOps';
import type {
  AddStepResponse,
  ShowChangeSummaryResponse,
  ShowDiffResponse,
  UpdateChangeSummaryResponse,
  UpdateStepResponse,
  WorkMode,
} from './messageTypes';

export type ChangeSummaryFile = {
  path: string;
  displayPath: string;
  additions: number;
  deletions: number;
  status: 'created' | 'modified' | 'read' | 'listed';
  issueText?: string;
  stepId?: string;
};

export type WriteBackupEntry = {
  originalContent: string | null;
  messageId: string;
};

export type PreviewFileState = {
  content: string;
  exists: boolean;
};

export type PreviewBuildResult = {
  newContent: string;
  canApply: boolean;
  issueText?: string;
};

export type UndoAllWriteBackupsResult = {
  undoneCount: number;
  failCount: number;
  restoredFiles: string[];
  deletedFiles: string[];
};

export type UndoAllWriteBackupsFeedback = {
  restoredLogMessage?: string;
  deletedLogMessage?: string;
  notificationMessage: string;
  notificationKind: 'info' | 'error';
};

export type UndoSingleWriteBackupResult =
  | { status: 'missing' }
  | { status: 'failed' }
  | { status: 'success'; remainingCount: number };

export type UndoExecutionNotification = {
  kind: 'info' | 'error' | 'warning';
  message: string;
};

export type UndoAllWriteBackupsExecution =
  | {
    status: 'empty';
    logMessages: string[];
    notification: UndoExecutionNotification;
  }
  | {
    status: 'completed';
    logMessages: string[];
    notification: UndoExecutionNotification;
    summaryResponse: UpdateChangeSummaryResponse;
  };

export type UndoSingleWriteBackupExecution =
  | {
    status: 'missing';
    logMessages: string[];
  }
  | {
    status: 'failed';
    logMessages: string[];
  }
  | {
    status: 'success';
    logMessages: string[];
    summaryResponse: UpdateChangeSummaryResponse;
  };

export type ExecuteWriteToolCallResult = {
  filePath: string;
  singleResult: ToolExecutionResult;
  diffResponse?: ShowDiffResponse;
  changeSummaryEntry?: ChangeSummaryFile;
};

export type ToolCallExecutionRecord = {
  toolCall: ParsedToolCall;
  success: boolean;
  changedFilePath?: string;
};

export type ExecuteToolCallBatchResult = {
  status: 'completed' | 'interrupted';
  nextStepSequence: number;
  toolResults: ToolExecutionResult[];
  executionRecords: ToolCallExecutionRecord[];
  batchWriteFiles: ChangeSummaryFile[];
  writeSuccessCount: number;
  writeFailCount: number;
};

type BuildPreviewSummaryFilesOptions = {
  writeFilePaths?: Set<string>;
  previewIssues?: Map<string, string>;
  toDisplayPath?: (filePath: string) => string;
};

type BuildAppliedChangeSummaryResponsesOptions = {
  messageId: string;
  summaryId: string;
  files: ChangeSummaryFile[];
  writeSuccessCount: number;
  writeFailCount: number;
};

export function readFileTextSafely(filePath: string, fallback = ''): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

export function upsertChangeSummaryFile(targetFiles: ChangeSummaryFile[], entry: ChangeSummaryFile): void {
  const existingIndex = targetFiles.findIndex(file => file.path === entry.path);
  const nextEntry = { ...entry };

  if (existingIndex === -1) {
    targetFiles.push(nextEntry);
    return;
  }

  targetFiles[existingIndex] = nextEntry;
}

export function getToolStepDescription(tc: ParsedToolCall): string {
  const fileName = tc.path.split(/[/\\]/).pop() || tc.path;
  switch (tc.type) {
    case 'read_file':
      return `Reading ${fileName}`;
    case 'write_file':
      return `Creating ${fileName}`;
    case 'edit_file':
      return `Editing ${fileName}`;
    case 'list_dir':
      return `Listing ${fileName}`;
    default:
      return `Processing ${fileName}`;
  }
}

export function getToolStepIcon(type: ToolCallType): string {
  switch (type) {
    case 'read_file':
      return '📖';
    case 'write_file':
      return '📝';
    case 'edit_file':
      return '✏️';
    case 'list_dir':
      return '📁';
    default:
      return '📄';
  }
}

export function detectLanguage(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', java: 'java', cs: 'csharp', go: 'go', rs: 'rust',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    md: 'markdown', sh: 'bash', bat: 'batch', ps1: 'powershell',
    sql: 'sql', vue: 'vue', svelte: 'svelte', php: 'php', rb: 'ruby',
  };
  return langMap[ext] || ext || 'text';
}

export function getDisplayPath(filePath: string): string {
  const relativePath = vscode.workspace.asRelativePath(filePath, false);
  return relativePath || (filePath.split(/[\\/]/).pop() || filePath);
}

export async function ensurePreviewFileState(
  previewStates: Map<string, PreviewFileState>,
  filePath: string,
): Promise<PreviewFileState> {
  const cachedState = previewStates.get(filePath);
  if (cachedState) {
    return cachedState;
  }

  let nextState: PreviewFileState = {
    content: '',
    exists: false,
  };

  try {
    const readResult = await readFile(filePath);
    if (readResult.success) {
      nextState = {
        content: readResult.content,
        exists: true,
      };
    }
  } catch {
    nextState = {
      content: '',
      exists: false,
    };
  }

  previewStates.set(filePath, nextState);
  return nextState;
}

function countExactOccurrences(source: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  while (true) {
    const matchIndex = source.indexOf(search, startIndex);
    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = matchIndex + search.length;
  }
}

export function buildPreviewContent(toolCall: ParsedToolCall, currentContent: string): PreviewBuildResult {
  if (toolCall.type === 'write_file') {
    return {
      newContent: toolCall.content || '',
      canApply: true,
    };
  }

  if (toolCall.type !== 'edit_file') {
    return {
      newContent: currentContent,
      canApply: false,
    };
  }

  const oldSegment = toolCall.oldContent;
  const newSegment = toolCall.newContent || '';
  if (oldSegment === undefined || oldSegment === '') {
    return {
      newContent: currentContent,
      canApply: false,
      issueText: '预览提示：编辑片段缺少 old 内容，实际执行会失败',
    };
  }

  if (!currentContent.includes(oldSegment)) {
    return {
      newContent: currentContent,
      canApply: false,
      issueText: '预览提示：当前文件中未找到要替换的内容，实际执行会失败',
    };
  }

  const matchCount = countExactOccurrences(currentContent, oldSegment);
  if (matchCount > 1) {
    return {
      newContent: currentContent,
      canApply: false,
      issueText: `预览提示：要替换的内容在文件中出现了 ${matchCount} 次，实际执行会因定位不唯一而失败`,
    };
  }

  return {
    newContent: currentContent.replace(oldSegment, newSegment),
    canApply: true,
  };
}

export function buildPreviewSummaryFiles(
  previewBaseStates: Map<string, PreviewFileState>,
  previewCurrentStates: Map<string, PreviewFileState>,
  options: BuildPreviewSummaryFilesOptions = {},
): ChangeSummaryFile[] {
  const summaryFiles: ChangeSummaryFile[] = [];
  const writeFilePaths = options.writeFilePaths ?? new Set<string>();
  const previewIssues = options.previewIssues ?? new Map<string, string>();
  const toDisplayPath = options.toDisplayPath ?? getDisplayPath;

  for (const [filePath, currentState] of previewCurrentStates.entries()) {
    const baseState = previewBaseStates.get(filePath);
    if (!baseState) {
      continue;
    }

    const baseContent = writeFilePaths.has(filePath) ? '' : baseState.content;
    const diffStats = calculateDiffStats(baseContent, currentState.content);
    summaryFiles.push({
      path: filePath,
      displayPath: toDisplayPath(filePath),
      additions: diffStats.additions,
      deletions: diffStats.deletions,
      status: baseState.exists ? 'modified' : 'created',
      issueText: previewIssues.get(filePath),
    });
  }

  return summaryFiles;
}

export function calculateDiffStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const oldLines = splitContentToLines(oldContent);
  const newLines = splitContentToLines(newContent);
  const operations = buildDiffOperationTypes(oldLines, newLines);

  let additions = 0;
  let deletions = 0;

  for (const operation of operations) {
    if (operation === 'add') {
      additions += 1;
    } else if (operation === 'del') {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

export async function executeWriteToolCall(options: {
  toolCall: ParsedToolCall;
  requestMode: WorkMode;
  writeBackups: Map<string, WriteBackupEntry>;
  messageId: string;
  stepId: string;
  summaryId: string;
  toDisplayPath?: (filePath: string) => string;
}): Promise<ExecuteWriteToolCallResult> {
  const requestedFilePath = options.toolCall.path;
  const resolvedFilePath = resolveAndValidatePath(requestedFilePath);
  const filePath = resolvedFilePath ?? requestedFilePath;

  if (resolvedFilePath && resolvedFilePath !== requestedFilePath) {
    info(`写操作路径已解析: ${requestedFilePath} -> ${resolvedFilePath}`);
  }

  if (resolvedFilePath && !options.writeBackups.has(filePath)) {
    let originalContent: string | null = null;
    try {
      originalContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
    }
    options.writeBackups.set(filePath, { originalContent, messageId: options.messageId });
  }

  const backupBeforeWrite = options.writeBackups.get(filePath)?.originalContent ?? '';
  const diffOldContent = options.toolCall.type === 'write_file'
    ? ''
    : readFileTextSafely(filePath, backupBeforeWrite);

  const result = await executeToolCalls([options.toolCall], options.requestMode);
  const singleResult = result[0];

  if (!singleResult.result.success) {
    return {
      filePath,
      singleResult,
    };
  }

  const newContent = readFileTextSafely(filePath);
  const diffStats = calculateDiffStats(diffOldContent, newContent);
  const diffResponse: ShowDiffResponse = {
    type: 'showDiff',
    messageId: options.messageId,
    stepId: options.stepId,
    summaryId: options.summaryId,
    filePath,
    language: detectLanguage(filePath),
    additions: diffStats.additions,
    deletions: diffStats.deletions,
    oldContent: diffOldContent,
    newContent,
    needsConfirm: false,
    collapsed: true,
  };
  const toDisplayPath = options.toDisplayPath ?? getDisplayPath;
  const changeSummaryEntry: ChangeSummaryFile = {
    path: filePath,
    displayPath: toDisplayPath(filePath),
    additions: diffStats.additions,
    deletions: diffStats.deletions,
    status: options.toolCall.type === 'write_file' ? 'created' : 'modified',
  };

  return {
    filePath,
    singleResult,
    diffResponse,
    changeSummaryEntry,
  };
}

export async function executeToolCallBatch(options: {
  toolCalls: ParsedToolCall[];
  requestMode: WorkMode;
  messageId: string;
  summaryId: string;
  stepSequenceStart: number;
  writeBackups: Map<string, WriteBackupEntry>;
  postMessage: (message: AddStepResponse | UpdateStepResponse | ShowDiffResponse) => void;
  canContinue?: () => boolean;
  toDisplayPath?: (filePath: string) => string;
}): Promise<ExecuteToolCallBatchResult> {
  const toolResults: ToolExecutionResult[] = [];
  const executionRecords: ToolCallExecutionRecord[] = [];
  const batchWriteFiles: ChangeSummaryFile[] = [];
  let writeSuccessCount = 0;
  let writeFailCount = 0;
  let nextStepSequence = options.stepSequenceStart;

  for (const toolCall of options.toolCalls) {
    if (options.canContinue && !options.canContinue()) {
      return {
        status: 'interrupted',
        nextStepSequence,
        toolResults,
        executionRecords,
        batchWriteFiles,
        writeSuccessCount,
        writeFailCount,
      };
    }

    const stepId = `step-${options.messageId}-${nextStepSequence++}`;
    options.postMessage({
      type: 'addStep',
      messageId: options.messageId,
      stepId,
      icon: getToolStepIcon(toolCall.type),
      description: getToolStepDescription(toolCall),
      status: 'running',
    });

    const startTime = Date.now();
    const isWriteOp = toolCall.type === 'write_file' || toolCall.type === 'edit_file';

    if (isWriteOp) {
      const writeResult = await executeWriteToolCall({
        toolCall,
        requestMode: options.requestMode,
        writeBackups: options.writeBackups,
        messageId: options.messageId,
        stepId,
        summaryId: options.summaryId,
        toDisplayPath: options.toDisplayPath,
      });
      const singleResult = writeResult.singleResult;
      toolResults.push(singleResult);

      if (singleResult.result.success) {
        writeSuccessCount += 1;
        if (writeResult.diffResponse) {
          options.postMessage(writeResult.diffResponse);
        }
        if (writeResult.changeSummaryEntry) {
          upsertChangeSummaryFile(batchWriteFiles, writeResult.changeSummaryEntry);
        }
      } else {
        writeFailCount += 1;
      }

      executionRecords.push({
        toolCall,
        success: singleResult.result.success,
        changedFilePath: singleResult.result.success ? writeResult.filePath : undefined,
      });
      options.postMessage({
        type: 'updateStep',
        stepId,
        status: singleResult.result.success ? 'done' : 'error',
        elapsed: Date.now() - startTime,
      });
      continue;
    }

    const result = await executeToolCalls([toolCall], options.requestMode);
    const singleResult = result[0];
    toolResults.push(singleResult);
    executionRecords.push({
      toolCall,
      success: singleResult.result.success,
    });
    options.postMessage({
      type: 'updateStep',
      stepId,
      status: singleResult.result.success ? 'done' : 'error',
      elapsed: Date.now() - startTime,
    });
  }

  return {
    status: 'completed',
    nextStepSequence,
    toolResults,
    executionRecords,
    batchWriteFiles,
    writeSuccessCount,
    writeFailCount,
  };
}

export function buildAppliedChangeSummaryResponses(
  options: BuildAppliedChangeSummaryResponsesOptions,
): Array<ShowChangeSummaryResponse | UpdateChangeSummaryResponse> {
  return [
    {
      type: 'showChangeSummary',
      messageId: options.messageId,
      summaryId: options.summaryId,
      needsConfirm: false,
      files: options.files,
    },
    {
      type: 'updateChangeSummary',
      summaryId: options.summaryId,
      status: options.writeFailCount > 0 ? 'partial' : 'accepted',
      text: options.writeFailCount === 0
        ? `✓ Applied ${options.writeSuccessCount} change${options.writeSuccessCount > 1 ? 's' : ''}`
        : `⚠ ${options.writeSuccessCount} applied, ${options.writeFailCount} failed`,
    },
  ];
}

export function executeUndoAllWriteBackupsWithFeedback(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  summaryId: string;
}): UndoAllWriteBackupsExecution {
  if (options.writeBackups.size === 0) {
    return {
      status: 'empty',
      logMessages: ['Undo all：备份为空，无需操作'],
      notification: {
        kind: 'warning',
        message: '⚠ Undo：没有可撤销的备份（可能已发送新消息导致备份清空，或插件已重载）',
      },
    };
  }

  const logMessages = [buildUndoAllStartLogMessage(options.writeBackups)];
  const undoResult = undoAllWriteBackups(options.writeBackups);
  const feedback = buildUndoAllResultFeedback(undoResult);
  if (feedback.restoredLogMessage) {
    logMessages.push(feedback.restoredLogMessage);
  }
  if (feedback.deletedLogMessage) {
    logMessages.push(feedback.deletedLogMessage);
  }

  return {
    status: 'completed',
    logMessages,
    notification: {
      kind: feedback.notificationKind,
      message: feedback.notificationMessage,
    },
    summaryResponse: buildUndoAllChangeSummaryResponse(options.summaryId, undoResult),
  };
}

export function executeUndoSingleWriteBackupWithFeedback(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  filePath: string;
  summaryId: string;
}): UndoSingleWriteBackupExecution {
  const undoResult = undoSingleWriteBackup(options.writeBackups, options.filePath);
  if (undoResult.status === 'missing') {
    return {
      status: 'missing',
      logMessages: [`单文件 Undo：未找到 ${options.filePath} 的备份，可能已撤销或未被修改`],
    };
  }

  if (undoResult.status === 'failed') {
    return {
      status: 'failed',
      logMessages: [],
    };
  }

  return {
    status: 'success',
    logMessages: [],
    summaryResponse: buildUndoSingleChangeSummaryResponse(options.summaryId, undoResult.remainingCount),
  };
}

export function executeUndoAllWriteBackupsFlow(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  summaryId: string;
  postMessage: (message: UpdateChangeSummaryResponse) => void;
}): void {
  const undoExecution = executeUndoAllWriteBackupsWithFeedback({
    writeBackups: options.writeBackups,
    summaryId: options.summaryId,
  });

  for (const logMessage of undoExecution.logMessages) {
    info(logMessage);
  }

  if (undoExecution.notification.kind === 'info') {
    vscode.window.showInformationMessage(undoExecution.notification.message);
  } else if (undoExecution.notification.kind === 'warning') {
    vscode.window.showWarningMessage(undoExecution.notification.message);
  } else {
    vscode.window.showErrorMessage(undoExecution.notification.message);
  }

  if (undoExecution.status === 'completed') {
    options.postMessage(undoExecution.summaryResponse);
  }
}

export function executeUndoSingleWriteBackupFlow(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  filePath: string;
  summaryId: string;
  postMessage: (message: UpdateChangeSummaryResponse) => void;
}): void {
  const undoExecution = executeUndoSingleWriteBackupWithFeedback({
    writeBackups: options.writeBackups,
    filePath: options.filePath,
    summaryId: options.summaryId,
  });

  for (const logMessage of undoExecution.logMessages) {
    info(logMessage);
  }

  if (undoExecution.status !== 'success') {
    return;
  }

  options.postMessage(undoExecution.summaryResponse);
}

export function undoAllWriteBackups(
  writeBackups: Map<string, WriteBackupEntry>,
): UndoAllWriteBackupsResult {
  let undoneCount = 0;
  let failCount = 0;
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [filePath, backup] of writeBackups.entries()) {
    try {
      const originalContent = backup.originalContent;
      if (originalContent === null) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          info(`Undo：已删除新建文件 ${filePath}`);
          deletedFiles.push(filePath);
        } else {
          info(`Undo：新建文件已不存在，视为已撤销 ${filePath}`);
        }
      } else {
        fs.writeFileSync(filePath, originalContent, 'utf-8');
        info(`Undo：已恢复文件 ${filePath}`);
        restoredFiles.push(filePath);
      }

      undoneCount += 1;
    } catch (err) {
      error(`Undo 失败 ${filePath}:`, err);
      failCount += 1;
    }
  }

  writeBackups.clear();

  return {
    undoneCount,
    failCount,
    restoredFiles,
    deletedFiles,
  };
}

export function undoSingleWriteBackup(
  writeBackups: Map<string, WriteBackupEntry>,
  filePath: string,
): UndoSingleWriteBackupResult {
  const backup = writeBackups.get(filePath);
  if (!backup) {
    return { status: 'missing' };
  }

  try {
    const originalContent = backup.originalContent;
    if (originalContent === null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        info(`单文件 Undo：已删除新建文件 ${filePath}`);
      } else {
        info(`单文件 Undo：新建文件已不存在，视为已撤销 ${filePath}`);
      }
    } else {
      fs.writeFileSync(filePath, originalContent, 'utf-8');
      info(`单文件 Undo：已恢复文件 ${filePath}`);
    }

    writeBackups.delete(filePath);
    return {
      status: 'success',
      remainingCount: writeBackups.size,
    };
  } catch (err) {
    error(`单文件 Undo 失败 ${filePath}:`, err);
    return { status: 'failed' };
  }
}

export function buildUndoAllStartLogMessage(writeBackups: Map<string, WriteBackupEntry>): string {
  const fileList = [...writeBackups.keys()]
    .map(filePath => filePath.split(/[\\/]/).pop() || filePath)
    .join(', ');

  return `Undo all：开始恢复 ${writeBackups.size} 个文件：${fileList}`;
}

export function buildUndoAllChangeSummaryResponse(
  summaryId: string,
  undoResult: UndoAllWriteBackupsResult,
): UpdateChangeSummaryResponse {
  const text = undoResult.failCount === 0
    ? `↩ Undone ${undoResult.undoneCount} change${undoResult.undoneCount > 1 ? 's' : ''}`
    : `↩ Undone ${undoResult.undoneCount}, ${undoResult.failCount} failed`;

  return {
    type: 'updateChangeSummary',
    summaryId,
    status: undoResult.failCount > 0 ? 'partial-undone' : 'undone',
    text,
  };
}

export function buildUndoAllResultFeedback(
  undoResult: UndoAllWriteBackupsResult,
): UndoAllWriteBackupsFeedback {
  const restoredLogMessage = undoResult.restoredFiles.length > 0
    ? `Undo all：已恢复原内容文件 -> ${undoResult.restoredFiles.join(' | ')}`
    : undefined;
  const deletedLogMessage = undoResult.deletedFiles.length > 0
    ? `Undo all：已删除新建文件 -> ${undoResult.deletedFiles.join(' | ')}`
    : undefined;
  const notificationMessage = undoResult.failCount === 0
    ? `✓ Undo 成功：已还原 ${undoResult.undoneCount} 个文件（恢复 ${undoResult.restoredFiles.length} 个，删除 ${undoResult.deletedFiles.length} 个）`
    : `⚠ Undo 部分失败：${undoResult.undoneCount} 成功，${undoResult.failCount} 失败（查看 Output 面板日志）`;

  return {
    restoredLogMessage,
    deletedLogMessage,
    notificationMessage,
    notificationKind: undoResult.failCount === 0 ? 'info' : 'error',
  };
}

export function buildUndoSingleChangeSummaryResponse(
  summaryId: string,
  remainingCount: number,
): UpdateChangeSummaryResponse {
  return {
    type: 'updateChangeSummary',
    summaryId,
    status: remainingCount === 0 ? 'undone' : 'partial-undone',
    text: remainingCount === 0
      ? '↩ All changes undone'
      : `↩ Undone 1 file (${remainingCount} remaining)`,
  };
}

export function buildFinalTurnChangeSummaryResponse(
  messageId: string,
  files: ChangeSummaryFile[],
): ShowChangeSummaryResponse {
  return {
    type: 'showChangeSummary',
    messageId,
    summaryId: `final-summary-${messageId}`,
    needsConfirm: false,
    files,
  };
}

function splitContentToLines(content: string): string[] {
  if (!content) {
    return [];
  }

  let normalized = content.replace(/\r\n/g, '\n');
  if (normalized.endsWith('\n')) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    return [];
  }

  return normalized.split('\n');
}

function buildDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length
    && prefixLength < newLines.length
    && oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let oldSuffixIndex = oldLines.length - 1;
  let newSuffixIndex = newLines.length - 1;
  while (
    oldSuffixIndex >= prefixLength
    && newSuffixIndex >= prefixLength
    && oldLines[oldSuffixIndex] === newLines[newSuffixIndex]
  ) {
    oldSuffixIndex -= 1;
    newSuffixIndex -= 1;
  }

  const operations: Array<'context' | 'add' | 'del'> = [];

  for (let index = 0; index < prefixLength; index += 1) {
    operations.push('context');
  }

  const middleOldLines = oldLines.slice(prefixLength, oldSuffixIndex + 1);
  const middleNewLines = newLines.slice(prefixLength, newSuffixIndex + 1);
  operations.push(...buildMiddleDiffOperationTypes(middleOldLines, middleNewLines));

  const suffixLength = oldLines.length - (oldSuffixIndex + 1);
  for (let index = 0; index < suffixLength; index += 1) {
    operations.push('context');
  }

  return operations;
}

function buildMiddleDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  if (oldLines.length === 0) {
    return newLines.map(() => 'add');
  }

  if (newLines.length === 0) {
    return oldLines.map(() => 'del');
  }

  if (oldLines.length * newLines.length <= 120000) {
    return buildMiddleDiffOperationTypesByLcs(oldLines, newLines);
  }

  return buildMiddleDiffOperationTypesByLookahead(oldLines, newLines);
}

function buildMiddleDiffOperationTypesByLcs(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  const rowCount = oldLines.length;
  const columnCount = newLines.length;
  const lcsTable: number[][] = [];

  for (let row = 0; row <= rowCount; row += 1) {
    lcsTable.push(new Array(columnCount + 1).fill(0));
  }

  for (let row = rowCount - 1; row >= 0; row -= 1) {
    for (let column = columnCount - 1; column >= 0; column -= 1) {
      if (oldLines[row] === newLines[column]) {
        lcsTable[row][column] = lcsTable[row + 1][column + 1] + 1;
      } else {
        lcsTable[row][column] = Math.max(lcsTable[row + 1][column], lcsTable[row][column + 1]);
      }
    }
  }

  const operations: Array<'context' | 'add' | 'del'> = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < rowCount && newIndex < columnCount) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push('context');
      oldIndex += 1;
      newIndex += 1;
    } else if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
      operations.push('del');
      oldIndex += 1;
    } else {
      operations.push('add');
      newIndex += 1;
    }
  }

  while (oldIndex < rowCount) {
    operations.push('del');
    oldIndex += 1;
  }

  while (newIndex < columnCount) {
    operations.push('add');
    newIndex += 1;
  }

  return operations;
}

function buildMiddleDiffOperationTypesByLookahead(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  const operations: Array<'context' | 'add' | 'del'> = [];
  let oldIndex = 0;
  let newIndex = 0;
  const lookaheadSize = 20;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push('context');
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const nextNewMatch = findNextMatchingLine(newLines, newIndex + 1, oldLines[oldIndex], lookaheadSize);
    const nextOldMatch = findNextMatchingLine(oldLines, oldIndex + 1, newLines[newIndex], lookaheadSize);

    if (nextNewMatch !== -1 && (nextOldMatch === -1 || nextNewMatch - newIndex <= nextOldMatch - oldIndex)) {
      while (newIndex < nextNewMatch) {
        operations.push('add');
        newIndex += 1;
      }
      continue;
    }

    if (nextOldMatch !== -1) {
      while (oldIndex < nextOldMatch) {
        operations.push('del');
        oldIndex += 1;
      }
      continue;
    }

    operations.push('del');
    operations.push('add');
    oldIndex += 1;
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    operations.push('del');
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    operations.push('add');
    newIndex += 1;
  }

  return operations;
}

function findNextMatchingLine(lines: string[], startIndex: number, targetLine: string, lookaheadSize: number): number {
  const maxIndex = Math.min(lines.length, startIndex + lookaheadSize);
  for (let index = startIndex; index < maxIndex; index += 1) {
    if (lines[index] === targetLine) {
      return index;
    }
  }
  return -1;
}
