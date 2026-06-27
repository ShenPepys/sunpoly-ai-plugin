/**
 * 工具执行反馈构建模块
 *
 * 负责将工具执行结果（读文件、写文件、列目录等）格式化为模型可理解的反馈文本，
 * 以及写失败后的可恢复/不可恢复状态判定。
 *
 * 从 ChatViewProvider_requestExecution.ts 中提取，职责单一：
 * - 写失败状态分析（resolveWriteFailureFollowUpState）
 * - 工具结果摘要构建（buildToolFeedback）
 */
import type { ParsedToolCall, ToolExecutionResult } from '../tools';

const MAX_TOOL_RESULT_SNIPPET_CHARS = 1600;
const MAX_DIRECTORY_ENTRIES_IN_FEEDBACK = 40;
const MAX_DEFERRED_TOOL_CALLS_IN_FEEDBACK = 12;

export const MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS = 2;

export type WriteFailureFollowUpState = {
  writeFailCount: number;
  recoverableWriteFailCount: number;
  fatalWriteFailCount: number;
  canContinueAfterWriteFailures: boolean;
  nextRecoverableWriteFailRounds: number;
  remainingRecoverableWriteFailureFollowUpRounds: number;
  reachedRetryLimit: boolean;
};

function isWriteToolCallType(type: ParsedToolCall['type']): boolean {
  return type === 'write_file' || type === 'edit_file' || type === 'ast_edit';
}

export function isRecoverableWriteFailureResult(result: ToolExecutionResult): boolean {
  if (!isWriteToolCallType(result.toolCall.type) || result.result.success) {
    return false;
  }

  const failureText = result.result.content || '';
  if (/当前处于\s+(Ask|Plan)\s+模式/i.test(failureText)) {
    return false;
  }

  if (/AST 编辑成功但写入文件失败/.test(failureText)) {
    return false;
  }

  if (/写入文件失败:|编辑文件失败:/.test(failureText)) {
    return false;
  }

  if (/无法写入文件:/.test(failureText)) {
    return false;
  }

  if (result.toolCall.type === 'write_file') {
    return /目标文件已存在|请先读取当前文件并改用 edit_file/.test(failureText);
  }

  return true;
}

export function resolveWriteFailureFollowUpState(options: {
  toolResults: ToolExecutionResult[];
  recoverableWriteFailRounds: number;
}): WriteFailureFollowUpState {
  const failedWriteResults = options.toolResults.filter(result => {
    return isWriteToolCallType(result.toolCall.type) && !result.result.success;
  });

  const recoverableWriteFailCount = failedWriteResults.filter(isRecoverableWriteFailureResult).length;
  const fatalWriteFailCount = failedWriteResults.length - recoverableWriteFailCount;
  if (failedWriteResults.length === 0) {
    return {
      writeFailCount: 0,
      recoverableWriteFailCount: 0,
      fatalWriteFailCount: 0,
      canContinueAfterWriteFailures: false,
      nextRecoverableWriteFailRounds: options.recoverableWriteFailRounds,
      remainingRecoverableWriteFailureFollowUpRounds: Math.max(0, MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS - options.recoverableWriteFailRounds),
      reachedRetryLimit: false,
    };
  }

  if (fatalWriteFailCount > 0) {
    return {
      writeFailCount: failedWriteResults.length,
      recoverableWriteFailCount,
      fatalWriteFailCount,
      canContinueAfterWriteFailures: false,
      nextRecoverableWriteFailRounds: options.recoverableWriteFailRounds,
      remainingRecoverableWriteFailureFollowUpRounds: Math.max(0, MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS - options.recoverableWriteFailRounds),
      reachedRetryLimit: false,
    };
  }

  if (options.recoverableWriteFailRounds >= MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS) {
    return {
      writeFailCount: failedWriteResults.length,
      recoverableWriteFailCount,
      fatalWriteFailCount: 0,
      canContinueAfterWriteFailures: false,
      nextRecoverableWriteFailRounds: options.recoverableWriteFailRounds,
      remainingRecoverableWriteFailureFollowUpRounds: 0,
      reachedRetryLimit: true,
    };
  }

  const nextRecoverableWriteFailRounds = options.recoverableWriteFailRounds + 1;
  return {
    writeFailCount: failedWriteResults.length,
    recoverableWriteFailCount,
    fatalWriteFailCount: 0,
    canContinueAfterWriteFailures: true,
    nextRecoverableWriteFailRounds,
    remainingRecoverableWriteFailureFollowUpRounds: Math.max(0, MAX_RECOVERABLE_WRITE_FAILURE_FOLLOW_UP_ROUNDS - nextRecoverableWriteFailRounds),
    reachedRetryLimit: false,
  };
}

function truncateFeedbackText(content: string, maxChars: number, suffix: string): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n${suffix}`;
}

function buildReadResultSummary(result: ToolExecutionResult): string {
  const content = result.result.content || '';
  const lineCount = content ? content.split(/\r?\n/).length : 0;
  const snippet = truncateFeedbackText(
    content,
    MAX_TOOL_RESULT_SNIPPET_CHARS,
    `...(内容已压缩，原始返回 ${content.length} 字符，如仍需细读请继续读取该文件)`,
  );

  return [
    `### 读取文件 ${result.toolCall.path}`,
    `- 状态：${result.result.success ? '成功' : '失败'}`,
    `- 估计行数：${lineCount}`,
    '- 关键信息片段：',
    '```',
    snippet,
    '```',
  ].join('\n');
}

