/**
 * 配置管理模块
 * 
 * 配置读取优先级（从高到低）：
 * 1. 项目根目录 .env 文件（开发调试用，不提交到 git）
 * 2. VS Code 用户设置（存在用户本机 AppData 中，也不会提交到 git）
 * 3. 代码中的默认值
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { info } from './logger';
import type { ModelConfig } from './prompts/types';

/** 配置项前缀 */
const CONFIG_PREFIX = 'myAiPlugin';

/** .env 文件缓存，避免每次读取都去读文件 */
let envCache: Record<string, string> | null = null;

/** .env 文件监听器，修改后自动清除缓存 */
const envWatchers: vscode.FileSystemWatcher[] = [];
const watchedEnvPaths = new Set<string>();

/** 插件安装目录（由 extension.ts 在激活时设置） */
let extensionPath = '';

/** SecretStorage 引用（由 extension.ts 在激活时注入） */
let secretStorage: vscode.SecretStorage | null = null;

/**
 * 设置 SecretStorage 引用
 * 必须在 extension.ts 的 activate() 中调用
 */
export function setSecretStorage(storage: vscode.SecretStorage): void {
  secretStorage = storage;
}

/** 获取指定模型的 SecretStorage key */
function secretKeyForModel(modelId: string, baseUrl: string): string {
  return `apiKey:${modelId}@${baseUrl}`;
}

/** 从 SecretStorage 读取模型 API Key */
export async function getSecretApiKey(modelId: string, baseUrl: string): Promise<string | undefined> {
  if (!secretStorage) { return undefined; }
  try {
    return await secretStorage.get(secretKeyForModel(modelId, baseUrl));
  } catch {
    return undefined;
  }
}

/** 将模型 API Key 写入 SecretStorage */
async function setSecretApiKey(modelId: string, baseUrl: string, apiKey: string): Promise<void> {
  if (!secretStorage) { return; }
  await secretStorage.store(secretKeyForModel(modelId, baseUrl), apiKey);
}

/**
 * 设置插件根目录路径
 * 必须在 extension.ts 的 activate() 中调用，用于查找插件目录下的 .env 文件
 */
export function setExtensionPath(extPath: string): void {
  extensionPath = extPath;
  // 路径变了，清除缓存强制重新读取
  envCache = null;
}

/**
 * 解析 .env 文件，返回键值对
 * 支持格式：KEY=VALUE 和 KEY="VALUE"（忽略空行和 # 注释）
 */
function loadEnvFile(): Record<string, string> {
  if (envCache) {
    return envCache;
  }

  envCache = {};

  // 按优先级查找 .env 文件：工作区根目录 > 插件安装目录
  const candidates: string[] = [];

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    candidates.push(path.join(workspaceFolders[0].uri.fsPath, '.env'));
  }
  if (extensionPath) {
    candidates.push(path.join(extensionPath, '.env'));
  }

  // 取第一个存在的 .env 文件
  const envPath = candidates.find(p => fs.existsSync(p));
  if (!envPath) {
    return envCache;
  }

  // 监听 .env 文件变更，自动清除缓存
  watchEnvFile(envPath);

  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, eqIndex).trim();
      // 去除值两端的引号
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      envCache[key] = value;
    }
  } catch {
    // .env 读取失败时静默处理，不影响正常使用
  }

  return envCache;
}

/**
 * 监听 .env 文件变更，修改后自动清除缓存以便下次读取最新内容
 */
function watchEnvFile(envPath: string): void {
  if (watchedEnvPaths.has(envPath)) { return; }
  watchedEnvPaths.add(envPath);

  const pattern = new vscode.RelativePattern(path.dirname(envPath), path.basename(envPath));
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onEnvChange = () => {
    envCache = null;
    info(`.env 文件已变更，缓存已清除: ${envPath}`);
  };
  watcher.onDidChange(onEnvChange);
  watcher.onDidCreate(onEnvChange);
  watcher.onDidDelete(onEnvChange);
  envWatchers.push(watcher);
}

