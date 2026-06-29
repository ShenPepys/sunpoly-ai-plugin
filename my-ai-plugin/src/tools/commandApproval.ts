/**
 * run_command 执行前用户确认
 */
import * as vscode from 'vscode';

export const COMMAND_DENIED_MESSAGE = '用户拒绝了命令执行';

const APPROVE_LABEL = '执行';

export type ConfirmRunCommandFn = (command: string) => Promise<boolean>;

async function defaultConfirmRunCommand(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    `AI 助手请求执行终端命令：\n\n${trimmed}`,
    { modal: true },
    APPROVE_LABEL,
  );
  return choice === APPROVE_LABEL;
}

let confirmRunCommandImpl: ConfirmRunCommandFn = defaultConfirmRunCommand;

export function setConfirmRunCommandForTesting(impl: ConfirmRunCommandFn | null): void {
  confirmRunCommandImpl = impl ?? defaultConfirmRunCommand;
}

export async function confirmRunCommand(command: string): Promise<boolean> {
  return confirmRunCommandImpl(command);
}
