/**
 * Vue SFC AST 适配器
 *
 * 支持对 .vue 文件中 <script> / <script setup> 块的结构化 AST 编辑。
 * 实现思路：
 * 1. 解析 .vue SFC，提取 <script> 块的内容与偏移量
 * 2. 将脚本内容写入临时 .ts/.js 文件
 * 3. 委托给现有的 typescriptAdapter 执行 AST 操作
 * 4. 将修改后的脚本内容回写到原始 .vue 文件的对应位置
 * 5. 清理临时文件
 */
import * as fs from 'fs';
import * as path from 'path';
import { info } from '../logger';
import { typescriptAdapter } from './astAdapter_typescript';
import type {
  AstEditRequest,
  AstEditResult,
  AstLanguageAdapter,
} from './astEditorTypes';

// ─── SFC 解析 ────────────────────────────────────────────

/** <script> 块的解析结果 */
interface VueScriptBlock {
  /** 开始标签的完整文本，如 '<script setup lang="ts">' */
  openTag: string;
  /** 脚本语言：'ts' 或 'js' */
  lang: 'ts' | 'js';
  /** 脚本内容（不含 <script> 标签本身） */
  content: string;
  /** 脚本内容在原始 .vue 文件中的起始偏移量（openTag 结束后） */
  contentStart: number;
  /** 脚本内容在原始 .vue 文件中的结束偏移量（</script> 之前） */
  contentEnd: number;
}

/**
 * 从 .vue 文件内容中提取 <script> 块
 * 优先匹配 <script setup>，其次匹配普通 <script>
 * 通过正则匹配标签位置，避免引入额外 SFC parser 依赖
 */
function extractScriptBlock(vueContent: string): VueScriptBlock | null {
  // 匹配 <script ...> 标签（支持 setup、lang 等属性，不区分顺序）
  const scriptTagRegex = /<script(\s[^>]*)?>[\s\S]*?<\/script>/gi;
  const candidates: VueScriptBlock[] = [];

  let match: RegExpExecArray | null;
  while ((match = scriptTagRegex.exec(vueContent)) !== null) {
    const fullMatch = match[0];
    const attrs = match[1] || '';

    // 跳过纯 CSS-in-JS 或其他非脚本类型的 script（如 <script type="application/json">）
    const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
    if (typeMatch && !typeMatch[1].includes('javascript') && !typeMatch[1].includes('typescript')) {
      continue;
    }

    // 解析 lang 属性
    const langMatch = attrs.match(/lang\s*=\s*["'](ts|typescript)["']/i);
    const lang: 'ts' | 'js' = langMatch ? 'ts' : 'js';

    // 计算内容偏移量
    const openTagEndIndex = vueContent.indexOf('>', match.index) + 1;
    const closeTagStartIndex = match.index + fullMatch.length - '</script>'.length;

    const content = vueContent.slice(openTagEndIndex, closeTagStartIndex);
    const openTag = vueContent.slice(match.index, openTagEndIndex);

    const isSetup = /\bsetup\b/i.test(attrs);

    candidates.push({
      openTag,
      lang,
      content,
      contentStart: openTagEndIndex,
      contentEnd: closeTagStartIndex,
    });

    // setup 块优先级更高（Vue 3 推荐写法）
    if (isSetup) {
      return candidates[candidates.length - 1];
    }
  }

  // 没有 setup 块时返回第一个普通 <script>
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * 将修改后的脚本内容回写到 .vue 文件中
 * 只替换 <script> 块的内容区域，保留 <template> / <style> 等其他部分
 */
function reassembleVueContent(
  originalVueContent: string,
  scriptBlock: VueScriptBlock,
  newScriptContent: string,
): string {
  return (
    originalVueContent.slice(0, scriptBlock.contentStart) +
    newScriptContent +
    originalVueContent.slice(scriptBlock.contentEnd)
  );
}

// ─── 临时文件管理 ──────────────────────────────────────────

/**
 * 在 .vue 文件同目录下创建临时脚本文件
 * 必须在 workspace root 内，否则 ts-morph 无法加载
 */
function createTempScriptFile(vueFilePath: string, scriptContent: string, lang: 'ts' | 'js'): string {
  const dir = path.dirname(path.resolve(vueFilePath));
  const ext = lang === 'ts' ? '.ts' : '.js';
  const tempPath = path.join(dir, `.__vue_ast_temp__${ext}`);
  fs.writeFileSync(tempPath, scriptContent, 'utf-8');
  return tempPath;
}

function cleanupTempFile(tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch {
    // 清理失败不影响主流程
  }
}

// ─── 适配器实现 ────────────────────────────────────────────

function isSupportedVueFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.vue';
}

async function executeVueAstEdit(
  request: AstEditRequest,
  fileContent: string,
): Promise<AstEditResult> {
  // 1. 提取 <script> 块
  const scriptBlock = extractScriptBlock(fileContent);
  if (!scriptBlock) {
    return {
      success: false,
      reason: `Vue 文件中未找到 <script> 块，无法执行 AST 编辑: ${request.filePath}`,
    };
  }

  if (!scriptBlock.content.trim()) {
    return {
      success: false,
      reason: `Vue 文件的 <script> 块内容为空: ${request.filePath}`,
    };
  }

  // 2. 写入临时文件
  const tempPath = createTempScriptFile(request.filePath, scriptBlock.content, scriptBlock.lang);
  const originalVuePath = path.resolve(request.filePath);

  try {
    // 3. 构造指向临时文件的请求，委托给 TS 适配器
    const tempRequest: AstEditRequest = {
      ...request,
      filePath: tempPath,
    } as AstEditRequest;

    info(`Vue AST: 提取 ${scriptBlock.openTag} → ${tempPath} (${scriptBlock.content.length} 字符)`);

    const tsResult = await typescriptAdapter.execute(tempRequest, scriptBlock.content);
    if (!tsResult.success) {
      return tsResult;
    }

    // 4. 将修改后的脚本回写到 .vue 文件结构中
    const tempFileResult = tsResult.files.find(
      (f) => path.resolve(f.filePath) === path.resolve(tempPath),
    );

    if (!tempFileResult) {
      return {
        success: false,
        reason: 'AST 编辑结果中未包含脚本文件的修改内容',
      };
    }

    const newVueContent = reassembleVueContent(
      fileContent,
      scriptBlock,
      tempFileResult.newContent,
    );

    // 5. 将结果中的临时文件路径映射回原始 .vue 文件路径
    // 其他受影响文件（如 rename_symbol 跨文件场景）保持不变
    const mappedFiles = tsResult.files.map((f) => {
      if (path.resolve(f.filePath) === path.resolve(tempPath)) {
        return { filePath: originalVuePath, newContent: newVueContent };
      }
      return f;
    });

    info(`Vue AST: 编辑完成，回写到 ${originalVuePath}`);

    return { success: true, files: mappedFiles };
  } finally {
    // 6. 清理临时文件
    cleanupTempFile(tempPath);
  }
}

/** Vue SFC AST 语言适配器 */
export const vueAdapter: AstLanguageAdapter = {
  id: 'vue',
  supportsFile: isSupportedVueFile,
  execute: executeVueAstEdit,
};