function buildListResultSummary(result: ToolExecutionResult): string {
  const lines = (result.result.content || '').split(/\r?\n/).filter(Boolean);
  const directoryCount = lines.filter(line => line.startsWith('[DIR]')).length;
  const fileCount = lines.filter(line => line.startsWith('[FILE]')).length;
  const visibleLines = lines.slice(0, MAX_DIRECTORY_ENTRIES_IN_FEEDBACK);
  const suffix = lines.length > visibleLines.length
    ? `...(目录项已压缩，原始共 ${lines.length} 项)`
    : '';

  return [
    `### 目录列表 ${result.toolCall.path}`,
    `- 状态：${result.result.success ? '成功' : '失败'}`,
    `- 条目统计：目录 ${directoryCount}，文件 ${fileCount}，合计 ${lines.length}`,
    '- 条目摘要：',
    '```',
    visibleLines.join('\n') || '(空目录)',
    suffix,
    '```',
  ].join('\n');
}

function buildWriteResultSummary(result: ToolExecutionResult): string {
  const content = truncateFeedbackText(
    result.result.content || '',
    500,
    '...(结果已压缩)',
  );

  const sections = [
    `### ${result.toolCall.type} ${result.toolCall.path}`,
    `- 状态：${result.result.success ? '成功' : '失败'}`,
    '- 结果：',
    '```',
    content,
    '```',
  ];

  // 附加 LSP 诊断摘要（如果有）
  if (result.result.diagnosticsSummary) {
    sections.push(result.result.diagnosticsSummary);
  }

  return sections.join('\n');
}

function buildSingleToolResultSummary(result: ToolExecutionResult): string {
  if (result.toolCall.type === 'read_file') {
    return buildReadResultSummary(result);
  }

  if (result.toolCall.type === 'list_dir') {
    return buildListResultSummary(result);
  }

  return buildWriteResultSummary(result);
}

function buildDeferredToolCallsSummary(toolCalls: ParsedToolCall[]): string {
  if (toolCalls.length === 0) {
    return '';
  }

  const visibleToolCalls = toolCalls.slice(0, MAX_DEFERRED_TOOL_CALLS_IN_FEEDBACK);
  const lines = visibleToolCalls.map(toolCall => `- ${toolCall.type} ${toolCall.path}`);

  if (toolCalls.length > visibleToolCalls.length) {
    lines.push(`- ...(其余 ${toolCalls.length - visibleToolCalls.length} 个待执行工具已省略)`);
  }

  return [
    '## 待执行工具（上一轮计划但本轮未执行）',
    ...lines,
  ].join('\n');
}

export function buildToolFeedback(options: {
  toolResults: ToolExecutionResult[];
  deferredToolCalls: ParsedToolCall[];
  readOnlyBatchLimited: boolean;
  sameFileToolCallLimited: boolean;
  duplicateReadOnlyToolCallsSkippedCount: number;
  recoverableWriteFailCount: number;
  remainingRecoverableWriteFailureFollowUpRounds: number;
}): string {
  const sections: string[] = [
    '以下是本轮工具执行后的阶段摘要。不要原样复述这些结果，请基于它们继续分析并决定下一步。',
  ];

  if (options.readOnlyBatchLimited) {
    sections.push(
      `为了避免本地模型上下文过长，本轮只执行了少量只读工具调用，仍有 ${options.deferredToolCalls.length} 个待读取项被延后。请先基于当前结果给出阶段判断，再继续读取下一批最关键的 1~3 个文件或目录，不要一次请求过多 read_file / list_dir。`,
    );
  }

  if (options.sameFileToolCallLimited) {
    sections.push(
      '同一轮中对同一文件的后续工具调用已被自动延后，避免基于旧内容连续修改同一文件。请先基于本轮已成功落盘的结果重新读取该文件，再决定下一步，不要在同一条回复里连续修改同一个文件。',
    );
  }

  if (options.duplicateReadOnlyToolCallsSkippedCount > 0) {
    sections.push(
      `同一轮中重复的只读工具调用已经被系统自动合并，跳过了 ${options.duplicateReadOnlyToolCallsSkippedCount} 个重复 read_file / list_dir。不要在同一条回复里重复读取同一个文件或目录。`,
    );
  }

  if (options.recoverableWriteFailCount > 0) {
    const followUpHint = options.remainingRecoverableWriteFailureFollowUpRounds > 0
      ? `当前还剩 ${options.remainingRecoverableWriteFailureFollowUpRounds} 次恢复续轮机会。`
      : '当前已经用完恢复续轮额度；如果下一轮写操作仍失败，系统将停止本次自动续轮。';
    sections.push(
      `本轮有 ${options.recoverableWriteFailCount} 个可恢复的写失败，系统允许继续续轮自动修正。请优先基于失败结果里的真实文件内容、自动重读片段或降级提示修正，不要盲目重复相同参数。${followUpHint}`,
    );
  }

  sections.push('## 本轮执行结果');
  sections.push(
    options.toolResults.map(result => buildSingleToolResultSummary(result)).join('\n\n'),
  );

  if (options.deferredToolCalls.length > 0) {
    sections.push(buildDeferredToolCallsSummary(options.deferredToolCalls));
    sections.push('如果信息仍然不足，请继续读取最关键的下一批文件；如果已经足够答案，请给出最终结论。');
  }

  return sections.filter(Boolean).join('\n\n');
}
