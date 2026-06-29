#!/usr/bin/env node
/**
 * 在新项目一键启用 RUNQUEUE 自动续跑（项目级 hook + runqueue.json + gitignore）。
 *
 * 用法（在任意目录对目标仓库执行）：
 *   node bootstrap-project.mjs --project /path/to/other-repo
 *   node bootstrap-project.mjs --project . --scope-cwd apps/my-app --queue-path apps/my-app/docs/RUNQUEUE.md
 *
 * 默认附带演示队列 + 快速入门 + 安装自检（--no-demo 可跳过）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SCRIPT = path.join(__dirname, 'install.mjs');
const VERIFY_SCRIPT = path.join(__dirname, 'verify-install.mjs');
const TEMPLATE_DIR = path.join(__dirname, 'kit', 'templates');

const GITIGNORE_LINES = ['.cursor/runqueue.active', '.cursor/runqueue-state.json'];

function printHelp() {
  console.log(`RUNQUEUE 项目一键 bootstrap

用法:
  node bootstrap-project.mjs --project <dir> [选项]

选项:
  --help                 显示帮助
  --project <dir>        目标仓库根（必填）
  --queue-path <rel>     正式 RUNQUEUE 路径（演示完成后改 config 用；默认自动推断）
  --scope-cwd <rel>      自动检查工作目录，相对仓库根（默认自动推断）
  --install-user-skill   同时安装 ~/.cursor/skills/runqueue-executor
  --no-demo              不写入演示队列与 QUICKSTART（仅装 hook）
  --force                覆盖已存在的 hook / 演示文件

默认（未 --no-demo）:
  - 写入 docs/RUNQUEUE-DEMO.md + docs/RUNQUEUE-QUICKSTART.zh-CN.md
  - runqueue.json 的 queuePath 先指向演示队列
  - 结束时运行 verify-install.mjs

示例:
  node bootstrap-project.mjs --project D:/work/my-app
  node bootstrap-project.mjs --project . --no-demo
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    project: null,
    queuePath: null,
    scopeCwd: null,
    installUserSkill: false,
    withDemo: true,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--install-user-skill') opts.installUserSkill = true;
    else if (arg === '--no-demo') opts.withDemo = false;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--project') {
      opts.project = argv[i + 1] || '.';
      i += 1;
    } else if (arg === '--queue-path') {
      opts.queuePath = argv[i + 1];
      i += 1;
    } else if (arg === '--scope-cwd') {
      opts.scopeCwd = argv[i + 1];
      i += 1;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }

  return opts;
}

/**
 * @param {string} root
 * @returns {{ scopeCwd: string, productionQueuePath: string }}
 */
function detectLayout(root) {
  if (fs.existsSync(path.join(root, 'backend'))) {
    return { scopeCwd: '.', productionQueuePath: 'docs/RUNQUEUE.md' };
  }

  const appsDir = path.join(root, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const name of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue;
      const appRoot = path.join(appsDir, name.name);
      if (fs.existsSync(path.join(appRoot, 'backend'))) {
        const rel = `apps/${name.name}`.replace(/\\/g, '/');
        return {
          scopeCwd: rel,
          productionQueuePath: `${rel}/docs/RUNQUEUE.md`,
        };
      }
    }
  }

  return { scopeCwd: '.', productionQueuePath: 'docs/RUNQUEUE.md' };
}

/**
 * @param {string} scopeCwd
 * @returns {string}
 */
function demoQueuePath(scopeCwd) {
  const base = scopeCwd === '.' ? 'docs' : `${scopeCwd.replace(/\\/g, '/')}/docs`;
  return `${base}/RUNQUEUE-DEMO.md`;
}

/**
 * @param {string} projectRoot
 * @param {string} scopeCwd
 * @returns {string}
 */
function scopeDocsDir(projectRoot, scopeCwd) {
  return path.join(projectRoot, scopeCwd, 'docs');
}

