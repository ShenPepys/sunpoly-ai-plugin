/**
 * LSP 诊断收集
 *
 * 在 edit_file / write_file / ast_edit 成功后，等待 VS Code 语言服务器处理完成，
 * 然后收集 Error / Warning 级别的诊断信息，反馈给模型用于自动修正。
 *
 * 设计要点：
 * - 等待时间可配置（默认 800ms），给 LSP 足够时间处理
 * - 只收集 Error 和 Warning，忽略 Information 和 Hint
 * - 诊断数量限制在 8 条以内，避免占用过多模型上下文
 * - 返回结构化的纯文本摘要，直接拼入工具反馈
 */
import * as vscode from 'vscode';
import { info } from '../logger';

// ==================== 类型定义 ====================

/** 单条诊断的简化表示 */
export interface DiagnosticEntry {
  /** 行号（1-indexed） */
  line: number;
  /** 严重程度文字标签 */
  severity: 'Error' | 'Warning';
  /** 诊断消息 */
  message: string;
  /** 来源（如 typescript、eslint） */
  source?: string;
}

/** 诊断收集结果 */
export interface DiagnosticsResult {
  /** 收集到的诊断条目 */
  entries: DiagnosticEntry[];
  /** 格式化后的摘要文本，可直接拼入模型反馈 */
  summary: string;
  /** 是否有 Error 级别的诊断 */
  hasErrors: boolean;
}

// ==================== 配置 ====================

/** 等待 LSP 处理的默认时间（毫秒） */
const DEFAULT_WAIT_MS = 800;

/** 最大收集诊断条数 */
const MAX_DIAGNOSTIC_ENTRIES = 8;

// ==================== 核心函数 ====================

/**
 * 等待指定毫秒数
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 将 VS Code DiagnosticSeverity 转为可读标签
 */
function severityToLabel(severity: vscode.DiagnosticSeverity): 'Error' | 'Warning' | 'Info' | 'Hint' {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'Error';
    case vscode.DiagnosticSeverity.Warning: return 'Warning';
    case vscode.DiagnosticSeverity.Information: return 'Info';
    case vscode.DiagnosticSeverity.Hint: return 'Hint';
    default: return 'Info';
  }
}

/**
 * 收集指定文件的 LSP 诊断信息。
 *
 * 在文件修改后调用，会先等待一段时间让 LSP 处理变更，
 * 然后收集 Error 和 Warning 级别的诊断。
 *
 * @param filePath 修改后的文件绝对路径
 * @param waitMs 等待 LSP 处理的时间（毫秒），默认 800ms
 * @returns 诊断结果，包含条目列表和格式化摘要
 */
export async function collectDiagnosticsAfterEdit(
  filePath: string,
  waitMs: number = DEFAULT_WAIT_MS,
): Promise<DiagnosticsResult> {
  const emptyResult: DiagnosticsResult = {
    entries: [],
    summary: '',
    hasErrors: false,
  };

  try {
    const fileUri = vscode.Uri.file(filePath);

    // 等待 LSP 处理文件变更
    await delay(waitMs);

    // 获取该文件的所有诊断
    const allDiagnostics = vscode.languages.getDiagnostics(fileUri);

    // 只保留 Error 和 Warning
    const relevantDiagnostics = allDiagnostics.filter(
      d => d.severity === vscode.DiagnosticSeverity.Error ||
           d.severity === vscode.DiagnosticSeverity.Warning,
    );

    if (relevantDiagnostics.length === 0) {
      return emptyResult;
    }

    // 按严重程度排序：Error 在前，Warning 在后
    relevantDiagnostics.sort((a, b) => a.severity - b.severity);

    // 限制条数
    const limitedDiagnostics = relevantDiagnostics.slice(0, MAX_DIAGNOSTIC_ENTRIES);
    const truncated = relevantDiagnostics.length > MAX_DIAGNOSTIC_ENTRIES;

    // 转为简化条目
    const entries: DiagnosticEntry[] = limitedDiagnostics.map(d => ({
      line: d.range.start.line + 1, // VS Code 诊断行号 0-indexed → 1-indexed
      severity: severityToLabel(d.severity) as 'Error' | 'Warning',
      message: d.message,
      source: d.source,
    }));

    const hasErrors = entries.some(e => e.severity === 'Error');

    // 构建摘要文本
    const lines: string[] = [
      `⚠️ 编辑后 LSP 诊断（${hasErrors ? '含错误' : '仅警告'}）：`,
    ];
    for (const entry of entries) {
      const sourceTag = entry.source ? ` [${entry.source}]` : '';
      lines.push(`  - 第 ${entry.line} 行 ${entry.severity}${sourceTag}: ${entry.message}`);
    }
    if (truncated) {
      lines.push(`  ...还有 ${relevantDiagnostics.length - MAX_DIAGNOSTIC_ENTRIES} 条诊断被省略`);
    }
    if (hasErrors) {
      lines.push('请检查以上错误并修复。');
    }

    const summary = lines.join('\n');
    info(`文件 ${filePath} 编辑后检测到 ${entries.length} 条诊断（${hasErrors ? '含错误' : '仅警告'}）`);

    return { entries, summary, hasErrors };
  } catch (err) {
    // 诊断收集失败不应阻塞主流程
    info(`LSP 诊断收集异常: ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

/**
 * 构建诊断摘要文本，适用于直接附加到工具反馈中。
 * 如果没有诊断则返回空字符串。
 */
export function buildDiagnosticsFeedback(diagnosticsResult: DiagnosticsResult | undefined): string {
  if (!diagnosticsResult || diagnosticsResult.entries.length === 0) {
    return '';
  }
  return diagnosticsResult.summary;
}
