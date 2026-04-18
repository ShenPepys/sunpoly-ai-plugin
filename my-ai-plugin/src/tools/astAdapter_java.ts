/**
 * Java AST 适配器
 *
 * 通过子进程调用 javaparser-based Java worker 实现对 .java 文件的结构化编辑。
 * 前置条件：用户机器需安装 JDK 11+，worker fat jar 需预先构建。
 */
import { createSubprocessAdapter, resolveFromProjectRoot } from './astAdapter_subprocess';
import type { AstLanguageAdapter } from './astEditorTypes';

/** fat jar 相对于插件根目录的路径 */
const WORKER_JAR_RELATIVE = 'resources/ast_workers/java_ast_worker/target/java-ast-worker-1.0.0.jar';

function getWorkerJarPath(): string {
  return resolveFromProjectRoot(WORKER_JAR_RELATIVE);
}

export const javaAdapter: AstLanguageAdapter = createSubprocessAdapter({
  id: 'java',
  extensions: ['java'],
  getSpawnArgs: () => ({
    command: 'java',
    args: ['-jar', getWorkerJarPath()],
  }),
  checkCommand: () => ({
    command: 'java',
    args: ['--version'],
    expectedOutput: '', // JDK 9+ 的 --version 输出到 stdout，任何非空输出说明 JVM 可用
  }),
});
