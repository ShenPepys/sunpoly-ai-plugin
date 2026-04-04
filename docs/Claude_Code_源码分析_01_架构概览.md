# Claude Code 源码分析 - 01 架构概览

> 基于 claude-code-main 源码全量阅读，2026-04-04

---

## 一、技术栈

| 层次 | 技术 |
|------|------|
| 运行时 | Bun（生产）/ Node.js（测试） |
| UI 框架 | React 19 + Ink（终端 UI） |
| 语言 | TypeScript 严格模式 |
| AI SDK | @anthropic-ai/sdk（官方） |
| Schema 验证 | Zod v4 |
| A/B 测试 | GrowthBook（Statsig 兼容） |
| 遥测 | OpenTelemetry |
| MCP 协议 | @modelcontextprotocol/sdk |
| 构建 | Bun bundle（feature() 宏做 DCE） |

---

## 二、目录结构

```
src/
├── bootstrap/          # 全局单例状态（state.ts，1759行）
├── bridge/             # claude.ai 远程控制（~30个文件）
├── cli/                # CLI 参数解析、传输层
├── commands/           # /config /compact /help 等斜杠命令（100+个）
├── components/         # React UI 组件（~80个文件）
│   ├── design-system/  # Dialog/Pane/Tabs/FuzzyPicker 基础组件
│   ├── messages/       # 各类消息渲染
│   ├── permissions/    # 权限对话框系列
│   └── shell/          # Shell 输出渲染
├── constants/          # API 限制、Beta 头、系统提示、工具列表
├── context/            # React Contexts（通知/overlay/voice/stats）
├── entrypoints/        # 入口（cli.tsx, init.ts, mcp.ts, sdk/）
├── hooks/              # React Hooks（80+个）
├── keybindings/        # 可配置键盘快捷键系统
├── memdir/             # 自动记忆系统（MEMORY.md）
├── plugins/            # 内置插件注册
├── query/              # 查询配置、停止钩子、Token 预算
├── remote/             # CCR 查看器（claude assistant 命令）
├── screens/            # 全屏幕界面（REPL/Doctor/Resume）
├── services/           # 核心服务（API/compact/analytics/mcp/lsp/oauth）
├── skills/             # 技能加载（.claude/skills/ Markdown）
├── state/              # AppState + React Provider
├── tasks/              # 后台任务（Shell/Agent/Remote/Teammate/Dream）
├── tools/              # 40+工具实现
├── types/              # 纯类型定义
└── utils/              # 工具函数（200+文件）
    ├── bash/           # Bash 命令解析、安全检查
    ├── git/            # Git 文件系统操作
    ├── hooks/          # 系统钩子
    ├── model/          # 模型选择、成本计算
    ├── permissions/    # 权限规则、分类器
    ├── plugins/        # 插件加载、市场
    ├── settings/       # 设置读写、验证、缓存
    ├── shell/          # Shell 提供者（Bash/PowerShell）
    ├── swarm/          # Agent Swarm（tmux/iTerm2）
    └── telemetry/      # OTel 事件、会话追踪
```

---

## 三、核心模块依赖关系

```
entrypoints/cli.tsx
  └── entrypoints/init.ts（初始化：config/TLS/proxy/telemetry）
  └── main.tsx（CLI 参数解析、会话恢复）
       └── screens/REPL.tsx（主界面）
            └── query.ts / QueryEngine.ts（执行引擎）
                 └── services/api/claude.ts（Anthropic API）
                 └── services/compact/*.ts（压缩）
                 └── services/tools/toolOrchestration.ts（工具调度）
                      └── tools/*/Tool.ts（各工具）
                           └── utils/permissions/（权限检查）
```

---

## 四、启动流程

### CLI 入口 `entrypoints/cli.tsx`
1. 快速路径：`--version` 零模块加载，直接输出
2. 其余路径动态 import `main.tsx`

