import * as fs from 'fs';
import * as path from 'path';
import { FileSystemRefreshResult, Project, ts, type SourceFile } from 'ts-morph';
import { error, info } from '../logger';

type AstProjectEntry = {
  workspaceRoot: string;
  normalizedWorkspaceRoot: string;
  project: Project;
  tsConfigPath?: string;
};

const astProjects = new Map<string, AstProjectEntry>();

function normalizePathForCompare(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  if (process.platform === 'win32') {
    return resolvedPath.toLowerCase();
  }
  return resolvedPath;
}

function buildWorkspacePrefix(normalizedWorkspaceRoot: string): string {
  if (normalizedWorkspaceRoot.endsWith(path.sep)) {
    return normalizedWorkspaceRoot;
  }
  return normalizedWorkspaceRoot + path.sep;
}

function isFileInsideWorkspace(filePath: string, workspaceRoot: string): boolean {
  const normalizedFilePath = normalizePathForCompare(filePath);
  const normalizedWorkspaceRoot = normalizePathForCompare(workspaceRoot);
  if (normalizedFilePath === normalizedWorkspaceRoot) {
    return true;
  }
  return normalizedFilePath.startsWith(buildWorkspacePrefix(normalizedWorkspaceRoot));
}

function resolveTsConfigPath(workspaceRoot: string): string | undefined {
  const candidateNames = ['tsconfig.json', 'jsconfig.json'];
  for (const candidateName of candidateNames) {
    const candidatePath = path.join(workspaceRoot, candidateName);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

function buildDefaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2021,
  };
}

function createProject(workspaceRoot: string): AstProjectEntry {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedWorkspaceRoot = normalizePathForCompare(resolvedWorkspaceRoot);
  const tsConfigPath = resolveTsConfigPath(resolvedWorkspaceRoot);

  const project = tsConfigPath
    ? new Project({
        tsConfigFilePath: tsConfigPath,
      })
    : new Project({
        compilerOptions: buildDefaultCompilerOptions(),
      });

  const entry: AstProjectEntry = {
    workspaceRoot: resolvedWorkspaceRoot,
    normalizedWorkspaceRoot,
    project,
    tsConfigPath,
  };

  info(
    'AST Project 已初始化',
    resolvedWorkspaceRoot,
    tsConfigPath ? `使用配置: ${tsConfigPath}` : '使用默认编译配置',
  );

  return entry;
}

function findProjectEntryByFilePath(filePath: string): AstProjectEntry | undefined {
  const resolvedFilePath = path.resolve(filePath);
  const matchedEntries = [...astProjects.values()].filter((entry) => {
    return isFileInsideWorkspace(resolvedFilePath, entry.workspaceRoot);
  });

  if (matchedEntries.length === 0) {
    return undefined;
  }

  matchedEntries.sort((left, right) => {
    return right.normalizedWorkspaceRoot.length - left.normalizedWorkspaceRoot.length;
  });

  return matchedEntries[0];
}

function loadSourceFileIfNeeded(entry: AstProjectEntry, filePath: string): SourceFile | undefined {
  const resolvedFilePath = path.resolve(filePath);
  const existingSourceFile = entry.project.getSourceFile(resolvedFilePath);
  if (existingSourceFile) {
    return existingSourceFile;
  }

  if (!fs.existsSync(resolvedFilePath)) {
    return undefined;
  }

  return entry.project.addSourceFileAtPathIfExists(resolvedFilePath);
}

function clearProject(entry: AstProjectEntry): void {
  const sourceFiles = entry.project.getSourceFiles();
  for (const sourceFile of sourceFiles) {
    entry.project.removeSourceFile(sourceFile);
  }
}

export function getOrCreateProject(workspaceRoot: string): Project {
  const normalizedWorkspaceRoot = normalizePathForCompare(workspaceRoot);
  const existingEntry = astProjects.get(normalizedWorkspaceRoot);
  if (existingEntry) {
    return existingEntry.project;
  }

  const entry = createProject(workspaceRoot);
  astProjects.set(entry.normalizedWorkspaceRoot, entry);
  return entry.project;
}

export function getSourceFile(filePath: string): SourceFile | undefined {
  const entry = findProjectEntryByFilePath(filePath);
  if (!entry) {
    return undefined;
  }

  return loadSourceFileIfNeeded(entry, filePath);
}

export function refreshSourceFile(filePath: string): SourceFile {
  const entry = findProjectEntryByFilePath(filePath);
  if (!entry) {
    throw new Error(`找不到文件对应的 AST Project，请先初始化工作区：${filePath}`);
  }

  const sourceFile = loadSourceFileIfNeeded(entry, filePath);
  if (!sourceFile) {
    throw new Error(`文件不存在，无法刷新 AST SourceFile：${filePath}`);
  }

  const refreshResult = sourceFile.refreshFromFileSystemSync();
  if (refreshResult === FileSystemRefreshResult.Deleted) {
    entry.project.removeSourceFile(sourceFile);
    throw new Error(`文件已从磁盘删除，无法刷新 AST SourceFile：${filePath}`);
  }

  return sourceFile;
}

export function disposeProject(workspaceRoot?: string): void {
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = normalizePathForCompare(workspaceRoot);
    const entry = astProjects.get(normalizedWorkspaceRoot);
    if (!entry) {
      return;
    }

    clearProject(entry);
    astProjects.delete(normalizedWorkspaceRoot);
    info('AST Project 已释放', entry.workspaceRoot);
    return;
  }

  for (const entry of astProjects.values()) {
    try {
      clearProject(entry);
      info('AST Project 已释放', entry.workspaceRoot);
    } catch (disposeError) {
      error('释放 AST Project 失败', entry.workspaceRoot, disposeError);
    }
  }

  astProjects.clear();
}
