import * as fs from 'fs';
import * as vscode from 'vscode';
import { info } from '../../logger';
import { buildDiffOperationTypes, splitContentToLines } from './diff';

// Undo/Backup system — extracted to u_undo
export {
  isChangeSummaryFileUndoable,
  collectWriteBackupMessageIds,
  executeUndoAllWriteBackupsWithFeedback,
  executeUndoSingleWriteBackupWithFeedback,
  executeUndoAllWriteBackupsFlow,
  executeUndoSingleWriteBackupFlow,
  undoAllWriteBackups,
  undoSingleWriteBackup,
  buildUndoAllStartLogMessage,
  buildUndoAllChangeSummaryResponse,
  buildUndoAllResultFeedback,
  buildUndoSingleChangeSummaryResponse,
  buildExpiredChangeSummaryResponse,
} from './undo';
export type {
  UndoAllWriteBackupsResult,
  UndoAllWriteBackupsFeedback,
  UndoSingleWriteBackupResult,
  UndoExecutionNotification,
  UndoAllWriteBackupsExecution,
  UndoSingleWriteBackupExecution,
} from './undo';

// Diff algorithm — extracted to diff.ts
export { splitContentToLines, buildDiffOperationTypes } from './diff';
import { executeToolCalls, readFile, validateFileReadState, buildReadFileStubIfUnchanged, isToolReadOnly, getToolIcon, getToolStepText, addLineNumbers, addLineNumbersFromStart } from '../../tools';
import type { ParsedToolCall, ToolCallType, ToolExecutionResult } from '../../tools';
import type { FileReadStateCache } from '../../tools';
import { extractScriptBlock } from '../../tools/astAdapter_vue';
import { collectDiagnosticsAfterEdit } from '../../tools/lspDiagnostics';
import { buildEditedContent, buildLineBasedEditContent, resolveAndValidatePath, findClosestMatch } from '../../tools/fileOps';
import type {
  AddStepResponse,
  ShowChangeSummaryResponse,
  ShowDiffResponse,
  UpdateChangeSummaryResponse,
  UpdateStepResponse,
  WorkMode,
} from '../messageTypes';

export type ChangeSummaryFile = {
  path: string;
  displayPath: string;
  additions: number;
  deletions: number;
  status: 'created' | 'modified' | 'read' | 'listed';
  issueText?: string;
  stepId?: string;
  undoable?: boolean;
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

export type ExecuteWriteToolCallResult = {
  filePath: string;
  singleResult: ToolExecutionResult;
  diffResponse?: ShowDiffResponse;
  changeSummaryEntry?: ChangeSummaryFile;
  additionalDiffs?: ShowDiffResponse[];
  additionalChangeSummaryEntries?: ChangeSummaryFile[];
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
  executedToolCalls: ParsedToolCall[];
  deferredToolCalls: ParsedToolCall[];
  readOnlyBatchLimited: boolean;
  sameFileToolCallLimited: boolean;
  duplicateReadOnlyToolCallsSkippedCount: number;
};

type ToolCallExecutionPlan = {
  executableToolCalls: ParsedToolCall[];
  deferredToolCalls: ParsedToolCall[];
  readOnlyBatchLimited: boolean;
  sameFileToolCallLimited: boolean;
  duplicateReadOnlyToolCallsSkippedCount: number;
};

const MAX_READ_ONLY_TOOL_CALLS_PER_ROUND = 3;

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
  if (tc.type === 'run_command') {
    return buildRunCommandStepDescription(tc.command ?? '');
  }

  return getToolStepText(tc.type, getToolStepSubjectLabel(tc));
}

function getToolStepSubjectLabel(tc: ParsedToolCall): string {
  if (tc.type === 'search_file') {
    return tc.pattern?.trim() || '(no pattern)';
  }
  if (tc.type === 'grep_code') {
    return tc.regex?.trim() || '(no regex)';
  }

  const pathLabel = tc.path?.trim() || '(no path)';
  return pathLabel.split(/[/\\]/).pop() || pathLabel;
}

