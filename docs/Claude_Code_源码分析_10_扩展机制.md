# Claude Code 源码分析 - 10 扩展机制（技能/插件/记忆）

---

## 一、技能系统（Skills）`skills/`

### 技能文件格式（`.claude/skills/my-skill.md`）

```markdown
---
description: "创建一个 React 组件"
argument-hint: "<组件名> [props...]"
allowed-tools: [FileWriteTool, BashTool]
model: claude-3-5-sonnet-latest
context: fork            # 在子代理中执行（不共享对话历史）
when-to-use: "当用户需要创建新的 React 组件时"
paths: ["src/**/*.tsx"]  # 只在接触这些路径后激活
effort: high             # 影响思考深度
---
创建一个名为 {{ARG1}} 的 React 组件，要求：
- TypeScript 类型定义
- Props 接口 `{{ARG1}}Props`
- 默认导出
- 使用 TailwindCSS 样式
```

### 技能 Frontmatter 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 技能描述（显示在 /help 和 AI 调用时）|
| `argument-hint` | string | 参数提示（如 `<file> [options]`）|
| `allowed-tools` | string[] | 限制此技能可用的工具集 |
| `model` | string | 指定执行模型 |
| `context` | 'inline' \| 'fork' | inline=共享历史，fork=子代理 |
| `when-to-use` | string | 向 AI 说明何时调用此技能 |
| `paths` | string[] | 条件激活：只在接触匹配路径后可见 |
| `effort` | string | 思考深度（low/medium/high） |
| `hooks` | HooksSettings | 技能级别的 hooks 配置 |
| `agent` | string | 指定执行此技能的代理类型 |
| `shell` | boolean | true = 执行 frontmatter 中的 shell 命令来生成 prompt |

### 技能加载 `skills/loadSkillsDir.ts`

```typescript
// 加载所有技能（多目录合并）
getSkillDirCommands(dirs) → Command[]
  ├─ 遍历 dirs（~/.claude/skills, .claude/skills, plugins/skills）
  ├─ 读取 *.md 文件
  ├─ 解析 frontmatter（parseFrontmatter）
  ├─ 应用变量替换（{{ARG1}} etc.）
  ├─ 检查 paths 条件（trackedFiles 是否匹配）
  └─ 注册为 PromptCommand

// 动态技能（条件激活）
getDynamicSkills(trackedFiles) → Command[]
  → 返回 paths 字段匹配当前已接触文件的技能
```

### 技能搜索引擎 `services/skillSearch/` (EXPERIMENTAL_SKILL_SEARCH)

```typescript
// 为技能建立本地向量索引
buildSkillIndex(skills: Command[]) → Promise<void>
  → 生成每个技能 description 的 embedding
  → 保存到 ~/.claude/skill_index_{hash}.bin

// 语义搜索技能
searchSkills(query: string) → Promise<SkillSearchResult[]>
  → 查询 query 的 embedding
  → 余弦相似度匹配
  → 返回 topK 结果

// ToolSearchTool 使用此服务
// 模型先用 ToolSearchTool 找到相关技能，再调用
```

### 内置技能 `skills/bundledSkills.ts`

```typescript
// 注册随 CLI 附带的内置技能
registerBundledSkill({
  name: 'memory',
  description: '保存/查询长期记忆',
  getPromptForCommand: async (args, ctx) => {
    return [{ type: 'text', text: '...' }]
  }
})

// 内置技能可带附属文件
registerBundledSkill({
  name: 'analysis',
  files: {
    'templates/report.md': '# Analysis Report Template...',
    'examples/sample.md': '...',
  },
  // files 会在首次调用时解压到 ~/.claude/skills/bundled/analysis/
})
```

---

## 二、插件系统 `plugins/`

### 插件类型

| 类型 | 标识符 | 来源 |
|------|--------|------|
| 内置插件 | `name@builtin` | 随 CLI 附带，用户可启/禁 |
| 市场插件 | `name@marketplace` | 从市场 URL 安装 |
| 本地插件 | `name@local` | `--plugin-dir` 命令行参数 |