/**
 * @param {string} gitignorePath
 */
function ensureGitignore(gitignorePath) {
  const linesToAdd = [];
  if (fs.existsSync(gitignorePath)) {
    const text = fs.readFileSync(gitignorePath, 'utf8');
    for (const line of GITIGNORE_LINES) {
      if (!text.split(/\r?\n/).some((row) => row.trim() === line)) {
        linesToAdd.push(line);
      }
    }
    if (linesToAdd.length === 0) {
      console.log(`  gitignore 已含 runqueue 条目: ${gitignorePath}`);
      return;
    }
    const suffix = text.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${suffix}\n# RUNQUEUE 续跑状态（勿提交）\n${linesToAdd.join('\n')}\n`, 'utf8');
  } else {
    fs.writeFileSync(
      gitignorePath,
      `# RUNQUEUE 续跑状态（勿提交）\n${GITIGNORE_LINES.join('\n')}\n`,
      'utf8',
    );
  }
  console.log(`  更新: ${gitignorePath}`);
}

/**
 * @param {string} projectRoot
 * @param {{ queuePath: string, scopeCwd: string, productionQueuePath: string }} layout
 */
function writeRunqueueJson(projectRoot, layout) {
  const target = path.join(projectRoot, '.cursor', 'runqueue.json');
  const doc = {
    enabled: true,
    queuePath: layout.queuePath.replace(/\\/g, '/'),
    scopeCwd: layout.scopeCwd.replace(/\\/g, '/'),
    maxRetriesPerItem: 3,
  };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`  写入: ${target}`);
  if (layout.productionQueuePath && layout.queuePath !== layout.productionQueuePath) {
    console.log(`  提示: 演示完成后将 queuePath 改为 ${layout.productionQueuePath}`);
  }
}

/**
 * @param {string} projectRoot
 * @param {string} scopeCwd
 * @param {boolean} force
 */
function installDemoFiles(projectRoot, scopeCwd, force) {
  const docsDir = scopeDocsDir(projectRoot, scopeCwd);
  fs.mkdirSync(docsDir, { recursive: true });

  const copies = [
    ['RUNQUEUE-DEMO.md', 'RUNQUEUE-DEMO.md'],
    ['RUNQUEUE-QUICKSTART.zh-CN.md', 'RUNQUEUE-QUICKSTART.zh-CN.md'],
  ];

  for (const [srcName, destName] of copies) {
    const src = path.join(TEMPLATE_DIR, srcName);
    const dest = path.join(docsDir, destName);
    if (fs.existsSync(dest) && !force) {
      console.log(`  跳过（已存在）: ${dest}`);
      continue;
    }
    if (!fs.existsSync(src)) {
      throw new Error(`缺少模板: ${src}`);
    }
    fs.copyFileSync(src, dest);
    console.log(`  写入: ${dest}`);
  }
}

/**
 * @param {string} projectRoot
 * @param {{ queuePath: string, scopeCwd: string, productionQueuePath: string }} layout
 * @param {boolean} userSkillInstalled
 */
