import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getEditorContext } from '../utils/editor';
import type { AddContextFileResponse, ChatSessionDisplayMessage } from './messageTypes';

export type WorkspaceSearchFile = {
  filePath: string;
  fileName: string;
};

export type DiscoveredWorkflow = {
  name: string;
  description: string;
  filePath: string;
  promptContent: string;
  sideEffects: string[];
};

export type ContextFilePreview = {
  content: string;
  noticeText?: string;
  skipCodeBlock?: boolean;
};

export type PickContextFilesResult = {
  nextFilePaths: string[];
  addedMessages: AddContextFileResponse[];
};

function toWorkspaceDisplayPath(filePath: string, uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return filePath.split(/[\\/]/).pop() || filePath;
  }

  return filePath.replace(workspaceFolder.uri.fsPath, '').replace(/^[\\/]/, '');
}

export async function searchWorkspaceFiles(keyword: string): Promise<WorkspaceSearchFile[]> {
  const openFiles: WorkspaceSearchFile[] = [];
  const openPaths = new Set<string>();
  const lowerKeyword = keyword.toLowerCase();

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const tabInput = tab.input as { uri?: vscode.Uri } | undefined;
      if (!tabInput?.uri) {
        continue;
      }

      const filePath = tabInput.uri.fsPath;
      const displayName = toWorkspaceDisplayPath(filePath, tabInput.uri);
      if (keyword && !displayName.toLowerCase().includes(lowerKeyword)) {
        continue;
      }

      if (openPaths.has(filePath)) {
        continue;
      }

      openPaths.add(filePath);
      openFiles.push({
        filePath,
        fileName: `📌 ${displayName}`,
      });
    }
  }

  const pattern = keyword ? `**/*${keyword}*` : '**/*';
  const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**}';
  const uris = await vscode.workspace.findFiles(pattern, excludePattern, 20);

  const searchFiles = uris
    .filter(uri => !openPaths.has(uri.fsPath))
    .map(uri => ({
      filePath: uri.fsPath,
      fileName: toWorkspaceDisplayPath(uri.fsPath, uri),
    }));

  return [...openFiles, ...searchFiles].slice(0, 20);
}

export function discoverWorkflows(workspaceRoot?: string): DiscoveredWorkflow[] {
  if (!workspaceRoot) {
    return [];
  }

  const workflowsDir = path.join(workspaceRoot, '.windsurf', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(workflowsDir).filter(fileName => fileName.endsWith('.md'));
  } catch {
    return [];
  }

  return files.map(fileName => {
    const filePath = path.join(workflowsDir, fileName);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);

    let description = '';
    if (frontmatterMatch) {
      const descMatch = frontmatterMatch[1].match(/description:\s*(.+)/);
      if (descMatch) {
        description = descMatch[1].trim();
      }
    }

    const promptContent = frontmatterMatch
      ? raw.slice(frontmatterMatch[0].length).trim()
      : raw.trim();

    const lowerPrompt = promptContent.toLowerCase();
    const sideEffects: string[] = [];
    if (/write_file|edit_file|创建文件|修改文件/.test(lowerPrompt)) {
      sideEffects.push('可能修改文件');
    }
    if (/run_command|执行命令|运行命令/.test(lowerPrompt)) {
      sideEffects.push('可能执行命令');
    }

    return {
      name: path.basename(fileName, '.md').replace(/[-_]/g, ' '),
      description,
      filePath,
      promptContent,
      sideEffects,
    };
  });
}

export async function pickContextFiles(existingFilePaths: string[]): Promise<PickContextFilesResult> {
  const files = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFolders: false,
    openLabel: '添加为上下文',
    filters: {
      '所有文件': ['*'],
    },
  });

  if (!files || files.length === 0) {
    return {
      nextFilePaths: existingFilePaths,
      addedMessages: [],
    };
  }

  const knownPaths = new Set(existingFilePaths);
  const nextFilePaths = [...existingFilePaths];
  const addedMessages: AddContextFileResponse[] = [];
  for (const file of files) {
    const filePath = file.fsPath;
    if (knownPaths.has(filePath)) {
      continue;
    }

    knownPaths.add(filePath);
    nextFilePaths.push(filePath);
    addedMessages.push({
      type: 'addContextFile',
      filePath,
      fileName: filePath.split(/[\\/]/).pop() || filePath,
    });
  }

  return {
    nextFilePaths,
    addedMessages,
  };
}

export async function saveChatExportMarkdown(markdown: string): Promise<string | undefined> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`ai-chat-${Date.now()}.md`),
    filters: { 'Markdown': ['md'], '所有文件': ['*'] },
  });

  if (!uri) {
    return undefined;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf-8'));
  return uri.fsPath;
}