### 插件清单格式（`plugin.json`）

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "示例插件",
  "skills": [
    {
      "name": "my-skill",
      "description": "...",
      "content": "技能提示词内容"
    }
  ],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "BashTool",
        "hooks": [{"type": "command", "command": "echo $TOOL_NAME"}]
      }
    ]
  },
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "my-mcp-server",
      "args": ["--port", "3001"]
    }
  },
  "lspServers": [
    {
      "name": "pylsp",
      "command": "pylsp",
      "extensions": [".py"],
      "rootUri": "file://${workspaceFolder}"
    }
  ]
}
```

### 内置插件注册 `plugins/builtinPlugins.ts`

```typescript
// 注册内置插件
registerBuiltinPlugin({
  name: 'playwright',
  description: 'Browser automation with Playwright',
  isAvailable: () => true,          // 始终可用
  defaultEnabled: false,            // 默认禁用
  skills: [{ name: 'browser-test', ... }],
  mcpServers: { 'playwright': { ... } }
})

// 获取所有内置插件（按启用状态分组）
getBuiltinPlugins() → { enabled: LoadedPlugin[], disabled: LoadedPlugin[] }

// 判断是否是内置插件 ID
isBuiltinPluginId('playwright@builtin') → true
```

### 插件加载流程 `utils/plugins/pluginLoader.ts`

```typescript
// 1. 从 settings.json 读取插件配置
// 2. 加载内置插件（按 user settings 启用/禁用）
// 3. 加载市场插件（从 ~/.claude/plugins/ 目录）
// 4. 加载本地插件（--plugin-dir 参数）
// 5. 解析每个插件的 plugin.json
// 6. 注册 MCP 服务器
// 7. 注册 hooks
// 8. 合并技能到全局命令列表
loadAllPlugins() → Promise<LoadedPlugin[]>
```

### 插件安装 `utils/plugins/pluginInstallationHelpers.ts`

```typescript
// 从市场安装插件
installPluginFromMarketplace(pluginId: string) → Promise<InstallResult>
  → 解析 pluginId（name@marketplace）
  → 从 marketplace URL 拉取 plugin.json
  → 验证签名（SHA256）
  → 克隆 git 仓库到 ~/.claude/plugins/
  → 更新 settings.json

// 注册插件（已有源文件）
cacheAndRegisterPlugin(pluginPath: string) → Promise<void>
```

### LSP 插件推荐 `utils/plugins/lspRecommendation.ts`

```typescript
// 检测文件扩展名，推荐对应 LSP 插件
getMatchingLspPlugins(fileExtension: string) → LspPluginMatch[]
  → 检查是否有对应 LSP 可执行文件（which pylsp, etc.）
  → 检查对应插件是否已安装
  → 返回推荐列表

// 已展示过就不再推荐
incrementIgnoredCount(pluginId: string) → void
addToNeverSuggest(pluginId: string) → void
```

---

## 三、Hooks 系统详解

### Hooks 配置格式

```json
// settings.json 或 plugin.json 中配置
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "BashTool",        // 工具名匹配
        "hooks": [
          {
            "type": "command",
            "command": "validate-command.sh $TOOL_INPUT",
            "timeout": 30000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",               // 匹配所有工具
        "hooks": [
          {
            "type": "command",
            "command": "audit-log.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "notify.sh 'Claude stopped'"
          }
        ]
      }
    ]
  }
}
```

### Hook 环境变量

```bash
# PreToolUse / PostToolUse hooks 中可用的环境变量
TOOL_NAME="BashTool"
TOOL_INPUT='{"command": "git status"}'
TOOL_RESULT='{"stdout": "On branch main..."}'  # PostToolUse
SESSION_ID="abc123"
CWD="/path/to/project"
MODEL="claude-opus-4-5"
```

### SDK Hooks（程序注册）

```typescript
// SDK 模式下可以通过代码注册 hooks
registerPostSamplingHook('Stop', async (context) => {
  const { messages, toolUseContext } = context
  // 在每次 AI 停止时执行
  await extractMemories(messages, toolUseContext)
})

