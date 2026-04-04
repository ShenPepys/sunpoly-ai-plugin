# Claude Code 源码分析 - 03 工具系统

---

## 一、工具基础接口 `Tool.ts`

所有工具通过 `buildTool()` 构建，核心接口：

```typescript
type ToolDef<TInput, TOutput> = {
  name: string
  description(input, ctx): Promise<string>     // 动态描述（上下文感知）
  prompt(): Promise<string>                     // 发给模型的提示词
  inputSchema: ZodSchema                        // Zod 输入验证
  outputSchema: ZodSchema                       // Zod 输出验证
  userFacingName(input): string                 // 界面显示名（如 "Reading src/foo.ts"）

  checkPermissions(input, ctx): Promise<PermissionResult>  // 权限检查
  call(input, ctx): AsyncGenerator<Progress, Output>       // 实际执行

  // 可选字段
  validateInput(input, ctx): Promise<ValidationResult>     // 输入校验
  maxResultSizeChars?: number     // 结果大小限制
  isConcurrencySafe?: boolean     // 是否可并发执行
  shouldDefer?: boolean           // 是否延迟（ToolSearch 用）
  getActivityDescription(input): string  // 进度显示文字
  getPath(input): string | null          // 文件路径提取（权限日志用）
}
```

### ToolUseContext（工具调用上下文）

每次工具调用时传递的上下文，包含：
```typescript
type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache          // 文件内容 LRU 缓存
  getAppState(): AppState
  setAppState(f): void
  setAppStateForTasks?(f): void          // 基础设施级别的 setAppState
  handleElicitation?                     // MCP elicitation 处理
  setToolJSX?: SetToolJSXFn             // 设置工具 JSX（权限对话框等）
  addNotification?: (notif) => void
  appendSystemMessage?                   // 添加系统消息
  sendOSNotification?                    // 发送 OS 通知
  setInProgressToolUseIDs: (f) => void
  setHasInterruptibleToolInProgress?     // 是否有可中断的工具在执行
  setResponseLength: (f) => void
  updateFileHistoryState: (f) => void    // 文件变更历史
  updateAttributionState: (f) => void    // commit 归因
  agentId?: AgentId                      // 子代理时设置
  agentType?: string                     // 子代理类型
  messages: Message[]
  fileReadingLimits?: { maxTokens?, maxSizeBytes? }
  globLimits?: { maxResults? }
  toolDecisions?: Map<...>               // 工具决策记录（来源/accept|reject/时间戳）
  queryTracking?: QueryChainTracking     // 查询链追踪（chainId/depth）
}
```

---

## 二、工具清单（40+ 个）

### 文件操作工具

| 工具 | 文件 | 说明 |
|------|------|------|
| `FileReadTool` | `FileReadTool/` | 读取文件（支持 PDF/图片/Notebook，token 预算控制）|
| `FileEditTool` | `FileEditTool/` | 编辑文件（old_string→new_string，自动 git diff）|
| `FileWriteTool` | `FileWriteTool/` | 写入/创建文件（完整内容覆盖）|
| `GlobTool` | `GlobTool/` | 文件路径 glob 匹配（最多 100 个结果）|
| `GrepTool` | `GrepTool/` | 基于 ripgrep 的内容搜索（-A/-B/-C/-n 等参数）|
| `NotebookEditTool` | `NotebookEditTool/` | Jupyter Notebook cell 编辑 |

### Shell 执行工具

| 工具 | 说明 |
|------|------|
| `BashTool` | Shell 命令执行（30分钟超时，沙盒可选，后台化支持）|
| `PowerShellTool` | Windows PowerShell（Windows 平台）|
| `REPLTool` | 交互式 REPL（ant-only，Python/Node 等）|

### Agent 与任务工具

| 工具 | 说明 |
|------|------|
| `AgentTool` | 派生子代理（sync/async/remote/worktree/fork 模式）|
| `SendMessageTool` | 向团队成员发消息（swarm 模式）|
| `TaskCreateTool` | 创建任务（TodoV2 系统）|
| `TaskGetTool` | 获取单个任务 |
| `TaskUpdateTool` | 更新任务状态/描述 |
| `TaskListTool` | 列出所有任务 |
| `TaskStopTool` | 停止后台任务 |
| `TaskOutputTool` | 获取后台任务输出 |
| `TodoWriteTool` | 写入 TODO 列表（TodoV1，旧版）|

