# Claude Code 源码分析 - 06 UI 组件层

---

## 一、屏幕层 `screens/`

| 文件 | 说明 |
|------|------|
| `REPL.tsx` | 主 REPL 界面（最重要，1700+行）|
| `Doctor.tsx` | `/doctor` 环境诊断界面 |
| `ResumeConversation.tsx` | `/resume` 会话选择界面（FuzzyPicker）|
| `LogSelector.tsx` | 日志文件选择界面 |

---

## 二、主 REPL 界面 `screens/REPL.tsx`

### 核心状态管理

```typescript
// 消息列表（会话历史）
const [messages, setMessages] = useState<Message[]>([])
// 加载状态（是否有 API 请求正在进行）
const [isLoading, setIsLoading] = useState(false)
// 权限确认队列（等待用户确认的工具调用）
const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<ToolUseConfirm[]>([])
// 工具 JSX（权限对话框 / 进度显示等）
const [toolJSX, setToolJSX] = useState<React.ReactNode>(null)
// 当前屏幕（repl / transcript / tool-output）
const [screen, setScreen] = useState<Screen>('repl')
// 流式模式（waiting / streaming / done）
const [streamMode, setStreamMode] = useState<SpinnerMode>('waiting')
// 进行中的工具 ID 集合
const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState(new Set<string>())
```

### 挂载的关键 Hooks

| Hook | 作用 |
|------|------|
| `useTextInput` | 处理键盘输入、Emacs 键绑定 |
| `useVimInput` | Vim 模式输入处理 |
| `usePasteHandler` | 图片/文本粘贴处理 |
| `useTypeahead` | 自动完成建议 |
| `useArrowKeyHistory` | ↑↓ 历史导航 |
| `useGlobalKeybindings` | ctrl+t/ctrl+o/ctrl+r 等全局快捷键 |
| `useCancelRequest` | ESC/ctrl+c 取消 |
| `useReplBridge` | claude.ai Bridge 连接 |
| `useRemoteSession` | CCR 远程会话查看 |
| `useDirectConnect` | 直连 WebSocket 会话 |
| `useSSHSession` | SSH 隧道会话 |
| `useIDEIntegration` | VS Code/JetBrains 集成 |
| `useManagePlugins` | 插件加载/更新 |
| `useScheduledTasks` | 定时任务调度 |
| `useTaskListWatcher` | 监听 tasks 目录 |
| `useLogMessages` | 增量记录会话 transcript |
| `useSwarmInitialization` | Swarm 初始化 |
| `useVoiceIntegration` | 语音输入 |
| `usePromptsFromClaudeInChrome` | Chrome 扩展接收 prompts |
| `useAwaySummary` | 5分钟离开后生成摘要 |
| `useOfficialMarketplaceNotification` | 市场安装通知 |
| `useLspPluginRecommendation` | LSP 插件推荐 |
| `useClaudeCodeHintRecommendation` | claude-code-hint 插件推荐 |
| `useSessionBackgrounding` | Ctrl+B 会话后台化 |

### REPL 渲染结构

```
<KeybindingProvider>          // 键盘绑定上下文
  <AppProvider>               // 应用状态上下文
    <NotificationProvider>    // 通知上下文
      <VoiceProvider>         // 语音上下文
        <Header />            // 顶部标题栏（模型/模式/版本）
        <Messages />          // 消息列表（虚拟滚动）
        <ToolJSX />           // 工具 JSX（权限对话框等）
        <Notification />      // 底部右侧通知气泡
        <StatusLine />        // 底部状态栏
        <PromptInput />       // 输入框
      </VoiceProvider>
    </NotificationProvider>
  </AppProvider>
</KeybindingProvider>
```

---

## 三、消息渲染 `components/messages/`

### 消息类型层次

