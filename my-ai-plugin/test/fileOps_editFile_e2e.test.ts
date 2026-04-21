/// <reference types="node" />
/**
 * editFile 端到端集成测试
 *
 * 模拟完整的 "读文件 → buildEditedContent 匹配 → 写回 → 验证" 流程。
 * 使用临时目录，测试覆盖：
 * - 精确匹配编辑
 * - Level 2 换行归一化编辑
 * - Level 3 行首空白容错编辑（Vue 文件典型场景）
 * - 模型幻觉导致的 not-found 失败
 * - 多处匹配导致的 not-unique 失败
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildEditedContent } from '../src/tools/fileOps';

/** 在临时目录中创建文件并返回绝对路径 */
function createTempFile(fileName: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-e2e-'));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** 模拟完整 editFile 流程：读 → 匹配 → 写回 */
function simulateEditFile(
  filePath: string,
  oldContent: string,
  newContent: string,
): { success: boolean; reason?: string; matchCount?: number } {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const result = buildEditedContent(fileContent, oldContent, newContent);

  if (!result.success) {
    return { success: false, reason: result.reason, matchCount: result.matchCount };
  }

  fs.writeFileSync(filePath, result.updatedContent, 'utf-8');
  return { success: true };
}

// ==================== 精确匹配 ====================

test('E2E editFile: 精确匹配 — 替换 JS 文件中的函数体', () => {
  const original = [
    'function greet(name) {',
    '  return "Hello, " + name;',
    '}',
    '',
    'module.exports = { greet };',
  ].join('\n');
  const filePath = createTempFile('greet.js', original);

  const result = simulateEditFile(
    filePath,
    '  return "Hello, " + name;',
    '  return `Hello, ${name}!`;',
  );

  assert.equal(result.success, true);
  const updated = fs.readFileSync(filePath, 'utf-8');
  assert.ok(updated.includes('`Hello, ${name}!`'), '替换内容应写入文件');
  assert.ok(updated.includes('module.exports'), '文件其余部分应保留');
  assert.ok(!updated.includes('"Hello, "'), '旧内容不应残留');

  // 清理
  fs.rmSync(path.dirname(filePath), { recursive: true });
});

// ==================== Level 2 换行归一化 ====================

test('E2E editFile: CRLF 文件 + LF old 仍能匹配并写回', () => {
  const original = 'line1\r\nline2\r\nline3\r\n';
  const filePath = createTempFile('crlf.txt', original);

  const result = simulateEditFile(filePath, 'line2\n', 'REPLACED\n');

  assert.equal(result.success, true);
  const updated = fs.readFileSync(filePath, 'utf-8');
  assert.ok(updated.includes('REPLACED'), '替换内容应写入');
  assert.ok(updated.includes('\r\n'), '文件应保持 CRLF');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});

// ==================== Level 3 白空格容错 — Vue 文件场景 ====================

test('E2E editFile: Vue 文件缩进不同 — Level 3 容错匹配成功', () => {
  // 真实 Vue 文件用 4 空格缩进
  const vueContent = [
    '<template>',
    '    <div class="login-page">',
    '        <h1>用户登录</h1>',
    '        <form @submit.prevent="handleLogin">',
    '            <input v-model="username" placeholder="用户名" />',
    '            <input v-model="password" type="password" placeholder="密码" />',
    '            <button type="submit">登录</button>',
    '        </form>',
    '    </div>',
    '</template>',
    '',
    '<script>',
    'export default {',
    '    data() {',
    '        return {',
    '            username: "",',
    '            password: "",',
    '        };',
    '    },',
    '    methods: {',
    '        handleLogin() {',
    '            console.log("login");',
    '        },',
    '    },',
    '};',
    '</script>',
  ].join('\n');
  const filePath = createTempFile('login.vue', vueContent);

  // 模型生成了 2 空格缩进的 old（缩进错误，但内容正确）
  const modelOld = [
    '      <button type="submit">登录</button>',
    '  </form>',
  ].join('\n');
  const modelNew = [
    '            <button type="submit">登录</button>',
    '            <button type="button" @click="handleQQLogin">QQ 登录</button>',
    '        </form>',
  ].join('\n');

  const result = simulateEditFile(filePath, modelOld, modelNew);

  assert.equal(result.success, true, 'Level 3 容错匹配应成功');
  const updated = fs.readFileSync(filePath, 'utf-8');
  assert.ok(updated.includes('QQ 登录'), '新增按钮应写入文件');
  assert.ok(updated.includes('handleQQLogin'), '事件处理器应写入');
  assert.ok(updated.includes('<h1>用户登录</h1>'), '文件其他部分应保留');
  assert.ok(updated.includes('handleLogin'), '原有方法应保留');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});

test('E2E editFile: Vue script 区域缩进不同 — Level 3 成功添加方法', () => {
  const vueContent = [
    '<script>',
    'export default {',
    '    methods: {',
    '        handleLogin() {',
    '            console.log("login");',
    '        },',
    '    },',
    '};',
    '</script>',
  ].join('\n');
  const filePath = createTempFile('login2.vue', vueContent);

  // 模型 old 没有缩进
  const modelOld = [
    'handleLogin() {',
    '    console.log("login");',
    '},',
  ].join('\n');
  const modelNew = [
    '        handleLogin() {',
    '            console.log("login");',
    '        },',
    '        handleQQLogin() {',
    '            window.open("https://qq.com/oauth");',
    '        },',
  ].join('\n');

  const result = simulateEditFile(filePath, modelOld, modelNew);

  assert.equal(result.success, true, 'Level 3 应成功匹配无缩进 old');
  const updated = fs.readFileSync(filePath, 'utf-8');
  assert.ok(updated.includes('handleQQLogin'), '新方法应写入');
  assert.ok(updated.includes('qq.com/oauth'), '方法体应正确');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});

// ==================== 失败场景 ====================

test('E2E editFile: 模型幻觉内容 — 返回 not-found', () => {
  const original = '<template>\n  <div>Hello</div>\n</template>\n';
  const filePath = createTempFile('hallucination.vue', original);

  // 模型幻觉了一段完全不存在的内容
  const result = simulateEditFile(
    filePath,
    '<div class="nonexistent">This does not exist</div>',
    '<div class="new">Replaced</div>',
  );

  assert.equal(result.success, false);
  assert.equal(result.reason, 'not-found');

  // 文件应未被修改
  const unchanged = fs.readFileSync(filePath, 'utf-8');
  assert.equal(unchanged, original, '文件不应被修改');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});

test('E2E editFile: 多处相同代码 — 返回 not-unique', () => {
  const original = [
    '<div class="item">Item 1</div>',
    '<div class="item">Item 2</div>',
    '<div class="item">Item 3</div>',
  ].join('\n');
  const filePath = createTempFile('duplicate.html', original);

  // old 匹配到多处
  const result = simulateEditFile(
    filePath,
    '<div class="item">',
    '<div class="item active">',
  );

  assert.equal(result.success, false);
  // 精确匹配出现 3 次 → not-unique
  assert.equal(result.reason, 'not-unique');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});

// ==================== 连续多次编辑 ====================

test('E2E editFile: 连续两次编辑同一文件', () => {
  const original = [
    'const a = 1;',
    'const b = 2;',
    'const c = 3;',
  ].join('\n');
  const filePath = createTempFile('multi-edit.js', original);

  // 第一次编辑
  const r1 = simulateEditFile(filePath, 'const a = 1;', 'const a = 10;');
  assert.equal(r1.success, true);

  // 第二次编辑（基于第一次编辑后的文件）
  const r2 = simulateEditFile(filePath, 'const c = 3;', 'const c = 30;');
  assert.equal(r2.success, true);

  const final = fs.readFileSync(filePath, 'utf-8');
  assert.ok(final.includes('const a = 10;'), '第一次编辑应保留');
  assert.ok(final.includes('const b = 2;'), '未修改行应保留');
  assert.ok(final.includes('const c = 30;'), '第二次编辑应写入');

  fs.rmSync(path.dirname(filePath), { recursive: true });
});
