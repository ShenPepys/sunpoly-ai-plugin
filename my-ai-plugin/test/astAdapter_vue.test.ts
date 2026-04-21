/// <reference types="node" />
/**
 * Vue SFC AST 适配器测试
 *
 * 测试 .vue 文件中 <script> 块的 AST 编辑功能：
 * - add_import: 在 <script> 中添加导入
 * - edit_function_body: 修改方法体
 * - add_object_property: 向对象添加属性
 * - 不同 <script> 变体（setup、lang="ts"、普通 JS）
 * - 无 <script> 块时的错误处理
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { vueAdapter } from '../src/tools/astAdapter_vue';
import { getOrCreateProject, disposeProject } from '../src/tools/astContext';
import type { AstEditRequest } from '../src/tools/astEditorTypes';

/** 在临时目录中创建 .vue 文件，返回 { filePath, workspaceRoot } */
function createVueTempFile(fileName: string, content: string): { filePath: string; workspaceRoot: string } {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ast-test-'));
  const filePath = path.join(workspaceRoot, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { filePath, workspaceRoot };
}

function cleanup(workspaceRoot: string): void {
  disposeProject(workspaceRoot);
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ==================== supportsFile ====================

test('vueAdapter.supportsFile 对 .vue 返回 true', () => {
  assert.equal(vueAdapter.supportsFile('login.vue'), true);
  assert.equal(vueAdapter.supportsFile('/path/to/App.vue'), true);
  assert.equal(vueAdapter.supportsFile('C:\\Project\\Home.VUE'), true);
});

test('vueAdapter.supportsFile 对非 .vue 文件返回 false', () => {
  assert.equal(vueAdapter.supportsFile('app.ts'), false);
  assert.equal(vueAdapter.supportsFile('index.html'), false);
  assert.equal(vueAdapter.supportsFile('style.css'), false);
});

// ==================== add_import ====================

test('Vue AST: add_import 在 <script> 中添加导入', async () => {
  const vueContent = [
    '<template>',
    '  <div>Hello</div>',
    '</template>',
    '',
    '<script>',
    'export default {',
    '  name: "Hello",',
    '};',
    '</script>',
    '',
    '<style scoped>',
    '.hello { color: red; }',
    '</style>',
  ].join('\n');

  const { filePath, workspaceRoot } = createVueTempFile('Hello.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'add_import',
      params: { modulePath: 'vue', namedImports: ['ref', 'computed'] },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, true);
    if (!result.success) { return; }

    assert.equal(result.files.length, 1);
    const vueFile = result.files[0];
    assert.equal(path.resolve(vueFile.filePath), path.resolve(filePath));

    // 新内容应包含 import 语句
    assert.ok(vueFile.newContent.includes('import'), '应包含 import');
    assert.ok(vueFile.newContent.includes('ref'), '应导入 ref');
    assert.ok(vueFile.newContent.includes('computed'), '应导入 computed');

    // template 和 style 应保留
    assert.ok(vueFile.newContent.includes('<template>'), '<template> 应保留');
    assert.ok(vueFile.newContent.includes('<div>Hello</div>'), '模板内容应保留');
    assert.ok(vueFile.newContent.includes('<style scoped>'), '<style> 应保留');
    assert.ok(vueFile.newContent.includes('.hello { color: red; }'), '样式应保留');
  } finally {
    cleanup(workspaceRoot);
  }
});

// ==================== edit_function_body ====================

test('Vue AST: edit_function_body 修改顶层函数体（Composition API 风格）', async () => {
  const vueContent = [
    '<template>',
    '  <button @click="handleLogin">登录</button>',
    '</template>',
    '',
    '<script>',
    'function handleLogin() {',
    '  console.log("login");',
    '}',
    '',
    'export default {',
    '  methods: { handleLogin },',
    '};',
    '</script>',
  ].join('\n');

  const { filePath, workspaceRoot } = createVueTempFile('Login.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'edit_function_body',
      params: { functionName: 'handleLogin', newBody: 'window.location.href = "/home";' },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, true);
    if (!result.success) { return; }

    const newContent = result.files[0].newContent;
    assert.ok(newContent.includes('window.location.href'), '新方法体应写入');
    assert.ok(!newContent.includes('console.log("login")'), '旧方法体应被替换');
    assert.ok(newContent.includes('<template>'), '<template> 应保留');
    assert.ok(newContent.includes('@click="handleLogin"'), '模板绑定应保留');
  } finally {
    cleanup(workspaceRoot);
  }
});

