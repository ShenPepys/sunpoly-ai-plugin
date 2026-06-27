/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { getWorkspaceStats, formatWorkspaceStats } from '../src/tools/workspaceStats';
import type { WorkspaceStats } from '../src/tools/workspaceStats';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

// ==================== 测试辅助 ====================

/**
 * 创建临时测试目录结构：
 * test-project/
 * ├── src/
 * │   ├── utils/
 * │   │   └── helper.ts     (5 行)
 * │   └── index.ts          (3 行)
 * ├── config/
 * │   └── settings.json     (4 行)
 * ├── node_modules/         (应被跳过)
 * │   └── fake-pkg/
 * │       └── index.js
 * ├── .git/                 (应被跳过)
 * │   └── HEAD
 * └── README.md             (2 行)
 */
async function createTestProject(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-stats-test-'));

  // 创建目录结构
  const dirs = [
    'src',
    path.join('src', 'utils'),
    'config',
    path.join('node_modules', 'fake-pkg'),
    '.git',
  ];
  for (const dir of dirs) {
    await fsp.mkdir(path.join(tmpDir, dir), { recursive: true });
  }

  // 创建文件
  const files: Record<string, string> = {
    [path.join('src', 'utils', 'helper.ts')]: 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const PI = 3.14;\n',
    [path.join('src', 'index.ts')]: 'import { add } from "./utils/helper";\nconsole.log(add(1, 2));\n',
    [path.join('config', 'settings.json')]: '{\n  "name": "test",\n  "version": "1.0.0"\n}\n',
    [path.join('node_modules', 'fake-pkg', 'index.js')]: 'module.exports = {};\n',
    [path.join('.git', 'HEAD')]: 'ref: refs/heads/main\n',
    'README.md': '# Test Project\n\nThis is a test project.\n',
  };
  for (const [relPath, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(tmpDir, relPath), content, 'utf-8');
  }

  return tmpDir;
}