### 网络工具

| 工具 | 说明 |
|------|------|
| `WebFetchTool` | HTTP 抓取并处理（带 prompt 对内容提问）|
| `WebSearchTool` | 网络搜索（Anthropic beta web_search）|
| `WebBrowserTool` | 完整浏览器操作（WEB_BROWSER_TOOL feature）|

### 计划模式工具

| 工具 | 说明 |
|------|------|
| `EnterPlanModeTool` | 进入 plan 模式（权限降低到只读）|
| `ExitPlanModeV2Tool` | 退出 plan 模式（用户批准）|

### Worktree 工具

| 工具 | 说明 |
|------|------|
| `EnterWorktreeTool` | 进入 Git worktree 分支工作区 |
| `ExitWorktreeTool` | 退出 worktree，合并变更 |

### MCP 相关

| 工具 | 说明 |
|------|------|
| `MCPTool` | MCP 协议工具代理（动态创建，每个 MCP 工具对应一个）|
| `ListMcpResourcesTool` | 列出 MCP 服务器资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源内容 |

### 调度/定时工具（AGENT_TRIGGERS feature）

| 工具 | 说明 |
|------|------|
| `CronCreateTool` | 创建定时任务（cron 表达式）|
| `CronDeleteTool` | 删除定时任务 |
| `CronListTool` | 列出所有定时任务 |
| `RemoteTriggerTool` | 远程触发器 |

### 通信工具（Kairos feature）

| 工具 | 说明 |
|------|------|
| `SendUserFileTool` | 发送文件给用户 |
| `PushNotificationTool` | 推送通知 |
| `SubscribePRTool` | 订阅 PR 事件 |

### 其他

| 工具 | 说明 |
|------|------|
| `LSPTool` | LSP 诊断查询 |
| `ToolSearchTool` | 工具搜索（延迟加载真实工具）|
| `ConfigTool` | 读写配置 |
| `AskUserQuestionTool` | 向用户提问（阻塞等待回答）|
| `SleepTool` | 延迟等待（Kairos/proactive 模式）|
| `TeamCreateTool` | 创建团队（swarm）|
| `TeamDeleteTool` | 删除团队 |
| `TungstenTool` | 特殊分析工具（ant-only）|
| `BriefTool` | Brief 摘要生成 |
| `LSPTool` | LSP 服务器诊断 |
| `SyntheticOutputTool` | 合成输出（SDK 模式）|
| `TestingPermissionTool` | 测试用权限工具 |
| `ExitPlanModeTool` | 退出 plan 模式（V1，旧版）|

---

## 三、BashTool 详解

### 命令分类（用于 UI 折叠显示）

```typescript
BASH_SEARCH_COMMANDS = ['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'fd', ...]
BASH_READ_COMMANDS   = ['cat', 'head', 'tail', 'jq', 'awk', 'sed', 'less', ...]
BASH_LIST_COMMANDS   = ['ls', 'tree', 'du', 'df']
BASH_SILENT_COMMANDS = ['mv', 'cp', 'rm', 'mkdir', 'touch', 'chmod', ...]
```

### 后台化机制

```
前台命令：等待完成，实时显示输出
  ↓ 超过 15 秒（Assistant 模式）
后台命令：立即返回 task_id，模型通过 TaskOutputTool 查询
```

### 沙盒集成（macOS）

```typescript
SandboxManager.isSandboxingEnabled()
  → 沙盒模式：网络访问受限，文件系统访问受限
  → 权限对话框：SandboxPermissionRequest 展示限制原因
```

### 卡顿检测（Stall Watchdog）

```typescript
STALL_CHECK_INTERVAL_MS = 5_000    // 每5秒检查
STALL_THRESHOLD_MS = 45_000        // 45秒无输出 → 卡顿
STALL_TAIL_BYTES = 1024            // 读最后 1KB 检测

PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  // ...
]
```

如果检测到像交互式提示，发送 `TASK_NOTIFICATION` 消息，模型可介入处理。

### 危险模式检测 `utils/bash/dangerousPatterns.ts`

```typescript
DANGEROUS_BASH_PATTERNS = [
  'rm -rf /',
  'mkfs',
  '> /dev/sda',
  'chmod 777 /',
  'dd if=',
  ':(){:|:&};:',  // fork bomb
  // ...
]
```

