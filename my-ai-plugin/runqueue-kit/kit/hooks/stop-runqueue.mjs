#!/usr/bin/env node
/**
 * Cursor stop hook：RUNQUEUE 自动续跑。
 * 仅在存在 `.cursor/runqueue.active` 且队列有未完成项时发出 followup_message。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function readStdin() {
  let text = '';
  if (process.platform === 'win32' && !process.stdin.isTTY) {
    try {
      // Windows：同步读 fd0 比 for-await 更可靠（Cursor 管道 stdin）
      text = fs.readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }

  text = text.trim();
  if (!text) {
    // stdin 为空时回退：项目 hook 的 cwd 即仓库根
    return { status: 'completed', workspace_roots: [process.cwd()], loop_count: 0 };
  }
  return JSON.parse(text);
}

/**
 * Cursor 在 Windows 上传 workspace_roots 形如 "/D:/repo"，直接 join 会导致找不到 .cursor 文件。
 * @param {string | undefined} raw
 */
function normalizeWorkspaceRoot(raw) {
  if (!raw) return process.cwd();
  let root = String(raw).trim();
  if (process.platform === 'win32') {
    const normalized = root.replace(/\\/g, '/');
    const driveMatch = normalized.match(/^\/+([a-zA-Z]):\/?(.*)$/);
    if (driveMatch) {
      const rest = driveMatch[2].replace(/\//g, path.sep);
      return path.resolve(`${driveMatch[1]}:${path.sep}${rest}`);
    }
  }
  return path.resolve(root);
}

/**
 * @param {{ id: string, status: string }} prev
 * @param {string} workspaceRoot
 */
function isPrevItemComplete(prev, workspaceRoot) {
  if (!prev || prev.status !== 'done') return false;
  // 续跑时只认勾选 + commit 含 ID，不重跑上一项 autoCheck（e2e/pytest 会卡住 stop hook）
  return hasRecentCommitForItem(workspaceRoot, prev.id);
}

/** @param {Record<string, unknown>} obj */
function output(obj) {
  const line = `${JSON.stringify(obj)}\n`;
  // Windows：避免 stdout 缓冲导致 Cursor 读不到 followup（社区已知问题）
  if (process.platform === 'win32') {
    fs.writeSync(1, line);
    return;
  }
  process.stdout.write(line);
}

/** @param {string} message */
function emitFollowup(message) {
  output({
    followup_message: message,
    decision: 'block',
    reason: message,
  });
}

/**
 * @param {string} workspaceRoot
 * @returns {{ path: string, data: Record<string, unknown> } | null}
 */
function findConfig(workspaceRoot) {
  const candidates = [path.join(workspaceRoot, '.cursor', 'runqueue.json')];

  try {
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      candidates.push(path.join(workspaceRoot, entry.name, '.cursor', 'runqueue.json'));
    }
  } catch {
    // 工作区不可读时仅使用根配置
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return { path: candidate, data: JSON.parse(fs.readFileSync(candidate, 'utf8')) };
    } catch {
      // 配置损坏则尝试下一个
    }
  }
  return null;
}

/**
 * @param {string} content
 * @returns {Array<{ id: string, title: string, status: string, autoCheck: string }>}
 */
function parseQueue(content) {
  const items = [];
  const sections = content.split(/^### \[/m).slice(1);

  for (const section of sections) {
    const idMatch = section.match(/^([^\]]+)\]/);
    if (!idMatch) continue;

    const id = idMatch[1].trim();
    const titleMatch = section.match(/\]\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : id;

    const checkboxMatch = section.match(/^- \[([ x])\]/m);
    let status = 'unknown';
    if (checkboxMatch?.[1] === 'x') status = 'done';
    else if (checkboxMatch?.[1] === ' ') status = 'pending';

    const checkMatch = section.match(/\*\*自动检查\*\*\s*\r?\n```bash\r?\n([\s\S]*?)```/);
    const autoCheck = checkMatch ? checkMatch[1].trim() : '';

    items.push({ id, title, status, autoCheck });
  }

  return items;
}

/**
 * @param {string} statePath
 */
function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { retries: {} };
  }
}

/**
 * @param {string} statePath
 * @param {{ retries: Record<string, number> }} state
 */
function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} commands
 * @param {string} scopeCwd
 * @param {string} workspaceRoot
 */
function runAutoCheck(commands, scopeCwd, workspaceRoot) {
  if (!commands) {
    return { ok: false, error: 'missing_auto_check' };
  }

  const lines = commands
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const cwd = path.resolve(workspaceRoot, scopeCwd);

  try {
    for (const line of lines) {
      execSync(line, {
        cwd,
        stdio: 'pipe',
        shell: true,
        env: process.env,
        timeout: 600_000,
      });
    }
    return { ok: true };
  } catch (error) {
    const err = /** @type {{ stderr?: Buffer, message?: string }} */ (error);
    return { ok: false, error: String(err.stderr?.toString() || err.message || error) };
  }
}