const RUN_COMMAND_STEP_PREFIX = 'Running command: ';

/** run_command 步骤初始描述（含命令前缀） */
export function buildRunCommandStepDescription(command: string, maxChars = 120): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return `${RUN_COMMAND_STEP_PREFIX}(empty)`;
  }

  const preview = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
  return `${RUN_COMMAND_STEP_PREFIX}${preview}`;
}

/** run_command 步骤完成后的描述（命令 + 输出摘要） */
export function buildRunCommandStepResultDescription(
  command: string,
  success: boolean,
  output?: string,
): string {
  const base = buildRunCommandStepDescription(command, 80);
  const outputText = (output ?? '').trim() || (success ? '(no output)' : 'Command failed');
  const summary = truncateStepFailureText(outputText.replace(/\s+/g, ' '), 100);
  return `${base} · ${summary}`;
}

export function getToolStepIcon(type: ToolCallType): string {
  return getToolIcon(type);
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

function isReadOnlyToolCall(toolCall: ParsedToolCall): boolean {
  return isToolReadOnly(toolCall.type);
}

function isWriteToolCall(toolCall: ParsedToolCall): boolean {
  return toolCall.type === 'write_file' || toolCall.type === 'edit_file' || toolCall.type === 'ast_edit';
}

function normalizeToolCallPath(filePath: string): string {
  const resolvedPath = resolveAndValidatePath(filePath) || filePath;
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

function getReadOnlyToolCallDedupKey(toolCall: ParsedToolCall): string | null {
  if (toolCall.type !== 'read_file' && toolCall.type !== 'list_dir') {
    return null;
  }
  if (!toolCall.path?.trim()) {
    return null;
  }

  return `${toolCall.type}:${normalizeToolCallPath(toolCall.path)}`;
}

function getFileExtension(filePath: string): string {
  return filePath.includes('.') ? `.${filePath.split('.').pop()!.toLowerCase()}` : '';
}

function offsetToLineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

export function shouldForceAstForEditFile(toolCall: ParsedToolCall, filePath: string, currentContent: string): boolean {
  const fileExt = getFileExtension(filePath);
  const STRICT_AST_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.cs', '.java']);
  if (STRICT_AST_EXTENSIONS.has(fileExt)) {
    return true;
  }

  if (fileExt !== '.vue' && fileExt !== '.html') {
    return false;
  }

  const scriptBlock = extractScriptBlock(currentContent);
  if (!scriptBlock || !scriptBlock.content.trim()) {
    return false;
  }

  if (toolCall.startLine !== undefined) {
    const editStartLine = toolCall.startLine;
    const editEndLine = toolCall.endLine ?? toolCall.startLine;
    const scriptStartLine = offsetToLineNumber(currentContent, scriptBlock.contentStart);
    const scriptEndLine = offsetToLineNumber(currentContent, scriptBlock.contentEnd);
    return editStartLine <= scriptEndLine && editEndLine >= scriptStartLine;
  }

  if (toolCall.oldContent) {
    return scriptBlock.content.includes(toolCall.oldContent);
  }

  return false;
}

export function buildToolCallExecutionPlan(toolCalls: ParsedToolCall[]): ToolCallExecutionPlan {
  const hasWriteOperation = toolCalls.some(toolCall => isWriteToolCall(toolCall));
  if (!hasWriteOperation) {
    const dedupedToolCalls: ParsedToolCall[] = [];
    const seenReadOnlyKeys = new Set<string>();
    let duplicateReadOnlyToolCallsSkippedCount = 0;

    for (const toolCall of toolCalls) {
      const dedupKey = getReadOnlyToolCallDedupKey(toolCall);
      if (dedupKey && seenReadOnlyKeys.has(dedupKey)) {
        duplicateReadOnlyToolCallsSkippedCount += 1;
        continue;
      }

      if (dedupKey) {
        seenReadOnlyKeys.add(dedupKey);
      }

      dedupedToolCalls.push(toolCall);
    }

    if (dedupedToolCalls.length <= MAX_READ_ONLY_TOOL_CALLS_PER_ROUND) {
      return {
        executableToolCalls: dedupedToolCalls,
        deferredToolCalls: [],
        readOnlyBatchLimited: false,
        sameFileToolCallLimited: false,
        duplicateReadOnlyToolCallsSkippedCount,
      };
    }

    return {
      executableToolCalls: dedupedToolCalls.slice(0, MAX_READ_ONLY_TOOL_CALLS_PER_ROUND),
      deferredToolCalls: dedupedToolCalls.slice(MAX_READ_ONLY_TOOL_CALLS_PER_ROUND),
      readOnlyBatchLimited: true,
      sameFileToolCallLimited: false,
      duplicateReadOnlyToolCallsSkippedCount,
    };
  }

  const executableToolCalls: ParsedToolCall[] = [];
  const deferredToolCalls: ParsedToolCall[] = [];
  const lockedFilePaths = new Set<string>();
  let sameFileToolCallLimited = false;

  for (const toolCall of toolCalls) {
    const normalizedPath = toolCall.type === 'list_dir' || !toolCall.path?.trim()
      ? undefined
      : normalizeToolCallPath(toolCall.path);

    if (normalizedPath && lockedFilePaths.has(normalizedPath)) {
      deferredToolCalls.push(toolCall);
      sameFileToolCallLimited = true;
      continue;
    }

    executableToolCalls.push(toolCall);

    if (normalizedPath && isWriteToolCall(toolCall)) {
      lockedFilePaths.add(normalizedPath);
    }
  }

  return {
    executableToolCalls,
    deferredToolCalls,
    readOnlyBatchLimited: false,
    sameFileToolCallLimited,
    duplicateReadOnlyToolCallsSkippedCount: 0,
  };
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

  // 行号编辑模式：用 start_line/end_line 定位，不需要 old 内容匹配
  if (toolCall.startLine !== undefined) {
    const lineResult = buildLineBasedEditContent(
      currentContent,
      toolCall.startLine,
      toolCall.endLine,
      toolCall.newContent || '',
    );
    if (!lineResult.success) {
      return {
        newContent: currentContent,
        canApply: false,
        issueText: `预览提示：${lineResult.message}`,
      };
    }
    return {
      newContent: lineResult.updatedContent,
      canApply: true,
    };
  }

  // 文本匹配模式：原有逻辑
  const oldSegment = toolCall.oldContent;
  const newSegment = toolCall.newContent || '';
  const editResult = buildEditedContent(currentContent, oldSegment || '', newSegment, { replaceAll: toolCall.replaceAll });
  if (!editResult.success) {
    if (editResult.reason === 'missing-old') {
      return {
        newContent: currentContent,
        canApply: false,
        issueText: '预览提示：编辑片段缺少 old 内容，实际执行会失败',
      };
    }

    if (editResult.reason === 'not-found') {
      // 自动降级：尝试模糊匹配，如果找到接近的内容则允许通过（实际执行时 editFile 会自动转换）
      const closest = findClosestMatch(currentContent, oldSegment || '');
      if (closest) {
        const lineResult = buildLineBasedEditContent(
          currentContent,
          closest.startLine,
          closest.endLine,
          newSegment,
        );
        if (lineResult.success) {
          return {
            newContent: lineResult.updatedContent,
            canApply: true,
          };
        }
      }
      // 模糊匹配也没找到，返回原有的错误提示
      const SNIPPET_MAX = 800;
      const snippet = currentContent.length > SNIPPET_MAX
        ? currentContent.slice(0, SNIPPET_MAX) + '\n...(已截断)'
        : currentContent;
      return {
        newContent: currentContent,
        canApply: false,
        issueText: `预览提示：当前文件中未找到要替换的内容，实际执行会失败。请先用 read_file 读取该文件确认真实内容后再重试 edit_file。\n文件开头内容片段:\n${snippet}`,
      };
    }

    return {
      newContent: currentContent,
      canApply: false,
      issueText: `预览提示：要替换的内容在文件中出现了 ${editResult.matchCount} 次，实际执行会因定位不唯一而失败`,
    };
  }

  return {
    newContent: editResult.updatedContent,
    canApply: true,
  };
}

function createWriteFailureSummaryEntry(options: {
  toolCall: ParsedToolCall;
  filePath: string;
  fileExistedBeforeWrite: boolean;
  issueText: string;
  stepId: string;
  toDisplayPath?: (filePath: string) => string;
}): ChangeSummaryFile {
  const toDisplayPath = options.toDisplayPath ?? getDisplayPath;
  return {
    path: options.filePath,
    displayPath: toDisplayPath(options.filePath),
    additions: 0,
    deletions: 0,
    status: options.toolCall.type === 'write_file' && !options.fileExistedBeforeWrite ? 'created' : 'modified',
    issueText: options.issueText,
    stepId: options.stepId,
    undoable: false,
  };
}

function truncateStepFailureText(text: string, maxChars = 120): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}...`;
}

function buildWriteFailureStepDescription(toolCall: ParsedToolCall, failureText: string): string {
  return `${getToolStepDescription(toolCall)} · ${truncateStepFailureText(failureText)}`;
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
      undoable: false,
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
  /** 文件读取状态缓存，用于 edit_file 执行前校验"先读后编" */
  fileReadStateCache?: FileReadStateCache;
}): Promise<ExecuteWriteToolCallResult> {
  const requestedFilePath = options.toolCall.path!;
  const resolvedFilePath = resolveAndValidatePath(requestedFilePath);
  const filePath = resolvedFilePath ?? requestedFilePath;
  const toDisplayPath = options.toDisplayPath ?? getDisplayPath;
  const fileExistedBeforeWrite = resolvedFilePath ? fs.existsSync(filePath) : false;

  if (resolvedFilePath && resolvedFilePath !== requestedFilePath) {
    info(`写操作路径已解析: ${requestedFilePath} -> ${resolvedFilePath}`);
  }

  if (resolvedFilePath && fileExistedBeforeWrite && options.toolCall.type === 'write_file') {
    const issueText = '预检失败：目标文件已存在。为了避免整文件重写，请先读取当前文件并改用 edit_file 做局部修改';
    return {
      filePath,
      singleResult: {
        toolCall: options.toolCall,
        result: {
          success: false,
          content: issueText,
        },
      },
      changeSummaryEntry: createWriteFailureSummaryEntry({
        toolCall: options.toolCall,
        filePath,
        fileExistedBeforeWrite,
        issueText,
        stepId: options.stepId,
        toDisplayPath,
      }),
    };
  }

  // 先读后编校验：edit_file 执行前检查文件是否被 read_file 读取过
  if (resolvedFilePath && fileExistedBeforeWrite && options.toolCall.type === 'edit_file' && options.fileReadStateCache) {
    try {
      const fileStat = fs.statSync(filePath);
      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const validation = validateFileReadState(filePath, options.fileReadStateCache, fileStat.mtimeMs, currentContent);
      if (!validation.valid) {
        const issueText = validation.reason || '编辑被拒绝：文件读取状态校验未通过';
        return {
          filePath,
          singleResult: {
            toolCall: options.toolCall,
            result: { success: false, content: issueText },
          },
          changeSummaryEntry: createWriteFailureSummaryEntry({
            toolCall: options.toolCall,
            filePath,
            fileExistedBeforeWrite,
            issueText,
            stepId: options.stepId,
            toDisplayPath,
          }),
        };
      }
    } catch (err) {
      // stat/read 失败不阻塞编辑流程，降级到无校验模式
      info(`readFileState 校验时读取文件异常，跳过校验: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (options.toolCall.type === 'edit_file' && !options.toolCall.astBypass) {
    const fileExt = getFileExtension(filePath);
    const currentContent = fileExistedBeforeWrite ? readFileTextSafely(filePath) : '';
    if (shouldForceAstForEditFile(options.toolCall, filePath, currentContent)) {
      const issueText = (fileExt === '.vue' || fileExt === '.html')
        ? `编辑被拒绝：${filePath} 的修改目标位于 <script> 块内，必须优先使用 ast_edit 工具。`
          + `\n\n如果你要修改的是模板、HTML 结构或样式，请改用 edit_file，并添加 ast_bypass="true"。`
        : `编辑被拒绝：${filePath} 是 AST 支持的文件类型（${fileExt}），必须优先使用 ast_edit 工具。`
          + `\n\nast_edit 支持的操作：add_import / remove_import / insert_function / edit_function_body / add_function_param / add_object_property / add_class_member / rename_symbol`
          + `\n\n如果此修改确实不适合 AST（如修改字符串常量、条件表达式、模板等非结构化内容），请在 edit_file 标签中添加 ast_bypass="true" 属性来绕过此检查。`;
      return {
        filePath,
        singleResult: {
          toolCall: options.toolCall,
          result: { success: false, content: issueText },
        },
        changeSummaryEntry: createWriteFailureSummaryEntry({
          toolCall: options.toolCall,
          filePath,
          fileExistedBeforeWrite,
          issueText,
          stepId: options.stepId,
          toDisplayPath,
        }),
      };
    }
  }

  // 编辑规模限制：old 内容超过 MAX_OLD_CONTENT_LINES 行时拒绝，引导模型拆分或使用行号模式
  const MAX_OLD_CONTENT_LINES = 30;
  if (options.toolCall.type === 'edit_file' && options.toolCall.oldContent && !options.toolCall.startLine) {
    const oldLineCount = options.toolCall.oldContent.split('\n').length;
    if (oldLineCount > MAX_OLD_CONTENT_LINES) {
      const issueText = `编辑被拒绝：old 内容过长（${oldLineCount} 行，上限 ${MAX_OLD_CONTENT_LINES} 行）。`
        + `请拆分为更小的编辑，或改用行号模式 edit_file（添加 start_line/end_line 属性）。`;
      return {
        filePath,
        singleResult: {
          toolCall: options.toolCall,
          result: { success: false, content: issueText },
        },
        changeSummaryEntry: createWriteFailureSummaryEntry({
          toolCall: options.toolCall,
          filePath,
          fileExistedBeforeWrite,
          issueText,
          stepId: options.stepId,
          toDisplayPath,
        }),
      };
    }
  }

  if (resolvedFilePath && fileExistedBeforeWrite && options.toolCall.type === 'edit_file') {
    const previewResult = buildPreviewContent(options.toolCall, readFileTextSafely(filePath));
    if (!previewResult.canApply) {
      const issueText = previewResult.issueText || '预检失败：当前编辑无法安全应用';
      return {
        filePath,
        singleResult: {
          toolCall: options.toolCall,
          result: {
            success: false,
            content: issueText,
          },
        },
        changeSummaryEntry: createWriteFailureSummaryEntry({
          toolCall: options.toolCall,
          filePath,
          fileExistedBeforeWrite,
          issueText,
          stepId: options.stepId,
          toDisplayPath,
        }),
      };
    }
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
      changeSummaryEntry: createWriteFailureSummaryEntry({
        toolCall: options.toolCall,
        filePath,
        fileExistedBeforeWrite,
        issueText: singleResult.result.content,
        stepId: options.stepId,
        toDisplayPath,
      }),
    };
  }

  const newContent = readFileTextSafely(filePath);

  // 写入成功后收集 LSP 诊断（Error/Warning），反馈给模型帮助自动修正
  if (resolvedFilePath) {
    const diagnosticsResult = await collectDiagnosticsAfterEdit(resolvedFilePath);
    if (diagnosticsResult.summary) {
      singleResult.result.diagnosticsSummary = diagnosticsResult.summary;
    }
  }

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
  const changeSummaryEntry: ChangeSummaryFile = {
    path: filePath,
    displayPath: toDisplayPath(filePath),
    additions: diffStats.additions,
    deletions: diffStats.deletions,
    status: options.toolCall.type === 'write_file' ? 'created' : 'modified',
    stepId: options.stepId,
    undoable: true,
  };

  // AST 多文件修改（如 rename_symbol）：为主文件以外的受影响文件生成备份、diff 和汇总
  const astAffected = singleResult.result.astAffectedFiles;
  if (astAffected && astAffected.length > 1) {
    const additionalDiffs: ShowDiffResponse[] = [];
    const additionalChangeSummaryEntries: ChangeSummaryFile[] = [];

    for (const affected of astAffected) {
      // 主文件已在上面处理，跳过
      const normalizedAffected = affected.filePath.replace(/\\/g, '/');
      const normalizedPrimary = filePath.replace(/\\/g, '/');
      if (normalizedAffected === normalizedPrimary) {
        continue;
      }

      // 为额外文件注册备份（undo 时恢复）
      if (!options.writeBackups.has(affected.filePath)) {
        options.writeBackups.set(affected.filePath, {
          originalContent: affected.originalContent,
          messageId: options.messageId,
        });
      }

      const secDiffStats = calculateDiffStats(affected.originalContent, affected.newContent);
      additionalDiffs.push({
        type: 'showDiff',
        messageId: options.messageId,
        stepId: options.stepId,
        summaryId: options.summaryId,
        filePath: affected.filePath,
        language: detectLanguage(affected.filePath),
        additions: secDiffStats.additions,
        deletions: secDiffStats.deletions,
        oldContent: affected.originalContent,
        newContent: affected.newContent,
        needsConfirm: false,
        collapsed: true,
      });
      additionalChangeSummaryEntries.push({
        path: affected.filePath,
        displayPath: toDisplayPath(affected.filePath),
        additions: secDiffStats.additions,
        deletions: secDiffStats.deletions,
        status: 'modified',
        stepId: options.stepId,
        undoable: true,
      });
    }

    return {
      filePath,
      singleResult,
      diffResponse,
      changeSummaryEntry,
      additionalDiffs,
      additionalChangeSummaryEntries,
    };
  }

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
  /** 文件读取状态缓存，read_file 成功后更新缓存，edit_file 执行前校验 */
  fileReadStateCache?: FileReadStateCache;
  /** 设置加载提示文本的回调函数 */
  setLoadingText?: (text: string) => void;
}): Promise<ExecuteToolCallBatchResult> {
  const toolResults: ToolExecutionResult[] = [];
  const executionRecords: ToolCallExecutionRecord[] = [];
  const batchWriteFiles: ChangeSummaryFile[] = [];
  const executionPlan = buildToolCallExecutionPlan(options.toolCalls);
  let writeSuccessCount = 0;
  let writeFailCount = 0;
  let nextStepSequence = options.stepSequenceStart;

  if (executionPlan.readOnlyBatchLimited) {
    info(
      `只读工具调用过多，本轮仅执行 ${executionPlan.executableToolCalls.length} 个，延后 ${executionPlan.deferredToolCalls.length} 个`,
    );
  }

  if (executionPlan.sameFileToolCallLimited) {
    info(
      `同一轮中同一文件的后续工具调用已延后，本轮执行 ${executionPlan.executableToolCalls.length} 个，延后 ${executionPlan.deferredToolCalls.length} 个`,
    );
  }

  if (executionPlan.duplicateReadOnlyToolCallsSkippedCount > 0) {
    info(
      `同一轮中重复的只读工具调用已合并，跳过 ${executionPlan.duplicateReadOnlyToolCallsSkippedCount} 个重复 read_file/list_dir`,
    );
  }

  for (const toolCall of executionPlan.executableToolCalls) {
    if (options.canContinue && !options.canContinue()) {
      return {
        status: 'interrupted',
        nextStepSequence,
        toolResults,
        executionRecords,
        batchWriteFiles,
        writeSuccessCount,
        writeFailCount,
        executedToolCalls: executionPlan.executableToolCalls,
        deferredToolCalls: executionPlan.deferredToolCalls,
        readOnlyBatchLimited: executionPlan.readOnlyBatchLimited,
        sameFileToolCallLimited: executionPlan.sameFileToolCallLimited,
        duplicateReadOnlyToolCallsSkippedCount: executionPlan.duplicateReadOnlyToolCallsSkippedCount,
      };
    }

    const stepId = `step-${options.messageId}-${nextStepSequence++}`;
    
    // 根据工具类型更新 loading 文本
    if (options.setLoadingText) {
      let loadingText = 'AI 正在执行工具...';
      switch (toolCall.type) {
        case 'read_file':
          loadingText = `AI 正在读取文件: ${toolCall.path || ''}`;
          break;
        case 'write_file':
          loadingText = `AI 正在写入文件: ${toolCall.path || ''}`;
          break;
        case 'edit_file':
          loadingText = `AI 正在编辑文件: ${toolCall.path || ''}`;
          break;
        case 'ast_edit':
          loadingText = `AI 正在重构代码: ${toolCall.path || ''}`;
          break;
        case 'run_command':
          loadingText = `AI 正在执行命令: ${toolCall.command?.substring(0, 50) || ''}${toolCall.command && toolCall.command.length > 50 ? '...' : ''}`;
          break;
        case 'list_dir':
          loadingText = `AI 正在浏览目录: ${toolCall.path || ''}`;
          break;
        default:
          loadingText = `AI 正在执行 ${toolCall.type}...`;
      }
      options.setLoadingText(loadingText);
    }
    
    options.postMessage({
      type: 'addStep',
      messageId: options.messageId,
      stepId,
      icon: getToolStepIcon(toolCall.type),
      description: getToolStepDescription(toolCall),
      status: 'running',
    });

    const startTime = Date.now();
    const isWriteOp = toolCall.type === 'write_file' || toolCall.type === 'edit_file' || toolCall.type === 'ast_edit';

    if (isWriteOp) {
      const writeResult = await executeWriteToolCall({
        toolCall,
        requestMode: options.requestMode,
        writeBackups: options.writeBackups,
        messageId: options.messageId,
        stepId,
        summaryId: options.summaryId,
        toDisplayPath: options.toDisplayPath,
        fileReadStateCache: options.fileReadStateCache,
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
        // AST 多文件修改（如 rename_symbol）产生的额外 diff 和汇总
        if (writeResult.additionalDiffs) {
          for (const diff of writeResult.additionalDiffs) {
            options.postMessage(diff);
          }
        }
        if (writeResult.additionalChangeSummaryEntries) {
          for (const entry of writeResult.additionalChangeSummaryEntries) {
            upsertChangeSummaryFile(batchWriteFiles, entry);
          }
        }
      } else {
        writeFailCount += 1;
        if (writeResult.changeSummaryEntry) {
          upsertChangeSummaryFile(batchWriteFiles, writeResult.changeSummaryEntry);
        }

        // edit_file 失败后自动重读文件，将最新内容注入错误反馈
        // 帮助模型在下一轮用正确的行号或内容重试
        if (toolCall.type === 'edit_file') {
          const autoReadPath = resolveAndValidatePath(toolCall.path!);
          if (autoReadPath && fs.existsSync(autoReadPath)) {
            try {
              const freshContent = fs.readFileSync(autoReadPath, 'utf-8');
              // 使用 addLineNumbers 给内容加行号，便于模型直接使用行号模式
              const numberedContent = addLineNumbers(freshContent);
              const AUTO_READ_MAX = 6000;
              const truncatedContent = numberedContent.length > AUTO_READ_MAX
                ? numberedContent.slice(0, AUTO_READ_MAX) + '\n...(已截断)'
                : numberedContent;
              singleResult.result.content += `\n\n[自动重读] 以下是 ${toolCall.path} 的当前内容（含行号），请基于这些行号使用行号模式重试编辑：\n${truncatedContent}`;

              // 同步更新 fileReadStateCache，避免"先读后编"校验在下一轮拒绝
              if (options.fileReadStateCache && autoReadPath) {
                options.fileReadStateCache.set(autoReadPath, {
                  content: freshContent,
                  timestamp: Date.now(),
                });
              }
              info(`edit_file 失败后自动重读: ${autoReadPath} (${freshContent.length} 字符)`);
            } catch (readErr) {
              info(`edit_file 失败后自动重读异常: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
            }
          }
        }
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
        description: singleResult.result.success
          ? undefined
          : buildWriteFailureStepDescription(toolCall, singleResult.result.content),
        elapsed: Date.now() - startTime,
      });
      continue;
    }

    const result = await executeToolCalls([toolCall], options.requestMode);
    const singleResult = result[0];

    // read_file 成功后：检测文件是否未变（返回 stub）+ 更新缓存 + 添加行号
    if (toolCall.type === 'read_file' && singleResult.result.success && options.fileReadStateCache) {
      const resolvedPath = resolveAndValidatePath(toolCall.path!);
      if (resolvedPath) {
        // 先检测是否可以返回 stub（比较新旧内容）
        const stubResult = buildReadFileStubIfUnchanged(resolvedPath, singleResult.result.content, options.fileReadStateCache);
        if (stubResult.useStub && stubResult.stubContent) {
          info(`文件未变，返回 stub: ${resolvedPath}`);
          singleResult.result.content = stubResult.stubContent;
        }

        // 用原始内容（无行号）更新缓存，保证与 validateFileReadState 中磁盘内容对比兼容
        options.fileReadStateCache.set(resolvedPath, {
          content: stubResult.useStub
            ? options.fileReadStateCache.get(resolvedPath)!.content
            : (singleResult.result.fullContentForCache ?? singleResult.result.content),
          timestamp: Date.now(),
        });

        // 缓存更新后，对返回给模型的内容添加行号（stub 消息不加行号）
        if (!stubResult.useStub) {
          const startLine = singleResult.result.readRangeStart ?? 1;
          singleResult.result.content = startLine > 1
            ? addLineNumbersFromStart(singleResult.result.content, startLine)
            : addLineNumbers(singleResult.result.content);
        }
      }
    } else if (toolCall.type === 'read_file' && singleResult.result.success) {
      const startLine = singleResult.result.readRangeStart ?? 1;
      singleResult.result.content = startLine > 1
        ? addLineNumbersFromStart(singleResult.result.content, startLine)
        : addLineNumbers(singleResult.result.content);
    }

    toolResults.push(singleResult);

    if (
      toolCall.type === 'run_command'
      && singleResult.result.success
      && options.fileReadStateCache
    ) {
      options.fileReadStateCache.clear();
      info('run_command 成功后已清空文件读取状态缓存');
    }

    executionRecords.push({
      toolCall,
      success: singleResult.result.success,
    });

    let completedDescription: string | undefined;
    if (toolCall.type === 'run_command') {
      completedDescription = buildRunCommandStepResultDescription(
        toolCall.command ?? '',
        singleResult.result.success,
        singleResult.result.content,
      );
    }

    options.postMessage({
      type: 'updateStep',
      stepId,
      status: singleResult.result.success ? 'done' : 'error',
      description: completedDescription,
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
    executedToolCalls: executionPlan.executableToolCalls,
    deferredToolCalls: executionPlan.deferredToolCalls,
    readOnlyBatchLimited: executionPlan.readOnlyBatchLimited,
    sameFileToolCallLimited: executionPlan.sameFileToolCallLimited,
    duplicateReadOnlyToolCallsSkippedCount: executionPlan.duplicateReadOnlyToolCallsSkippedCount,
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
