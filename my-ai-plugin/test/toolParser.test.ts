/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasToolCalls, parseToolCalls, stripToolCalls } from '../src/tools/toolParser';

test('parseToolCalls 会忽略 fenced code block 中的工具 XML，只解析代码块外调用', () => {
  const content = [
    '先展示一个示例：',
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
    '',
    '<tool_call><read_file path="src/real.ts" /></tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'read_file');
  assert.equal(parsed[0].path, 'src/real.ts');
});

test('parseToolCalls 在工具 XML 只存在于 fenced code block 中时回退到全文解析', () => {
  const content = [
    '首先列出目录：',
    '```xml',
    '<list_dir path="miniprogram" />',
    '```',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'list_dir');
  assert.equal(parsed[0].path, 'miniprogram');
});

test('hasToolCalls 在工具 XML 只存在于 fenced code block 中时回退返回 true（兼容模型包裹真实调用）', () => {
  const content = [
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
  ].join('\n');

  // 代码块外没有工具调用时回退到全文检测，返回 true
  assert.equal(hasToolCalls(content), true);
});

test('stripToolCalls 会保留 fenced code block 中的示例 XML，只剥离代码块外调用', () => {
  const content = [
    '先展示一个示例：',
    '```xml',
    '<tool_call><read_file path="demo/example.ts" /></tool_call>',
    '```',
    '',
    '下面执行真实调用：',
    '<tool_call><read_file path="src/real.ts" /></tool_call>',
  ].join('\n');

  const stripped = stripToolCalls(content);

  assert.match(stripped, /<tool_call><read_file path="demo\/example\.ts" \/><\/tool_call>/);
  assert.match(stripped, /```xml/);
  assert.doesNotMatch(stripped, /src\/real\.ts/);
});

// ─── ast_edit 解析测试 ────────────────────────────────────

test('parseToolCalls 能解析 JSON 格式的 ast_edit 工具调用', () => {
  const content = [
    '<tool_call>',
    '<ast_edit path="src/demo.ts" action="add_import">',
    '{"modulePath": "./utils", "namedImports": ["foo", "bar"]}',
    '</ast_edit>',
    '</tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'ast_edit');
  assert.equal(parsed[0].path, 'src/demo.ts');
  assert.equal(parsed[0].astAction, 'add_import');
  assert.deepEqual(parsed[0].astParams, {
    modulePath: './utils',
    namedImports: ['foo', 'bar'],
  });
});

test('parseToolCalls 能解析 <param> 标签格式的 ast_edit 工具调用', () => {
  const content = [
    '<ast_edit path="src/demo.ts" action="add_import">',
    '<param name="modulePath">./utils</param>',
    '<param name="namedImports">foo,bar</param>',
    '</ast_edit>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'ast_edit');
  assert.equal(parsed[0].astAction, 'add_import');
  assert.equal((parsed[0].astParams as Record<string, unknown>)['modulePath'], './utils');
  assert.deepEqual((parsed[0].astParams as Record<string, unknown>)['namedImports'], ['foo', 'bar']);
});

test('parseToolCalls 解析 ast_edit 的 rename_symbol（JSON 含数字参数）', () => {
  const content = [
    '<tool_call>',
    '<ast_edit path="src/demo.ts" action="rename_symbol">',
    '{"oldName": "foo", "newName": "bar", "line": 10, "column": 5}',
    '</ast_edit>',
    '</tool_call>',
  ].join('\n');

  const parsed = parseToolCalls(content);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].astAction, 'rename_symbol');
  const params = parsed[0].astParams as Record<string, unknown>;
  assert.equal(params['oldName'], 'foo');
  assert.equal(params['newName'], 'bar');
  assert.equal(params['line'], 10);
  assert.equal(params['column'], 5);
});

test('hasToolCalls 能检测 ast_edit 标签', () => {
  assert.equal(hasToolCalls('<ast_edit path="x" action="add_import">{"modulePath":"y"}</ast_edit>'), true);
});

test('stripToolCalls 能清除 ast_edit 标签', () => {
  const content = '一些文字\n<ast_edit path="x" action="add_import">{"modulePath":"y"}</ast_edit>\n结束';
  const stripped = stripToolCalls(content);
  assert.doesNotMatch(stripped, /ast_edit/);
  assert.match(stripped, /一些文字/);
  assert.match(stripped, /结束/);
});

test('stripToolCalls 剥离代码块内工具调用后不应残留空围栏', () => {
  // 模型把 read_file 包在 ```xml 代码块里
  const content = [
    '我来读取这个文件：',
    '```xml',
    '<read_file path="src/index.ts" />',
    '```',
  ].join('\n');

  const stripped = stripToolCalls(content);
  // 不应包含空代码围栏
  assert.doesNotMatch(stripped, /```/);
  assert.match(stripped, /我来读取这个文件/);
});

test('stripToolCalls 纯代码块内工具调用全剥离后结果应为空或纯文本', () => {
  // 模型回复仅含代码块内的工具调用，无其他文字
  const content = '```\n<tool_call><read_file path="a.ts" /></tool_call>\n```';
  const stripped = stripToolCalls(content);
  // 不应残留空代码块
  assert.doesNotMatch(stripped, /```/);
});

test('parseToolCalls 能解析带 replace_all 属性的 edit_file', () => {
  const content = '<tool_call><edit_file path="src/a.ts" replace_all="true"><old>foo</old><new>bar</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'edit_file');
  assert.equal(calls[0].path, 'src/a.ts');
  assert.equal(calls[0].oldContent, 'foo');
  assert.equal(calls[0].newContent, 'bar');
  assert.equal(calls[0].replaceAll, true);
});

test('parseToolCalls 不带 replace_all 属性时 replaceAll 为 undefined', () => {
  const content = '<tool_call><edit_file path="src/a.ts"><old>foo</old><new>bar</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].replaceAll, undefined);
});

test('parseToolCalls replace_all="false" 时 replaceAll 为 undefined', () => {
  const content = '<tool_call><edit_file path="src/a.ts" replace_all="false"><old>foo</old><new>bar</new></edit_file></tool_call>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].replaceAll, undefined, 'replace_all="false" 不应设置 replaceAll');
});

test('parseToolCalls 能解析 run_command（带 tool_call 包裹）', () => {
  const content = '<tool_call><run_command>npm install</run_command></tool_call>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'run_command');
  assert.equal(calls[0].command, 'npm install');
  assert.equal(calls[0].timeout, undefined);
});

test('parseToolCalls 能解析带 timeout 属性的 run_command', () => {
  const content = '<tool_call><run_command timeout="60000">npm run build</run_command></tool_call>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'run_command');
  assert.equal(calls[0].command, 'npm run build');
  assert.equal(calls[0].timeout, 60000);
});

test('parseToolCalls 能解析裸 run_command 标签', () => {
  const content = '<run_command>git status</run_command>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'run_command');
  assert.equal(calls[0].command, 'git status');
});

test('parseToolCalls write_file 内容包含 HTML/XML 关闭标签时不会被截断', () => {
  const htmlContent = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><script src="app.js"></script></head>',
    '<body>',
    '<div class="app">',
    '<script>',
    '  console.log("hello");',
    '</script>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
  const content = `<tool_call><write_file path="index.html">${htmlContent}</write_file>`;
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'write_file');
  assert.equal(calls[0].path, 'index.html');
  assert.ok(calls[0].content!.includes('</script>'), 'content 应包含 </script> 标签');
  assert.ok(calls[0].content!.includes('</div>'), 'content 应包含 </div> 标签');
  assert.ok(calls[0].content!.includes('</html>'), 'content 应包含 </html> 标签');
  assert.equal(calls[0].content, htmlContent, 'content 应与原始 HTML 完全一致');
});

test('parseToolCalls edit_file 的 old/new 内容包含 XML 标签时不被截断', () => {
  const content = [
    '<tool_call>',
    '<edit_file path="src/App.vue">',
    '<old>    <div class="old">text</div></old>',
    '<new>    <div class="new">updated</div></new>',
    '</edit_file>',
    '',
  ].join('\n');
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'edit_file');
  assert.equal(calls[0].oldContent, '    <div class="old">text</div>');
  assert.equal(calls[0].newContent, '    <div class="new">updated</div>');
});

test('stripToolCalls 能剥离内容含 XML 标签的 write_file', () => {
  const content = [
    '我来创建页面：',
    '<tool_call><write_file path="a.html"><html><body><script>x=1</script></body></html></write_file>',
    '创建完成。',
  ].join('\n');
  const stripped = stripToolCalls(content);
  assert.doesNotMatch(stripped, /write_file/);
  assert.doesNotMatch(stripped, /<html>/);
  assert.match(stripped, /我来创建页面/);
  assert.match(stripped, /创建完成/);
});

test('parseToolCalls run_command 命令内容包含 XML 样式的字符串时不被截断', () => {
  const content = '<tool_call><run_command>echo "<div>hello</div>" > file.txt</run_command>';
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'run_command');
  assert.equal(calls[0].command, 'echo "<div>hello</div>" > file.txt');
});

test('stripToolCalls 能正确剥离 run_command 标签', () => {
  const content = '我来执行安装命令：<tool_call><run_command>npm install</run_command></tool_call>\n安装完成。';
  const stripped = stripToolCalls(content);
  assert.doesNotMatch(stripped, /run_command/);
  assert.match(stripped, /我来执行安装命令/);
  assert.match(stripped, /安装完成/);
});
