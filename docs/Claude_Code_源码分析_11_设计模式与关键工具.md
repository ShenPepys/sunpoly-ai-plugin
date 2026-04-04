# Claude Code 源码分析 - 11 设计模式与关键工具函数

---

## 一、关键设计模式

### 1.1 Feature 宏（构建时 DCE）

```typescript
// bun:bundle 提供的 feature() 宏
// 在构建时被替换为 true/false 常量
// 如果为 false，对应代码块被死代码消除（Dead Code Elimination）

import { feature } from 'bun:bundle'

// 正确用法（ternary，DCE 友好）
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null

// 错误用法（if-else 可能无法完全 DCE）
// if (!feature('BRIDGE_MODE')) return  // 不推荐
```

**已知 feature flags**（部分）：

| Flag | 说明 |
|------|------|
| `BRIDGE_MODE` | claude.ai 远程控制 |
| `KAIROS` | Kairos/Assistant 模式 |
| `KAIROS_BRIEF` | Brief 模式 |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub webhook 集成 |
| `PROACTIVE` | 主动模式 |
| `AGENT_TRIGGERS` | 定时任务工具 |
| `AGENT_TRIGGERS_REMOTE` | 远程触发器 |
| `COORDINATOR_MODE` | 协调器模式 |
| `FORK_SUBAGENT` | 进程 fork 子代理 |
| `DAEMON` | Daemon 模式 |
| `VOICE_MODE` | 语音输入 |
| `EXTRACT_MEMORIES` | 自动记忆提取 |
| `TEAMMEM` | 团队记忆 |
| `WORKFLOW_SCRIPTS` | 工作流脚本 |
| `MONITOR_TOOL` | 监控工具 |
| `QUICK_SEARCH` | 快速文件搜索（ctrl+shift+f）|
| `TERMINAL_PANEL` | 终端面板 |
| `WEB_BROWSER_TOOL` | 浏览器工具 |
| `UDS_INBOX` | UNIX domain socket 收件箱 |
| `CONTEXT_COLLAPSE` | 上下文折叠 |
| `REACTIVE_COMPACT` | 响应式压缩 |
| `HISTORY_SNIP` | 历史片段（snip 模式）|
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能语义搜索 |
| `ULTRAPLAN` | UltraPlan 模式 |
| `BG_SESSIONS` | 后台会话 |
| `DUMP_SYSTEM_PROMPT` | 系统提示 dump 工具 |
| `TEMPLATES` | 任务模板分类器 |

### 1.2 React Compiler 缓存（`_c(N)`）

许多组件使用 React Compiler 自动优化，生成：
```typescript
export function MyComponent({ prop1, prop2 }) {
  const $ = _c(6)  // 创建 N 格缓存槽

  let t0
  if ($[0] !== prop1 || $[1] !== prop2) {
    t0 = <div>{prop1}: {prop2}</div>  // 重新渲染
    $[0] = prop1
    $[1] = prop2
    $[2] = t0
  } else {
    t0 = $[2]  // 使用缓存
  }
  return t0
}
```

这比 `useMemo` 更细粒度，只有实际依赖变化时才重新计算。

### 1.3 AsyncLocalStorage（子代理隔离）

```typescript
// 每个子代理/团队成员有自己的 AsyncLocalStorage 上下文
// 防止并发代理互相覆盖全局状态

import { AsyncLocalStorage } from 'async_hooks'

const storage = new AsyncLocalStorage<AgentContext>()

// 在子代理中运行
storage.run({ agentId, sessionId }, async () => {
  // 在此 context 中：
  // getAgentId() → 返回此代理的 ID
  // getSessionId() → 返回此代理的 session ID
  // logging 自动标注 agentId
  await runAgent(messages, toolUseContext)
})
```

### 1.4 useSyncExternalStore 模式

```typescript
// 用于订阅外部 store（非 React state）
// 如 TasksV2Store、VoiceStore 等

class TasksV2Store {
  #changed = createSignal()  // 简单的发布-订阅

  subscribe(listener: () => void): () => void {
    return this.#changed.subscribe(listener)
  }

  getSnapshot(): TasksSnapshot {
    return { tasks: this.#tasks, hidden: this.#hidden }
  }
}

// 在组件中使用
const snapshot = useSyncExternalStore(
  store.subscribe,
  store.getSnapshot
)
```

### 1.5 Lazy Schema（避免循环依赖）

```typescript
// 解决循环依赖问题：schema 的定义延迟到第一次使用时
import { lazySchema } from '../utils/lazySchema.js'

const MySchema = lazySchema(() =>
  z.object({
    id: z.string(),
    children: z.array(MySchema())  // 递归引用
  })
)
```

### 1.6 Signal（简单发布-订阅）