/**
 * @param {string} workspaceRoot
 * @param {string} itemId
 */
function hasRecentCommitForItem(workspaceRoot, itemId) {
  try {
    const log = execSync('git log -5 --oneline', {
      cwd: workspaceRoot,
      encoding: 'utf8',
      shell: true,
    });
    return log.includes(itemId);
  } catch {
    return false;
  }
}

/**
 * @param {string} activePath
 */
function deactivate(activePath) {
  try {
    fs.unlinkSync(activePath);
  } catch {
    // 已删除则忽略
  }
}

async function main() {
  let payload;
  try {
    payload = await readStdin();
  } catch {
    output({});
    return;
  }

  if (payload.status === 'aborted') {
    output({});
    return;
  }

  const workspaceRoot = normalizeWorkspaceRoot(payload.workspace_roots?.[0]);
  const activePath = path.join(workspaceRoot, '.cursor', 'runqueue.active');
  if (!fs.existsSync(activePath)) {
    output({});
    return;
  }

  const configWrap = findConfig(workspaceRoot);
  if (!configWrap || configWrap.data.enabled === false) {
    output({});
    return;
  }

  const config = configWrap.data;
  const scopeCwd = String(config.scopeCwd || '.');
  const queueRel = String(config.queuePath || 'docs/RUNQUEUE.md');
  const queuePath = path.isAbsolute(queueRel)
    ? queueRel
    : path.resolve(workspaceRoot, queueRel);

  if (!fs.existsSync(queuePath)) {
    output({});
    return;
  }

  const content = fs.readFileSync(queuePath, 'utf8');
  const items = parseQueue(content);
  const pending = items.find((item) => item.status === 'pending');
  const statePath = path.join(workspaceRoot, '.cursor', 'runqueue-state.json');
  const state = loadState(statePath);
  const maxRetries = Number(config.maxRetriesPerItem ?? 3);
  const queueLabel = path.relative(workspaceRoot, queuePath) || queueRel;

  if (!pending) {
    deactivate(activePath);
    saveState(statePath, { retries: {} });
    output({});
    return;
  }

  if (!pending.autoCheck) {
    output({});
    return;
  }

  const check = runAutoCheck(pending.autoCheck, scopeCwd, workspaceRoot);
  const sectionPattern = new RegExp(
    `### \\[${pending.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?^- \\[([ x])\\]`,
    'm',
  );
  const sectionMatch = content.match(sectionPattern);
  const isChecked = sectionMatch?.[1] === 'x';
  const committed = hasRecentCommitForItem(workspaceRoot, pending.id);

  const pendingIdx = items.findIndex((item) => item.id === pending.id);
  const prevItem = pendingIdx > 0 ? items[pendingIdx - 1] : null;

  // 上一项已提交完成 → 自动开跑当前待办（不论当前自动检查是否因残留文件而通过）
  if (prevItem && isPrevItemComplete(prevItem, workspaceRoot) && !isChecked) {
    const retries = state.retries[pending.id] || 0;
    if (retries === 0) {
      state.retries[pending.id] = 0;
      saveState(statePath, state);
      emitFollowup(
        `【RUNQUEUE 自动续跑】${prevItem.id} 已完成。请按 ${queueLabel} 执行下一项 ${pending.id}（遵循 runqueue-executor skill）。不要询问是否继续。`,
      );
      return;
    }
  }

  if (check.ok && !isChecked) {
    state.retries[pending.id] = 0;
    saveState(statePath, state);
    emitFollowup(
      `【RUNQUEUE 自动续跑】${pending.id} 自动检查已通过，但尚未勾选或提交。请将该项改为 - [x]，按提交模板 git commit（消息须含 ${pending.id}），然后停止。`,
    );
    return;
  }

  if (check.ok && isChecked && !committed) {
    emitFollowup(
      `【RUNQUEUE 自动续跑】${pending.id} 已勾选，但最近 5 条 commit 未包含 ${pending.id}。请按提交信息模板 commit 后停止。`,
    );
    return;
  }

  const retries = (state.retries[pending.id] || 0) + 1;
  state.retries[pending.id] = retries;
  saveState(statePath, state);

  if (retries >= maxRetries) {
    deactivate(activePath);
    output({});
    return;
  }

  emitFollowup(
    `【RUNQUEUE 自动续跑】${pending.id} 自动检查未通过（第 ${retries}/${maxRetries} 次）。请修复并重新跑自动检查，通过后再勾选、commit。不要跳到下一项。`,
  );
}

main().catch(() => output({}));
