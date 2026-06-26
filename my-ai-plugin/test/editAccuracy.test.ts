/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addLineNumbers,
  findClosestMatch,
  buildEditedContent,
  buildLineBasedEditContent,
} from '../src/tools/fileOps';

// ==================== addLineNumbers 行号格式化 ====================

test('addLineNumbers: 基本格式——右对齐行号 + tab', () => {
  const content = 'line1\nline2\nline3';
  const result = addLineNumbers(content);
  const lines = result.split('\n');

  assert.equal(lines.length, 3);
  assert.equal(lines[0], '1\tline1');
  assert.equal(lines[1], '2\tline2');
  assert.equal(lines[2], '3\tline3');
});

test('addLineNumbers: 超过 9 行时行号列宽自动扩展为 2 位', () => {
  const lines = Array.from({ length: 15 }, (_, i) => `code_${i + 1}`);
  const result = addLineNumbers(lines.join('\n'));
  const outputLines = result.split('\n');

  // 第 1 行应为 " 1\tcode_1"（右对齐 2 位）
  assert.equal(outputLines[0], ' 1\tcode_1');
  // 第 9 行应为 " 9\tcode_9"
  assert.equal(outputLines[8], ' 9\tcode_9');
  // 第 10 行应为 "10\tcode_10"
  assert.equal(outputLines[9], '10\tcode_10');
  // 第 15 行应为 "15\tcode_15"
  assert.equal(outputLines[14], '15\tcode_15');
});

test('addLineNumbers: 超过 99 行时行号列宽自动扩展为 3 位', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `x${i}`);
  const result = addLineNumbers(lines.join('\n'));
  const outputLines = result.split('\n');

  assert.equal(outputLines[0], '  1\tx0');
  assert.equal(outputLines[98], ' 99\tx98');
  assert.equal(outputLines[99], '100\tx99');
  assert.equal(outputLines[119], '120\tx119');
});

test('addLineNumbers: 空内容返回单行行号', () => {
  const result = addLineNumbers('');
  assert.equal(result, '1\t');
});

test('addLineNumbers: 空行也保留行号', () => {
  const content = 'a\n\nc';
  const result = addLineNumbers(content);
  const lines = result.split('\n');
  assert.equal(lines[0], '1\ta');
  assert.equal(lines[1], '2\t');
  assert.equal(lines[2], '3\tc');
});

// ==================== findClosestMatch 模糊匹配 ====================

test('findClosestMatch: 精确匹配时返回匹配率 1.0', () => {
  const fileContent = 'function a() {}\nfunction b() {\n  return 1;\n}\nfunction c() {}';
  const oldContent = 'function b() {\n  return 1;\n}';

  const result = findClosestMatch(fileContent, oldContent);
  assert.notEqual(result, null);
  assert.equal(result!.startLine, 2);
  assert.equal(result!.endLine, 4);
  assert.equal(result!.matchRate, 1.0);
});

test('findClosestMatch: 模型复现有小偏差时仍能定位（核心场景）', () => {
  const fileContent = [
    'export function calculateTotal(items: CartItem[]): number {',
    '  let total = 0;',
    '  for (const item of items) {',
    '    total += item.price * item.quantity;',
    '  }',
    '  return total;',
    '}',
  ].join('\n');

  // 模型复现时缩进偏差（常见错误：少了 2 个空格）
  const oldContent = [
    'let total = 0;',
    'for (const item of items) {',
    '  total += item.price * item.quantity;',
    '}',
    'return total;',
  ].join('\n');

  const result = findClosestMatch(fileContent, oldContent);
  assert.notEqual(result, null, '缩进偏差时应能模糊匹配');
  assert.equal(result!.startLine, 2);
  assert.equal(result!.endLine, 6);
  assert.ok(result!.matchRate > 0.4, `匹配率应 > 40%，实际: ${result!.matchRate}`);
});

test('findClosestMatch: 模型漏掉/多写个别行时仍能定位', () => {
  const fileContent = [
    'import { a } from "./a";',
    'import { b } from "./b";',
    'import { c } from "./c";',
    '',
    'const x = a();',
    'const y = b();',
    'const z = c();',
  ].join('\n');

  // 模型漏掉了一行 import
  const oldContent = [
    'import { a } from "./a";',
    'import { c } from "./c";',
    '',
    'const x = a();',
  ].join('\n');

  const result = findClosestMatch(fileContent, oldContent);
  assert.notEqual(result, null, '漏行时应能模糊匹配');
  assert.ok(result!.matchRate > 0.4, `匹配率应 > 40%，实际: ${result!.matchRate}`);
  // 应定位到文件开头附近
  assert.ok(result!.startLine <= 2, `应定位在文件前部，实际 startLine: ${result!.startLine}`);
});

test('findClosestMatch: 完全不相关的内容返回 null', () => {
  const fileContent = 'function hello() {\n  console.log("hello");\n}';
  const oldContent = 'class Database {\n  connect() {}\n  disconnect() {}\n}';

  const result = findClosestMatch(fileContent, oldContent);
  assert.equal(result, null, '完全不匹配时应返回 null');
});

test('findClosestMatch: 首尾空行应被忽略', () => {
  const fileContent = 'a\nb\nc\nd';
  const oldContent = '\n\nb\nc\n\n';

  const result = findClosestMatch(fileContent, oldContent);
  assert.notEqual(result, null);
  assert.equal(result!.startLine, 2);
  assert.equal(result!.endLine, 3);
});

// ==================== 自动降级：文本匹配失败 → 模糊匹配 → 行号替换 ====================