function printNextSteps(projectRoot, layout, userSkillInstalled) {
  const quickstartRel = layout.queuePath.includes('/')
    ? `${path.dirname(layout.queuePath).replace(/\\/g, '/')}/RUNQUEUE-QUICKSTART.zh-CN.md`
    : 'docs/RUNQUEUE-QUICKSTART.zh-CN.md';
  const quickstart = path.join(projectRoot, quickstartRel);
  const hasQuickstart = fs.existsSync(quickstart);

  console.log(`
════════════════════════════════════════════════════════════
  RUNQUEUE 已在目标项目就绪。
════════════════════════════════════════════════════════════

  ① 自检（命令行）:
     node ${path.join(__dirname, 'verify-install.mjs')} --project ${projectRoot}

  ② Cursor: Developer → Reload Window

  ③ ${hasQuickstart ? `打开 ${quickstartRel}，按「第三步」跑演示` : '对话开跑'}

  【演示续跑 — 复制到 Agent】
  「按 RUNQUEUE 执行，遵循 runqueue-executor skill」
  → 完成 DEMO-1 并 stop 后，应收到【RUNQUEUE 自动续跑】执行 DEMO-2

  【正式任务 — 演示通过后】
  「从 docs/你的计划.md 生成 RUNQUEUE，遵循 runqueue-executor，先不执行」
  并将 .cursor/runqueue.json 的 queuePath 改为: ${layout.productionQueuePath}

  当前 queuePath = ${layout.queuePath}
  scopeCwd       = ${layout.scopeCwd}
  skill: ${userSkillInstalled ? '已安装 ~/.cursor/skills/runqueue-executor' : '使用本机已有 runqueue-executor'}
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.project) {
    console.error('缺少 --project <dir>');
    printHelp();
    process.exit(1);
  }

  const projectRoot = path.resolve(opts.project);
  if (!fs.existsSync(projectRoot)) {
    console.error(`目标目录不存在: ${projectRoot}`);
    process.exit(1);
  }

  const detected = detectLayout(projectRoot);
  const scopeCwd = opts.scopeCwd ?? detected.scopeCwd;
  const productionQueuePath = opts.queuePath ?? detected.productionQueuePath;
  const activeQueuePath = opts.withDemo ? demoQueuePath(scopeCwd) : productionQueuePath;

  const layout = {
    scopeCwd,
    queuePath: activeQueuePath,
    productionQueuePath,
  };

  console.log('RUNQUEUE 项目 bootstrap');
  console.log(`  目标: ${projectRoot}`);
  console.log(`  推断: scopeCwd=${detected.scopeCwd}, 正式队列=${detected.productionQueuePath}`);
  console.log(`  演示: ${opts.withDemo ? '是' : '否'}`);

  const installArgs = [INSTALL_SCRIPT, '--no-user', '--project', projectRoot];
  if (opts.force) installArgs.push('--force');

  console.log('\n[1/4] 安装项目 hook + hooks.json …');
  const installResult = spawnSync(process.execPath, installArgs, {
    stdio: 'inherit',
    cwd: __dirname,
  });
  if (installResult.status !== 0) {
    process.exit(installResult.status ?? 1);
  }

  console.log('\n[2/4] 写入 runqueue.json + .gitignore …');
  writeRunqueueJson(projectRoot, layout);
  ensureGitignore(path.join(projectRoot, '.gitignore'));

  if (opts.withDemo) {
    console.log('\n[3/4] 写入演示队列 + 快速入门 …');
    installDemoFiles(projectRoot, scopeCwd, opts.force);
  } else {
    console.log('\n[3/4] 跳过演示文件（--no-demo）');
  }

  let userSkillInstalled = false;
  if (opts.installUserSkill) {
    console.log('\n[+] 安装用户级 skill …');
    const userArgs = [INSTALL_SCRIPT, '--user', '--no-project-hooks'];
    if (opts.force) userArgs.push('--force');
    const userResult = spawnSync(process.execPath, userArgs, {
      stdio: 'inherit',
      cwd: __dirname,
    });
    if (userResult.status !== 0) {
      process.exit(userResult.status ?? 1);
    }
    userSkillInstalled = true;
  } else {
    const skillPath = path.join(os.homedir(), '.cursor', 'skills', 'runqueue-executor', 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      console.log('\n[!] 本机未检测到 runqueue-executor skill，建议加 --install-user-skill 重跑');
    }
  }

  console.log('\n[4/4] 安装自检 …');
  const verifyResult = spawnSync(process.execPath, [VERIFY_SCRIPT, '--project', projectRoot], {
    stdio: 'inherit',
    cwd: __dirname,
  });

  printNextSteps(projectRoot, layout, userSkillInstalled);

  if (verifyResult.status !== 0) {
    process.exit(verifyResult.status ?? 1);
  }
}

main();
