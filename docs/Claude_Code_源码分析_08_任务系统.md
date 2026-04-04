# Claude Code 源码分析 - 08 任务系统

---

## 一、任务状态机

```
pending → running → completed
                 ↘ failed
                 ↘ killed
```

```typescript
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
type TaskType   = 'local_bash' | 'local_agent' | 'remote_agent'
               | 'in_process_teammate' | 'local_workflow'
               | 'monitor_mcp' | 'dream'

// 终态判断（不再转换）
isTerminalTaskStatus(status) → status === 'completed' | 'failed' | 'killed'
```

### 任务基础状态 `TaskStateBase`

```typescript
type TaskStateBase = {
  id: string              // UUID
  type: TaskType
  status: TaskStatus
  description: string     // UI 显示描述
  toolUseId?: string      // 对应的 AgentTool toolUse ID
  startTime: number
  endTime?: number
  totalPausedMs?: number  // 暂停总时长（worktree 等待期间）
  outputFile: string      // 磁盘输出文件路径（.claude/tasks/{id}.jsonl）
  outputOffset: number    // 已读取的文件偏移量
  notified: boolean       // 是否已通知用户
}
```

---

## 二、任务系统注册 `tasks.ts`

```typescript
// 所有任务通过 getAllTasks() 获取
getAllTasks() → [
  LocalShellTask,
  LocalAgentTask,
  RemoteAgentTask,
  DreamTask,
  LocalWorkflowTask?,    // feature('WORKFLOW_SCRIPTS')
  MonitorMcpTask?,       // feature('MONITOR_TOOL')
]

// 按类型获取任务处理器
getTaskByType(type: TaskType) → Task | undefined
```

每个 Task 实现：
```typescript
type Task = {
  type: TaskType
  spawn(input, context): Promise<TaskHandle>
  kill(taskId, context): Promise<void>
  render?(state, context): React.ReactNode  // 可选渲染
}
```

---

## 三、LocalShellTask（后台 Shell 任务）

### 核心功能

```typescript
LocalShellTask.spawn(input: LocalShellSpawnInput, context)
  → 创建 child_process.spawn
  → 输出重定向到 outputFile（.claude/tasks/{id}.jsonl）
  → 启动 stall watchdog（检测卡顿）
  → 返回 { taskId, cleanup }
```

### 卡顿检测 Stall Watchdog

```typescript
// 后台 Shell 命令卡住（等待用户输入）时的检测
const STALL_CHECK_INTERVAL_MS = 5_000    // 每5秒检查
const STALL_THRESHOLD_MS = 45_000        // 45秒无输出 → 卡顿
const STALL_TAIL_BYTES = 1024            // 读最后 1KB 检测模式

// 交互式提示检测
PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Password:/i,
  /Username:/i,
  ...
]

// 检测到卡顿 → 触发 TASK_NOTIFICATION
// 模型收到通知后可以决定是否介入（发送输入/kill 任务）
```

### TaskOutputTool 轮询机制

```typescript
// 模型通过 TaskOutputTool 获取后台任务输出
TaskOutputTool.call({ task_id, timeout_ms })
  → 读取 outputFile（从 outputOffset 开始）
  → 更新 outputOffset
  → 返回新输出（最多 MAX_OUTPUT_CHARS 字符）
  → 如果任务完成 → 返回最终状态
```

---

## 四、LocalAgentTask（后台子代理任务）

### 进度追踪

```typescript
type AgentTaskProgress = {
  toolUseCount: number         // 已执行的工具调用数
  tokenCount: number           // 已使用的 token 数
  lastActivity: string         // 最近活动描述（"Reading src/foo.ts"）
  recentActivities: string[]   // 最近 5 次活动
  summary: string              // Haiku 生成的摘要（"Fixing NPE in auth.ts"）
  lastSummaryTime: number      // 上次生成摘要的时间
}
```

### 后台摘要生成

```typescript
// 每 30 秒生成一次简短摘要（agentSummary.ts）
generateAgentSummary(recentMessages) → Promise<string>
  → 发给 claude-haiku-4-5
  → 系统提示："Generate a 3-5 word progress description"
  → 返回如 "Implementing auth middleware"

// 摘要显示在 UI 的 TasksPane 中
```

### UI 显示（TasksPane）

```
┌─ Background Tasks ─────────────────┐
│ ✓ Fix auth bug           00:45     │
│ ◆ Implement feature    1:23 ◆      │
│   Implementing auth middleware      │
│   [4 tool calls] [$0.012]          │
│ ● Run tests                ●       │
│   Running npm test...               │
└────────────────────────────────────┘
```

