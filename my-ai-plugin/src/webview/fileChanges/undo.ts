import * as fs from 'fs';
import * as vscode from 'vscode';
import { error, info } from '../../logger';
import type { UpdateChangeSummaryResponse } from '../messageTypes';
import type { ChangeSummaryFile, WriteBackupEntry } from './index';

// Re-export for backward compatibility
export type { WriteBackupEntry };

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
  | { status: 'failed'; errorMessage: string }
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
    notification: UndoExecutionNotification;
  }
  | {
    status: 'failed';
    logMessages: string[];
    notification: UndoExecutionNotification;
  }
  | {
    status: 'success';
    logMessages: string[];
    notification?: UndoExecutionNotification;
    remainingCount: number;
    summaryResponse: UpdateChangeSummaryResponse;
  };

export function isChangeSummaryFileUndoable(
  file: Pick<ChangeSummaryFile, 'status' | 'undoable' | 'issueText'>,
): boolean {
  if (typeof file.undoable === 'boolean') {
    return file.undoable;
  }

  const isWriteFile = file.status === 'created' || file.status === 'modified';
  return isWriteFile && !file.issueText;
}

export function collectWriteBackupMessageIds(writeBackups: Map<string, WriteBackupEntry>): string[] {
  const messageIds = new Set<string>();
  for (const backup of writeBackups.values()) {
    if (backup.messageId) {
      messageIds.add(backup.messageId);
    }
  }
  return [...messageIds];
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
      notification: {
        kind: 'warning',
        message: '未找到该文件的可撤销备份，可能已经撤销，或该文件不是本轮写入产生的改动',
      },
    };
  }

  if (undoResult.status === 'failed') {
    return {
      status: 'failed',
      logMessages: [`单文件 Undo：恢复 ${options.filePath} 失败 -> ${undoResult.errorMessage}`],
      notification: {
        kind: 'error',
        message: '单文件 Undo 失败，请查看 Output 面板日志',
      },
    };
  }

  return {
    status: 'success',
    logMessages: [],
    remainingCount: undoResult.remainingCount,
    summaryResponse: buildUndoSingleChangeSummaryResponse(options.summaryId, undoResult.remainingCount),
  };
}

export function executeUndoAllWriteBackupsFlow(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  summaryId: string;
  postMessage: (message: UpdateChangeSummaryResponse) => void;
  onCompleted?: (undoExecution: Extract<UndoAllWriteBackupsExecution, { status: 'completed' }>) => void;
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
    options.onCompleted?.(undoExecution);
  }
}

export function executeUndoSingleWriteBackupFlow(options: {
  writeBackups: Map<string, WriteBackupEntry>;
  filePath: string;
  summaryId: string;
  postMessage: (message: UpdateChangeSummaryResponse) => void;
  onSuccess?: (undoExecution: Extract<UndoSingleWriteBackupExecution, { status: 'success' }>) => void;
}): void {
  const undoExecution = executeUndoSingleWriteBackupWithFeedback({
    writeBackups: options.writeBackups,
    filePath: options.filePath,
    summaryId: options.summaryId,
  });

  for (const logMessage of undoExecution.logMessages) {
    info(logMessage);
  }

  if (undoExecution.notification) {
    if (undoExecution.notification.kind === 'info') {
      vscode.window.showInformationMessage(undoExecution.notification.message);
    } else if (undoExecution.notification.kind === 'warning') {
      vscode.window.showWarningMessage(undoExecution.notification.message);
    } else {
      vscode.window.showErrorMessage(undoExecution.notification.message);
    }
  }

  if (undoExecution.status !== 'success') {
    return;
  }

  options.postMessage(undoExecution.summaryResponse);
  options.onSuccess?.(undoExecution);
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
    const errMsg = err instanceof Error ? err.message : String(err);
    error(`单文件 Undo 失败 ${filePath}:`, err);
    return {
      status: 'failed',
      errorMessage: errMsg,
    };
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

export function buildExpiredChangeSummaryResponse(
  summaryId: string,
  text = 'Undo expired',
): UpdateChangeSummaryResponse {
  return {
    type: 'updateChangeSummary',
    summaryId,
    status: 'cancelled',
    text,
  };
}