```typescript
// utils/signal.ts
type Signal = {
  subscribe(listener: () => void): () => void
  emit(): void
}

function createSignal(): Signal {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      listeners.forEach(l => l())
    }
  }
}
```

### 1.7 Zod Schema 最佳实践

```typescript
// 所有工具 input/output 使用 Zod 验证
// lazySchema 包裹延迟初始化（解决循环/启动性能）
const BashInputSchema = lazySchema(() =>
  z.object({
    command: z.string().describe('Shell 命令'),
    timeout: z.number().optional().describe('超时（毫秒）'),
    description: z.string().optional()
  })
)

// 工具调用时验证输入
const parseResult = tool.inputSchema.safeParse(rawInput)
if (!parseResult.success) {
  return { behavior: 'deny', message: `Invalid input: ${parseResult.error.message}` }
}
```

---

## 二、关键工具函数 `utils/`

### 2.1 settings 系统 `utils/settings/`

```typescript
// 设置读取（多层次合并）
getInitialSettings(): SettingsJson
  → 合并 policySettings + userSettings + projectSettings
     + localSettings + flagSettings
  → 高优先级字段覆盖低优先级

// 按来源读取
getSettingsForSource(source: SettingSource): SettingsJson

// 更新特定来源的设置
updateSettingsForSource(source, updater)

// 保存全局配置
saveGlobalConfig(config: GlobalConfig)

// settings.json 完整类型（来自 JSON Schema 自动生成）
type SettingsJson = {
  model?: string
  smallModel?: string
  maxTokens?: number
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
  env?: Record<string, string>
  hooks?: HooksSettings
  autoMemoryEnabled?: boolean
  mcpServers?: Record<string, McpServerConfig>
  // ...100+ 字段
}
```

### 2.2 模型系统 `utils/model/`

```typescript
// 模型别名解析
parseUserSpecifiedModel(nameOrAlias: string): ModelName
  → 检查 GrowthBook 别名映射（tengu_ant_model_override）
  → 检查内置别名（claude-3-5-sonnet → claude-3-5-sonnet-20241022）
  → 返回完整模型名称

// 获取当前主循环模型
getMainLoopModel(): ModelName
  → mainLoopModelOverride（/model 命令）
  || settings.model
  || 默认模型（claude-opus-4-5 等）

// 模型成本计算
calculateUSDCost(usage: TokenUsage, model: ModelName): number
  → 基于 modelCost.ts 中的价格表

// 获取模型上下文窗口大小
getContextWindowForModel(model: ModelName): number
  → 200k（claude-3-5-sonnet/opus）, 100k（其他）

// 获取模型最大输出 token
getModelMaxOutputTokens(model: ModelName): number
  → 64k（claude-3-7-sonnet）, 16k（claude-3-5-sonnet）
```

### 2.3 配置系统 `utils/config.ts`

```typescript
// 全局配置（~/.claude.json）
getGlobalConfig(): GlobalConfig
saveGlobalConfig(config: GlobalConfig): void

// 项目配置（.claude/settings.json）
getCurrentProjectConfig(): ProjectConfig
saveCurrentProjectConfig(config: ProjectConfig): void

// 配置路径
GLOBAL_CONFIG_PATH = '~/.claude.json'
PROJECT_CONFIG_PATH = '.claude/settings.json'
LOCAL_CONFIG_PATH = '.claude/settings.local.json'
MANAGED_CONFIG_PATH = '/etc/claude-code/managed-settings.json'
```

### 2.4 会话存储 `utils/sessionStorage.ts`

```typescript
// 会话持久化（.claude/sessions/{hash}/{sessionId}.jsonl）
recordTranscript(messages: Message[]): Promise<void>
  → 增量追加新消息（只追加未记录的消息）
  → 每条消息序列化为 JSONL 格式

// 加载会话历史
loadSessionTranscript(sessionId: string): Promise<Message[]>

// 获取会话目录
getProjectDir(cwd: string): string
  → ~/.claude/projects/{projectHash}/

// 当前会话标题
getCurrentSessionTitle(): string | undefined
setCurrentSessionTitle(title: string): void
```

### 2.5 文件操作 `utils/fileRead.ts` / `utils/fsOperations.ts`

```typescript
// 支持大文件的行读取
readLinesReverse(filePath, maxLines) → AsyncGenerator<string>
  → 从文件末尾向前读取（用于历史记录）

// 批量文件读取（带 timeout）
readFileWithTimeout(filePath, timeoutMs) → Promise<string>

// 原子写入（先写临时文件，再原子移动）
writeFileAtomic(filePath, content): Promise<void>

// 安全的 JSON 操作（不抛出）
jsonParse(text): unknown | undefined
jsonStringify(value): string | undefined
```

### 2.6 Git 工具 `utils/git.ts`

