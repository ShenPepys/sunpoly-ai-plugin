/**
 * 文件读取状态缓存
 *
 * 记录模型通过 read_file 工具读取过的文件信息，用于：
 * 1. 强制 "先读后编" —— edit_file 执行前校验文件是否被读取过
 * 2. 检测外部修改 —— 文件在读取后被外部修改时拒绝编辑
 * 3. 文件未变 stub —— 重复读取同一文件且内容未变时返回简短提示（P1-B）
 *
 * 设计参考 Claude Code 的 FileStateCache：
 * - LRU 淘汰策略，限制条目数和总字节数
 * - 路径归一化（path.normalize），解决 Windows 正反斜杠和冗余 .. 导致的缓存不命中
 */
import * as path from 'path';

// ==================== 类型定义 ====================

/** 单条文件读取状态 */
export interface FileReadState {
  /** 读取时的文件内容 */
  content: string;
  /** 读取时的时间戳（Date.now()），用于检测外部修改 */
  timestamp: number;
  /** 部分读取的起始行（1-indexed），undefined 表示全量读取 */
  offset?: number;
  /** 部分读取的行数，undefined 表示全量读取 */
  limit?: number;
  /**
   * 是否只是部分视图（如 @ 文件注入的截断内容）。
   * 标记为 true 时，edit_file 校验会拒绝——模型必须先显式 read_file
   */
  isPartialView?: boolean;
}

/** edit_file 执行前的校验结果 */
export interface FileReadStateValidation {
  /** 校验是否通过 */
  valid: boolean;
  /** 校验不通过时的原因描述，可直接反馈给模型 */
  reason?: string;
}

// ==================== 默认配置 ====================

/** 最大缓存条目数 */
const DEFAULT_MAX_ENTRIES = 100;

/** 最大缓存总大小（字节）—— 25MB，防止内存膨胀 */
const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024;

// ==================== LRU 缓存实现 ====================

/**
 * 文件读取状态 LRU 缓存。
 *
 * 所有路径 key 在存取时自动归一化（path.normalize + Windows 大小写不敏感），
 * 保证相同物理路径始终命中同一缓存条目。
 *
 * 淘汰策略：
 * - 超过 maxEntries 时淘汰最久未访问的条目
 * - 超过 maxSizeBytes 时持续淘汰最旧条目直到满足限制
 */