// 内置 PostSampling hooks
registerPostSamplingHook('Stop', extractMemoriesHook)
registerPostSamplingHook('Stop', autoDreamHook)
registerPostSamplingHook('Stop', promptSuggestionHook)
```

### Hook 事件完整列表（29 种）

```typescript
const HOOK_EVENTS = [
  'PreToolUse',        // 工具调用前（可阻止）
  'PostToolUse',       // 工具调用后
  'PostToolUseFailure', // 工具调用失败后
  'Notification',      // OS 通知前
  'UserPromptSubmit',  // 用户提交 prompt 前（可修改）
  'SessionStart',      // 会话开始
  'SessionEnd',        // 会话结束
  'Stop',              // AI 停止（主要的后处理 hook）
  'StopFailure',       // AI 停止失败
  'SubagentStart',     // 子代理开始
  'SubagentStop',      // 子代理停止
  'PreCompact',        // 压缩前
  'PostCompact',       // 压缩后
  'PermissionRequest', // 权限请求（可自动批准）
  'PermissionDenied',  // 权限被拒绝
  'Setup',             // 初始化 hook（安装依赖等）
  'TeammateIdle',      // 团队成员空闲
  'TaskCreated',       // 任务创建
  'TaskCompleted',     // 任务完成
  'Elicitation',       // MCP 请求用户输入
  'ElicitationResult', // elicitation 结果
  'ConfigChange',      // 配置变更
  'WorktreeCreate',    // Worktree 创建
  'WorktreeRemove',    // Worktree 删除
  'InstructionsLoaded', // CLAUDE.md 加载
  'CwdChanged',        // 工作目录变化
  'FileChanged',       // 文件变化（FileEditTool/FileWriteTool 后触发）
]
```

---

## 四、自动记忆系统 `memdir/`

### 记忆文件路径 `memdir/paths.ts`

```typescript
// 是否启用自动记忆
isAutoMemoryEnabled(): boolean
  → 检查 CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量
  → --bare / SIMPLE 模式 → 禁用
  → CCR 远程且无持久存储 → 禁用
  → settings.autoMemoryEnabled 设置
  → 默认：启用

// 记忆文件路径
getAutoMemPath() → string
  → ~/.claude/memories/{projectHash}/MEMORY.md
  → projectHash = sha256(projectRoot)
```

### MEMORY.md 管理 `memdir/memdir.ts`

```typescript
// MEMORY.md 约束
MAX_ENTRYPOINT_LINES = 200   // 最大 200 行
MAX_ENTRYPOINT_BYTES = 25_000  // 最大 25KB

// 超出限制时的截断处理
truncateEntrypointContent(raw: string): EntrypointTruncation
  → 先按行数截断（200行）
  → 再按字节截断（25KB，在最近的换行符处）
  → 附加截断说明（"[Truncated: exceeded 200-line limit]"）

// 构建记忆 prompt
buildMemoryPrompt(context: ToolUseContext) → Promise<string>
  → 读取 MEMORY.md（截断处理）
  → 格式化为系统提示片段
  → 包含"如何使用记忆"的说明
```

### MEMORY.md 格式规范

```markdown
<!-- 记忆文件示例 -->
# Project Context
- This is a TypeScript monorepo using pnpm workspaces
- Main packages: core, api, web
- Testing: vitest for unit, playwright for E2E

# User Preferences
- Prefers functional programming style
- Uses named exports over default exports
- Always adds JSDoc comments

