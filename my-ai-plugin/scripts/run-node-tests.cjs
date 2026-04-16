const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function collectTestFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  let collectedFiles = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectedFiles = collectedFiles.concat(collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      collectedFiles.push(fullPath);
    }
  }

  return collectedFiles;
}

const testsDirectoryPath = path.resolve(__dirname, '..', '.test-dist', 'test');
const testFiles = collectTestFiles(testsDirectoryPath);

if (testFiles.length === 0) {
  console.error('未找到已编译的测试文件，请先执行 npm run test:build。');
  process.exit(1);
}

const vscodeMockPath = path.resolve(__dirname, 'vscode-mock.cjs');
const runResult = spawnSync(process.execPath, ['--require', vscodeMockPath, '--test', ...testFiles], {
  stdio: 'inherit',
});

process.exit(runResult.status ?? 1);
