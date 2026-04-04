/**
 * 编辑器交互工具函数
 * 负责从 VS Code 编辑器中获取选中代码、文件信息、诊断信息等
 */
import * as vscode from 'vscode';
import type { EditorContext } from '../prompts/types';

/**
 * 获取当前编辑器上下文
 * 包括选中代码、文件路径、语言等信息
 * 如果没有活动编辑器，返回 null
 */
export function getEditorContext(): EditorContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const document = editor.document;
  const selection = editor.selection;

  // 获取选中代码，如果未选中则取整个文件内容
  const selectedCode = selection.isEmpty
    ? document.getText()
    : document.getText(selection);

  // 行号从 0-indexed 转换为 1-indexed，更符合人类阅读习惯
  const startLine = selection.isEmpty ? 1 : selection.start.line + 1;
  const endLine = selection.isEmpty ? document.lineCount : selection.end.line + 1;

  return {
    selectedCode,
    filePath: document.uri.fsPath,
    fileName: document.uri.fsPath.split(/[/\\]/).pop() ?? '',
    fileLanguage: document.languageId,
    startLine,
    endLine,
  };
}

/**
 * 获取当前文件的诊断信息（错误和警告）
 * 用于 Bug 修复场景，帮助 AI 理解代码问题
 */
export function getDiagnostics(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return '';
  }

  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  if (diagnostics.length === 0) {
    return '';
  }

  // 只取错误和警告级别的诊断，忽略提示和信息
  const relevantDiagnostics = diagnostics.filter(
    d => d.severity === vscode.DiagnosticSeverity.Error ||
         d.severity === vscode.DiagnosticSeverity.Warning
  );

  if (relevantDiagnostics.length === 0) {
    return '';
  }

  const lines = relevantDiagnostics.map(d => {
    const level = d.severity === vscode.DiagnosticSeverity.Error ? '错误' : '警告';
    const line = d.range.start.line + 1;
    return `[${level}] 第${line}行: ${d.message} (${d.source ?? '未知来源'})`;
  });

  return lines.join('\n');
}

/**
 * 获取光标周围的代码上下文
 * 用于代码续写场景，提供光标前后的代码作为上下文
 * @param beforeLines 光标前取多少行，默认 80
 * @param afterLines 光标后取多少行，默认 20
 */
export function getCursorContext(beforeLines = 80, afterLines = 20): {
  before: string;
  after: string;
  cursorLine: number;
} | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const document = editor.document;
  const cursorLine = editor.selection.active.line;
  const totalLines = document.lineCount;

  // 计算取值范围，确保不越界
  const startLine = Math.max(0, cursorLine - beforeLines);
  const endLine = Math.min(totalLines, cursorLine + afterLines);

  const beforeRange = new vscode.Range(startLine, 0, cursorLine, 0);
  const afterRange = new vscode.Range(
    cursorLine, editor.selection.active.character,
    endLine, 0
  );

  return {
    before: document.getText(beforeRange),
    after: document.getText(afterRange),
    cursorLine: cursorLine + 1,
  };
}
