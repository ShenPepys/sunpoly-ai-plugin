/**
 * 日志管理模块
 * 使用 VS Code OutputChannel 输出日志，方便调试
 * 日志可在 VS Code "输出"面板 → 选择"AI 编程助手"频道查看
 */
import * as vscode from 'vscode';

/** 日志级别 */
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** 全局 OutputChannel 实例，插件激活时创建 */
let outputChannel: vscode.OutputChannel | null = null;

/**
 * 初始化日志模块
 * 必须在 extension.activate() 中调用
 */
export function initLogger(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('AI 编程助手');
  }
}

/**
 * 销毁日志模块
 * 在 extension.deactivate() 中调用
 */
export function disposeLogger(): void {
  outputChannel?.dispose();
  outputChannel = null;
}

/**
 * 写入一条日志
 * 格式：[时间] [级别] 消息
 */
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!outputChannel) {
    return;
  }

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extra = args.length > 0 ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  outputChannel.appendLine(`[${timestamp}] [${level}] ${message}${extra}`);
}

/** 调试日志 */
export function debug(message: string, ...args: unknown[]): void {
  log('DEBUG', message, ...args);
}

/** 信息日志 */
export function info(message: string, ...args: unknown[]): void {
  log('INFO', message, ...args);
}

/** 警告日志 */
export function warn(message: string, ...args: unknown[]): void {
  log('WARN', message, ...args);
}

/** 错误日志 */
export function error(message: string, ...args: unknown[]): void {
  log('ERROR', message, ...args);
}

/** 显示日志输出面板 */
export function show(): void {
  outputChannel?.show(true);
}
