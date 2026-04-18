/**
 * C# AST 适配器
 *
 * 通过子进程调用 Roslyn-based C# worker 实现对 .cs 文件的结构化编辑。
 * 前置条件：用户机器需安装 .NET SDK 6.0+。
 */
import { createSubprocessAdapter, resolveFromProjectRoot } from './astAdapter_subprocess';
import type { AstLanguageAdapter } from './astEditorTypes';

/** worker 项目相对于插件根目录的路径 */
const WORKER_PROJECT_RELATIVE = 'resources/ast_workers/csharp_ast_worker';

function getWorkerProjectPath(): string {
  return resolveFromProjectRoot(WORKER_PROJECT_RELATIVE);
}

export const csharpAdapter: AstLanguageAdapter = createSubprocessAdapter({
  id: 'csharp',
  extensions: ['cs'],
  getSpawnArgs: () => ({
    command: 'dotnet',
    args: ['run', '--project', getWorkerProjectPath()],
  }),
  checkCommand: () => ({
    command: 'dotnet',
    args: ['--version'],
    expectedOutput: '', // 任何非空输出都说明 dotnet 可用
  }),
});
