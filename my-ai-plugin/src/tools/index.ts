/**
 * 工具系统入口
 * 统一导出文件操作、解析器、执行器
 */
export { readFile, writeFile, editFile, listDir, addLineNumbers, addLineNumbersFromStart } from './fileOps';
export type { FileOpResult } from './fileOps';
export { searchFile, grepCode } from './searchTools';
export type { SearchFileResult, GrepCodeResult, GrepMatch } from './searchTools';
export { execCommand } from './terminalExec';
export type { ExecCommandResult } from './terminalExec';
export { parseToolCalls, hasToolCalls, stripToolCalls, stripMalformedToolCallTail } from './toolParser';
export type { ParsedToolCall, ToolCallType } from './toolParser';
export { executeToolCalls, formatToolResults } from './toolExecutor';
export type { ToolExecutionResult } from './toolExecutor';
export {
  FileReadStateCache,
  validateFileReadState,
  buildReadFileStubIfUnchanged,
  buildReadFileStubIfFullyRead,
  updateFileReadCoverage,
} from './fileReadStateCache';
export type { FileReadState, FileReadStateValidation, ReadFileStubResult } from './fileReadStateCache';
export { getToolDef, getToolLabel, getToolIcon, isToolReadOnly, getToolStepText, getAllToolDefs } from './toolDefs';
export type { ToolDef } from './toolDefs';
export { getWorkspaceStats, formatWorkspaceStats } from './workspaceStats';
export type { WorkspaceStats, FileStats, DirStats } from './workspaceStats';