async function cleanupTestProject(tmpDir: string): Promise<void> {
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/** 设置 mock 的 workspaceFolders 指向指定目录 */
function setMockWorkspace(rootPath: string): void {
  vscode.workspace.workspaceFolders = [
    { uri: { fsPath: rootPath }, name: 'test', index: 0 },
  ];
}

/** 清除 mock 的 workspaceFolders */
function clearMockWorkspace(): void {
  vscode.workspace.workspaceFolders = undefined;
}

// ==================== getWorkspaceStats 测试 ====================

test('getWorkspaceStats 未打开工作区时返回失败', async () => {
  clearMockWorkspace();
  const result = await getWorkspaceStats();
  assert.equal(result.success, false);
  assert.match(result.errorMessage ?? '', /未打开工作区/);
});

test('getWorkspaceStats 能统计多层级目录的文件类型分布', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);

    const result = await getWorkspaceStats();
    assert.equal(result.success, true, `应成功: ${result.errorMessage}`);
    assert.equal(result.rootPath, tmpDir);

    // 验证文件类型统计
    assert.ok(result.byExtension, '应有 byExtension');
    assert.ok(result.byExtension['.ts'], '应统计 .ts 文件');
    assert.ok(result.byExtension['.json'], '应统计 .json 文件');
    assert.ok(result.byExtension['.md'], '应统计 .md 文件');

    // .ts: helper.ts(5行) + index.ts(2行) = 2 文件, 7 行
    assert.equal(result.byExtension['.ts'].count, 2, '.ts 应有 2 个文件');
    assert.equal(result.byExtension['.ts'].lines, 7, '.ts 应有 7 行');

    // .json: settings.json(4行) = 1 文件, 4 行
    assert.equal(result.byExtension['.json'].count, 1, '.json 应有 1 个文件');
    assert.equal(result.byExtension['.json'].lines, 4, '.json 应有 4 行');

    // .md: README.md(3行) = 1 文件
    assert.equal(result.byExtension['.md'].count, 1, '.md 应有 1 个文件');

    // 验证 node_modules 和 .git 被跳过
    assert.ok(!result.byExtension['.js'], '.js 文件应被跳过（在 node_modules 中）');

    // 总文件数: 2(ts) + 1(json) + 1(md) = 4
    assert.equal(result.totalFiles, 4, '应有 4 个有效文件');

    // 总行数: 7(ts) + 4(json) + 3(md) = 14
    assert.equal(result.totalLines, 14, '应有 14 行代码');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 能计算最大目录深度', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats();
    assert.equal(result.success, true);

    // 最深路径: src/utils/ (深度 2)
    assert.equal(result.maxDepth, 2, '最大深度应为 2 (src/utils)');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 能列出所有目录及其统计', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats();
    assert.equal(result.success, true);
    assert.ok(result.directories, '应有 directories');

    // 应包含: . (根), src, src/utils, config
    // 不包含: node_modules, .git
    const dirNames = result.directories.map(d => d.relativePath).sort();
    assert.ok(dirNames.includes('.'), '应包含根目录');
    assert.ok(dirNames.includes('src'), '应包含 src');
    assert.ok(dirNames.includes(path.join('src', 'utils')), '应包含 src/utils');
    assert.ok(dirNames.includes('config'), '应包含 config');

    // node_modules 和 .git 不应出现
    assert.ok(!dirNames.includes('node_modules'), '不应包含 node_modules');
    assert.ok(!dirNames.includes('.git'), '不应包含 .git');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 能返回最大文件列表', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats();
    assert.equal(result.success, true);
    assert.ok(result.largestFiles, '应有 largestFiles');
    assert.ok(result.largestFiles.length > 0, '最大文件列表不为空');

    // 验证列表按字节数降序
    for (let i = 1; i < result.largestFiles.length; i++) {
      assert.ok(
        result.largestFiles[i - 1].bytes >= result.largestFiles[i].bytes,
        '文件应按字节数降序排列',
      );
    }
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 支持 maxScanDepth 限制', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);

    // 深度限制为 1，src/utils 不应被扫描
    const result = await getWorkspaceStats('.', 1);
    assert.equal(result.success, true);

    // 只有根目录下的文件和 src/ config/ 目录下的直接文件
    // src/utils/ 不应被扫描（深度 > 1）
    const dirPaths = result.directories?.map(d => d.relativePath) ?? [];
    assert.ok(!dirPaths.includes(path.join('src', 'utils')), '深度限制 1 时不应包含 src/utils');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 支持额外排除目录', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);

    const result = await getWorkspaceStats('.', 5, ['config']);
    assert.equal(result.success, true);

    const dirPaths = result.directories?.map(d => d.relativePath) ?? [];
    assert.ok(!dirPaths.includes('config'), '额外排除 config 时不应包含');

    // .json 文件在 config/ 中，应被排除
    assert.ok(!result.byExtension?.['.json'], '排除 config 后不应统计 .json');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 目标路径不在工作区内时返回失败', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats('../../etc');
    assert.equal(result.success, false);
    assert.match(result.errorMessage ?? '', /不在工作区/);
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 目标目录不存在时返回失败', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats('nonexistent-dir');
    assert.equal(result.success, false);
    assert.match(result.errorMessage ?? '', /不存在/);
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

test('getWorkspaceStats 记录扫描耗时', async () => {
  const tmpDir = await createTestProject();
  try {
    setMockWorkspace(tmpDir);
    const result = await getWorkspaceStats();
    assert.equal(result.success, true);
    assert.ok(typeof result.scanTimeMs === 'number', 'scanTimeMs 应为数字');
    assert.ok(result.scanTimeMs >= 0, 'scanTimeMs 应非负');
  } finally {
    await cleanupTestProject(tmpDir);
    clearMockWorkspace();
  }
});

// ==================== formatWorkspaceStats 测试 ====================

test('formatWorkspaceStats 格式化成功结果', () => {
  const stats: WorkspaceStats = {
    success: true,
    rootPath: '/test/project',
    byExtension: {
      '.ts': { count: 10, lines: 500, bytes: 15360 },
      '.json': { count: 3, lines: 50, bytes: 1024 },
    },
    totalFiles: 13,
    totalLines: 550,
    totalBytes: 16384,
    maxDepth: 3,
    scanTimeMs: 42,
    directories: [
      { name: 'project', relativePath: '.', fileCount: 1, dirCount: 2, maxDepth: 3 },
      { name: 'src', relativePath: 'src', fileCount: 8, dirCount: 1, maxDepth: 2 },
    ],
    largestFiles: [
      { path: 'src/main.ts', bytes: 8192, lines: 200 },
    ],
  };

  const output = formatWorkspaceStats(stats);

  assert.match(output, /📊 工作区项目统计/);
  assert.match(output, /\/test\/project/);
  assert.match(output, /总文件数: 13/);
  assert.match(output, /总代码行: 550/);
  assert.match(output, /\.ts/);
  assert.match(output, /\.json/);
  assert.match(output, /src\/main\.ts/);
  assert.match(output, /42ms/);
});

test('formatWorkspaceStats 格式化失败结果', () => {
  const stats: WorkspaceStats = {
    success: false,
    errorMessage: '目录不存在',
  };

  const output = formatWorkspaceStats(stats);
  assert.match(output, /统计失败/);
  assert.match(output, /目录不存在/);
});

test('formatWorkspaceStats 空项目统计正常显示', () => {
  const stats: WorkspaceStats = {
    success: true,
    rootPath: '/empty',
    byExtension: {},
    totalFiles: 0,
    totalLines: 0,
    totalBytes: 0,
    maxDepth: 0,
    scanTimeMs: 5,
    directories: [],
    largestFiles: [],
  };

  const output = formatWorkspaceStats(stats);
  assert.match(output, /总文件数: 0/);
  assert.match(output, /总代码行: 0/);
});