/**
 * 重新加载 .env 文件（当用户修改 .env 后手动刷新）
 */
export function reloadEnv(): void {
  envCache = null;
}

/**
 * 释放 .env 文件监听器（插件停用时调用）
 */
export function disposeEnvWatchers(): void {
  for (const watcher of envWatchers) {
    watcher.dispose();
  }
  envWatchers.length = 0;
  watchedEnvPaths.clear();
}

/**
 * 读取单个配置项
 * 优先级：.env 文件 > VS Code 设置 > 默认值
 * @param key 配置键名（不含前缀）
 * @param defaultValue 默认值
 * @param envKey .env 文件中对应的键名（可选，默认自动转换为大写蛇形）
 */
function get<T>(key: string, defaultValue: T, envKey?: string): T {
  // 先查 .env 文件
  const env = loadEnvFile();
  const envName = envKey ?? toEnvKey(key);
  if (envName in env) {
    const envValue = env[envName];
    // 根据默认值类型自动转换
    if (typeof defaultValue === 'number') {
      const parsedNumber = Number(envValue);
      if (Number.isFinite(parsedNumber)) {
        return parsedNumber as T;
      }

      return defaultValue;
    }
    return envValue as T;
  }

  // 再查 VS Code 设置
  return vscode.workspace.getConfiguration(CONFIG_PREFIX).get<T>(key, defaultValue);
}

/**
 * 将 camelCase 键名转换为 UPPER_SNAKE_CASE
 * 例如 apiKey → API_KEY，baseUrl → BASE_URL
 */
