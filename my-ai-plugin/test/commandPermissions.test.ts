/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_PERMISSIONS_ENV_KEY,
  getCommandPermissionsSettingValue,
} from '../src/config';
import {
  globPatternToRegExp,
  hasShellRedirect,
  loadCommandPermissionsConfig,
  matchesCommandGlob,
  parseCommandPermissionsConfig,
  setCommandPermissionsForTesting,
  splitCommandChain,
  validateCommand,
  validateCommandSegment,
} from '../src/tools/commandPermissions';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

test('parseCommandPermissionsConfig 解析 allow/deny/allowRedirects', () => {
  const config = parseCommandPermissionsConfig({
    allow: ['npm *', 'echo *'],
    deny: ['rm*'],
    allowRedirects: true,
  });

  assert.deepEqual(config.allow, ['npm *', 'echo *']);
  assert.deepEqual(config.deny, ['rm*']);
  assert.equal(config.allowRedirects, true);
});

test('matchesCommandGlob 支持 * 通配', () => {
  assert.equal(matchesCommandGlob('npm *', 'npm install'), true);
  assert.equal(matchesCommandGlob('rm*', 'rm -rf tmp'), true);
  assert.equal(matchesCommandGlob('echo *', 'npm install'), false);
});

test('validateCommand deny 列表拦截匹配命令', () => {
  const result = validateCommand('rm -rf node_modules', { deny: ['rm*'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /deny/i);
});

test('validateCommand allow 白名单仅放行匹配项', () => {
  const allowed = validateCommand('npm test', { allow: ['npm *'] });
  assert.equal(allowed.allowed, true);

  const denied = validateCommand('git status', { allow: ['npm *'] });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /allow/i);
});

test('validateCommand 链式命令任一段失败则整体拒绝', () => {
  const result = validateCommand('echo ok && rm -rf tmp', { deny: ['rm*'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /rm -rf tmp/);
});

test('splitCommandChain 忽略引号内的运算符', () => {
  const segments = splitCommandChain('echo "a && b" && npm test');
  assert.deepEqual(segments, ['echo "a && b"', 'npm test']);
});

test('validateCommand 默认禁止 shell 重定向', () => {
  const result = validateCommand('echo hello > out.txt', {});
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /重定向/);
  assert.equal(hasShellRedirect('echo hello > out.txt'), true);
});

test('validateCommand allowRedirects=true 时允许重定向', () => {
  const result = validateCommand('echo hello > out.txt', { allowRedirects: true });
  assert.equal(result.allowed, true);
});

test('validateCommand 对接内置危险命令模式', () => {
  const result = validateCommand('rm -rf /', {});
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /危险/);
});

test('loadCommandPermissionsConfig 使用注入配置（模拟环境变量加载结果）', () => {
  const envLike = parseCommandPermissionsConfig(
    JSON.parse('{"allow":["npm *"],"deny":["curl *"],"allowRedirects":false}'),
  );
  setCommandPermissionsForTesting(envLike);

  try {
    const loaded = loadCommandPermissionsConfig();
    assert.deepEqual(loaded, envLike);
    assert.equal(validateCommand('npm run build', loaded).allowed, true);
    assert.equal(validateCommand('curl https://example.com', loaded).allowed, false);
  } finally {
    setCommandPermissionsForTesting(null);
  }
});

test('getCommandPermissionsSettingValue 回退到 VS Code 设置', () => {
  const originalGet = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (_key: string, defaultValue: unknown) => ({
      deny: ['format *'],
      allowRedirects: false,
    }),
  });

  try {
    const raw = getCommandPermissionsSettingValue();
    const parsed = parseCommandPermissionsConfig(raw);
    assert.deepEqual(parsed.deny, ['format *']);
    assert.equal(parsed.allowRedirects, false);
    assert.equal(
      validateCommandSegment('format C:', parsed).allowed,
      false,
    );
  } finally {
    vscode.workspace.getConfiguration = originalGet;
  }

  assert.equal(COMMAND_PERMISSIONS_ENV_KEY, 'MY_AI_PLUGIN_COMMAND_PERMISSIONS');
});

test('globPatternToRegExp 生成大小写不敏感匹配', () => {
  assert.equal(globPatternToRegExp('npm*').test('NPM install'), true);
});
