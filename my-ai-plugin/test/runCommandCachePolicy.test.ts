/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldInvalidateFileReadStateAfterCommand } from '../src/tools/runCommandCachePolicy';

test('shouldInvalidateFileReadStateAfterCommand: git diff 不清缓存', () => {
  assert.equal(
    shouldInvalidateFileReadStateAfterCommand('cd /d "d:\\proj" && git diff circle_match_oob/run_and_check.py'),
    false,
  );
  assert.equal(
    shouldInvalidateFileReadStateAfterCommand('git diff --stat file.py'),
    false,
  );
});

test('shouldInvalidateFileReadStateAfterCommand: 可能改文件的命令仍清缓存', () => {
  assert.equal(shouldInvalidateFileReadStateAfterCommand('npm install'), true);
  assert.equal(shouldInvalidateFileReadStateAfterCommand('git checkout main'), true);
  assert.equal(shouldInvalidateFileReadStateAfterCommand('python scripts/build.py'), true);
});
