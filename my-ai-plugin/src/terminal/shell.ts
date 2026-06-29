/**
 * Shell 路径检测：优先读取 VS Code terminal.integrated 配置，再回退到环境变量。
 */
import { userInfo } from 'node:os';
import * as vscode from 'vscode';

export const WINDOWS_POWERSHELL_7_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
export const WINDOWS_POWERSHELL_LEGACY_PATH =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const SHELL_PATHS = {
  POWERSHELL_7: WINDOWS_POWERSHELL_7_PATH,
  POWERSHELL_LEGACY: WINDOWS_POWERSHELL_LEGACY_PATH,
  CMD: 'C:\\Windows\\System32\\cmd.exe',
  WSL_BASH: '/bin/bash',
  GIT_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe',
  MAC_DEFAULT: '/bin/zsh',
  LINUX_DEFAULT: '/bin/bash',
  FALLBACK: '/bin/sh',
} as const;

interface WindowsTerminalProfile {
  path?: string;
  source?: 'PowerShell' | 'WSL';
}

type WindowsTerminalProfiles = Record<string, WindowsTerminalProfile>;

interface SimpleTerminalProfile {
  path?: string;
}

type SimpleTerminalProfiles = Record<string, SimpleTerminalProfile>;

function getWindowsTerminalConfig(): {
  defaultProfileName: string | null;
  profiles: WindowsTerminalProfiles;
} {
  try {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfileName = config.get<string>('defaultProfile.windows') ?? null;
    const profiles = config.get<WindowsTerminalProfiles>('profiles.windows') ?? {};
    return { defaultProfileName, profiles };
  } catch {
    return { defaultProfileName: null, profiles: {} };
  }
}

function getMacTerminalConfig(): {
  defaultProfileName: string | null;
  profiles: SimpleTerminalProfiles;
} {
  try {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfileName = config.get<string>('defaultProfile.osx') ?? null;
    const profiles = config.get<SimpleTerminalProfiles>('profiles.osx') ?? {};
    return { defaultProfileName, profiles };
  } catch {
    return { defaultProfileName: null, profiles: {} };
  }
}

function getLinuxTerminalConfig(): {
  defaultProfileName: string | null;
  profiles: SimpleTerminalProfiles;
} {
  try {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfileName = config.get<string>('defaultProfile.linux') ?? null;
    const profiles = config.get<SimpleTerminalProfiles>('profiles.linux') ?? {};
    return { defaultProfileName, profiles };
  } catch {
    return { defaultProfileName: null, profiles: {} };
  }
}

function getWindowsShellFromVSCode(): string | null {
  const { defaultProfileName, profiles } = getWindowsTerminalConfig();
  if (!defaultProfileName) {
    return null;
  }

  const profile = profiles[defaultProfileName];
  const lowerName = defaultProfileName.toLowerCase();

  if (lowerName.includes('powershell')) {
    if (profile?.path) {
      return profile.path;
    }
    if (profile?.source === 'PowerShell') {
      return SHELL_PATHS.POWERSHELL_7;
    }
    return SHELL_PATHS.POWERSHELL_LEGACY;
  }

  if (profile?.path) {
    return profile.path;
  }

  if (profile?.source === 'WSL' || lowerName.includes('wsl')) {
    return SHELL_PATHS.WSL_BASH;
  }

  return SHELL_PATHS.CMD;
}

function getMacShellFromVSCode(): string | null {
  const { defaultProfileName, profiles } = getMacTerminalConfig();
  if (!defaultProfileName) {
    return null;
  }
  return profiles[defaultProfileName]?.path ?? null;
}

function getLinuxShellFromVSCode(): string | null {
  const { defaultProfileName, profiles } = getLinuxTerminalConfig();
  if (!defaultProfileName) {
    return null;
  }
  return profiles[defaultProfileName]?.path ?? null;
}

function getShellFromUserInfo(): string | null {
  try {
    const { shell } = userInfo();
    return shell || null;
  } catch {
    return null;
  }
}

function getShellFromEnv(): string | null {
  const { env } = process;

  if (process.platform === 'win32') {
    return env.COMSPEC || SHELL_PATHS.CMD;
  }

  if (process.platform === 'darwin') {
    return env.SHELL || SHELL_PATHS.MAC_DEFAULT;
  }

  if (process.platform === 'linux') {
    return env.SHELL || SHELL_PATHS.LINUX_DEFAULT;
  }

  return null;
}

/** 获取当前平台应使用的 shell 可执行文件路径 */
export function getShell(): string {
  if (process.platform === 'win32') {
    const windowsShell = getWindowsShellFromVSCode();
    if (windowsShell) {
      return windowsShell;
    }
  } else if (process.platform === 'darwin') {
    const macShell = getMacShellFromVSCode();
    if (macShell) {
      return macShell;
    }
  } else if (process.platform === 'linux') {
    const linuxShell = getLinuxShellFromVSCode();
    if (linuxShell) {
      return linuxShell;
    }
  }

  const userInfoShell = getShellFromUserInfo();
  if (userInfoShell) {
    return userInfoShell;
  }

  const envShell = getShellFromEnv();
  if (envShell) {
    return envShell;
  }

  if (process.platform === 'win32') {
    return SHELL_PATHS.CMD;
  }

  return SHELL_PATHS.FALLBACK;
}