```typescript
// 检查是否在 git 仓库中
getIsGit(): Promise<boolean>

// 获取当前分支
getBranch(): Promise<string>

// 获取默认分支
getDefaultBranch(): Promise<string>

// 获取远程 URL
getRemoteUrl(): Promise<string | undefined>

// 查找 git 根目录
findCanonicalGitRoot(cwd: string): Promise<string>

// 检查文件是否被 gitignore
isPathGitignored(filePath, cwd) → Promise<boolean>

// 获取当前 git 状态（短格式）
getGitStatus(): Promise<string | null>
```

### 2.7 消息工具 `utils/messages.ts`

```typescript
// 创建各类消息
createUserMessage(content, opts) → UserMessage
createAssistantMessage(content, opts) → AssistantMessage
createSystemMessage(text, subtype) → SystemMessage
createToolUseSummaryMessage(summary) → ToolUseSummaryMessage
createAttachmentMessage(content, opts) → AttachmentMessage
createCompactBoundaryMessage() → SystemCompactBoundaryMessage
createAwaySummaryMessage(summary) → SystemAwaySummaryMessage

// 消息归一化（发送给 API 前处理）
normalizeMessagesForAPI(messages) → APIMessages
  → 过滤 system 消息（not sent to API）
  → 合并连续的 user 消息
  → 清理 tool_result 格式
  → 处理 content_replacement_state

// 获取文本内容
getContentText(content: ContentBlockParam | ContentBlock) → string

// 计数工具调用
countToolCalls(messages) → number

// 过滤重复的记忆附件
filterDuplicateMemoryAttachments(messages, attachments) → AttachmentMessage[]
```

### 2.8 调试与日志 `utils/debug.ts` / `utils/log.ts`

```typescript
// 调试日志（只在 CLAUDE_DEBUG=true 时输出）
logForDebugging(message, opts?: { level: 'debug' | 'info' | 'warn' | 'error' })

// 错误日志（写入 ~/.claude/logs/{date}.log）
logError(error: unknown, context?: string)

// ant-only 错误日志（附加详细内部信息）
logAntError(error, context)

// 诊断日志（不含 PII，用于诊断问题）
logForDiagnosticsNoPII(level, event, data?)

// 内存中保存最近错误（供 /bug 命令读取）
getInMemoryErrors(): Array<{ error: string; timestamp: string }>
```

### 2.9 错误处理 `utils/errors.ts`

```typescript
// 统一错误消息提取
errorMessage(err: unknown): string
  → Error → err.message
  → string → err
  → 其余 → JSON.stringify(err)

// 特定错误类型检查
isENOENT(err): boolean       // 文件不存在
isFsInaccessible(err): boolean  // 文件系统不可访问
getErrnoCode(err): string | null  // 获取 errno 码

// 配置解析错误（专门类型）
class ConfigParseError extends Error { ... }
```

### 2.10 进程与平台 `utils/platform.ts`

```typescript
// 平台检测
getPlatform(): 'windows' | 'macos' | 'linux'

// 运行时检测
isRunningWithBun(): boolean  // Bun vs Node.js

// Bundle 模式检测
isInBundledMode(): boolean   // 是否在 Bun bundle 中运行

// Shell 路径（Windows 路径转换）
setShellIfWindows(): void    // 设置 SHELL env var（Windows 无此变量）
```

---

## 三、数据流总览

### 用户输入到 API 调用

```
用户键盘输入
  → useTextInput（状态管理）
  → usePasteHandler（粘贴处理）
  → useTypeahead（自动完成）
  → 用户按 Enter
  → REPL.tsx onQuery()
  → processUserInput()（检查斜杠命令）
  ├─ 斜杠命令 → 执行本地命令（/help, /config 等）
  └─ 普通消息 → query(messages, toolUseContext)
       → services/api/claude.ts queryModelWithStreaming()
       → Anthropic API（流式）
       → 解析 streaming events
       → yield AssistantMessage + StreamEvent
       → 如果有 tool_use → runTools()
          → tool.checkPermissions()
          → 如需询问 → toolUseConfirmQueue
          → 用户确认 → tool.call()
          → 返回 tool_result
       → 继续主循环
```

### 消息持久化流程

```
query() yield 新 Message
  → REPL.tsx setMessages()（React state）
  → useLogMessages（增量记录）
      → recordTranscript（追加到 .jsonl 文件）
  → Messages.tsx 渲染（虚拟滚动）
  → useReplBridge（推送到 claude.ai）
```

### 权限请求流程

```
tool.call() 触发权限检查
  → canUseTool（useCanUseTool hook）
  → interactiveHandler（主 REPL）
  → setToolUseConfirmQueue（添加到队列）
  → 渲染 PermissionRequest 组件
  → 用户选择（Allow/Deny/Always Allow）
  → Promise resolve(result)
  → 更新 alwaysAllowRules（如果选了 Always）
  → 继续 tool.call() 或返回错误
```

