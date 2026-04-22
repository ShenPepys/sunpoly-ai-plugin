/**
 * 统一工具定义注册表
 *
 * 集中管理所有工具的元数据（名称、标签、图标、只读标志、步骤描述模板），
 * 消除散落在 toolExecutor / ChatViewProvider 等文件中的重复 switch 语句。
 * 新增工具只需在此处注册，所有消费方自动生效。
 */
import type { ToolCallType } from './toolParser';

// ==================== 类型定义 ====================

/** 单个工具的元数据定义 */
export interface ToolDef {
  /** 工具类型标识，与 ParsedToolCall.type 对应 */
  type: ToolCallType;
  /** 中文标签（用于日志和模型反馈） */
  label: string;
  /** UI 图标（emoji） */
  icon: string;
  /** 是否只读操作（无副作用，可并行） */
  readOnly: boolean;
  /** 步骤描述模板（英文动词前缀），文件名由调用方拼接 */
  stepVerb: string;
}

// ==================== 工具注册表 ====================

/** 所有已注册工具的元数据，按 type 索引 */
const toolDefMap: Map<ToolCallType, ToolDef> = new Map();

/**
 * 注册一个工具定义。
 * 如果同 type 已存在会覆盖（方便测试或插件扩展）。
 */
function register(def: ToolDef): void {
  toolDefMap.set(def.type, def);
}

// ==================== 内置工具注册 ====================

register({
  type: 'read_file',
  label: '读取文件',
  icon: '📖',
  readOnly: true,
  stepVerb: 'Reading',
});

register({
  type: 'write_file',
  label: '写入文件',
  icon: '📝',
  readOnly: false,
  stepVerb: 'Creating',
});

register({
  type: 'edit_file',
  label: '编辑文件',
  icon: '✏️',
  readOnly: false,
  stepVerb: 'Editing',
});

register({
  type: 'list_dir',
  label: '列出目录',
  icon: '📁',
  readOnly: true,
  stepVerb: 'Listing',
});

register({
  type: 'ast_edit',
  label: 'AST 编辑',
  icon: '🌳',
  readOnly: false,
  stepVerb: 'AST editing',
});

// ==================== 查询 API ====================

/**
 * 获取指定工具类型的定义。
 * 未注册的工具返回 undefined。
 */
export function getToolDef(type: ToolCallType): ToolDef | undefined {
  return toolDefMap.get(type);
}

/**
 * 获取工具的中文标签（带图标前缀）。
 * 未注册的工具返回原始 type。
 */
export function getToolLabel(type: ToolCallType): string {
  const def = toolDefMap.get(type);
  return def ? `${def.icon} ${def.label}` : type;
}

/**
 * 获取工具的 UI 图标。
 * 未注册的工具返回默认图标。
 */
export function getToolIcon(type: ToolCallType): string {
  return toolDefMap.get(type)?.icon ?? '📄';
}

/**
 * 判断工具调用是否为只读操作。
 * 未注册的工具默认视为非只读（安全侧）。
 */
export function isToolReadOnly(type: ToolCallType): boolean {
  return toolDefMap.get(type)?.readOnly ?? false;
}

/**
 * 获取工具步骤描述（英文动词 + 文件名）。
 * @param type 工具类型
 * @param fileName 文件名（不含路径）
 */
export function getToolStepText(type: ToolCallType, fileName: string): string {
  const verb = toolDefMap.get(type)?.stepVerb ?? 'Processing';
  return `${verb} ${fileName}`;
}

/**
 * 获取所有已注册的工具定义（只读副本）。
 */
export function getAllToolDefs(): readonly ToolDef[] {
  return Array.from(toolDefMap.values());
}
