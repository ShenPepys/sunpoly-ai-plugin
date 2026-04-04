# Claude Code 源码分析 - 07 React Hooks 层

---

## 一、权限核心 Hook `hooks/useCanUseTool.tsx`

### 三路路由架构

```typescript
useCanUseTool(toolPermissionContext)
  → 返回 canUseTool(tool, input, ...) 函数

// 根据模式路由到三个处理器
canUseTool()
  ├─ isSwarmWorker()  → swarmWorkerHandler（转发到 leader）
  ├─ isCoordinator()  → coordinatorHandler（汇聚到协调器）
  └─ 默认             → interactiveHandler（显示权限对话框）
```

### interactiveHandler

```typescript
// 1. 检查 bypassPermissions → 直接 allow
// 2. 检查规则（alwaysDeny/alwaysAllow）
// 3. 调用 tool.checkPermissions()
// 4. 如果需要询问 → 加入 toolUseConfirmQueue
// 5. 等待用户在 UI 选择（Promise resolve）
// 6. 返回 PermissionResult
```

### swarmWorkerHandler

```typescript
// 1. 生成 permissionRequestId（UUID）
// 2. 写入 mailbox（Worker → Leader IPC）
// 3. 轮询等待 leader 响应（500ms 间隔）
// 4. 解析响应，调用 onAllow/onReject
```

---

## 二、输入处理 Hooks

### `useTextInput`（主输入状态机）

```typescript
useTextInput(props: UseTextInputProps): TextInputState

// 支持的按键操作（Emacs-style）
Ctrl+A / Home    → 行首
Ctrl+E / End     → 行末
Ctrl+B / ←       → 向前一个字符
Ctrl+F / →       → 向后一个字符
Alt+B            → 向前一个单词
Alt+F            → 向后一个单词
Ctrl+K           → 从光标到行末（Kill）
Ctrl+U           → 从行首到光标（Kill）
Ctrl+W           → 删除前一个单词（Kill）
Ctrl+Y           → Yank（粘贴 kill ring）
Alt+Y            → Yank Pop（循环 kill ring）
Ctrl+D           → 删除光标处字符
Ctrl+H / Backspace → 删除前一字符
Ctrl+T           → 交换光标前两字符
```

**Kill Ring**：
- 被 Kill 的内容进入 kill ring（环形队列，最多 10 条）
- Ctrl+Y 粘贴最近 kill 的内容
- Alt+Y 在 kill ring 中循环

### `useVimInput`（Vim 模式）

```typescript
// Vim 模式状态
type VimMode = 'INSERT' | 'NORMAL' | 'VISUAL' | 'REPLACE'

// NORMAL 模式操作
h/l/b/w/^/$  → 光标移动
i/I/a/A/o/O  → 进入 INSERT 模式
d/c/y        → 操作符（需配合 motion/text object）
dw/de/db     → delete word/end/back
cw/ci"/ca(   → change 操作
yw/yy        → yank
dd           → 删除整行
u            → undo（不是真正的 undo，恢复 INSERT 前的内容）
.            → 重复上次修改
r<char>      → replace 单个字符
~            → 切换大小写
J            → 合并下一行
```

### `usePasteHandler`

```typescript
// 检测粘贴（多个字符快速到达 = 粘贴，而非手动输入）
PASTE_THRESHOLD = 100ms  // 100ms 内多字符到达视为粘贴

// 图片粘贴检测
CLIPBOARD_CHECK_DEBOUNCE_MS = 50ms

// 处理流程
wrappedOnInput(input, key, event)
  ├─ 检测到粘贴（chunks 合并）
  ├─ 检查剪贴板是否有图片（getImageFromClipboard）
  ├─ 是图片 → onImagePaste(base64, mediaType, dimensions)
  └─ 是文本 → onPaste(text)
```

---

## 三、自动完成 `hooks/useTypeahead.tsx`

### 触发规则

