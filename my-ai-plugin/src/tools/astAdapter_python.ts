/**
 * Python AST 适配器
 *
 * 通过子进程调用 python_ast_worker.py，实现对 .py 文件的结构化 AST 编辑。
 * 子进程惰性启动、复用、超时处理，dispose 时 kill。
 * 如果用户机器没有 Python 3 或 libcst，supportsFile 返回 false，自动降级。
 */
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { info, warn, error as logError } from '../logger';
import { resolveFromProjectRoot } from './astAdapter_subprocess';
import type {
  AstEditRequest,
  AstEditResult,
  AstLanguageAdapter,
} from './astEditorTypes';

// ─── 常量 ──────────────────────────────────────────────────

/** 单次操作超时（毫秒） */
const OPERATION_TIMEOUT_MS = 10_000;

/** worker 脚本相对于插件根目录的路径 */
const WORKER_SCRIPT_RELATIVE = 'resources/ast_workers/python_ast_worker.py';

// ─── 子进程管理 ────────────────────────────────────────────

let workerProcess: ChildProcess | null = null;
/** 可用性状态：null=未检测, true=可用, false=不可用 */
let pythonAvailable: boolean | null = null;
/** 自增请求 ID */
let requestIdCounter = 0;
/** 等待响应的回调：requestId → { resolve, timer } */
const pendingRequests = new Map<string, {
  resolve: (result: AstEditResult) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
/** 缓存的 worker 脚本绝对路径 */
let workerScriptPath: string | undefined;

/**
 * 检测 Python 3 和 libcst 是否可用。
 * 只检测一次，结果缓存。
 */
async function checkPythonAvailable(): Promise<boolean> {
  if (pythonAvailable !== null) {
    return pythonAvailable;
  }

  try {
    const result = await runCommand(getPythonCommand(), ['-c', 'import libcst; print("ok")']);
    pythonAvailable = result.trim() === 'ok';
    if (!pythonAvailable) {
      warn('Python libcst 检测失败：输出不符合预期');
    }
  } catch (e) {
    pythonAvailable = false;
    warn(`Python 3 或 libcst 不可用：${e instanceof Error ? e.message : e}`);
  }

  return pythonAvailable;
}

/**
 * 获取 Python 命令名。Windows 上优先尝试 python，其他系统用 python3。
 */
function getPythonCommand(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * 运行一个短命令并返回 stdout 内容。
 */
function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`命令退出码 ${code}: ${stderr || stdout}`));
      }
    });
    proc.on('error', reject);
    // 5 秒超时
    setTimeout(() => {
      proc.kill();
      reject(new Error('命令执行超时'));
    }, 5000);
  });
}

/**
 * 获取 worker 脚本的绝对路径。
 */
function getWorkerScriptPath(): string {
  if (!workerScriptPath) {
    workerScriptPath = resolveFromProjectRoot(WORKER_SCRIPT_RELATIVE);
  }
  return workerScriptPath;
}

/**
 * 启动或复用 worker 子进程。
 */
function ensureWorkerProcess(): ChildProcess {
  if (workerProcess && !workerProcess.killed && workerProcess.exitCode === null) {
    return workerProcess;
  }

  const scriptPath = getWorkerScriptPath();
  info(`启动 Python AST worker：${scriptPath}`);

  workerProcess = spawn(getPythonCommand(), [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 监听 stdout，按行解析 JSON 响应
  let buffer = '';
  workerProcess.stdout?.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    // 保留最后一个不完整的行
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      try {
        const response = JSON.parse(trimmed) as Record<string, unknown>;
        const reqId = String(response['id'] ?? '');
        const pending = pendingRequests.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(reqId);
          pending.resolve(convertWorkerResponse(response));
        }
      } catch {
        warn(`Python worker 输出非法 JSON：${trimmed.slice(0, 200)}`);
      }
    }
  });

  workerProcess.stderr?.on('data', (data) => {
    warn(`Python worker stderr：${data.toString().trim()}`);
  });

  workerProcess.on('close', (code) => {
    info(`Python AST worker 退出，退出码：${code}`);
    workerProcess = null;
    // 清理所有等待中的请求
    for (const [reqId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, reason: `Python worker 意外退出（退出码 ${code}）` });
    }
    pendingRequests.clear();
  });

  workerProcess.on('error', (err) => {
    logError(`Python AST worker 启动失败：${err.message}`);
    workerProcess = null;
  });

  return workerProcess;
}

/**
 * 将 worker 响应转换为 AstEditResult。
 */
function convertWorkerResponse(response: Record<string, unknown>): AstEditResult {
  if (response['success']) {
    const files = response['files'] as Array<{ filePath: string; newContent: string }>;
    return { success: true, files: files || [] };
  }
  return { success: false, reason: String(response['reason'] ?? '未知错误') };
}

/**
 * 向 worker 发送请求并等待响应。
 */
function sendRequest(request: Record<string, unknown>): Promise<AstEditResult> {
  return new Promise((resolve) => {
    const reqId = `py-${++requestIdCounter}`;
    request['id'] = reqId;

    const proc = ensureWorkerProcess();

    // 超时处理
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      resolve({ success: false, reason: `Python AST 操作超时（${OPERATION_TIMEOUT_MS / 1000}s）` });
    }, OPERATION_TIMEOUT_MS);

    pendingRequests.set(reqId, { resolve, timer });

    const json = JSON.stringify(request) + '\n';
    proc.stdin?.write(json, 'utf-8');
  });
}

// ─── 适配器实现 ────────────────────────────────────────────

async function pythonSupportsFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.py') {
    return false;
  }
  return checkPythonAvailable();
}

async function pythonExecute(request: AstEditRequest, fileContent: string): Promise<AstEditResult> {
  const available = await checkPythonAvailable();
  if (!available) {
    return { success: false, reason: 'Python 3 或 libcst 不可用' };
  }

  return sendRequest({
    action: request.action,
    filePath: request.filePath,
    fileContent,
    params: request.params,
  });
}

function pythonDispose(): void {
  if (workerProcess && !workerProcess.killed) {
    // 先尝试优雅退出
    try {
      workerProcess.stdin?.write(JSON.stringify({ id: 'dispose', action: 'shutdown' }) + '\n');
    } catch { /* 忽略写入失败 */ }

    // 500ms 后强制 kill
    const proc = workerProcess;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 500);
  }
  workerProcess = null;
  pythonAvailable = null;

  // 清理等待中的请求
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve({ success: false, reason: 'Python adapter disposed' });
  }
  pendingRequests.clear();
}

// ─── 导出 ─────────────────────────────────────────────────

/**
 * Python AST 语言适配器。
 * supportsFile 是异步的（需要检测 Python 可用性），
 * 但接口要求同步返回 boolean。所以首次检测在 execute 中做，
 * supportsFile 只做扩展名判断 + 缓存结果。
 */
export const pythonAdapter: AstLanguageAdapter = {
  id: 'python',
  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.py') {
      return false;
    }
    // 如果还没检测过，乐观返回 true，在 execute 中会做真正检测
    // 如果已检测过且不可用，返回 false
    if (pythonAvailable === false) {
      return false;
    }
    return true;
  },
  execute: pythonExecute,
  dispose: pythonDispose,
};