test('自动降级：文本匹配失败时通过模糊匹配自动转为行号替换', () => {
  // 模拟真实场景：文件内容有缩进，模型给出的 old 缩进不准
  const fileContent = [
    'export class UserService {',
    '  async getUser(id: string) {',
    '    const user = await this.db.findOne(id);',
    '    if (!user) throw new Error("not found");',
    '    return user;',
    '  }',
    '}',
  ].join('\n');

  const oldContent = [
    '  const user = await this.db.findOne(id);',
    '  if (!user) throw new Error("not found");',
    '  return user;',
  ].join('\n');

  const newContent = [
    '    const user = await this.db.findOne(id);',
    '    if (!user) throw new NotFoundError(`User ${id} not found`);',
    '    return user;',
  ].join('\n');

  // Step 1: 文本匹配应该失败（缩进不一致）
  const textResult = buildEditedContent(fileContent, oldContent, newContent);

  if (textResult.success) {
    // 如果文本匹配碰巧成功了（三级容错），也 OK，跳过降级验证
    assert.ok(textResult.updatedContent.includes('NotFoundError'), '替换后应包含新内容');
    return;
  }

  // Step 2: 文本匹配失败，走自动降级
  const closest = findClosestMatch(fileContent, oldContent);
  assert.notEqual(closest, null, '模糊匹配应找到接近的内容');
  assert.equal(closest!.startLine, 3);
  assert.equal(closest!.endLine, 5);

  // Step 3: 用行号模式完成替换
  const lineResult = buildLineBasedEditContent(
    fileContent,
    closest!.startLine,
    closest!.endLine,
    newContent,
  );
  assert.equal(lineResult.success, true, '行号替换应成功');
  assert.ok(lineResult.updatedContent.includes('NotFoundError'), '替换后应包含新内容');
  assert.ok(!lineResult.updatedContent.includes('throw new Error("not found")'), '旧内容应被替换');
});

test('自动降级：模型多写了一行时仍能正确替换', () => {
  const fileContent = [
    'const a = 1;',
    'const b = 2;',
    'const c = 3;',
    'console.log(a + b + c);',
  ].join('\n');

  // 模型多写了一行 const d = 4;
  const oldContent = [
    'const a = 1;',
    'const b = 2;',
    'const d = 4;',
    'const c = 3;',
  ].join('\n');

  const newContent = [
    'const a = 10;',
    'const b = 20;',
    'const c = 30;',
  ].join('\n');

  // 文本匹配应该失败
  const textResult = buildEditedContent(fileContent, oldContent, newContent);

  if (!textResult.success) {
    // 走自动降级
    const closest = findClosestMatch(fileContent, oldContent);
    assert.notEqual(closest, null, '多写一行时模糊匹配应成功');
    assert.ok(closest!.matchRate > 0.4, `匹配率应 > 40%，实际: ${closest!.matchRate}`);

    // 用行号模式完成替换
    const lineResult = buildLineBasedEditContent(
      fileContent,
      closest!.startLine,
      closest!.endLine,
      newContent,
    );
    assert.equal(lineResult.success, true);
    assert.ok(lineResult.updatedContent.includes('const a = 10;'));
  }
});

test('自动降级：匹配率低于 40% 时不降级，返回原有错误', () => {
  const fileContent = 'function hello() {\n  console.log("hello");\n}';
  const oldContent = 'class Database {\n  connect() {}\n  disconnect() {}\n}';
  const newContent = 'class Database {\n  async connect() {}\n}';

  // 文本匹配失败
  const textResult = buildEditedContent(fileContent, oldContent, newContent);
  assert.equal(textResult.success, false);

  // 模糊匹配也找不到（内容完全不相关）
  const closest = findClosestMatch(fileContent, oldContent);
  assert.equal(closest, null, '不相关内容不应降级');
});

// ==================== 综合场景：模拟模型常见的编辑不精确 ====================

test('综合：模型把 tab 写成空格时自动降级', () => {
  const fileContent = [
    'function process(data: Data) {',
    '\tconst result = transform(data);',
    '\treturn result;',
    '}',
  ].join('\n');

  // 模型把 tab 写成了 2 个空格
  const oldContent = [
    '  const result = transform(data);',
    '  return result;',
  ].join('\n');

  const newContent = [
    '\tconst result = transform(data);',
    '\tif (!result) return null;',
    '\treturn result;',
  ].join('\n');

  const textResult = buildEditedContent(fileContent, oldContent, newContent);

  if (!textResult.success) {
    const closest = findClosestMatch(fileContent, oldContent);
    assert.notEqual(closest, null, 'tab/空格差异时应能匹配');

    const lineResult = buildLineBasedEditContent(
      fileContent,
      closest!.startLine,
      closest!.endLine,
      newContent,
    );
    assert.equal(lineResult.success, true);
    assert.ok(lineResult.updatedContent.includes('if (!result) return null;'));
  }
});

test('综合：长文件中精确定位（100 行文件中找到第 45-47 行）', () => {
  const lines = Array.from({ length: 100 }, (_, i) => {
    if (i === 44) return '  const total = calculateSum(items);';
    if (i === 45) return '  const tax = total * 0.1;';
    if (i === 46) return '  return total + tax;';
    return `  // line ${i + 1}`;
  });
  const fileContent = lines.join('\n');

  // 模型复现时行首空白不一致
  const oldContent = [
    'const total = calculateSum(items);',
    'const tax = total * 0.1;',
    'return total + tax;',
  ].join('\n');

  const closest = findClosestMatch(fileContent, oldContent);
  assert.notEqual(closest, null, '长文件中应能精确定位');
  assert.equal(closest!.startLine, 45);
  assert.equal(closest!.endLine, 47);
  assert.ok(closest!.matchRate > 0.4);
});