| 输入前缀 | 自动完成类型 |
|---------|------------|
| `/` | 斜杠命令自动完成 |
| `@` | 文件路径 + Agent 名称 |
| `#` | Slack 频道（Kairos 模式）|
| `!` | Shell 历史命令（fish-style）|
| `--` | 命令行参数提示 |

### 文件路径自动完成

```typescript
// 后台维护文件索引（避免每次 glob 操作）
FileIndexManager
  ├─ 监听目录变化（fs.watch）
  ├─ 延迟重建索引（Debounce 500ms）
  └─ 支持 .gitignore 过滤

// 匹配策略
matchFiles(prefix: string) → FileMatch[]
  → prefix 以 '/' 开头 → 绝对路径匹配
  → prefix 以 './' → 相对路径匹配
  → 否则 → 从 cwd 开始模糊匹配
```

### 命令自动完成

```typescript
matchCommands(input: string, commands: Command[]) → CommandMatch[]
  → 前缀匹配（/comp → /compact, /config）
  → 模糊匹配（fuse.js）
  → 按使用频率排序
```

---

## 四、历史导航

### `useArrowKeyHistory`（箭头键历史）

```typescript
// ↑ 按一次 → 加载上一条历史
// ↑ 继续按 → 继续向前（分块加载，每次 10 条）
// ↓ 按键 → 向后（向最新）
// ↓ 到底 → 清空输入（返回空）

const HISTORY_CHUNK_SIZE = 10   // 每次加载 10 条历史
const MAX_HISTORY_DISPLAY = 100 // 最多显示 100 条
```

历史来自 `history.ts`（`~/.claude/history.jsonl`）。

### `useHistorySearch`（Ctrl+R 历史搜索）

```typescript
// Ctrl+R 进入历史搜索模式
// 实时过滤（输入变化立即更新）
// ↑↓ 导航搜索结果
// Enter 选中，Esc 退出搜索

// 搜索算法：fuse.js 模糊搜索（threshold: 0.4）
```

---

## 五、Bridge Hook `hooks/useReplBridge.tsx`

### 连接状态机

```
disconnected
  ↓ (auth + feature gate)
connecting
  ↓ (WebSocket established)
connected
  ↓ (WebSocket error / server close)
reconnecting
  ↓ (retry after backoff)
connected / disconnected
```

### 消息处理

```typescript
// 入站消息类型（来自 claude.ai）
'user_message'    → 注入到本地输入队列
'permission_response' → 解析后调用 bridgePermissionCallbacks
'cancel'          → 触发 AbortController
'set_permission_mode' → 更新 toolPermissionContext
'clear'           → 清空对话历史
'session_update'  → 更新会话元数据

// 出站消息类型（发到 claude.ai）
每条 Message → 推送消息流
权限请求 → permission_request 事件
状态更新 → status_change 事件
```

---

## 六、IDE 集成 Hook `hooks/useIDEIntegration.ts`

```typescript
useIDEIntegration(mcpClients)

// 检测 IDE 连接
getConnectedIdeName() → 'vscode' | 'jetbrains' | undefined

// 收到 IDE 发来的 diff 决策
useDiffInIDE({
  onChange,
  filePath,
  edits,
  editMode  // 'single' | 'multiple'
})
  → callIdeRpc('openDiff', ...)
  → 监听 IDE 的 accept/reject 事件
  → 调用 onChange(decision, input)
```

---

## 七、任务 V2 Store `hooks/useTasksV2.ts`

```typescript
// Singleton store（单例，共享给 REPL/Spinner/PromptInputFooter）
class TasksV2Store {
  #tasks: Task[] | undefined
  #hidden = false
  #watcher: FSWatcher | null    // 文件系统监听
  #hideTimer: setTimeout | null // 5秒后隐藏已完成任务
  #debounceTimer: setTimeout | null  // 50ms 防抖
  #pollTimer: setTimeout | null      // 5秒回退轮询
  
  // useSyncExternalStore 合约
  subscribe(listener) → unsubscribe
  getSnapshot() → { tasks, hidden }
}
```

