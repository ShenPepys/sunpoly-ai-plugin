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