export class FileReadStateCache {
  /** 使用 Map 保证插入顺序 = 访问顺序（最近访问的在末尾） */
  private cache = new Map<string, FileReadState>();
  /** 当前缓存总字节数 */
  private currentSizeBytes = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
  ) {}

  // -------------------- 路径归一化 --------------------

  /** 归一化路径，解决 Windows 正反斜杠、冗余 .. 等问题 */
  private normalizeKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    // Windows 下路径大小写不敏感
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  // -------------------- 大小计算 --------------------

  /** 估算单条缓存的字节大小（以 content 为主） */
  private estimateSize(state: FileReadState): number {
    // Buffer.byteLength 准确计算 UTF-8 字节数，至少 1 字节防止零值
    return Math.max(1, Buffer.byteLength(state.content, 'utf-8'));
  }

  // -------------------- 淘汰逻辑 --------------------

  /** 淘汰最久未访问的条目，直到满足条目数和字节数限制 */
  private evict(): void {
    // Map 迭代顺序 = 插入顺序，最先插入（最久未访问）的在前面
    const iterator = this.cache.entries();
    while (
      (this.cache.size > this.maxEntries || this.currentSizeBytes > this.maxSizeBytes) &&
      this.cache.size > 0
    ) {
      const next = iterator.next();
      if (next.done) {
        break;
      }
      const [key, state] = next.value;
      this.currentSizeBytes -= this.estimateSize(state);
      this.cache.delete(key);
    }
  }

  // -------------------- 公开 API --------------------

  /**
   * 获取指定文件的读取状态。
   * 命中时会将条目移到末尾（标记为最近访问），实现 LRU 语义。
   */
  get(filePath: string): FileReadState | undefined {
    const key = this.normalizeKey(filePath);
    const state = this.cache.get(key);
    if (state) {
      // 移到末尾（LRU 访问刷新）
      this.cache.delete(key);
      this.cache.set(key, state);
    }
    return state;
  }

  /**
   * 记录文件的读取状态。
   * 如果已存在会更新并刷新访问顺序；超限时自动淘汰最旧条目。
   */
  set(filePath: string, state: FileReadState): void {
    const key = this.normalizeKey(filePath);

    // 如果已存在，先减去旧大小
    const existing = this.cache.get(key);
    if (existing) {
      this.currentSizeBytes -= this.estimateSize(existing);
      this.cache.delete(key);
    }

    const newSize = this.estimateSize(state);
    this.currentSizeBytes += newSize;
    this.cache.set(key, state);

    // 淘汰超限条目
    this.evict();
  }

  /** 检查指定文件是否在缓存中 */
  has(filePath: string): boolean {
    return this.cache.has(this.normalizeKey(filePath));
  }

  /** 删除指定文件的缓存 */
  delete(filePath: string): boolean {
    const key = this.normalizeKey(filePath);
    const state = this.cache.get(key);
    if (state) {
      this.currentSizeBytes -= this.estimateSize(state);
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  /** 清空所有缓存 */
  clear(): void {
    this.cache.clear();
    this.currentSizeBytes = 0;
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.cache.size;
  }

  /** 当前缓存总字节数 */
  get totalSizeBytes(): number {
    return this.currentSizeBytes;
  }
}

// ==================== 校验函数 ====================

/**
 * 在 edit_file / write_file(覆盖已有文件) 执行前，校验文件是否满足 "先读后编" 要求。
 *
 * 校验规则：
 * 1. 文件必须在 readStateCache 中有记录（模型必须先 read_file）
 * 2. 缓存条目不能是 isPartialView（@ 注入不等于完整读取）
 * 3. 文件自上次读取后不能被外部修改（比较磁盘修改时间 vs 缓存 timestamp）
 *    - Windows 兼容：时间戳变化后还做内容对比兜底
 *
 * @param filePath 要编辑的文件的绝对路径
 * @param cache 文件读取状态缓存
 * @param currentMtimeMs 文件当前的修改时间戳（fs.statSync(filePath).mtimeMs）
 * @param currentContent 文件当前的磁盘内容（仅在时间戳不匹配时用于兜底对比）
 */
export function validateFileReadState(
  filePath: string,
  cache: FileReadStateCache,
  currentMtimeMs: number,
  currentContent?: string,
): FileReadStateValidation {
  const state = cache.get(filePath);

  // 校验 1：文件从未被读取过
  if (!state) {
    return {
      valid: false,
      reason: `编辑被拒绝：文件 "${filePath}" 尚未被读取过。请先使用 read_file 工具读取该文件，确认当前内容后再编辑。不要猜测文件内容。`,
    };
  }

  // 校验 2：只有 @ 注入的部分视图，不等于完整读取
  if (state.isPartialView) {
    return {
      valid: false,
      reason: `编辑被拒绝：文件 "${filePath}" 仅通过 @ 引用注入了部分内容。请先使用 read_file 工具完整读取该文件后再编辑。`,
    };
  }

  // 校验 3：文件自上次读取后是否被外部修改
  // 给 1 秒的时间戳容差，避免文件系统时间精度问题
  const TIMESTAMP_TOLERANCE_MS = 1000;
  const timeDiff = currentMtimeMs - state.timestamp;

  if (timeDiff > TIMESTAMP_TOLERANCE_MS) {
    // 时间戳显示文件可能被修改了，但在 Windows 上某些场景（云同步、杀毒软件）
    // 会修改时间戳但不改内容，所以做内容对比兜底
    if (currentContent !== undefined && currentContent === state.content) {
      // 内容实际未变，只是时间戳被更新了，放行
      return { valid: true };
    }

    return {
      valid: false,
      reason: `编辑被拒绝：文件 "${filePath}" 在上次读取后已被外部修改。请重新使用 read_file 读取最新内容后再编辑。`,
    };
  }

  return { valid: true };
}

// ==================== 重复读取 stub ====================

/** buildReadFileStubIfUnchanged 的返回结果 */
export interface ReadFileStubResult {
  /** 是否应使用 stub 替代完整内容 */
  useStub: boolean;
  /** stub 文本（仅 useStub=true 时有值） */
  stubContent?: string;
}

/**
 * 检查本次 read_file 结果是否与缓存中的上次读取内容完全一致。
 * 如果一致，返回 stub 文本代替完整内容，节省模型上下文窗口。
 *
 * @param filePath 文件的解析后绝对路径
 * @param newContent 本次 read_file 返回的完整内容
 * @param cache 文件读取状态缓存
 * @returns useStub=true 表示内容未变、应使用 stubContent 替代
 */
export function buildReadFileStubIfUnchanged(
  filePath: string,
  newContent: string,
  cache: FileReadStateCache,
): ReadFileStubResult {
  const previousState = cache.get(filePath);
  if (!previousState) {
    return { useStub: false };
  }

  // 仅部分视图不做 stub 比较（@ 注入的内容不完整）
  if (previousState.isPartialView) {
    return { useStub: false };
  }

  if (previousState.content === newContent) {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    return {
      useStub: true,
      stubContent: `[文件未变] ${fileName} 的内容与上次读取完全一致（${newContent.length} 字符），无需重复阅读。你可以直接基于之前的理解继续操作。`,
    };
  }

  return { useStub: false };
}
