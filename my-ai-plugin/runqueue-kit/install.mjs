#!/usr/bin/env node
/**
 * RUNQUEUE Kit 安装器（Windows / Linux / macOS）
 *
 * 用法：
 *   node install.mjs                 # 用户级：~/.cursor（推荐，本机所有项目可用）
 *   node install.mjs --project .     # 在当前项目写入 .cursor/runqueue.json 范例
 *   node install.mjs --project-hooks # 同时在项目内安装 hooks（不用用户级时）
 *   node install.mjs --force       # 覆盖已存在的 kit 文件
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.join(__dirname, 'kit');

const RUNQUEUE_HOOK_PROJECT = {
  command: 'node .cursor/hooks/stop-runqueue.mjs',
  loop_limit: null,
};

/**
 * @param {string} cursorHome
 */
function buildUserHookCommand(cursorHome) {
  return `node "${path.join(cursorHome, 'hooks', 'stop-runqueue.mjs')}"`;
}

function printHelp() {
  console.log(`RUNQUEUE Kit 安装器

用法:
  node install.mjs [选项]

选项:
  --help           显示帮助
  --user           安装到用户目录 ~/.cursor（默认开启）
  --no-user        跳过用户级安装
  --project <dir>  在项目 <dir> 写入 .cursor/runqueue.json 并安装项目 hook（默认）
  --no-project-hooks  与 --project 合用：只写 runqueue.json，不装项目 hook
  --force          覆盖已存在的 skill / hook 脚本

示例:
  node install.mjs
  node install.mjs --project /path/to/my-repo
  node install.mjs --project . --project-hooks
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    user: true,
    project: null,
    projectHooks: false,
    noProjectHooks: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--user') opts.user = true;
    else if (arg === '--no-user') opts.user = false;
    else if (arg === '--project-hooks') opts.projectHooks = true;
    else if (arg === '--no-project-hooks') opts.noProjectHooks = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--project') {
      opts.project = argv[i + 1] || '.';
      i += 1;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }

  if (opts.project && !opts.noProjectHooks) {
    opts.projectHooks = true;
  }

  return opts;
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {boolean} force
 */
function copyFile(src, dest, force) {
  if (!fs.existsSync(src)) {
    throw new Error(`缺少 kit 文件: ${src}`);
  }
  if (fs.existsSync(dest) && !force) {
    console.log(`  跳过（已存在）: ${dest}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  写入: ${dest}`);
  return true;
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {boolean} force
 */
function copyDir(srcDir, destDir, force) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`缺少 kit 目录: ${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(from, to, force);
    else copyFile(from, to, force);
  }
}

/**
 * @param {unknown} hook
 */
function isRunqueueStopHook(hook) {
  if (!hook || typeof hook !== 'object') return false;
  const cmd = String(/** @type {{ command?: string }} */ (hook).command || '');
  return cmd.includes('stop-runqueue');
}

/**
 * @param {string} hooksPath
 * @param {{ command: string, loop_limit: null }} entry
 * @param {boolean} force
 */
function mergeHooksJson(hooksPath, entry, force) {
  let doc = { version: 1, hooks: { stop: [] } };

  if (fs.existsSync(hooksPath)) {
    try {
      doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    } catch {
      const backup = `${hooksPath}.bak.${Date.now()}`;
      fs.copyFileSync(hooksPath, backup);
      console.log(`  原 hooks.json 无法解析，已备份: ${backup}`);
    }
  }

  if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
  if (!Array.isArray(doc.hooks.stop)) doc.hooks.stop = [];

  const exists = doc.hooks.stop.some(isRunqueueStopHook);
  if (exists && !force) {
    console.log(`  跳过 hooks.json（已含 stop-runqueue）: ${hooksPath}`);
    return;
  }

  doc.hooks.stop = doc.hooks.stop.filter((h) => !isRunqueueStopHook(h));
  doc.hooks.stop.push(entry);
  doc.version = 1;

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`  更新: ${hooksPath}`);
}

/**
 * @param {boolean} force
 */
function installUserKit(force) {
  const cursorHome = path.join(os.homedir(), '.cursor');
  console.log(`\n[1/2] 用户级安装 → ${cursorHome}`);

  copyDir(
    path.join(KIT_DIR, 'skills', 'runqueue-executor'),
    path.join(cursorHome, 'skills', 'runqueue-executor'),
    force,
  );

  copyFile(
    path.join(KIT_DIR, 'hooks', 'stop-runqueue.mjs'),
    path.join(cursorHome, 'hooks', 'stop-runqueue.mjs'),
    force,
  );

  if (process.platform === 'win32') {
    copyFile(
      path.join(KIT_DIR, 'hooks', 'stop-runqueue.cmd'),
      path.join(cursorHome, 'hooks', 'stop-runqueue.cmd'),
      force,
    );
  }

  mergeHooksJson(
    path.join(cursorHome, 'hooks.json'),
    { command: buildUserHookCommand(cursorHome), loop_limit: null },
    force,
  );
}

/**
 * @param {string} projectDir
 * @param {boolean} projectHooks
 * @param {boolean} force
 */
function installProjectKit(projectDir, projectHooks, force) {
  const root = path.resolve(projectDir);
  const cursorDir = path.join(root, '.cursor');
  console.log(`\n[2/2] 项目配置 → ${root}`);

  const runqueuePath = path.join(cursorDir, 'runqueue.json');
  const examplePath = path.join(KIT_DIR, 'runqueue.json.example');

  if (fs.existsSync(runqueuePath) && !force) {
    console.log(`  跳过（已存在）: ${runqueuePath}`);
  } else {
    copyFile(examplePath, runqueuePath, true);
    console.log('  请编辑 runqueue.json 中的 queuePath 与 scopeCwd');
  }

  if (projectHooks) {
    copyFile(
      path.join(KIT_DIR, 'hooks', 'stop-runqueue.mjs'),
      path.join(cursorDir, 'hooks', 'stop-runqueue.mjs'),
      force,
    );
    if (process.platform === 'win32') {
      copyFile(
        path.join(KIT_DIR, 'hooks', 'stop-runqueue.cmd'),
        path.join(cursorDir, 'hooks', 'stop-runqueue.cmd'),
        force,
      );
    }
    mergeHooksJson(path.join(cursorDir, 'hooks.json'), RUNQUEUE_HOOK_PROJECT, force);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(KIT_DIR)) {
    console.error(`找不到 kit 目录: ${KIT_DIR}`);
    process.exit(1);
  }

  console.log('RUNQUEUE Kit 安装开始');
  console.log(`  包路径: ${__dirname}`);

  if (opts.user) installUserKit(opts.force);
  if (opts.project) installProjectKit(opts.project, opts.projectHooks, opts.force);

  console.log(`
完成。下一步:
  1. 重启 Cursor 或执行 Developer: Reload Window
  2. 在 Cursor 设置中确认 Hooks 已加载
  3. 对话: 「从 docs/你的计划.md 生成 RUNQUEUE，遵循 runqueue-executor，先不执行」
  4. 确认队列后: 「按 RUNQUEUE 执行」

说明: 本安装器不包含任何业务代码，仅安装 skill + stop hook。`);
}

main();