# Important Notes
- auth.ts uses JWT stored in httpOnly cookies
- Database: PostgreSQL with Drizzle ORM
- CI/CD: GitHub Actions
```

### Frontmatter 标记

MEMORY.md 中的 frontmatter 可以标记记忆的类型：
```markdown
---
type: preference    # 用户偏好
importance: high    # 重要性
expires: 2026-06-01 # 过期时间
---
User prefers dark mode
```

---

## 五、CLAUDE.md 加载 `utils/claudemd.ts`

### 加载优先级（从低到高）

```
1. 托管文件（/etc/claude-code/CLAUDE.md）           # 最先注入
2. 用户主目录（~/.claude/CLAUDE.md）
3. 项目根目录（CLAUDE.md 或 .claude/CLAUDE.md）
4. 子目录（逐级向上，直到 git root）               # 最后注入（模型更关注）
5. 本地私有（CLAUDE.local.md）
```

**注入顺序设计**：越靠后注入的内容，在模型的 attention 中权重越高。项目级配置比全局配置优先级更高。

### CLAUDE.md 特殊语法

```markdown
<!-- 条件激活（paths 过滤）-->
<!-- paths: src/**/*.py -->
# Python 代码规范
- 使用 black 格式化
- type hints 必须

<!-- 嵌套引用（nested memory）-->
@./docs/ARCHITECTURE.md
@./src/auth/README.md
```

### 记忆类型注入（nested memory attachments）

```typescript
// 当模型读取了包含 @ 引用的 CLAUDE.md 时
// 将被引用的文件作为 attachment 注入对话
filterInjectedMemoryFiles(files, alreadyInjected)
  → 避免重复注入（loadedNestedMemoryPaths 去重）
```

---

## 六、键盘绑定系统 `keybindings/`

### 默认键绑定 `keybindings/defaultBindings.ts`

```typescript
// Global Context（始终有效）
DEFAULT_BINDINGS = [{
  context: 'Global',
  bindings: {
    'ctrl+c': 'app:interrupt',
    'ctrl+d': 'app:exit',
    'ctrl+l': 'app:redraw',
    'ctrl+t': 'app:toggleTodos',
    'ctrl+o': 'app:toggleTranscript',
    'ctrl+r': 'history:search',
    'shift+tab': 'mode:cycle',    // Windows 无 VT mode → meta+m
    'ctrl+b': 'app:backgroundSession',
    'ctrl+e': 'app:editCurrentMessage',
    'meta+j': 'app:toggleTerminal',   // TERMINAL_PANEL feature
    'ctrl+shift+f': 'app:globalSearch', // QUICK_SEARCH feature
  }
}]
```

### 用户自定义键绑定（`~/.claude/keybindings.json`）

```json
{
  "bindings": {
    "Global": {
      "ctrl+shift+h": "history:search",
      "ctrl+j": "app:toggleTodos"
    },
    "PromptInput": {
      "ctrl+enter": "prompt:submit",
      "alt+r": "prompt:clear"
    }
  }
}
```

### 键绑定系统架构

```typescript
// KeybindingContext 提供全局键绑定
KeybindingProvider → KeybindingContext
  ├─ bindings: ParsedBinding[]       // 所有解析后的键绑定
  ├─ resolve(input, key, contexts)   // 解析按键 → action
  ├─ pendingChord: ParsedKeystroke[] // 当前 chord 状态（如 ctrl+x ctrl+s）
  ├─ activeContexts: Set<...>        // 当前活跃的上下文（决定优先级）
  ├─ registerActiveContext(ctx)      // 注册活跃上下文
  └─ registerHandler(action, handler)// 注册 action 处理器

// Chord 支持（两段键）
// ctrl+x, ctrl+s → 保存（Emacs 风格）
// 第一段按下后显示 "Chord: ctrl+x..."
// 等待第二段键完成 chord
```

### 快捷键验证 `keybindings/validate.ts`

用户 keybindings.json 中的问题会在启动时警告：
```
- 绑定到保留快捷键（ctrl+c/ctrl+d 不可重绑）
- 与已有绑定冲突
- 无效的按键格式
- 无效的 action 名称
```

### 保留快捷键 `keybindings/reservedShortcuts.ts`

```typescript
RESERVED_SHORTCUTS = ['ctrl+c', 'ctrl+d']
// 这两个有特殊的"双击"时序处理逻辑
// ctrl+c 单击 = 中断，双击快速 = 退出
// ctrl+d 单击 = 退出
```
