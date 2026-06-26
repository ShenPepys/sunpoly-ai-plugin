/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildToolCallExecutionPlan, shouldForceAstForEditFile } from '../src/webview/fileChanges';
import type { ParsedToolCall } from '../src/tools/toolParser';

function makeToolCall(overrides: Partial<ParsedToolCall> & Pick<ParsedToolCall, 'type' | 'path'>): ParsedToolCall {
  return {
    rawMatch: `<${overrides.type}>`,
    ...overrides,
  } as ParsedToolCall;
}

test('buildToolCallExecutionPlan: 只读工具超过上限时延后后续读取', () => {
  const toolCalls: ParsedToolCall[] = [
    makeToolCall({ type: 'read_file', path: 'src/a.ts' }),
    makeToolCall({ type: 'read_file', path: 'src/b.ts' }),
    makeToolCall({ type: 'read_file', path: 'src/c.ts' }),
    makeToolCall({ type: 'read_file', path: 'src/d.ts' }),
  ];

  const plan = buildToolCallExecutionPlan(toolCalls);

  assert.equal(plan.executableToolCalls.length, 3);
  assert.equal(plan.deferredToolCalls.length, 1);
  assert.equal(plan.readOnlyBatchLimited, true);
  assert.equal(plan.sameFileToolCallLimited, false);
  assert.equal(plan.deferredToolCalls[0].path, 'src/d.ts');
});

test('buildToolCallExecutionPlan: 同一文件第一次写入后，后续工具调用延后到下一轮', () => {
  const filePath = 'miniprogram/pages/login/login.vue';
  const toolCalls: ParsedToolCall[] = [
    makeToolCall({ type: 'read_file', path: filePath }),
    makeToolCall({
      type: 'ast_edit',
      path: filePath,
      astAction: 'edit_function_body',
      astParams: {
        functionName: 'onWechatLogin',
        newBody: 'return;',
      },
    }),
    makeToolCall({ type: 'read_file', path: filePath }),
    makeToolCall({
      type: 'edit_file',
      path: filePath,
      astBypass: true,
      startLine: 10,
      endLine: 12,
      newContent: '<button>QQ 登录</button>',
    }),
    makeToolCall({ type: 'read_file', path: 'src/other.ts' }),
  ];

  const plan = buildToolCallExecutionPlan(toolCalls);

  assert.equal(plan.sameFileToolCallLimited, true);
  assert.equal(plan.readOnlyBatchLimited, false);
  assert.equal(plan.executableToolCalls.length, 3);
  assert.equal(plan.deferredToolCalls.length, 2);

  assert.deepEqual(
    plan.executableToolCalls.map(toolCall => `${toolCall.type}:${toolCall.path}`),
    [
      `read_file:${filePath}`,
      `ast_edit:${filePath}`,
      'read_file:src/other.ts',
    ],
  );

  assert.deepEqual(
    plan.deferredToolCalls.map(toolCall => `${toolCall.type}:${toolCall.path}`),
    [
      `read_file:${filePath}`,
      `edit_file:${filePath}`,
    ],
  );
});

test('buildToolCallExecutionPlan: 纯只读批次中重复 read_file 会被自动合并', () => {
  const filePath = 'miniprogram/pages/login/login.vue';
  const toolCalls: ParsedToolCall[] = [
    makeToolCall({ type: 'read_file', path: filePath }),
    makeToolCall({ type: 'read_file', path: filePath }),
    makeToolCall({ type: 'read_file', path: filePath }),
    makeToolCall({ type: 'read_file', path: 'src/app.ts' }),
  ];

  const plan = buildToolCallExecutionPlan(toolCalls);

  assert.equal(plan.duplicateReadOnlyToolCallsSkippedCount, 2);
  assert.equal(plan.readOnlyBatchLimited, false);
  assert.equal(plan.sameFileToolCallLimited, false);
  assert.deepEqual(
    plan.executableToolCalls.map(toolCall => `${toolCall.type}:${toolCall.path}`),
    [
      `read_file:${filePath}`,
      'read_file:src/app.ts',
    ],
  );
  assert.deepEqual(plan.deferredToolCalls, []);
});

test('shouldForceAstForEditFile: .vue 模板修改不强制 AST', () => {
  const filePath = 'miniprogram/pages/login/login.vue';
  const content = [
    '<template>',
    '  <view class="login-page">',
    '    <button class="wechat-btn">微信登录</button>',
    '  </view>',
    '</template>',
    '',
    '<script>',
    'export default {',
    '  methods: {',
    '    onWechatLogin() {',
    '      return true;',
    '    }',
    '  }',
    '}',
    '</script>',
  ].join('\n');

  const toolCall = makeToolCall({
    type: 'edit_file',
    path: filePath,
    oldContent: '<button class="wechat-btn">微信登录</button>',
    newContent: '<button class="wechat-btn">QQ登录</button>',
  });

  assert.equal(shouldForceAstForEditFile(toolCall, filePath, content), false);
});

test('shouldForceAstForEditFile: .vue script 块文本修改强制 AST', () => {
  const filePath = 'miniprogram/pages/login/login.vue';
  const content = [
    '<template>',
    '  <view class="login-page"></view>',
    '</template>',
    '',
    '<script>',
    'export default {',
    '  methods: {',
    '    onWechatLogin() {',
    '      return true;',
    '    }',
    '  }',
    '}',
    '</script>',
  ].join('\n');

  const toolCall = makeToolCall({
    type: 'edit_file',
    path: filePath,
    oldContent: '    onWechatLogin() {\n      return true;\n    }',
    newContent: '    onWechatLogin() {\n      return false;\n    }',
  });

  assert.equal(shouldForceAstForEditFile(toolCall, filePath, content), true);
});

test('shouldForceAstForEditFile: .vue 无 script 块时不强制 AST', () => {
  const filePath = 'miniprogram/pages/login/login.vue';
  const content = [
    '<template>',
    '  <view class="login-page">纯模板页面</view>',
    '</template>',
  ].join('\n');

  const toolCall = makeToolCall({
    type: 'edit_file',
    path: filePath,
    startLine: 2,
    endLine: 2,
    newContent: '  <view class="login-page">修复后的模板页面</view>',
  });

  assert.equal(shouldForceAstForEditFile(toolCall, filePath, content), false);
});
