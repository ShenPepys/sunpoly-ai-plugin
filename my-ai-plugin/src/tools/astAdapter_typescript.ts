import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Project,
  SyntaxKind,
  type ArrowFunction,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';
import { getOrCreateProject, getSourceFile, refreshSourceFile } from './astContext';
import type {
  AstAddClassMemberParams,
  AstAddFunctionParamParams,
  AstAddImportParams,
  AstAddObjectPropertyParams,
  AstEditFailureResult,
  AstEditFunctionBodyParams,
  AstEditRequest,
  AstEditResult,
  AstEditSuccessResult,
  AstInsertFunctionParams,
  AstLanguageAdapter,
  AstRemoveImportParams,
  AstRenameSymbolParams,
} from './astEditorTypes';

// ─── 常量与类型 ───────────────────────────────────────────

type FunctionLikeNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ─── 通用工具函数 ─────────────────────────────────────────

function fail(reason: string): AstEditFailureResult {
  return { success: false, reason };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在内存 AST 上执行变更，收集所有受影响文件的新内容后，
 * 回滚内存 AST 到磁盘状态。上层拿到新内容后决定是否写盘。
 */
function withAstMutation(
  request: AstEditRequest,
  mutate: (sf: SourceFile, touched: Set<string>) => void,
): AstEditResult {
  let touched: Set<string> | undefined;

  try {
    getOrCreateProject(request.workspaceRoot);

    const resolvedPath = path.resolve(request.filePath);
    const sf = refreshSourceFile(resolvedPath);
    touched = new Set<string>([resolvedPath]);

    mutate(sf, touched);
    return collectResults(touched);
  } catch (error) {
    const msg = normalizeError(error);
    // 提示上层可以降级到 edit_file
    return fail(`${msg}（建议降级为 edit_file 文本替换）`);
  } finally {
    if (touched) {
      rollbackTouched(touched);
    }
  }
}

/** 从内存 AST 中收集受影响文件的最新文本 */
function collectResults(touched: Set<string>): AstEditSuccessResult {
  const files = [...touched].map((filePath) => {
    const sf = getSourceFile(filePath);
    if (!sf) {
      throw new Error(`无法读取变更后的 AST 文件内容：${filePath}`);
    }
    return { filePath, newContent: sf.getFullText() };
  });
  return { success: true, files };
}

/** 将内存 AST 回滚到磁盘上的真实内容 */
function rollbackTouched(touched: Set<string>): void {
  for (const filePath of touched) {
    if (!fs.existsSync(filePath)) { continue; }
    try { refreshSourceFile(filePath); } catch { /* 忽略回滚失败 */ }
  }
}

/** 过滤空字符串，返回有效的命名导入列表 */
function validNamedImports(names?: string[]): string[] {
  return names ? names.filter((n) => n.trim() !== '') : [];
}

/**
 * 在 SourceFile 中按名称查找函数声明、箭头函数或函数表达式。
 * 箭头函数和函数表达式通过变量声明名称匹配。
 */
function findFunctionByName(sf: SourceFile, name: string): FunctionLikeNode | undefined {
  // 优先查找具名函数声明
  const funcDecl = sf.getFunction(name);
  if (funcDecl) { return funcDecl; }

  // 再查找 const xxx = () => {} 或 const xxx = function() {}
  const varDecl = sf.getVariableDeclaration(name);
  if (!varDecl) { return undefined; }

  const initializer = varDecl.getInitializer();
  if (!initializer) { return undefined; }

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return initializer;
  }

  return undefined;
}

// ─── 操作：add_import ─────────────────────────────────────

function executeAddImport(sf: SourceFile, params: AstAddImportParams): void {
  const namedImports = validNamedImports(params.namedImports);
  const existing = sf.getImportDeclaration(
    (decl) => decl.getModuleSpecifierValue() === params.modulePath,
  );

  if (!existing) {
    sf.addImportDeclaration({
      moduleSpecifier: params.modulePath,
      defaultImport: params.defaultImport,
      namedImports,
    });
    return;
  }

  // 合并到已有 import 声明
  if (params.defaultImport) {
    const current = existing.getDefaultImport()?.getText();
    if (!current) {
      existing.setDefaultImport(params.defaultImport);
    } else if (current !== params.defaultImport) {
      throw new Error(`模块 ${params.modulePath} 已有默认导入 ${current}，无法改为 ${params.defaultImport}`);
    }
  }

  for (const name of namedImports) {
    const alreadyHas = existing.getNamedImports().some((ni) => ni.getName() === name);
    if (!alreadyHas) {
      existing.addNamedImport(name);
    }
  }
}

// ─── 操作：remove_import ──────────────────────────────────