function toEnvKey(camelKey: string): string {
  return camelKey.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/** 模型配置项（对应 settings 中 models 数组的每一项） */
interface ModelProfile {
  name: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  /** 是否支持图片输入（可选，不填则按 modelId 自动判断） */
  supportsVision?: boolean;
  /** 自定义 API 路径，不填时默认 /v1/chat/completions */
  apiPath?: string;
}

/** 默认模型配置 */
const DEFAULT_MODEL: ModelProfile = {
  name: 'DeepSeek Chat',
  modelId: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  contextWindow: 64000,
};

const DEFAULT_CONTEXT_WINDOW = 16000;

function getStoredModels(): ModelProfile[] {
  const models = vscode.workspace
    .getConfiguration(CONFIG_PREFIX)
    .get<ModelProfile[]>('models');

  return Array.isArray(models) ? models : [];
}

function buildEnvModel(env: Record<string, string>): ModelProfile {
  return normalizeModelProfile({
    name: env.MODEL_NAME ?? 'DeepSeek Chat',
    modelId: env.MODEL_ID ?? 'deepseek-chat',
    baseUrl: env.BASE_URL ?? 'https://api.deepseek.com',
    apiKey: env.API_KEY ?? '',
    contextWindow: env.CONTEXT_WINDOW ? Number(env.CONTEXT_WINDOW) : undefined,
  });
}

const CONTEXT_WINDOW_MAP: Record<string, number> = {
  'deepseek-chat': 64000,
  'deepseek-coder': 64000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'doubao-pro-32k': 32768,
  'doubao-lite-32k': 32768,
};

/**
 * 当 modelId 不在精确映射表中时，按模型名关键词匹配上下文窗口
 * 用于处理本地部署的模型（modelId 通常是文件路径，无法精确匹配）
 */
const CONTEXT_WINDOW_PATTERNS: Array<{ pattern: RegExp; contextWindow: number }> = [
  { pattern: /qwen/i, contextWindow: 16000 },
  { pattern: /coder/i, contextWindow: 16000 },
  { pattern: /llama/i, contextWindow: 8000 },
  { pattern: /mistral/i, contextWindow: 32000 },
];

/** 知识截止日期映射表 */
const CUTOFF_MAP: Record<string, string> = {
  'deepseek-chat': '2025年3月',
  'deepseek-coder': '2025年3月',
  'gpt-4o': '2024年10月',
  'gpt-4o-mini': '2024年10月',
  'doubao-pro-32k': '2025年1月',
  'doubao-lite-32k': '2025年1月',
};

/**
 * 获取所有模型配置列表
 * 优先从 .env 读取（开发调试），否则从 VS Code 设置读取
 */
export function getAllModels(): ModelProfile[] {
  const env = loadEnvFile();
  const settingsModels = getStoredModels().map(normalizeModelProfile);

  if (env.API_KEY) {
    const envModel = buildEnvModel(env);
    return settingsModels.length > 0 ? [envModel, ...settingsModels] : [envModel];
  }

  return settingsModels.length > 0 ? settingsModels : [normalizeModelProfile(DEFAULT_MODEL)];
}

function normalizeContextWindow(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const safeValue = Math.floor(value);
  return safeValue > 0 ? safeValue : undefined;
}

function normalizeModelProfile(model: ModelProfile): ModelProfile {
  return {
    ...model,
    contextWindow: resolveContextWindow(model.modelId, model.contextWindow),
  };
}

function resolveContextWindow(modelId: string, contextWindow?: number): number {
  // 优先级1：用户显式配置的值
  const normalizedConfigured = normalizeContextWindow(contextWindow);
  if (normalizedConfigured !== undefined) {
    return normalizedConfigured;
  }

  // 优先级2：精确匹配已知模型
  const normalizedModelId = (modelId || '').toLowerCase();
  if (normalizedModelId in CONTEXT_WINDOW_MAP) {
    return CONTEXT_WINDOW_MAP[normalizedModelId];
  }

  // 优先级3：模式匹配（适用于本地部署模型，modelId 通常是文件路径）
  for (const entry of CONTEXT_WINDOW_PATTERNS) {
    if (entry.pattern.test(normalizedModelId)) {
      return entry.contextWindow;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/** 获取当前活跃模型的序号 */
export function getActiveModelIndex(): number {
  return get<number>('activeModelIndex', 0);
}

/** 设置当前活跃模型的序号（保存到用户级设置） */
export async function setActiveModelIndex(index: number): Promise<void> {
  const models = getAllModels();
  const maxIndex = Math.max(0, models.length - 1);
  const normalizedIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  const safeIndex = Math.min(Math.max(normalizedIndex, 0), maxIndex);

  await vscode.workspace
    .getConfiguration(CONFIG_PREFIX)
    .update('activeModelIndex', safeIndex, true);
}

/**
 * 获取当前活跃模型的配置
 * 返回 ModelConfig 类型，供 Prompt 构建和 API 调用使用
 */
export function getModelConfig(): ModelConfig {
  const models = getAllModels();
  const activeIndex = getActiveModelIndex();
  // 确保 index 不越界
  const safeIndex = Math.max(0, Math.min(activeIndex, models.length - 1));
  const model = models[safeIndex] ?? DEFAULT_MODEL;

  return {
    modelName: model.name,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    apiPath: model.apiPath || '/v1/chat/completions',
    knowledgeCutoff: CUTOFF_MAP[(model.modelId || '').toLowerCase()] ?? '未知',
    contextWindow: resolveContextWindow(model.modelId, model.contextWindow),
    // 用户在 settings 中显式声明优先，否则按 modelId 自动判断
    supportsVision: model.supportsVision ?? detectVisionSupport(model.modelId),
  };
}

/**
 * 根据 modelId 判断该模型是否支持图片输入
 * 已知支持 Vision 的模型字符串匹配，新增模型时在此数组中补充
 */
export function detectVisionSupport(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  const visionPrefixes = [
    'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision',
    'claude-3', 'claude-3-5', 'claude-3-7',
    'gemini',
    'doubao-vision', 'doubao-1.5-pro',
    'qwen-vl', 'qwen2.5-vl', 'qwen-max',
  ];
  return visionPrefixes.some(prefix => lowerModelId.includes(prefix));
}

/**
 * 获取当前模型的 API Key
 * 如果未配置则提示用户去设置中添加模型
 */
export async function ensureApiKey(): Promise<string | undefined> {
  const config = getModelConfig();

  // 优先从 SecretStorage 读取
  const secretKey = await getSecretApiKey(config.modelId, config.baseUrl);
  if (secretKey) {
    return secretKey;
  }

  // 回退：从明文配置读取（兼容未迁移的情况）
  if (config.apiKey) {
    return config.apiKey;
  }

  // 提示用户输入
  const input = await vscode.window.showInputBox({
    prompt: `请输入 ${config.modelName} 的 API Key`,
    placeHolder: 'sk-...',
    password: true,
    ignoreFocusOut: true,
  });

  if (input) {
    const allModels = getAllModels();
    const activeIndex = Math.max(0, Math.min(getActiveModelIndex(), allModels.length - 1));
    const settingsModels = getStoredModels();
    const modelsToSave = settingsModels.length > 0
      ? settingsModels.map(model => ({ ...model }))
      : [{ ...DEFAULT_MODEL }];
    const isEnvModelSelected = !!loadEnvFile().API_KEY && activeIndex === 0;
    const settingsIndex = isEnvModelSelected ? -1 : (loadEnvFile().API_KEY ? activeIndex - 1 : activeIndex);

    if (isEnvModelSelected) {
      // 选中的是 .env 来源的模型，API Key 应写入 .env 文件而非 settings
      vscode.window.showInformationMessage(
        '当前模型来自 .env 文件，请在 .env 中设置 API_KEY 以持久保存（本次输入仅当次生效）'
      );
    } else {
      // 优先写入 SecretStorage（安全存储）
      await setSecretApiKey(config.modelId, config.baseUrl, input);

      // 同时写入 settings 作为回退（SecretStorage 不可用时降级）
      if (settingsIndex >= 0 && modelsToSave[settingsIndex]) {
        modelsToSave[settingsIndex] = {
          ...modelsToSave[settingsIndex],
          apiKey: input,
        };
        await vscode.workspace
          .getConfiguration(CONFIG_PREFIX)
          .update('models', modelsToSave, true);
      }
    }
    return input;
  }

  vscode.window.showWarningMessage(
    '未配置 API Key，请在设置中配置 myAiPlugin.models 或创建 .env 文件'
  );
  return undefined;
}

/** 获取回复语言偏好 */
export function getLanguage(): string {
  return get<string>('language', '中文');
}

/** 获取最大 token 数 */
export function getMaxTokens(): number {
  return get<number>('maxTokens', 4096);
}

/** 获取温度参数 */
export function getTemperature(): number {
  return get<number>('temperature', 0.3);
}

/**
 * 获取用户自定义系统提示词
 * 非空时应完全替换内置 buildSystemPrompt 的输出
 * @returns 自定义提示词字符串，空字符串表示使用内置提示词
 */
export function getCustomSystemPrompt(): string {
  return get<string>('systemPrompt', '').trim();
}

/**
 * 获取代理地址
 * 优先读取 myAiPlugin.proxy，其次读取 VS Code 内置 http.proxy
 * @returns 代理地址字符串，空字符串表示不使用代理
 */
export function getProxy(): string {
  // 插件自定义代理配置
  const pluginProxy = get<string>('proxy', '');
  if (pluginProxy) { return pluginProxy; }

  // 回退到 VS Code 内置代理设置
  const vscodeProxy = vscode.workspace.getConfiguration('http').get<string>('proxy', '');
  return vscodeProxy;
}

/**
 * 获取面板标题
 * 用户可自定义为企业名称，默认 "Sunpoly"
 */
export function getPanelTitle(): string {
  const panelTitle = get<string>('panelTitle', 'Sunpoly').trim();
  return panelTitle || 'Sunpoly';
}

/**
 * 将明文 API Key 从 settings 迁移到 SecretStorage
 * 在 activate() 中调用，每次启动时检查并迁移
 * 迁移完成后清空 settings 中的 apiKey 字段
 */
export async function migrateApiKeysToSecretStorage(): Promise<void> {
  if (!secretStorage) { return; }

  const storedModels = getStoredModels();
  let migrated = false;

  for (const model of storedModels) {
    if (model.apiKey && model.apiKey.length > 0 && !model.apiKey.startsWith('填写')) {
      const existing = await getSecretApiKey(model.modelId, model.baseUrl);
      if (!existing) {
        try {
          await setSecretApiKey(model.modelId, model.baseUrl, model.apiKey);
          migrated = true;
        } catch (err) {
          // 单个 key 写入失败不影响其他 key 的迁移
          info(`API Key 迁移失败 (${model.modelId}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  if (migrated) {
    // 清空 settings 中的明文 apiKey
    const clearedModels = storedModels.map(model => ({
      ...model,
      apiKey: '',
    }));
    await vscode.workspace
      .getConfiguration(CONFIG_PREFIX)
      .update('models', clearedModels, true);
    info(`已将 ${storedModels.filter(m => m.apiKey && !m.apiKey.startsWith('填写')).length} 个 API Key 迁移到 SecretStorage`);
  }
}

/** 插件终端 Profile 覆盖（default = 跟随 VS Code 集成终端设置） */
export type TerminalDefaultProfile = 'default' | 'pwsh' | 'cmd' | 'bash' | 'wsl';

export interface TerminalExecutionConfig {
  defaultProfile: TerminalDefaultProfile;
  shellIntegrationTimeoutSeconds: number;
  commandDefaultTimeoutSeconds: number;
  longCommandTimeoutSeconds: number;
  reuseTerminal: boolean;
  maxOutputLines: number;
}

const TERMINAL_PROFILE_VALUES: TerminalDefaultProfile[] = ['default', 'pwsh', 'cmd', 'bash', 'wsl'];

function normalizeTerminalProfile(value: string | undefined): TerminalDefaultProfile {
  if (value && TERMINAL_PROFILE_VALUES.includes(value as TerminalDefaultProfile)) {
    return value as TerminalDefaultProfile;
  }
  return 'default';
}

function toPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 读取终端执行相关 VS Code 设置 */
export function getTerminalExecutionConfig(): TerminalExecutionConfig {
  const shellIntegrationTimeoutSeconds = get('terminal.shellIntegrationTimeoutSeconds', 4);
  const commandDefaultTimeoutSeconds = get('terminal.commandDefaultTimeoutSeconds', 30);
  const longCommandTimeoutSeconds = get('terminal.longCommandTimeoutSeconds', 300);
  const maxOutputLines = get('terminal.maxOutputLines', 200);
  const reuseTerminal = get('terminal.reuseTerminal', true);

  return {
    defaultProfile: normalizeTerminalProfile(get('terminal.defaultProfile', 'default')),
    shellIntegrationTimeoutSeconds: toPositiveNumber(shellIntegrationTimeoutSeconds, 4),
    commandDefaultTimeoutSeconds: toPositiveNumber(commandDefaultTimeoutSeconds, 30),
    longCommandTimeoutSeconds: toPositiveNumber(longCommandTimeoutSeconds, 300),
    reuseTerminal: typeof reuseTerminal === 'boolean' ? reuseTerminal : true,
    maxOutputLines: toPositiveNumber(maxOutputLines, 200),
  };
}

/** 解析 run_command 实际超时（毫秒） */
export function resolveCommandTimeoutMs(requestedMs?: number): number {
  const { commandDefaultTimeoutSeconds, longCommandTimeoutSeconds } = getTerminalExecutionConfig();
  const defaultMs = commandDefaultTimeoutSeconds * 1000;
  const maxMs = longCommandTimeoutSeconds * 1000;

  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return defaultMs;
  }

  return Math.min(requestedMs, maxMs);
}

/** 根据输出行数上限估算字符截断阈值 */
export function getMaxCommandOutputChars(): number {
  const { maxOutputLines } = getTerminalExecutionConfig();
  return Math.max(maxOutputLines, 1) * 80;
}
