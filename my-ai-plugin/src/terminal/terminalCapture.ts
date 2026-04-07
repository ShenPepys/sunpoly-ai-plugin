/**
 * 终端错误分析辅助模块
 *
 * 采用剪贴板方案：用户在终端中选中并复制错误文本后，
 * 插件从剪贴板读取内容并发送给 AI 分析。
 *
 * 之所以不使用 onDidWriteTerminalData，是因为该 API 在
 * VS Code 1.85（项目目标版本）的 @types/vscode 中尚未稳定，
 * 剪贴板方案兼容所有版本且工作流简单明确。
 */

import * as vscode from 'vscode';

/**
 * 从剪贴板读取终端错误内容
 *
 * @returns 如果剪贴板有内容则返回文本，否则返回 null
 */
export async function readErrorFromClipboard(): Promise<string | null> {
  const text = await vscode.env.clipboard.readText();
  const trimmed = text.trim();
  if (!trimmed) { return null; }
  return trimmed;
}

/**
 * 将原始错误文本包装为发送给 AI 的提示消息
 *
 * 包含：请求分析原因 + 修复建议 + 代码块格式的错误内容
 * @param errorText 从剪贴板或其他来源获取的错误文本
 */
export function buildErrorAnalysisPrompt(errorText: string): string {
  return `请分析以下终端错误，说明根本原因并给出具体的修复方案：\n\n\`\`\`\n${errorText}\n\`\`\``;
}
