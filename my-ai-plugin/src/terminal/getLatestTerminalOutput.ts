import * as vscode from 'vscode';

type GetLatestTerminalOutputFn = () => Promise<string>;

async function defaultGetLatestTerminalOutput(): Promise<string> {
  const originalClipboard = await vscode.env.clipboard.readText();

  try {
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

    const terminalContents = (await vscode.env.clipboard.readText()).trim();
    if (terminalContents === originalClipboard.trim()) {
      return '';
    }

    return terminalContents;
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }
}

let getLatestTerminalOutputImpl: GetLatestTerminalOutputFn = defaultGetLatestTerminalOutput;

export function setGetLatestTerminalOutputForTesting(
  impl: GetLatestTerminalOutputFn | null,
): void {
  getLatestTerminalOutputImpl = impl ?? defaultGetLatestTerminalOutput;
}

/** 通过剪贴板获取当前活动终端内容（Shell Integration 不可用时的 fallback） */
export async function getLatestTerminalOutput(): Promise<string> {
  return getLatestTerminalOutputImpl();
}