**设计原因**：Spinner 组件每轮挂载/卸载，如果 per-hook 设置文件监听会导致频繁 watch/unwatch。单例 store 共享一个文件监听器。

---

## 八、定时任务 Hook `hooks/useScheduledTasks.ts`

```typescript
useScheduledTasks({ isLoading, assistantMode, setMessages })

// 内部创建 CronScheduler
createCronScheduler({
  isLoading: () => isLoadingRef.current,
  onFire: (prompt) => enqueuePendingNotification(prompt, 'later')
})
```

定时任务来自 `.claude/scheduled_tasks.json`：
```json
[
  {
    "id": "task-1",
    "name": "Daily standup reminder",
    "cron": "0 9 * * 1-5",    // 周一到周五 9:00
    "prompt": "Prepare my daily standup summary"
  }
]
```

---

## 九、远程会话 Hook `hooks/useDirectConnect.ts`

```typescript
useDirectConnect({
  config: DirectConnectConfig | undefined,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools
}): UseDirectConnectResult

// DirectConnectConfig 来自 --direct-connect 命令行参数
type DirectConnectConfig = {
  serverUrl: string
  sessionId?: string
  accessToken?: string
}

// 返回值
type UseDirectConnectResult = {
  isRemoteMode: boolean
  sendMessage(content): Promise<boolean>
  cancelRequest(): void
  disconnect(): void
}
```

---

## 十、会话后台化 Hook `hooks/useSessionBackgrounding.ts`

```typescript
useSessionBackgrounding({
  setMessages,
  setIsLoading,
  resetLoadingState,
  setAbortController,
  onBackgroundQuery  // 派生后台任务
})

// Ctrl+B 触发
handleBackgroundSession()
  ├─ 有 foregroundedTask？
  │   → re-background：将 foregroundedTask 重新放回后台
  └─ 无 foregroundedTask？
      → background current：将当前加载的请求派生为后台任务
```

---

## 十一、语音输入 Hook `hooks/useVoice.ts`

```typescript
// 声音录制策略
macOS → 原生 CoreAudio（性能最佳）
其余  → SoX（系统安装的录音工具）

// hold-to-talk 机制
keydown → 开始录音
keyup   → 停止录音 → 发送到 STT

// RELEASE_TIMEOUT_MS = 300ms
// 没有 keydown 事件但 RELEASE_TIMEOUT_MS 内也没有 keyup → 自动停止
// （应对 auto-repeat 按键场景）
```

### 语言支持（BCP-47 codes）

```typescript
LANGUAGE_NAME_TO_CODE = {
  english: 'en', spanish: 'es', français: 'fr',
  japanese: 'ja', korean: 'ko', chinese: 'zh',
  german: 'de', italian: 'it', portuguese: 'pt',
  // ...更多
}
```

---

## 十二、更新通知 Hook `hooks/useUpdateNotification.ts`

```typescript
useUpdateNotification(updatedVersion, initialVersion)
  → 比较 semver（只比较 major.minor.patch）
  → 新版本 → 返回版本字符串（触发 UI 通知）
  → 无更新 → 返回 null

// 忽略 pre-release 标签（只关注 semver 主版本号）
getSemverPart('1.2.3-alpha') → '1.2.3'
```

---

## 十三、Turn Diff 追踪 `hooks/useTurnDiffs.ts`

```typescript
// 追踪每轮对话中的文件变更（用于显示 turn-level diff summary）
useTurnDiffs(messages) → TurnDiff[]

type TurnDiff = {
  turnIndex: number
  userPromptPreview: string   // 用户提示词预览（前 50 字符）
  timestamp: string
  files: Map<string, TurnFileDiff>
  stats: {
    filesChanged: number
    linesAdded: number
    linesRemoved: number
  }
}
```

增量更新策略：
- 只处理新增消息（`lastProcessedIndex` 追踪）
- 同一文件的多次编辑合并为最终 diff
- 使用 `structuredPatch` 计算精确 diff hunks
