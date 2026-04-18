/**
 * 子进程 AST 适配器通用基础设施
 *
 * 提供惰性启动、进程复用、超时、优雅关闭等能力。
 * Python / C# / Java 适配器共享此逻辑。
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { info, warn, error as logError } from '../logger';
import type { AstEditRequest, AstEditResult } from './astEditorTypes';

/**
 * 从 __dirname 向上查找 package.json 所在目录，作为项目根目录。
 * 适用于正式构建（dist/tools/）和测试构建（.test-dist/src/tools/）两种情况。
 */
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：假设正式构建结构 dist/tools/ → 上两级
  return path.resolve(__dirname, '..', '..');
}

/** 缓存的项目根目录 */
let cachedProjectRoot: string | undefined;

/**
 * 从项目根目录解析相对路径。
 * 供 C# / Java / Python 适配器使用。
 */
export function resolveFromProjectRoot(relativePath: string): string {
  if (!cachedProjectRoot) {
    cachedProjectRoot = findProjectRoot();
  }
  return path.resolve(cachedProjectRoot, relativePath);
}

/** 单次操作超时（毫秒），包含首次启动 worker 的时间 */
const OPERATION_TIMEOUT_MS = 30_000;

/** 子进程适配器的配置 */
export interface SubprocessAdapterConfig {
  /** 适配器唯一 ID */
  id: string;
  /** 支持的文件扩展名（不含点号，如 'py'） */
  extensions: string[];
  /** 返回启动子进程的命令和参数 */
  getSpawnArgs: () => { command: string; args: string[] };
  /** 检测运行时是否可用（返回要执行的检测命令和预期输出）*/
  checkCommand: () => { command: string; args: string[]; expectedOutput: string };
}

/** 子进程适配器实例的运行时状态 */
interface SubprocessState {
  workerProcess: ChildProcess | null;
  available: boolean | null;
  requestIdCounter: number;
  pendingRequests: Map<string, {
    resolve: (result: AstEditResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

/**
 * 创建一个基于子进程通信的 AST 语言适配器。
 * 所有子进程适配器（Python / C# / Java）共享此工厂函数。
 */
export function createSubprocessAdapter(config: SubprocessAdapterConfig) {
  const extSet = new Set(config.extensions.map(e => `.${e}`));

  const state: SubprocessState = {
    workerProcess: null,
    available: null,
    requestIdCounter: 0,
    pendingRequests: new Map(),
  };

  // ─── 运行时检测 ─────────────────────────────────────────

  function checkAvailable(): boolean {
    if (state.available !== null) return state.available;

    try {
      const { command, args, expectedOutput } = config.checkCommand();
      const result = execSync(`${command} ${args.join(' ')}`, {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // expectedOutput 为空表示"只要命令执行成功且有输出就算可用"
      const trimmed = result.trim();
      state.available = expectedOutput
        ? trimmed === expectedOutput
        : trimmed.length > 0;
      if (!state.available) {
        warn(`${config.id} 运行时检测失败：输出不符合预期`);
      }
    } catch {
      state.available = false;
      warn(`${config.id} 运行时不可用`);
    }

    return state.available;
  }

  // ─── 子进程管理 ─────────────────────────────────────────

  function ensureWorkerProcess(): ChildProcess {
    if (state.workerProcess && !state.workerProcess.killed && state.workerProcess.exitCode === null) {
      return state.workerProcess;
    }

    const { command, args } = config.getSpawnArgs();
    info(`启动 ${config.id} AST worker：${command} ${args.join(' ')}`);

    state.workerProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    state.workerProcess.stdout?.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const response = JSON.parse(trimmed) as Record<string, unknown>;
          const reqId = String(response['id'] ?? '');
          const pending = state.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timer);
            state.pendingRequests.delete(reqId);
            pending.resolve(convertResponse(response));
          }
        } catch {
          warn(`${config.id} worker 输出非法 JSON：${trimmed.slice(0, 200)}`);
        }
      }
    });

    state.workerProcess.stderr?.on('data', (data) => {
      warn(`${config.id} worker stderr：${data.toString().trim()}`);
    });

    state.workerProcess.on('close', (code) => {
      info(`${config.id} AST worker 退出，退出码：${code}`);
      state.workerProcess = null;
      for (const [, pending] of state.pendingRequests) {
        clearTimeout(pending.timer);
        pending.resolve({ success: false, reason: `${config.id} worker 意外退出（退出码 ${code}）` });
      }
      state.pendingRequests.clear();
    });

    state.workerProcess.on('error', (err) => {
      logError(`${config.id} AST worker 启动失败：${err.message}`);
      state.workerProcess = null;
    });

    return state.workerProcess;
  }

  function convertResponse(response: Record<string, unknown>): AstEditResult {
    if (response['success']) {
      const files = response['files'] as Array<{ filePath: string; newContent: string }>;
      return { success: true, files: files || [] };
    }
    return { success: false, reason: String(response['reason'] ?? '未知错误') };
  }

  function sendRequest(request: Record<string, unknown>): Promise<AstEditResult> {
    return new Promise((resolve) => {
      const reqId = `${config.id}-${++state.requestIdCounter}`;
      request['id'] = reqId;

      const proc = ensureWorkerProcess();

      const timer = setTimeout(() => {
        state.pendingRequests.delete(reqId);
        resolve({ success: false, reason: `${config.id} AST 操作超时（${OPERATION_TIMEOUT_MS / 1000}s）` });
      }, OPERATION_TIMEOUT_MS);

      state.pendingRequests.set(reqId, { resolve, timer });

      const json = JSON.stringify(request) + '\n';
      proc.stdin?.write(json, 'utf-8');
    });
  }

  // ─── 适配器接口 ─────────────────────────────────────────

  return {
    id: config.id,

    supportsFile(filePath: string): boolean {
      const ext = filePath.lastIndexOf('.') >= 0
        ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
        : '';
      if (!extSet.has(ext)) return false;
      if (state.available === false) return false;
      return true;
    },

    async execute(request: AstEditRequest, fileContent: string): Promise<AstEditResult> {
      const available = checkAvailable();
      if (!available) {
        return { success: false, reason: `${config.id} 运行时不可用` };
      }

      return sendRequest({
        action: request.action,
        filePath: request.filePath,
        fileContent,
        params: request.params,
      });
    },

    dispose(): void {
      if (state.workerProcess && !state.workerProcess.killed) {
        try {
          state.workerProcess.stdin?.write(
            JSON.stringify({ id: 'dispose', action: 'shutdown' }) + '\n'
          );
        } catch { /* 忽略写入失败 */ }

        const proc = state.workerProcess;
        setTimeout(() => {
          if (proc && !proc.killed) proc.kill('SIGKILL');
        }, 500);
      }
      state.workerProcess = null;
      state.available = null;

      for (const [, pending] of state.pendingRequests) {
        clearTimeout(pending.timer);
        pending.resolve({ success: false, reason: `${config.id} adapter disposed` });
      }
      state.pendingRequests.clear();
    },
  };
}
