#!/usr/bin/env node
/**
 * 检查目标项目的 RUNQUEUE 安装是否就绪；可选冒烟 stop hook（无 active 时不应崩溃）。
 *
 * 用法:
 *   node verify-install.mjs --project .
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {{ name: string, ok: boolean, detail?: string }} CheckResult */

function printHelp() {
  console.log(`RUNQUEUE 安装自检

用法:
  node verify-install.mjs --project <dir>

全部 ✓ 时 exit 0；任一项 ✗ 时 exit 1。
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { project: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--project') {
      opts.project = argv[i + 1] || '.';
      i += 1;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * @param {string} projectRoot
 * @returns {CheckResult[]}
 */
function runChecks(projectRoot) {
  const results = /** @type {CheckResult[]} */ ([]);
  const root = path.resolve(projectRoot);

  const add = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
  };

  add('Node.js 可用', true, process.version);

  const configPath = path.join(root, '.cursor', 'runqueue.json');
  if (!fs.existsSync(configPath)) {
    add('.cursor/runqueue.json', false, '缺失');
    return results;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    add('.cursor/runqueue.json', true);
  } catch (e) {
    add('.cursor/runqueue.json', false, String(e));
    return results;
  }

  add('runqueue.enabled', config.enabled !== false, String(config.enabled));

  const queueRel = String(config.queuePath || '');
  const queueAbs = path.join(root, queueRel);
  add(`队列文件 ${queueRel}`, fs.existsSync(queueAbs), queueAbs);

  const scopeCwd = String(config.scopeCwd || '.');
  const scopeAbs = path.resolve(root, scopeCwd);
  add(`scopeCwd ${scopeCwd}`, fs.existsSync(scopeAbs), scopeAbs);

  const hookMjs = path.join(root, '.cursor', 'hooks', 'stop-runqueue.mjs');
  add('.cursor/hooks/stop-runqueue.mjs', fs.existsSync(hookMjs));

  if (process.platform === 'win32') {
    const hookCmd = path.join(root, '.cursor', 'hooks', 'stop-runqueue.cmd');
    add('.cursor/hooks/stop-runqueue.cmd (Win)', fs.existsSync(hookCmd));
  }

  const hooksJsonPath = path.join(root, '.cursor', 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const hooksDoc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      const stops = hooksDoc?.hooks?.stop;
      const hasRunqueue = Array.isArray(stops)
        && stops.some((h) => String(h?.command || '').includes('stop-runqueue'));
      add('hooks.json 已注册 stop-runqueue', hasRunqueue);
    } catch (e) {
      add('hooks.json 可解析', false, String(e));
    }
  } else {
    add('.cursor/hooks.json', false, '缺失');
  }

  const skillPath = path.join(os.homedir(), '.cursor', 'skills', 'runqueue-executor', 'SKILL.md');
  add('用户级 runqueue-executor skill', fs.existsSync(skillPath), skillPath);

  const quickstartRel = queueRel.includes('/')
    ? `${path.dirname(queueRel).replace(/\\/g, '/')}/RUNQUEUE-QUICKSTART.zh-CN.md`
    : 'docs/RUNQUEUE-QUICKSTART.zh-CN.md';
  const quickstart = path.join(root, quickstartRel);
  add(quickstartRel, fs.existsSync(quickstart));

  add(`演示队列 ${queueRel}`, fs.existsSync(queueAbs));

  if (fs.existsSync(hookMjs)) {
    const payload = JSON.stringify({
      status: 'completed',
      workspace_roots: [root],
      loop_count: 0,
    });
    const hookRun = spawnSync(process.execPath, [hookMjs], {
      input: payload,
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    const hookOk = hookRun.status === 0;
    add('stop hook 冒烟（无 active 时 exit 0）', hookOk, hookRun.stderr?.slice(0, 200) || '');
  }

  return results;
}

/**
 * @param {CheckResult[]} results
 */
function printResults(results) {
  console.log('\nRUNQUEUE 安装自检结果\n');
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const detail = r.detail ? ` — ${r.detail}` : '';
    console.log(`  ${mark} ${r.name}${detail}`);
    if (!r.ok) failed += 1;
  }

  console.log('');
  if (failed === 0) {
    console.log('全部通过。下一步：');
    console.log('  1. Cursor Reload Window');
    console.log('  2. 阅读 docs/RUNQUEUE-QUICKSTART.zh-CN.md');
    console.log('  3. 对话：「按 RUNQUEUE 执行，遵循 runqueue-executor skill」');
  } else {
    console.log(`${failed} 项未通过。可重跑: bootstrap-project.cmd --project . --force`);
  }
  return failed;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.project) {
    console.error('缺少 --project <dir>');
    process.exit(1);
  }

  const projectRoot = path.resolve(opts.project);
  if (!fs.existsSync(projectRoot)) {
    console.error(`目录不存在: ${projectRoot}`);
    process.exit(1);
  }

  console.log(`检查项目: ${projectRoot}`);
  const failed = printResults(runChecks(projectRoot));
  process.exit(failed > 0 ? 1 : 0);
}

main();