function executeRemoveImport(sf: SourceFile, params: AstRemoveImportParams): void {
  const existing = sf.getImportDeclaration(
    (decl) => decl.getModuleSpecifierValue() === params.modulePath,
  );
  if (!existing) {
    throw new Error(`未找到来自 ${params.modulePath} 的 import 声明`);
  }

  const namesToRemove = validNamedImports(params.namedImports);

  if (namesToRemove.length === 0) {
    // 没有指定具体名称，删除整条 import
    existing.remove();
    return;
  }

  // 只删除指定的命名导入
  for (const name of namesToRemove) {
    const namedImport = existing.getNamedImports().find((ni) => ni.getName() === name);
    if (namedImport) {
      namedImport.remove();
    }
  }

  // 如果删完后既没有命名导入也没有默认导入，清除整条
  const remainingNamed = existing.getNamedImports();
  const hasDefault = existing.getDefaultImport();
  if (remainingNamed.length === 0 && !hasDefault) {
    existing.remove();
  }
}

// ─── 操作：insert_function ────────────────────────────────

function executeInsertFunction(sf: SourceFile, params: AstInsertFunctionParams): void {
  if (params.insertAfter) {
    const anchor = sf.getFunction(params.insertAfter);
    if (!anchor) {
      throw new Error(`未找到锚点函数 ${params.insertAfter}`);
    }
    // 获取锚点函数在顶层语句列表中的索引，在其后面插入
    const stmtIndex = sf.getStatements().indexOf(anchor);
    sf.insertStatements(stmtIndex + 1, `\n${params.functionCode}`);
    return;
  }

  if (params.insertBefore) {
    const anchor = sf.getFunction(params.insertBefore);
    if (!anchor) {
      throw new Error(`未找到锚点函数 ${params.insertBefore}`);
    }
    const stmtIndex = sf.getStatements().indexOf(anchor);
    sf.insertStatements(stmtIndex, `${params.functionCode}\n`);
    return;
  }

  // 默认追加到文件末尾
  sf.addStatements(`\n${params.functionCode}`);
}

// ─── 操作：edit_function_body ─────────────────────────────

function executeEditFunctionBody(sf: SourceFile, params: AstEditFunctionBodyParams): void {
  const target = findFunctionByName(sf, params.functionName);
  if (!target) {
    throw new Error(`未找到函数 ${params.functionName}`);
  }

  // 箭头函数如果是表达式体（=> expr），没有花括号，setBodyText 会失败。
  // 需要先将表达式体包装为块体 => { return expr; }，再替换。
  if (Node.isArrowFunction(target)) {
    const body = target.getBody();
    if (!Node.isBlock(body)) {
      // 用当前表达式生成临时块体，让 setBodyText 可以正常工作
      target.replaceWithText(
        target.getFullText().replace(
          body.getFullText(),
          `{\n  ${params.newBody}\n}`,
        ),
      );
      return;
    }
  }

  target.setBodyText(params.newBody);
}

// ─── 操作：add_function_param ─────────────────────────────

/**
 * 将原始参数代码片段（如 `b?: string = "x"`）解析为 ts-morph 的结构化对象，
 * 因为 insertParameter 不接受纯字符串。
 */
function parseParamStructure(paramCode: string) {
  const tempProject = new Project({ useInMemoryFileSystem: true });
  const tempFile = tempProject.createSourceFile(
    '__temp_param__.ts',
    `function __temp__(${paramCode}) {}`,
  );
  const params = tempFile.getFunctionOrThrow('__temp__').getParameters();
  if (params.length === 0) {
    throw new Error(`无法解析参数代码：${paramCode}`);
  }
  return params[0].getStructure();
}

function executeAddFunctionParam(sf: SourceFile, params: AstAddFunctionParamParams): void {
  const target = findFunctionByName(sf, params.functionName);
  if (!target) {
    throw new Error(`未找到函数 ${params.functionName}`);
  }

  const structure = parseParamStructure(params.paramCode);
  const existingCount = target.getParameters().length;

  // position 为空时默认追加到末尾
  const insertIndex = params.position ?? existingCount;
  const clampedIndex = Math.max(0, Math.min(insertIndex, existingCount));

  target.insertParameter(clampedIndex, structure);
}

// ─── 操作：add_object_property ────────────────────────────

/**
 * 根据 locator 在 SourceFile 中定位 ObjectLiteralExpression。
 * 支持通过变量名 + 可选属性路径逐层定位嵌套对象。
 */
function findObjectLiteral(
  sf: SourceFile,
  locator: AstAddObjectPropertyParams['objectLocator'],
): ObjectLiteralExpression {
  if (!locator.variableName) {
    throw new Error('objectLocator 必须提供 variableName');
  }

  const varDecl = sf.getVariableDeclaration(locator.variableName);
  if (!varDecl) {
    throw new Error(`未找到变量 ${locator.variableName}`);
  }

  let current = varDecl.getInitializerIfKindOrThrow(
    SyntaxKind.ObjectLiteralExpression,
  ) as ObjectLiteralExpression;

  // 按属性路径逐层钻入嵌套对象
  if (locator.propertyPath) {
    for (const key of locator.propertyPath) {
      const prop = current.getProperty(key);
      if (!prop || !Node.isPropertyAssignment(prop)) {
        throw new Error(`属性路径 ${key} 未找到或不是 PropertyAssignment`);
      }
      const init = prop.getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      current = init as ObjectLiteralExpression;
    }
  }

  return current;
}

