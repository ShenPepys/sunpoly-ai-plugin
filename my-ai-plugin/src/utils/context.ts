/**
 * 上下文构建工具函数
 * 负责收集环境信息、构建发送给 AI 的上下文
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { EnvContext, ModelConfig } from '../prompts/types';

/**
 * 获取当前开发环境上下文
 * 包括工作区路径、操作系统、Git 状态等
 */
export function getEnvContext(): EnvContext {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '未知';

  // 检测是否为 Git 仓库
  let isGitRepo = false;
  if (workspaceFolder !== '未知') {
    const gitDir = path.join(workspaceFolder, '.git');
    isGitRepo = fs.existsSync(gitDir);
  }

  return {
    workspaceFolder,
    isGitRepo,
    platform: process.platform,
    shell: vscode.env.shell,
    osVersion: `${os.type()} ${os.release()}`,
  };
}

/**
 * 从 VS Code 用户设置中读取模型配置
 * 设置项前缀为 myAiPlugin.*
 */
export function getModelConfig(): ModelConfig {
  const config = vscode.workspace.getConfiguration('myAiPlugin');

  const modelId = config.get<string>('modelId', 'deepseek-chat');

  return {
    modelName: config.get<string>('modelName', 'DeepSeek Chat'),
    modelId,
    baseUrl: config.get<string>('baseUrl', 'https://api.deepseek.com'),
    apiKey: config.get<string>('apiKey', ''),
    knowledgeCutoff: getKnowledgeCutoff(modelId),
  };
}

/**
 * 根据模型 ID 返回知识截止日期
 * 新增模型时在此表中添加对应条目即可
 */
function getKnowledgeCutoff(modelId: string): string {
  const cutoffMap: Record<string, string> = {
    'deepseek-chat': '2025年3月',
    'deepseek-coder': '2025年3月',
    'gpt-4o': '2024年10月',
    'gpt-4o-mini': '2024年10月',
    'gpt-4-turbo': '2024年4月',
    'doubao-pro-32k': '2025年1月',
    'doubao-lite-32k': '2025年1月',
  };
  return cutoffMap[modelId] ?? '未知';
}

/**
 * 检测工作区项目类型和技术栈
 * 通过扫描常见配置文件来识别，返回技术栈描述字符串
 */
export function detectProjectType(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) { return ''; }

  const indicators: string[] = [];

  // 定义：文件名 → 技术标签
  const fileToTech: [string, string][] = [
    ['package.json', 'Node.js'],
    ['tsconfig.json', 'TypeScript'],
    ['pom.xml', 'Java/Maven'],
    ['build.gradle', 'Java/Gradle'],
    ['requirements.txt', 'Python'],
    ['pyproject.toml', 'Python'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['composer.json', 'PHP'],
    ['Gemfile', 'Ruby'],
    ['.csproj', 'C#/.NET'],
    ['CMakeLists.txt', 'C/C++'],
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'],
    ['.vue', ''],
  ];

  for (const [file, tech] of fileToTech) {
    if (fs.existsSync(path.join(workspaceFolder, file)) && tech) {
      indicators.push(tech);
    }
  }

  // 检测前端框架（从 package.json 读取依赖）
  const pkgPath = path.join(workspaceFolder, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['react']) { indicators.push('React'); }
      if (allDeps['vue']) { indicators.push('Vue'); }
      if (allDeps['@angular/core']) { indicators.push('Angular'); }
      if (allDeps['next']) { indicators.push('Next.js'); }
      if (allDeps['express']) { indicators.push('Express'); }
      if (allDeps['vscode']) { indicators.push('VS Code Extension'); }
      if (allDeps['@types/vscode']) { indicators.push('VS Code Extension'); }
    } catch {
      // 解析失败则跳过
    }
  }

  // 去重
  const unique = [...new Set(indicators)];
  return unique.length > 0 ? unique.join(', ') : '';
}

/**
 * 获取 Git 状态信息：当前分支名 + 未提交的变更文件
 * 用于注入 system prompt，让 AI 了解用户当前的开发上下文
 */
export function getGitStatus(): { branch: string; changedFiles: string[] } {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) { return { branch: '', changedFiles: [] }; }

  const gitDir = path.join(workspaceFolder, '.git');
  if (!fs.existsSync(gitDir)) { return { branch: '', changedFiles: [] }; }

  let branch = '';
  let changedFiles: string[] = [];

  try {
    // 读取当前分支（从 .git/HEAD）
    const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (headContent.startsWith('ref: refs/heads/')) {
      branch = headContent.replace('ref: refs/heads/', '');
    } else {
      branch = headContent.substring(0, 8) + '...'; // detached HEAD
    }
  } catch {
    // 读取失败则跳过
  }

  try {
    // 通过 child_process 获取未提交文件（同步执行，限时 3 秒）
    const { execSync } = require('child_process');
    const output = execSync('git status --porcelain', {
      cwd: workspaceFolder,
      timeout: 3000,
      encoding: 'utf-8',
    });
    changedFiles = output
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => line.substring(3).trim())
      .slice(0, 20); // 最多 20 个文件，避免列表过长
  } catch {
    // git 命令执行失败则跳过
  }

  return { branch, changedFiles };
}

/**
 * 获取用户偏好语言
 * 默认返回中文
 */
export function getLanguagePreference(): string {
  const config = vscode.workspace.getConfiguration('myAiPlugin');
  return config.get<string>('language', '中文');
}

/**
 * 读取工作区根目录的 README.md 和 package.json，提炼项目背景信息
 *
 * 用于注入系统提示词，让 AI 了解当前项目的用途和依赖，
 * 减少用户需要手动说明"这是什么项目"的重复劳动。
 *
 * @returns 格式化好的项目背景字符串，若工作区为空或文件不存在则返回空字符串
 */
export function getProjectContext(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) { return ''; }

  const sections: string[] = [];

  // ── README.md ────────────────────────────────────────────
  const readmePath = path.join(workspaceFolder, 'README.md');
  if (fs.existsSync(readmePath)) {
    try {
      const raw = fs.readFileSync(readmePath, 'utf-8');
      // 只取前 2000 字，避免巨型 README 撑爆 token
      const snippet = raw.length > 2000 ? raw.slice(0, 2000) + '\n...(已截断)' : raw;
      sections.push(`### 项目 README\n${snippet}`);
    } catch {
      // 读取失败则跳过
    }
  }

  // ── package.json ─────────────────────────────────────────
  const pkgPath = path.join(workspaceFolder, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const lines: string[] = [];

      if (pkg.name)        { lines.push(`- 名称：${pkg.name}`); }
      if (pkg.description) { lines.push(`- 描述：${pkg.description}`); }
      if (pkg.version)     { lines.push(`- 版本：${pkg.version}`); }

      // scripts：只列出前 6 个，避免冗余
      const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 6);
      if (scripts.length > 0) {
        lines.push(`- 脚本：${scripts.join(', ')}`);
      }

      // 依赖：合并 dependencies + devDependencies，只列包名，最多 15 个
      const allDeps = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }).slice(0, 15);
      if (allDeps.length > 0) {
        lines.push(`- 主要依赖：${allDeps.join(', ')}`);
      }

      if (lines.length > 0) {
        sections.push(`### package.json 摘要\n${lines.join('\n')}`);
      }
    } catch {
      // JSON 解析失败则跳过
    }
  }

  if (sections.length === 0) { return ''; }

  return `## 当前项目背景（自动读取）\n\n${sections.join('\n\n')}`;
}