---

## 五、RemoteAgentTask（CCR 远程代理任务）

```typescript
RemoteAgentTask.spawn(input, context)
  → 调用 CCR API 创建远程执行环境
  → 返回 environmentId
  → 轮询任务状态（Bridge polling）
  → 流式接收代理输出

// 远程代理在 Anthropic 管理的容器中运行
// 可以持久化到 worktree 中
```

---

## 六、InProcessTeammateTask（同进程团队成员）

### AsyncLocalStorage 隔离机制

```typescript
// 每个团队成员（Teammate）在独立的 AsyncLocalStorage 上下文中运行
runWithTeammateContext(identity: TeammateIdentity, async () => {
  // 在此 context 中：
  // - bootstrap/state 的操作不互相干扰
  // - getAgentId() 返回此 teammate 的 ID
  // - logging 会标注 teammateId
  await runAgent(messages, toolUseContext)
})
```

### 团队通信（InProcessTeammateTask.ts）

```typescript
// 主代理向团队成员发消息
injectUserMessageToTeammate(taskId, message)
  → 找到对应的 InProcessTeammateTask
  → 将消息注入到该 teammate 的输入队列

// 团队成员空闲时的状态
type TeammateStatus = 'idle' | 'working' | 'waiting_permission' | 'done'
```

### 权限流转（swarm 模式）

```
Teammate 触发权限请求
  ↓
swarmWorkerHandler（useCanUseTool）
  ↓
写入 permissionSync 文件（.claude/swarm/{teamId}/permissions/{requestId}.json）
  ↓
Leader 的 useSwarmPermissionPoller 轮询（500ms）
  ↓
Leader 渲染权限对话框
  ↓
用户选择后写入响应文件
  ↓
Teammate 轮询读取响应
  ↓
继续执行
```

---

## 七、DreamTask（后台记忆整合）

```typescript
DreamTask.spawn(context)
  → 读取当前 MEMORY.md
  → 读取最近对话（最近 N 条 assistant messages）
  → 派生子代理运行记忆整合逻辑
  → 子代理分析：哪些信息值得长期记忆？
  → 更新 ~/.claude/memories/{projectHash}/MEMORY.md

// 触发条件（autoDream.ts）
executeAutoDream()
  → 距上次 Dream > 2 小时
  || 对话轮次 > 5 且距上次 Dream > 30 分钟
  → 创建后台 DreamTask
```

---

## 八、任务 UI 导航

### 后台任务面板（Ctrl+T）

```typescript
useBackgroundTaskNavigation()
  // ↑↓ 在任务间导航
  // Enter → 前台化（foreground）选中的任务
  // Esc → 折叠任务面板
  // ctrl+b → 后台化当前前台任务

// 前台化任务时：
// - 显示任务的消息历史
// - 可以发送消息给该任务
// - 权限对话框在主界面显示
```

### 任务导航状态

```typescript
// AppState 中的任务 UI 状态
type AppState = {
  expandedView: 'none' | 'tasks' | 'teammates'
  foregroundedTaskId: string | undefined
  selectedIPAgentIndex: number   // -1 = leader, 0..N-1 = teammate
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  coordinatorTaskIndex: number
}
```

---

## 九、任务磁盘存储

### 输出文件格式（`.claude/tasks/{id}.jsonl`）

每行一个 JSON 事件：
```json
{"type": "progress", "data": {"text": "Reading src/auth.ts..."}, "timestamp": 1234567890}
{"type": "tool_use", "data": {"tool": "FileReadTool", "input": {...}}, "timestamp": ...}
{"type": "tool_result", "data": {"output": "..."}, "timestamp": ...}
{"type": "completion", "data": {"status": "completed", "cost": 0.012}, "timestamp": ...}
```

### 任务目录结构

```
.claude/
├── tasks/
│   ├── {taskId}.jsonl        # 任务输出流
│   └── {taskId}.meta.json    # 任务元数据
├── sessions/
│   └── {sessionId}.jsonl     # 会话 transcript
└── swarm/
    └── {teamId}/
        └── permissions/       # 权限同步文件
```

---

## 十、任务通知系统

```typescript
// 任务完成时发送 OS 通知
sendOSNotification({
  message: "Task completed: Fix auth bug",
  notificationType: "task_complete"
})

// OS 通知支持（根据终端类型）
├─ iTerm2: iterm2_notification escape sequence
├─ Kitty: kitty_notification protocol
├─ macOS 通知中心: node-notifier
└─ Fallback: 终端 Bell (ctrl+G)
```