function executeAddObjectProperty(sf: SourceFile, params: AstAddObjectPropertyParams): void {
  const obj = findObjectLiteral(sf, params.objectLocator);
  const existingCount = obj.getProperties().length;
  // insertProperty 接受原始代码字符串
  obj.insertProperty(existingCount, params.propertyCode);
}

// ─── 操作：add_class_member ───────────────────────────────

function executeAddClassMember(sf: SourceFile, params: AstAddClassMemberParams): void {
  const cls = sf.getClass(params.className);
  if (!cls) {
    throw new Error(`未找到类 ${params.className}`);
  }

  if (params.insertAfter) {
    // 找到锚点成员，在其后插入
    const members = cls.getMembers();
    const anchorIndex = members.findIndex((m) => {
      if (Node.isMethodDeclaration(m)) { return m.getName() === params.insertAfter; }
      if (Node.isPropertyDeclaration(m)) { return m.getName() === params.insertAfter; }
      return false;
    });
    if (anchorIndex === -1) {
      throw new Error(`未找到类成员 ${params.insertAfter}`);
    }
    cls.insertMember(anchorIndex + 1, params.memberCode);
    return;
  }

  // 默认追加到类末尾
  const memberCount = cls.getMembers().length;
  cls.insertMember(memberCount, params.memberCode);
}

// ─── 操作：rename_symbol ──────────────────────────────────

/**
 * 重命名符号。支持两种定位方式：
 * 1. 按名称在文件中查找第一个匹配的标识符
 * 2. 按行列精确定位（line/column 均为 1-based）
 *
 * rename 会自动更新 Project 内所有引用（跨文件）。
 */
function executeRenameSymbol(
  sf: SourceFile,
  params: AstRenameSymbolParams,
  touched: Set<string>,
): void {
  let targetNode: Node | undefined;

  if (params.line !== undefined && params.column !== undefined) {
    // 行列定位：先转为绝对偏移量，再取节点
    const fullText = sf.getFullText();
    const lines = fullText.split('\n');
    const lineIndex = params.line - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`行号 ${params.line} 超出文件范围（共 ${lines.length} 行）`);
    }
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) {
      offset += lines[i].length + 1; // +1 是换行符
    }
    offset += params.column - 1;
    targetNode = sf.getDescendantAtPos(offset);
  } else {
    // 按名称查找：遍历所有 Identifier，找第一个匹配的
    targetNode = sf.getDescendants().find(
      (node) => Node.isIdentifier(node) && node.getText() === params.oldName,
    );
  }

  if (!targetNode) {
    throw new Error(`未找到符号 ${params.oldName}`);
  }

  // rename 只能在 Identifier 节点上调用
  if (!Node.isIdentifier(targetNode)) {
    throw new Error(`定位到的节点不是标识符（${targetNode.getKindName()}），无法重命名`);
  }

  // 先收集引用所在文件，rename 后这些文件都会被修改
  const refs = targetNode.findReferencesAsNodes();
  for (const ref of refs) {
    touched.add(ref.getSourceFile().getFilePath());
  }

  targetNode.rename(params.newName);
}

// ─── 分发器 ───────────────────────────────────────────────

function dispatchAction(
  sf: SourceFile,
  request: AstEditRequest,
  touched: Set<string>,
): void {
  switch (request.action) {
    case 'add_import':
      executeAddImport(sf, request.params);
      break;
    case 'remove_import':
      executeRemoveImport(sf, request.params);
      break;
    case 'insert_function':
      executeInsertFunction(sf, request.params);
      break;
    case 'edit_function_body':
      executeEditFunctionBody(sf, request.params);
      break;
    case 'add_function_param':
      executeAddFunctionParam(sf, request.params);
      break;
    case 'add_object_property':
      executeAddObjectProperty(sf, request.params);
      break;
    case 'add_class_member':
      executeAddClassMember(sf, request.params);
      break;
    case 'rename_symbol':
      executeRenameSymbol(sf, request.params, touched);
      break;
    default: {
      const _exhaustive: never = request;
      throw new Error(`未知的 AST 操作：${(_exhaustive as AstEditRequest).action}`);
    }
  }
}

// ─── 适配器入口 ───────────────────────────────────────────

async function executeTypescriptEdit(
  request: AstEditRequest,
  _fileContent: string,
): Promise<AstEditResult> {
  return withAstMutation(request, (sf, touched) => {
    dispatchAction(sf, request, touched);
  });
}

/** TS/JS AST 语言适配器 */
export const typescriptAdapter: AstLanguageAdapter = {
  id: 'typescript',
  supportsFile: isSupportedFile,
  execute: executeTypescriptEdit,
};
