/**
 * 演示脚本：展示四种编辑模式的真实执行结果
 * 运行方式：npx ts-node test/demo_edit_results.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { buildEditedContent, buildLineBasedEditContent } from '../src/tools/fileOps';
import { registerAdapter, routeAstEdit } from '../src/tools/astRouter';
import { typescriptAdapter } from '../src/tools/astAdapter_typescript';
import { getOrCreateProject, disposeProject } from '../src/tools/astContext';
import type { AstEditRequest } from '../src/tools/astEditorTypes';

// 创建临时目录
// 用 process.cwd() 确保输出到源码目录，而非 .test-dist
const tmpDir = path.resolve(process.cwd(), 'test', 'demo_output');
if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
registerAdapter(typescriptAdapter);
getOrCreateProject(tmpDir);

function separator(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function showDiff(before: string, after: string) {
  console.log('\n--- 修改前 ---');
  console.log(before);
  console.log('\n--- 修改后 ---');
  console.log(after);
}

// ==================== 1. write_file ====================
separator('1. write_file：创建新文件');

const file1 = path.join(tmpDir, 'login.ts');
const writeContent = `import { ref } from 'vue';

const username = ref('');
const password = ref('');

function login() {
  console.log('登录', username.value, password.value);
}
`;
fs.writeFileSync(file1, writeContent, 'utf-8');
console.log(`\n写入文件: ${file1}`);
console.log('\n--- 写入内容 ---');
console.log(fs.readFileSync(file1, 'utf-8'));

// ==================== 2. edit_file 文本匹配 ====================
separator('2. edit_file（文本匹配）：修改 login 函数体');

const before2 = fs.readFileSync(file1, 'utf-8');
const editResult2 = buildEditedContent(
  before2,
  "  console.log('登录', username.value, password.value);",
  "  const res = await fetch('/api/login', {\n    method: 'POST',\n    body: JSON.stringify({ username: username.value, password: password.value }),\n  });\n  return res.json();",
);

if (editResult2.success) {
  fs.writeFileSync(file1, editResult2.updatedContent, 'utf-8');
  showDiff(before2, editResult2.updatedContent);
  console.log(`\n匹配方式: ${editResult2.usedNormalizedMatch ? '归一化匹配' : '精确匹配'}`);
} else {
  console.log('编辑失败:', editResult2.reason);
}

// ==================== 3. edit_file 行号模式 ====================
separator('3. edit_file（行号模式）：在第 3 行后插入 QQ 登录字段');

const before3 = fs.readFileSync(file1, 'utf-8');
const lines3 = before3.split('\n');
console.log('\n当前文件（带行号）:');
lines3.forEach((line, i) => console.log(`  ${i + 1} | ${line}`));

// 替换第 4 行（password 那行），改为 password + qqToken 两行
const lineResult3 = buildLineBasedEditContent(
  before3,
  4, 4,
  "const password = ref('');\nconst qqToken = ref('');",
);

if (lineResult3.success) {
  fs.writeFileSync(file1, lineResult3.updatedContent, 'utf-8');
  showDiff(before3, lineResult3.updatedContent);
} else {
  console.log('编辑失败:', lineResult3.message);
}

// ==================== 4. edit_file replace_all ====================
separator('4. edit_file（replace_all）：把所有 username 改为 loginName');

const before4 = fs.readFileSync(file1, 'utf-8');
const replaceResult = buildEditedContent(before4, 'username', 'loginName', { replaceAll: true });

if (replaceResult.success) {
  fs.writeFileSync(file1, replaceResult.updatedContent, 'utf-8');
  showDiff(before4, replaceResult.updatedContent);
  console.log(`\n替换次数: ${replaceResult.replacedCount ?? 1} 处`);
} else {
  console.log('编辑失败:', replaceResult.reason);
}

// ==================== AST 部分用 async 包裹 ====================
async function runAstDemos() {

// ==================== 5. AST add_import ====================
separator('5. AST add_import：添加 import 声明');

const file5 = path.join(tmpDir, 'service.ts');
const content5 = `function getUser(id: number) {
  return null;
}

const result = getUser(1);
`;
fs.writeFileSync(file5, content5, 'utf-8');

const before5 = fs.readFileSync(file5, 'utf-8');

const req5: AstEditRequest = {
  workspaceRoot: tmpDir,
  filePath: file5,
  action: 'add_import',
  params: { modulePath: './database', namedImports: ['db', 'QueryResult'] },
} as AstEditRequest;

const astResult5 = await routeAstEdit(req5, before5);
if (!('supported' in astResult5) && astResult5.success) {
  for (const f of astResult5.files) { fs.writeFileSync(f.filePath, f.newContent, 'utf-8'); }
  showDiff(before5, fs.readFileSync(file5, 'utf-8'));
} else {
  console.log('AST 操作失败');
}

// ==================== 6. AST edit_function_body ====================
separator('6. AST edit_function_body：替换函数实现');

const before6 = fs.readFileSync(file5, 'utf-8');

const req6: AstEditRequest = {
  workspaceRoot: tmpDir,
  filePath: file5,
  action: 'edit_function_body',
  params: {
    functionName: 'getUser',
    newBody: 'const user = db.findOne({ id });\nif (!user) throw new Error("用户不存在");\nreturn user;',
  },
} as AstEditRequest;

const astResult6 = await routeAstEdit(req6, before6);
if (!('supported' in astResult6) && astResult6.success) {
  for (const f of astResult6.files) { fs.writeFileSync(f.filePath, f.newContent, 'utf-8'); }
  showDiff(before6, fs.readFileSync(file5, 'utf-8'));
} else {
  console.log('AST 操作失败');
}

// ==================== 7. AST insert_function ====================
separator('7. AST insert_function：插入新函数');

const before7 = fs.readFileSync(file5, 'utf-8');

const req7: AstEditRequest = {
  workspaceRoot: tmpDir,
  filePath: file5,
  action: 'insert_function',
  params: {
    functionCode: 'function deleteUser(id: number): boolean {\n  return db.delete({ id }) > 0;\n}',
    insertAfter: 'getUser',
  },
} as AstEditRequest;

const astResult7 = await routeAstEdit(req7, before7);
if (!('supported' in astResult7) && astResult7.success) {
  for (const f of astResult7.files) { fs.writeFileSync(f.filePath, f.newContent, 'utf-8'); }
  showDiff(before7, fs.readFileSync(file5, 'utf-8'));
} else {
  console.log('AST 操作失败');
}

// ==================== 8. AST add_class_member ====================
separator('8. AST add_class_member：给类添加方法');

const file8 = path.join(tmpDir, 'user-service.ts');
fs.writeFileSync(file8, `class UserService {
  private db: any;

  getUser(id: number) {
    return this.db.find(id);
  }
}
`, 'utf-8');

const before8 = fs.readFileSync(file8, 'utf-8');

const req8: AstEditRequest = {
  workspaceRoot: tmpDir,
  filePath: file8,
  action: 'add_class_member',
  params: {
    className: 'UserService',
    memberCode: 'updateUser(id: number, data: any) {\n  return this.db.update(id, data);\n}',
    insertAfter: 'getUser',
  },
} as AstEditRequest;

const astResult8 = await routeAstEdit(req8, before8);
if (!('supported' in astResult8) && astResult8.success) {
  for (const f of astResult8.files) { fs.writeFileSync(f.filePath, f.newContent, 'utf-8'); }
  showDiff(before8, fs.readFileSync(file8, 'utf-8'));
} else {
  console.log('AST 操作失败');
}

// ==================== 清理 ====================
separator('完成！');
console.log(`\n临时目录: ${tmpDir}`);
console.log('所有编辑模式测试完毕。');

disposeProject(tmpDir);
// 不删除临时目录，保留文件让用户查看
// fs.rmSync(tmpDir, { recursive: true, force: true });

} // end runAstDemos

runAstDemos().catch(console.error);