### 初始化 `entrypoints/init.ts`
`init()` 只运行一次（memoize），依序执行：
1. `enableConfigs()` — 读取 `~/.claude.json` 和项目配置
2. `applySafeConfigEnvironmentVariables()` — settings.env 环境变量
3. `configureGlobalMTLS()` — TLS/mTLS
4. `configureGlobalAgents()` — HTTP/SOCKS 代理
5. `applyExtraCACertsFromConfig()` — CA 证书
6. 懒加载 OpenTelemetry（defer ~400KB）
7. `preconnectAnthropicApi()` — 后台预热连接
8. `initializeRemoteManagedSettingsLoadingPromise()` — 企业托管设置
9. `initializePolicyLimitsLoadingPromise()` — 策略限制
10. `populateOAuthAccountInfoIfNeeded()` — OAuth 账户信息

### `main.tsx` 启动决策树
```
解析 CLI 参数
  ├── --print/-p → headless SDK 模式（不渲染 UI）
  ├── --resume → 恢复上次会话
  ├── --remote → 远程查看模式（useRemoteSession）
  ├── --ssh → SSH 隧道会话
  ├── --assistant → Kairos 助手模式
  └── 默认 → 交互式 REPL 模式（渲染 React/Ink）
```

---

## 五、全局状态 `bootstrap/state.ts`

系统唯一全局单例，主要字段分类：

### 工作目录
```typescript
originalCwd: string     // 启动时工作目录（不随 worktree 变化）
projectRoot: string     // 稳定项目根（用于历史/技能/会话）
cwd: string             // 当前工作目录（实时更新）
```

### 会话标识
```typescript
sessionId: SessionId          // UUID，每次启动生成
parentSessionId: SessionId    // 父会话 ID
mainLoopModelOverride: ModelSetting  // /model 命令覆盖
```

### 成本/性能统计
```typescript
totalCostUSD: number
totalAPIDuration: number
totalToolDuration: number
turnHookDurationMs: number
turnClassifierDurationMs: number
totalLinesAdded: number
totalLinesRemoved: number
modelUsage: { [modelName: string]: ModelUsage }
```

### Prompt Cache Latch（防止缓存失效）
```typescript
afkModeHeaderLatched: boolean | null    // AFK beta 头 sticky-on
fastModeHeaderLatched: boolean | null   // Fast 模式头 sticky-on
cacheEditingHeaderLatched: boolean | null
thinkingClearLatched: boolean | null    // 清除 thinking 块 latch
promptCache1hEligible: boolean | null   // 1小时 cache TTL 资格
```
这些 latch 一旦激活就保持，防止中途设置变化导致 prompt cache 失效。

### Session-only 标志（不持久化到磁盘）
```typescript
sessionBypassPermissionsMode: boolean
sessionTrustAccepted: boolean   // 主目录信任
sessionPersistenceDisabled: boolean
hasExitedPlanMode: boolean
needsPlanModeExitAttachment: boolean
scheduledTasksEnabled: boolean
```

---

## 六、AppState（React 状态）`state/AppStateStore.ts`

主要字段分组：

```typescript
type AppState = {
  settings: SettingsJson           // 用户设置
  mainLoopModel: ModelSetting      // 当前模型
  verbose: boolean
  isBriefOnly: boolean             // Brief 模式
  expandedView: 'none' | 'tasks' | 'teammates'
  footerSelection: FooterItem | null  // footer pill 焦点
  toolPermissionContext: ToolPermissionContext  // 权限上下文
  kairosEnabled: boolean           // Kairos/Assistant 模式
  
  // 远程/Bridge 连接
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  replBridgeEnabled: boolean
  replBridgeConnected: boolean
  replBridgeSessionUrl: string | undefined
  
  // 任务系统
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  
  // MCP
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number     // 自增触发重连
  }
  
  // 插件
  plugins: { loaded: LoadedPlugin[], errors: PluginError[], needsRefresh: boolean }
  
  // 通知
  notifications: { queue: Notification[], current: Notification | null }
}
```

### 状态变化副作用 `onChangeAppState.ts`
- 权限模式变化 → 通知 CCR + 通知 SDK
- mainLoopModel 变化 → 保存到 settings.json
- expandedView 变化 → 保存 showExpandedTodos/showSpinnerTree 到配置
