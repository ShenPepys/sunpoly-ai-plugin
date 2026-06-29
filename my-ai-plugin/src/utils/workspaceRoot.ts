/**
 * 多根工作区路径解析
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function normalizePathForCompare(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathWithinRoot(absPath: string, rootPath: string): boolean {
  const compareAbs = normalizePathForCompare(absPath);
  const compareRoot = normalizePathForCompare(rootPath);
  const rootPrefix = compareRoot.endsWith(path.sep) ? compareRoot : `${compareRoot}${path.sep}`;
  return compareAbs === compareRoot || compareAbs.startsWith(rootPrefix);
}

export function isPathWithinAnyWorkspaceFolder(
  absPath: string,
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): boolean {
  return folders.some((folder) => isPathWithinRoot(absPath, folder.uri.fsPath));
}

function normalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function stripWorkspaceFolderNamePrefix(
  relPath: string,
  folder: vscode.WorkspaceFolder,
): string {
  const normalizedRel = normalizeRelativePath(relPath);
  if (normalizedRel === folder.name) {
    return '.';
  }
  const prefix = `${folder.name}/`;
  if (normalizedRel.startsWith(prefix)) {
    return normalizedRel.slice(prefix.length);
  }
  return normalizedRel;
}

/**
 * 将相对路径解析为工作区内的绝对路径（基于匹配到的 workspace folder）
 */
export function resolvePathInWorkspaceFolder(
  relPath: string,
  folder: vscode.WorkspaceFolder,
): string {
  if (path.isAbsolute(relPath)) {
    return path.resolve(relPath);
  }

  const stripped = stripWorkspaceFolderNamePrefix(relPath, folder);
  return path.resolve(folder.uri.fsPath, stripped);
}

/**
 * 按相对/绝对路径匹配正确的 workspace folder（多根工作区不再固定 [0]）
 */
export function resolveWorkspaceFolderForPath(
  relPath: string,
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): vscode.WorkspaceFolder | undefined {
  if (!folders.length) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const normalizedRel = normalizeRelativePath(relPath);
  if (!normalizedRel || normalizedRel === '.') {
    return folders[0];
  }

  if (path.isAbsolute(relPath)) {
    const absolutePath = path.resolve(relPath);
    for (const folder of folders) {
      if (isPathWithinRoot(absolutePath, folder.uri.fsPath)) {
        return folder;
      }
    }
    return undefined;
  }

  for (const folder of folders) {
    if (normalizedRel === folder.name || normalizedRel.startsWith(`${folder.name}/`)) {
      return folder;
    }
  }

  const existingMatches: vscode.WorkspaceFolder[] = [];
  for (const folder of folders) {
    const candidate = resolvePathInWorkspaceFolder(relPath, folder);
    if (isPathWithinRoot(candidate, folder.uri.fsPath) && fs.existsSync(candidate)) {
      existingMatches.push(folder);
    }
  }
  if (existingMatches.length >= 1) {
    return existingMatches[0];
  }

  const containmentMatches: vscode.WorkspaceFolder[] = [];
  for (const folder of folders) {
    const candidate = resolvePathInWorkspaceFolder(relPath, folder);
    if (isPathWithinRoot(candidate, folder.uri.fsPath)) {
      containmentMatches.push(folder);
    }
  }
  if (containmentMatches.length === 1) {
    return containmentMatches[0];
  }

  return folders[0];
}

/**
 * 将绝对路径转为相对路径；多根时前缀 workspace folder 名称
 */
export function toWorkspaceRelativePath(
  absolutePath: string,
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): string {
  for (const folder of folders) {
    if (!isPathWithinRoot(absolutePath, folder.uri.fsPath)) {
      continue;
    }

    const rel = path.relative(folder.uri.fsPath, absolutePath).replace(/\\/g, '/');
    if (folders.length > 1) {
      return rel === '' || rel === '.' ? folder.name : `${folder.name}/${rel}`;
    }
    return rel;
  }

  return absolutePath;
}

export function getWorkspaceRootPaths(
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): string[] {
  return folders.map((folder) => folder.uri.fsPath);
}
