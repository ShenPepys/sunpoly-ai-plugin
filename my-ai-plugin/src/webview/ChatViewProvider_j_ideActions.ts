import * as path from 'path';
import * as vscode from 'vscode';
import { error, info } from '../logger';
import { buildErrorAnalysisPrompt, readErrorFromClipboard } from '../terminal/terminalCapture';
import type { DiscoveredWorkflow } from './ChatViewProvider_e_workspaceContext';

export async function buildTerminalErrorAnalysisPrompt(): Promise<string | null> {
  const errorText = await readErrorFromClipboard();
  if (!errorText) {
    vscode.window.showInformationMessage(
      '剪贴板为空。请先在终端中选中错误文本并复制 (Ctrl+C)，然后再点击此按鈕。'
    );
    return null;
  }

  info('分析终端错误，剪贴板内容长度:', errorText.length);
  return buildErrorAnalysisPrompt(errorText);
}

export async function openFilesInIde(
  files: Array<{ path: string; status: 'created' | 'modified' | 'read' | 'listed' }>,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  for (const file of files) {
    if (file.status !== 'created' && file.status !== 'modified') {
      continue;
    }

    const absolutePath = path.isAbsolute(file.path)
      ? file.path
      : path.join(workspaceRoot, file.path);

    const uri = vscode.Uri.file(absolutePath);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    } catch (err) {
      error('openFilesInIde 打开文件失败:', absolutePath, err);
      vscode.window.showErrorMessage(`无法打开文件：${absolutePath}`);
    }
  }
}

export async function selectWorkflowToRun(
  workflows: DiscoveredWorkflow[],
): Promise<{ label: string; promptContent: string } | null> {
  if (workflows.length === 0) {
    vscode.window.showInformationMessage(
      '当前工作区没有可用的工作流。\n请在 <工作区根>/.windsurf/workflows/ 目录下创建 .md 文件。'
    );
    return null;
  }

  const items = workflows.map(workflow => ({
    label: workflow.name,
    description: workflow.description || '无说明',
    detail: workflow.sideEffects.length > 0
      ? `副作用：${workflow.sideEffects.join('、')}`
      : '无文件修改 / 命令执行',
    promptContent: workflow.promptContent,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要运行的工作流',
    matchOnDescription: true,
    matchOnDetail: false,
  });

  if (!selected) {
    return null;
  }

  const confirmLabel = '运行此工作流';
  const sideEffectMessage = selected.detail !== '无文件修改 / 命令执行'
    ? `\n注意：${selected.detail}`
    : '';
  const confirm = await vscode.window.showWarningMessage(
    `将运行「${selected.label}」${sideEffectMessage}`,
    { modal: true },
    confirmLabel,
  );

  if (confirm !== confirmLabel) {
    return null;
  }

  return {
    label: selected.label,
    promptContent: selected.promptContent,
  };
}

export function insertCodeToEditor(code: string): boolean {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('没有打开的编辑器，无法插入代码');
    return false;
  }

  editor.edit(editBuilder => {
    if (editor.selection.isEmpty) {
      editBuilder.insert(editor.selection.active, code);
    } else {
      editBuilder.replace(editor.selection, code);
    }
  });

  vscode.window.showInformationMessage('代码已插入到编辑器');
  return true;
}
