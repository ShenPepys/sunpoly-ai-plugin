/**
 * 终端执行模块入口（P0 起逐步替换 terminalExec 底层实现）。
 */
export {
  getShell,
  WINDOWS_POWERSHELL_7_PATH,
  WINDOWS_POWERSHELL_LEGACY_PATH,
} from './shell';
export {
  getWindowsPowerShellCandidates,
  getFallbackWindowsPowerShellPath,
  probeWindowsExecutable,
  resolveWindowsPowerShellExecutable,
  resetPowerShellResolverCacheForTesting,
  setPowerShellProbeForTesting,
} from './powershell';
export {
  SHELL_INTEGRATION_WAIT_TIMEOUT_MS,
  SHELL_INTEGRATION_STREAM_TIMEOUT_MS,
  NO_SHELL_INTEGRATION_WAIT_MS,
} from './constants';
export { getLatestTerminalOutput, setGetLatestTerminalOutputForTesting } from './getLatestTerminalOutput';
export { TerminalRegistry } from './vscodeTerminalRegistry';
export type { TerminalInfo } from './vscodeTerminalRegistry';
export {
  VscodeTerminalProcess,
  mergePromise,
} from './vscodeTerminalProcess';
export type { TerminalProcessResultPromise, TerminalCompletionDetails } from './vscodeTerminalProcess';
export { VscodeTerminalManager } from './vscodeTerminalManager';