// ==================== <script lang="ts"> ====================

test('Vue AST: <script lang="ts"> TypeScript 语法正常处理', async () => {
  const vueContent = [
    '<template>',
    '  <div>{{ msg }}</div>',
    '</template>',
    '',
    '<script lang="ts">',
    'import { defineComponent } from "vue";',
    '',
    'export default defineComponent({',
    '  setup() {',
    '    const msg = "hello";',
    '    return { msg };',
    '  },',
    '});',
    '</script>',
  ].join('\n');

  const { filePath, workspaceRoot } = createVueTempFile('TypedComp.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'add_import',
      params: { modulePath: 'vue', namedImports: ['ref'] },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, true);
    if (!result.success) { return; }

    const newContent = result.files[0].newContent;
    // 应合并到已有的 vue import
    assert.ok(newContent.includes('ref'), '应导入 ref');
    assert.ok(newContent.includes('defineComponent'), '已有导入应保留');
    assert.ok(newContent.includes('<script lang="ts">'), '<script> 标签应保留');
  } finally {
    cleanup(workspaceRoot);
  }
});

// ==================== <script setup> ====================

test('Vue AST: <script setup> 块正常处理', async () => {
  const vueContent = [
    '<template>',
    '  <div>{{ count }}</div>',
    '</template>',
    '',
    '<script setup>',
    'import { ref } from "vue";',
    '',
    'const count = ref(0);',
    '',
    'function increment() {',
    '  count.value++;',
    '}',
    '</script>',
  ].join('\n');

  const { filePath, workspaceRoot } = createVueTempFile('Counter.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'insert_function',
      params: {
        functionCode: 'function decrement() {\n  count.value--;\n}',
        insertAfter: 'increment',
      },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, true);
    if (!result.success) { return; }

    const newContent = result.files[0].newContent;
    assert.ok(newContent.includes('decrement'), '新函数应插入');
    assert.ok(newContent.includes('count.value--'), '函数体应正确');
    assert.ok(newContent.includes('increment'), '原函数应保留');
    assert.ok(newContent.includes('<script setup>'), '<script setup> 标签应保留');
  } finally {
    cleanup(workspaceRoot);
  }
});

// ==================== 错误场景 ====================

test('Vue AST: 无 <script> 块时返回失败', async () => {
  const vueContent = [
    '<template>',
    '  <div>纯模板</div>',
    '</template>',
    '',
    '<style>',
    'div { color: blue; }',
    '</style>',
  ].join('\n');

  const { filePath, workspaceRoot } = createVueTempFile('NoScript.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'add_import',
      params: { modulePath: 'vue', namedImports: ['ref'] },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, false);
    if (result.success) { return; }
    assert.ok(result.reason.includes('未找到'), '错误信息应提示未找到 script 块');
  } finally {
    cleanup(workspaceRoot);
  }
});

test('Vue AST: <script> 块内容为空时返回失败', async () => {
  const vueContent = '<template><div></div></template>\n<script>\n</script>\n';
  const { filePath, workspaceRoot } = createVueTempFile('Empty.vue', vueContent);
  getOrCreateProject(workspaceRoot);

  try {
    const request: AstEditRequest = {
      workspaceRoot,
      filePath,
      action: 'add_import',
      params: { modulePath: 'vue', namedImports: ['ref'] },
    };

    const result = await vueAdapter.execute(request, vueContent);

    assert.equal(result.success, false);
    if (result.success) { return; }
    assert.ok(result.reason.includes('为空'), '错误信息应提示内容为空');
  } finally {
    cleanup(workspaceRoot);
  }
});
