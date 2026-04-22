/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeFile, editFile, readFile } from '../src/tools/fileOps';

// 创建临时目录，测试结束后清理
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-e2e-'));

// 需要 mock 掉 resolveAndValidatePath，因为它依赖 vscode.workspace
// 这里直接测试底层纯函数 + 真实文件读写的组合逻辑
// 由于 writeFile/editFile/readFile 内部调用 resolveAndValidatePath，
// 而测试环境没有 vscode workspace，所以改为直接测试文件操作的核心逻辑

import { buildEditedContent, buildLineBasedEditContent } from '../src/tools/fileOps';

// ==================== 端到端：真实文件写入 + 文本匹配编辑 ====================

test('E2E: 写入文件后用文本匹配模式编辑', () => {
  const filePath = path.join(tmpDir, 'test_edit_text.ts');

  // 写入初始文件
  const initial = [
    'function greet(name: string) {',
    '  return "Hello, " + name;',
    '}',
    '',
    'export default greet;',
  ].join('\n');
  fs.writeFileSync(filePath, initial, 'utf-8');

  // 验证文件写入成功
  const written = fs.readFileSync(filePath, 'utf-8');
  assert.equal(written, initial);

  // 用 buildEditedContent 做文本匹配编辑
  const editResult = buildEditedContent(
    written,
    '  return "Hello, " + name;',
    '  return `Hello, ${name}!`;',
  );
  assert.equal(editResult.success, true);
  if (!editResult.success) { return; }

  // 写回文件
  fs.writeFileSync(filePath, editResult.updatedContent, 'utf-8');

  // 验证文件内容
  const edited = fs.readFileSync(filePath, 'utf-8');
  assert.ok(edited.includes('`Hello, ${name}!`'), '模板字符串替换应成功');
  assert.ok(!edited.includes('"Hello, "'), '原始字符串拼接应被替换');
  assert.ok(edited.includes('export default greet;'), '其他代码应保持不变');
});

// ==================== 端到端：写入文件后用行号模式编辑 ====================

test('E2E: 写入文件后用行号模式编辑', () => {
  const filePath = path.join(tmpDir, 'test_edit_line.vue');

  // 写入初始 Vue 文件
  const initial = [
    '<template>',
    '  <div class="login">',
    '    <h1>登录</h1>',
    '    <input v-model="username" placeholder="用户名" />',
    '    <input v-model="password" type="password" placeholder="密码" />',
    '    <button @click="login">登录</button>',
    '  </div>',
    '</template>',
  ].join('\n');
  fs.writeFileSync(filePath, initial, 'utf-8');

  // 用行号模式在第 6 行（button 行）后插入 QQ 登录按钮
  // 替换第 6 行为两行
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lineResult = buildLineBasedEditContent(
    fileContent,
    6, 6,
    '    <button @click="login">登录</button>\n    <button @click="qqLogin">QQ 登录</button>',
  );
  assert.equal(lineResult.success, true);
  if (!lineResult.success) { return; }

  fs.writeFileSync(filePath, lineResult.updatedContent, 'utf-8');

  // 验证
  const edited = fs.readFileSync(filePath, 'utf-8');
  assert.ok(edited.includes('QQ 登录'), 'QQ 登录按钮应被添加');
  assert.ok(edited.includes('@click="login"'), '原登录按钮应保留');
  assert.ok(edited.includes('<h1>登录</h1>'), '标题应保持不变');
  assert.ok(edited.includes('</template>'), '模板结束标签应保留');
});

// ==================== 端到端：replace_all 全局替换 ====================

test('E2E: replace_all 全局替换变量名', () => {
  const filePath = path.join(tmpDir, 'test_replace_all.ts');

  const initial = [
    'const userName = "test";',
    'function greet(userName: string) {',
    '  console.log(userName);',
    '  return userName.toUpperCase();',
    '}',
  ].join('\n');
  fs.writeFileSync(filePath, initial, 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildEditedContent(fileContent, 'userName', 'displayName', { replaceAll: true });

  assert.equal(result.success, true);
  if (!result.success) { return; }

  fs.writeFileSync(filePath, result.updatedContent, 'utf-8');

  const edited = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!edited.includes('userName'), '所有 userName 应被替换');
  assert.equal((edited.match(/displayName/g) || []).length, 4, '应有 4 处 displayName');
});

// ==================== 端到端：CRLF 文件编辑 ====================

test('E2E: CRLF 文件的文本匹配编辑保持换行风格', () => {
  const filePath = path.join(tmpDir, 'test_crlf.ts');

  // 写入 CRLF 文件
  const initial = 'line1\r\nline2\r\nline3\r\n';
  fs.writeFileSync(filePath, initial, 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // 用 LF 风格的 old 匹配 CRLF 文件（应通过归一化匹配）
  const result = buildEditedContent(fileContent, 'line2\n', 'LINE2_REPLACED\n');
  assert.equal(result.success, true);
  if (!result.success) { return; }
  assert.equal(result.usedNormalizedMatch, true);

  fs.writeFileSync(filePath, result.updatedContent, 'utf-8');

  const edited = fs.readFileSync(filePath, 'utf-8');
  assert.ok(edited.includes('LINE2_REPLACED'), '替换应成功');
  assert.ok(edited.includes('\r\n'), 'CRLF 风格应保留');
});

// ==================== 端到端：行号模式 CRLF ====================

test('E2E: CRLF 文件的行号模式编辑保持换行风格', () => {
  const filePath = path.join(tmpDir, 'test_crlf_line.ts');

  const initial = 'aaa\r\nbbb\r\nccc\r\n';
  fs.writeFileSync(filePath, initial, 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildLineBasedEditContent(fileContent, 2, 2, 'BBB');
  assert.equal(result.success, true);
  if (!result.success) { return; }

  fs.writeFileSync(filePath, result.updatedContent, 'utf-8');

  const edited = fs.readFileSync(filePath, 'utf-8');
  assert.equal(edited, 'aaa\r\nBBB\r\nccc\r\n');
});

// ==================== 端到端：编辑失败场景 ====================

test('E2E: 文本匹配未命中返回 not-found', () => {
  const filePath = path.join(tmpDir, 'test_not_found.ts');
  fs.writeFileSync(filePath, 'hello world', 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildEditedContent(fileContent, 'no match here', 'new');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'not-found');

  // 文件应未被修改
  const unchanged = fs.readFileSync(filePath, 'utf-8');
  assert.equal(unchanged, 'hello world');
});

test('E2E: 多处匹配且未开启 replace_all 返回 not-unique', () => {
  const filePath = path.join(tmpDir, 'test_not_unique.ts');
  fs.writeFileSync(filePath, 'foo bar foo baz foo', 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildEditedContent(fileContent, 'foo', 'qux');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'not-unique');
  assert.equal(result.matchCount, 3);
});

test('E2E: 行号超出范围返回 invalid-range', () => {
  const filePath = path.join(tmpDir, 'test_invalid_range.ts');
  fs.writeFileSync(filePath, 'line1\nline2\n', 'utf-8');

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildLineBasedEditContent(fileContent, 10, 12, 'x');
  assert.equal(result.success, false);
  if (result.success) { return; }
  assert.equal(result.reason, 'invalid-range');
});

// ==================== 清理临时目录 ====================

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});