export function readContextFilePreview(filePath: string): ContextFilePreview {
  const maxBytes = 64 * 1024;
  const maxChars = 12000;

  if (!fs.existsSync(filePath)) {
    throw new Error('文件不存在，可能已被移动或删除');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`读取文件信息失败: ${errMsg}`);
  }

  if (stat.size === 0) {
    return { content: '' };
  }

  const bytesToRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fileDescriptor = fs.openSync(filePath, 'r');

  try {
    fs.readSync(fileDescriptor, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fileDescriptor);
  }

  if (buffer.includes(0)) {
    return {
      content: '',
      noticeText: '⚠️ 文件疑似为二进制内容，未注入上下文',
      skipCodeBlock: true,
    };
  }

  let content = buffer.toString('utf-8');
  const notices: string[] = [];

  if (stat.size > maxBytes) {
    notices.push(`⚠️ 文件过大，仅注入前 ${(maxBytes / 1024).toFixed(0)}KB`);
  }

  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    notices.push(`⚠️ 内容过长，仅注入前 ${maxChars} 个字符`);
  }

  if (notices.length > 0) {
    content += '\n...(已截断)';
  }

  return {
    content,
    noticeText: notices.length > 0 ? notices.join('；') : undefined,
  };
}

export function buildContextContent(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return '';
  }

  const sections: string[] = [];
  sections.push('## 用户引用的上下文文件\n');

  for (const filePath of filePaths) {
    try {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const preview = readContextFilePreview(filePath);
      const sectionLines: string[] = [`### ${fileName}`];

      if (preview.noticeText) {
        sectionLines.push(`> ${preview.noticeText}`);
      }

      if (!preview.skipCodeBlock) {
        sectionLines.push('```');
        sectionLines.push(preview.content);
        sectionLines.push('```');
      }

      sections.push(sectionLines.join('\n'));
    } catch (err) {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const errMsg = err instanceof Error ? err.message : String(err);
      sections.push(`### ${fileName}\n> ⚠️ 无法读取文件: ${errMsg}\n`);
    }
  }

  return sections.join('\n');
}

export function buildUserContentWithContext(baseContent: string, contextFilePaths: string[]): string {
  let userContent = baseContent;

  const editorCtx = getEditorContext();
  if (editorCtx && editorCtx.selectedCode) {
    userContent += `\n\n## 当前选中的代码\n- 文件：${editorCtx.fileName}\n- 语言：${editorCtx.fileLanguage}\n- 行号：第 ${editorCtx.startLine} 行 ~ 第 ${editorCtx.endLine} 行\n\n\`\`\`${editorCtx.fileLanguage}\n${editorCtx.selectedCode}\n\`\`\``;
  }

  const contextContent = buildContextContent(contextFilePaths);
  if (contextContent) {
    userContent += `\n\n${contextContent}`;
  }

  return userContent;
}

function formatExportTimestamp(timestamp?: number): string {
  if (!timestamp) {
    return '';
  }

  return `  \`${new Date(timestamp).toLocaleString('zh-CN', { hour12: false })}\``;
}

function buildProcessSummaryParts(message: ChatSessionDisplayMessage): string[] {
  if (!message.processSummary) {
    return [];
  }

  const summaryParts: string[] = [];
  if (message.processSummary.totalSteps > 0) {
    summaryParts.push(`已执行 ${message.processSummary.totalSteps} 步`);
  }
  if (message.processSummary.listCount > 0) {
    summaryParts.push(`列目录 ${message.processSummary.listCount}`);
  }
  if (message.processSummary.modifyCount > 0) {
    summaryParts.push(`修改 ${message.processSummary.modifyCount}`);
  }
  if (message.processSummary.createCount > 0) {
    summaryParts.push(`创建 ${message.processSummary.createCount}`);
  }
  if (message.processSummary.failedCount > 0) {
    summaryParts.push(`失败 ${message.processSummary.failedCount}`);
  }

  return summaryParts;
}

export function buildChatExportMarkdown(displayHistory: ChatSessionDisplayMessage[]): string {
  const lines: string[] = [];
  lines.push('# AI 对话记录');
  lines.push('');
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  for (const message of displayHistory) {
    const ts = formatExportTimestamp(message.timestamp);

    if (message.role === 'user') {
      lines.push(`## 🧑 用户${ts}`);
      lines.push('');
      lines.push(message.content);
    } else {
      lines.push(`## 🤖 AI${ts}`);
      lines.push('');
      lines.push(message.content);

      const summaryParts = buildProcessSummaryParts(message);
      if (summaryParts.length > 0) {
        lines.push('');
        lines.push(`> 过程摘要：${summaryParts.join(' · ')}`);
      }

      if (message.processSummary && message.processSummary.changedFiles.length > 0) {
        lines.push(`> 改动文件：${message.processSummary.changedFiles.join('、')}`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