---

## 四、AgentTool 详解（主文件 234KB）

### 执行模式

| 模式 | 说明 |
|------|------|
| `sync` | 同步执行，阻塞等待完成 |
| `async` | 异步执行，立即返回 task_id |
| `remote` | 在 CCR 远端执行（云端代理）|
| `worktree` | 在独立 Git worktree 中执行 |
| `fork` | 进程 fork 隔离执行（FORK_SUBAGENT feature）|

### 代理定义格式（`.claude/agents/my-agent.md`）

```markdown
---
description: "描述此代理的职责"
when_to_use: "何时调用此代理"
tools: [BashTool, FileEditTool]    # 可选：限制工具集
model: claude-3-5-sonnet-latest    # 可选：指定模型
context: fork                       # 可选：执行上下文
---
你是一个专门做 X 的代理...
```

### 内置代理类型

- `general-purpose` — 通用子代理
- `Bash` — 专注 Shell 操作
- `Explore` — 代码库探索
- `Verification` — 验证/测试代理

### 子代理上下文隔离

子代理通过 `AsyncLocalStorage` 隔离：
```typescript
// 子代理的 setAppState 是 no-op，防止覆盖主线程状态
// 只有 setAppStateForTasks 可以访问根 store（注册后台任务）
createSubagentContext(toolUseContext, {
  agentId,
  setAppState: () => {},  // no-op
  setAppStateForTasks: rootSetAppState,  // 可访问根 store
})
```

---

## 五、FileEditTool 详解

### 输入 Schema

```typescript
type FileEditInput = {
  file_path: string
  old_string: string    // 精确匹配（包括空白字符）
  new_string: string    // 替换后的内容
}
```

### 执行流程

```
1. 读取文件当前内容（FileStateCache）
2. 精确查找 old_string（失败时给出上下文建议）
3. 替换为 new_string
4. 写入文件
5. 生成 structuredPatch（unified diff）
6. 更新 FileStateCache（带 mtime 验证）
7. 触发 LSP 诊断追踪
8. 触发 FileChanged hooks
9. 返回 diff 用于 UI 渲染
```

### IDE 集成

```typescript
useDiffInIDE()  // 在 VS Code/JetBrains 显示 diff 预览
  → callIdeRpc('openDiff', { ... })  // 打开 IDE diff 视图
  → 等待用户在 IDE 中 accept/reject
  → 将决策传递回权限系统
```

---

## 六、工具结果大小控制

```typescript
// applyToolResultBudget() 在 toolOrchestration.ts 中调用
const MAX_TOOL_RESULT_CHARS = 250_000  // 单个工具结果最大字符数
const TRUNCATION_SUFFIX = '\n... [output truncated]'
```

工具结果超出限制时：
1. 截断到 `MAX_TOOL_RESULT_CHARS`
2. 附加截断说明
3. 长结果写入 `ContentReplacementState`（引用替代，减小消息体积）

---

## 七、工具加载 `tools.ts`

工具注册顺序决定模型看到的工具列表顺序。主要的条件加载：

```typescript
// ant-only
REPLTool: process.env.USER_TYPE === 'ant'
SuggestBackgroundPRTool: process.env.USER_TYPE === 'ant'

// feature flags
SleepTool: feature('PROACTIVE') || feature('KAIROS')
CronTools: feature('AGENT_TRIGGERS')
RemoteTriggerTool: feature('AGENT_TRIGGERS_REMOTE')
MonitorTool: feature('MONITOR_TOOL')
SendUserFileTool: feature('KAIROS')
PushNotificationTool: feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
WebBrowserTool: feature('WEB_BROWSER_TOOL')
WorkflowTool: feature('WORKFLOW_SCRIPTS')
SnipTool: feature('HISTORY_SNIP')
ListPeersTool: feature('UDS_INBOX')

// 环境变量
PowerShellTool: isPowerShellToolEnabled()   // Windows 且已启用
VerifyPlanExecutionTool: process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
```

### 工具集预设

```typescript
// --tools 命令行参数支持的预设
TOOL_PRESETS = {
  'read-only': [FileReadTool, GlobTool, GrepTool],
  'write': [FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool],
  'bash': [BashTool, ...writeTools],
  // ...
}
```
