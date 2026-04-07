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
import type { ModelConfig } from './prompts/types';

/** 配置项前缀 */
const CONFIG_PREFIX = 'myAiPlugin';

/** .env 文件缓存，避免每次读取都去读文件 */
let envCache: Record<string, string> | null = null;

/** 插件安装目录（由 extension.ts 在激活时设置） */
let extensionPath = '';

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
 * 重新加载 .env 文件（当用户修改 .env 后手动刷新）
 */
export function reloadEnv(): void {
  envCache = null;
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
      return Number(envValue) as T;
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
}

/** 默认模型配置 */
const DEFAULT_MODEL: ModelProfile = {
  name: 'DeepSeek Chat',
  modelId: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
};

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
  // .env 中的配置作为第一个模型（开发调试用）
  const env = loadEnvFile();
  if (env.API_KEY) {
    const envModel: ModelProfile = {
      name: env.MODEL_NAME ?? 'DeepSeek Chat',
      modelId: env.MODEL_ID ?? 'deepseek-chat',
      baseUrl: env.BASE_URL ?? 'https://api.deepseek.com',
      apiKey: env.API_KEY,
    };
    // .env 配置与 VS Code 设置中的合并，.env 排第一
    const settingsModels = vscode.workspace
      .getConfiguration(CONFIG_PREFIX)
      .get<ModelProfile[]>('models', [DEFAULT_MODEL]);
    return [envModel, ...settingsModels.filter(m => m.apiKey)];
  }

  // 仅从 VS Code 设置读取
  const models = vscode.workspace
    .getConfiguration(CONFIG_PREFIX)
    .get<ModelProfile[]>('models', [DEFAULT_MODEL]);

  return models.length > 0 ? models : [DEFAULT_MODEL];
}

/** 获取当前活跃模型的序号 */
export function getActiveModelIndex(): number {
  return get<number>('activeModelIndex', 0);
}

/** 设置当前活跃模型的序号（保存到用户级设置） */
export async function setActiveModelIndex(index: number): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_PREFIX)
    .update('activeModelIndex', index, true);
}

/**
 * 获取当前活跃模型的配置
 * 返回 ModelConfig 类型，供 Prompt 构建和 API 调用使用
 */
export function getModelConfig(): ModelConfig {
  const models = getAllModels();
  const activeIndex = getActiveModelIndex();
  // 确保 index 不越界
  const safeIndex = Math.min(activeIndex, models.length - 1);
  const model = models[safeIndex] ?? DEFAULT_MODEL;

  return {
    modelName: model.name,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    knowledgeCutoff: CUTOFF_MAP[model.modelId] ?? '未知',
    supportsVision: detectVisionSupport(model.modelId),
  };
}

/**
 * 根据 modelId 判断该模型是否支持图片输入
 * 已知支持 Vision 的模型字符串匹配，新增模型时在此数组中补充
 */
function detectVisionSupport(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  const visionPrefixes = [
    'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision',
    'claude-3', 'claude-3-5', 'claude-3-7',
    'gemini',
    'doubao-vision',
    'qwen-vl',
  ];
  return visionPrefixes.some(prefix => lowerModelId.includes(prefix));
}

/**
 * 获取当前模型的 API Key
 * 如果未配置则提示用户去设置中添加模型
 */
export async function ensureApiKey(): Promise<string | undefined> {
  const config = getModelConfig();
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
    // 将 key 写入当前活跃模型的配置中
    const models = getAllModels();
    const activeIndex = Math.min(getActiveModelIndex(), models.length - 1);
    if (models[activeIndex]) {
      models[activeIndex].apiKey = input;
      await vscode.workspace
        .getConfiguration(CONFIG_PREFIX)
        .update('models', models, true);
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
 * 用户可自定义为企业名称，默认 "AI 助理"
 */
export function getPanelTitle(): string {
  return get<string>('panelTitle', 'AI 助理');
}