```
Messages.tsx（列表容器）
  └── MessageRow.tsx（高度测量包装器）
       └── Message.tsx（类型分发）
            ├── AssistantTextMessage.tsx    // AI 文本回复（Markdown 渲染）
            ├── UserTextMessage.tsx          // 用户输入（高亮提示词）
            ├── AttachmentMessage.tsx        // 附件消息（计划/团队/工具引用）
            ├── SystemTextMessage.tsx        // 系统消息（权限警告等）
            ├── AssistantToolUseMessage.tsx  // 工具调用显示
            └── UserToolResultMessage/       // 工具结果显示
                 ├── BashResultMessage.tsx    // Bash 输出（折叠/展开）
                 ├── FileEditResultMessage.tsx // 文件编辑（diff 显示）
                 ├── AgentResultMessage.tsx   // 代理任务结果
                 └── GenericResultMessage.tsx // 通用结果
```

### 消息折叠机制 `utils/collapseReadSearch.ts`

```typescript
// 连续的读取/搜索操作合并为折叠组
collapseReadSearch(messages) → CollapsedMessages
  ├─ 连续 FileReadTool 调用 → 折叠为 "Reading 5 files"
  ├─ 连续 GrepTool 调用 → 折叠为 "Searching in 3 directories"
  └─ ctrl+o 展开查看详情

// 折叠组标记
type CollapseGroup = {
  startIndex: number
  endIndex: number
  label: string      // "Reading 5 files in src/"
  isExpanded: boolean
}
```

### Brief 模式过滤

```typescript
// isBriefOnly 模式只显示关键消息
filterMessagesForBrief(messages) → BriefMessages
  → 只保留：用户消息、最终 AI 文本、错误消息
  → 过滤掉：工具调用/结果、系统提示、中间状态
```

---

## 四、设计系统 `components/design-system/`

### Dialog（确认对话框）

```typescript
<Dialog
  title="Allow bash command?"
  body="git commit -m 'Initial commit'"
  options={[
    { label: 'Allow once', value: 'allow', key: 'y' },
    { label: 'Allow always', value: 'allow-always', key: 'a' },
    { label: 'Deny', value: 'deny', key: 'n' }
  ]}
  onSelect={handleSelect}
/>
```

特性：
- 自动注册 Escape 键（Cancel）
- 支持 y/n/a 等单键快捷响应
- 注册到 overlay context（防止 ESC 中断请求）

### FuzzyPicker（模糊搜索选择器）

```typescript
<FuzzyPicker
  items={sessions}
  getItemText={s => s.title}
  onSelect={handleSelect}
  onCancel={handleCancel}
  placeholder="Search sessions..."
/>
```

特性：
- Fuse.js 模糊搜索
- ↑↓ 导航
- Enter 确认，Esc 取消
- 支持自定义渲染（renderItem）

### Tabs（多 Tab 导航）

```typescript
<Tabs
  tabs={['Overview', 'Details', 'History']}
  activeTab={activeTab}
  onTabChange={setActiveTab}
/>
```

特性：
- Tab/←/→ 键导航
- 支持 label 和 key 快捷键

### ProgressBar（进度条）

```typescript
<ProgressBar
  value={0.75}      // 0.0 - 1.0
  width={30}
  color="blue"
/>
// 输出: ████████████████████████░░░░░░ 75%
```

使用 Unicode 块字符：`▏▎▍▌▋▊▉█░`

### ThemeProvider（主题）

```typescript
// 内置主题
THEMES = ['dark', 'light', 'auto', 'blue-storm', 'earth', 'galaxy', ...]

// 主题色键值
type Theme = {
  primary: string     // 主色（用于标题/高亮）
  secondary: string   // 次色
  error: string       // 错误色
  warning: string     // 警告色
  success: string     // 成功色
  info: string        // 信息色
  // ...
}
```

---

## 五、权限对话框 `components/permissions/`

### PermissionRequest.tsx（路由入口）

```typescript
// 根据 tool.name 路由到对应对话框
PermissionRequest({ toolUseConfirm })
  ├─ tool.name === 'Bash' → BashPermissionRequest
  ├─ tool.name === 'Edit' → FileEditPermissionRequest
  ├─ tool.name === 'Write' → FileWritePermissionRequest
  ├─ tool.name 匹配 mcp__ → MCPPermissionRequest
  ├─ tool.name === 'Sandbox' → SandboxPermissionRequest
  └─ 其余 → GenericPermissionRequest
```

### BashPermissionRequest.tsx