---

## 四、性能关键路径

### 4.1 启动性能

| 阶段 | 耗时目标 | 关键技术 |
|------|---------|---------|
| `--version` | < 10ms | 零模块加载 |
| 首次渲染 | < 500ms | 动态 import、懒加载 |
| MCP 连接 | 异步 | 不阻塞首次渲染 |
| GrowthBook 初始化 | 异步 | 使用 cached 值直到完成 |
| OTel 初始化 | 懒加载 | defer ~400KB 模块 |

```typescript
// 启动性能分析
profileCheckpoint('cli_entry')
profileCheckpoint('init_function_start')
profileCheckpoint('init_completed')
// ... 各阶段时间点记录
```

### 4.2 消息渲染性能

- 虚拟滚动：只渲染视口内 ±80 行
- 批量挂载：每批 25 个消息（SLIDE_STEP）
- 量化滚动：40px 量化（SCROLL_QUANTUM）
- React Compiler：细粒度依赖缓存

### 4.3 文件系统访问优化

```typescript
// FileStateCache：文件内容 LRU 缓存（防止重复读取）
// 最多缓存 100 个文件（或 25MB）
createFileStateCacheWithSizeLimit(100, 25 * 1024 * 1024)

// mtime 验证：文件变化时自动失效
readFileState.get(filePath)
  → 检查 mtime（stat 调用）
  → 命中 → 返回缓存
  → 未命中 → 读文件 → 更新缓存
```

### 4.4 API 成本优化

```typescript
// Prompt Cache 策略（每次请求节省 90% 成本）
// 系统提示 cache_control: { type: 'ephemeral' }
// 工具列表 cache_control（有 MCP 工具时）

// Micro-compact：清除旧工具结果（减小输入 token）
// Auto-compact：超过 80% context 时压缩（延续对话）

// 时间触发 micro-compact：
// 离开超过 60 分钟 → cache 已过期 → 主动清除旧内容
```

---

## 五、安全模型

### 5.1 路径遍历防护

```typescript
sanitizePath(userPath, baseDirs)
  → realpath（解析符号链接）
  → 确保在 baseDirs 之一的子路径内
  → 拒绝 '../../' 类型路径
```

### 5.2 命令注入防护

```typescript
// BashTool 输入不经过 shell 解释器直接传给 spawn
// execFile(shell, ['-c', command]) 而非 exec(command)
// 工具结果中的内容不会被当作 shell 命令执行
```

### 5.3 Prompt Injection 检测

```typescript
// yoloClassifier（Auto 模式）专门检测 prompt injection：
// 工具输出中包含 "Claude, please..." 类型的指令
// 通过 Haiku 分类器标记为"危险"，触发用户确认
```

### 5.4 Work Secret 安全

```typescript
// Work secret 是一次性 token（只用一次就失效）
// 通过环境变量而非命令行参数传递（避免 ps 泄露）
// 与 CCR 通信使用 HTTPS（不会明文传输）
```

---

## 六、斜杠命令系统 `commands/`

100+ 斜杠命令，通过 `getCommands()` 获取，主要分类：

### 系统管理类
- `/config` — 配置查看/修改
- `/doctor` — 环境诊断
- `/login` / `/logout` — OAuth 认证
- `/version` — 版本信息
- `/upgrade` — 更新到最新版本
- `/status` — 连接状态

### 对话管理类
- `/clear` — 清空对话历史
- `/compact` — 手动压缩
- `/resume` — 恢复历史会话
- `/session` — 会话管理
- `/export` — 导出对话

### 权限管理类
- `/permissions` — 权限规则管理
- `/plan` — 进入/退出 plan 模式

### 外部集成类
- `/mcp` — MCP 服务器管理
- `/ide` — IDE 集成
- `/share` — 分享对话
- `/commit` — 生成并提交 commit
- `/pr_comments` — 获取 PR 评论

### 记忆相关类
- `/memory` — 查看/编辑 MEMORY.md
- `/remember` — 立即保存指定内容到记忆

### 工具与插件类
- `/plugin` — 插件管理（安装/启用/禁用）
- `/reload-plugins` — 重新加载插件
- `/hooks` — Hooks 管理
- `/skills` — 技能列表

### 分析与报告类
- `/cost` — 显示本次会话成本
- `/usage` — 详细使用量报告
- `/insights` — 会话分析报告

### 开发调试类（ant-only 或 debug 模式）
- `/debug-tool-call` — 调试工具调用
- `/ant-trace` — 内部追踪
- `/break-cache` — 强制缓存失效
- `/backfill-sessions` — 会话数据回填
