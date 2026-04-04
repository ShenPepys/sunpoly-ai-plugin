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

/**
 * 解析 .env 文件，返回键值对
 * 支持格式：KEY=VALUE 和 KEY="VALUE"（忽略空行和 # 注释）
 */
function loadEnvFile(): Record<string, string> {
  if (envCache) {
    return envCache;
  }

  envCache = {};

  // 从工作区根目录查找 .env 文件
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return envCache;
  }

  const envPath = path.join(workspaceFolders[0].uri.fsPath, '.env');
  if (!fs.existsSync(envPath)) {
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

/** 获取模型配置 */
export function getModelConfig(): ModelConfig {
  const modelId = get<string>('modelId', 'deepseek-chat');

  // 根据模型 ID 映射知识截止日期
  const cutoffMap: Record<string, string> = {
    'deepseek-chat': '2025年3月',
    'deepseek-coder': '2025年3月',
    'gpt-4o': '2024年10月',
    'gpt-4o-mini': '2024年10月',
    'doubao-pro-32k': '2025年1月',
    'doubao-lite-32k': '2025年1月',
  };

  return {
    modelName: get<string>('modelName', 'DeepSeek Chat'),
    modelId,
    baseUrl: get<string>('baseUrl', 'https://api.deepseek.com'),
    apiKey: get<string>('apiKey', ''),
    knowledgeCutoff: cutoffMap[modelId] ?? '未知',
  };
}

/** 获取 API Key，如果未配置则提示用户 */
export async function ensureApiKey(): Promise<string | undefined> {
  const apiKey = get<string>('apiKey', '');
  if (apiKey) {
    return apiKey;
  }

  // 提示用户输入 API Key
  const input = await vscode.window.showInputBox({
    prompt: '请输入 AI 模型的 API Key',
    placeHolder: 'sk-...',
    password: true,
    ignoreFocusOut: true,
  });

  if (input) {
    // 保存到用户级别的设置中
    await vscode.workspace.getConfiguration(CONFIG_PREFIX).update('apiKey', input, true);
    return input;
  }

  vscode.window.showWarningMessage('未配置 API Key，AI 功能无法使用。请在设置中配置 myAiPlugin.apiKey');
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