```
┌─────────────────────────────────┐
│ Do you want to run this         │
│ command?                        │
│                                 │
│  git commit -m "Fix bug"        │
│                                 │
│ [y] Allow once                  │
│ [a] Always allow 'git *'        │
│ [n] Deny                        │
└─────────────────────────────────┘
```

特性：
- 显示完整命令
- 建议最小化 always-allow 规则（如 `git *` 而非完整命令）
- 显示当前适用的权限规则（PermissionRuleExplanation）

### FileEditPermissionRequest.tsx

```
┌─────────────────────────────────┐
│ Edit src/auth.ts?               │
│                                 │
│ - const token = getToken()      │
│ + const token = await getToken()│
│                                 │
│ [y] Allow                       │
│ [a] Always allow edits in src/  │
│ [n] Deny                        │
└─────────────────────────────────┘
```

特性：
- 显示 unified diff（通过 diff 库生成）
- IDE 集成：可在 VS Code/JetBrains 打开 diff 视图
- 显示文件路径和修改统计

### TrustDialog.tsx（新目录信任）

首次在未信任目录运行时显示：
```
┌─────────────────────────────────┐
│ Trust /path/to/project?         │
│                                 │
│ Claude Code will read CLAUDE.md │
│ and run code in this directory. │
│                                 │
│ [y] Yes, trust this directory   │
│ [n] No (exit)                   │
└─────────────────────────────────┘
```

---

## 六、输入框 `components/PromptInput/`

### PromptInput.tsx（主组件）

```
┌─────────────────────────────────────────────────────────┐
│ > Your message here...                                  │
│ [Image: screenshot.png]  [Pasted text #1]              │
├─────────────────────────────────────────────────────────┤
│ default mode  │  claude-opus-4-5  │  3.2k/200k tokens  │
│ ↑↓ history  Tab complete  ctrl+k clear  ctrl+v image   │
└─────────────────────────────────────────────────────────┘
```

### PromptInputFooter.tsx（底部状态栏）

显示模式切换 pills：
```
[default] [model: opus-4-5] [3.2k/200k] [no memory]
```

每个 pill 都可以用 Tab/←/→ 聚焦，Enter 激活（弹出设置界面）。

---

## 七、Spinner 组件

```typescript
<Spinner
  mode="streaming"   // waiting / streaming / done / error
  tools={activeTool}  // 当前活跃工具
/>
```

显示：
- `waiting`：`⠙` 旋转动画（30fps）
- `streaming`：`◆ Thinking...` 或 `◆ Reading src/foo.ts`
- `done`：无显示
- `error`：`✗`

---

## 八、StatusLine 组件

```typescript
<StatusLine />
// 输出（底部状态栏）：
// ◆ auto mode │ session: abc-123 │ $0.042 │ 15 turns │ 32k tokens
```

包含：
- 权限模式（带颜色）
- 当前会话 ID
- 累计成本
- 对话轮次
- Token 使用量（带警告色）
- Git 信息（branch/diff stats）
- Bridge 连接状态

---

## 九、虚拟滚动 `components/VirtualizedMessageList.tsx`

```typescript
const DEFAULT_ESTIMATE = 3   // 未测量项的高度估计（行数）
const OVERSCAN_ROWS = 80     // 视口外预渲染行数
const SLIDE_STEP = 25        // 单次最多挂载 25 个新项
const MAX_MOUNTED_ITEMS = 300 // 最大挂载项数（超出时卸载旧项）
const SCROLL_QUANTUM = 40    // 滚动量化（防止每像素重渲染）
```

**工作原理**：
1. 使用 `useSyncExternalStore` 订阅滚动位置
2. 根据视口高度和项目高度估算可见范围
3. 只渲染可见范围内的消息（+80行 overscan）
4. 首次渲染时分批（25个/批）挂载消息，减少一次性 layout 压力
5. 测量实际高度后更新估算

---

## 十、AutoUpdater `components/AutoUpdater.tsx`

```typescript
// 自动检查新版本（每 24 小时）
useAutoUpdater()
  → 检查 npm registry 最新版本
  → 如果有新版本，显示提示
  → 用户同意后执行 npm install -g @anthropic-ai/claude-code@latest
  → 更新完成后重启进程
```
