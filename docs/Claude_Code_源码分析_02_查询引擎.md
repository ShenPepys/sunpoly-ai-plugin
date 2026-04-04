# Claude Code 源码分析 - 02 查询引擎与执行循环

---

## 一、`query.ts` — 核心执行循环

`query()` 是整个系统的心脏，驱动 LLM 对话的完整执行。

### 函数签名
```typescript
async function* query(params: QueryParams): AsyncGenerator<Message | StreamEvent>
```

### 执行流程

```
query(params)
  │
  ├─ buildQueryConfig()        → 快照当前 Statsig 门控
  ├─ createBudgetTracker()     → Token 预算追踪器
  │
  └─ 主循环（最多 maxTurns 次）：
       │
       ├─ microcompactMessages()    → 清除旧工具结果（micro-compact）
       ├─ fetchSystemPromptParts()  → 系统提示（CLAUDE.md + 上下文）
       ├─ prependUserContext()      → 添加用户上下文（git 状态/CWD 等）
       ├─ appendSystemContext()     → 附加系统上下文（工具列表等）
       │
       ├─ callModel()              → 调用 Anthropic API（流式）
       │   ├─ 处理 thinking blocks
       │   ├─ 处理 tool_use blocks
       │   ├─ 处理 text blocks
       │   └─ 记录 stop_reason
       │
       ├─ 如果有 tool_use：
       │   ├─ StreamingToolExecutor（并发安全执行器）
       │   └─ runTools()           → 实际调用各工具
       │
       ├─ autoCompactIfNeeded()    → 自动压缩检查（context 超 80%）
       ├─ checkTokenBudget()       → Token 预算检查
       └─ handleStopHooks()        → 执行停止钩子
```

### 停止循环条件

| 条件 | 处理 |
|------|------|
| `stop_reason == 'end_turn'` | 正常结束，退出循环 |
| `stop_reason == 'max_tokens'` | 触发 max_output_tokens 恢复循环（最多 3 次） |
| `stop_reason == 'tool_use'` 且无工具 | 结束 |
| TOKEN_BUDGET_EXCEEDED | 预算耗尽，发 nudge 继续或停止 |
| autoCompact 触发 | 压缩后继续 |
| 用户中断（AbortError） | 立即终止 |
| maxTurns 达到 | 强制结束 |

### Thinking Blocks 规则（代码注释中的"magic rules"）

1. 含 thinking/redacted_thinking 的消息必须与 `max_thinking_length > 0` 的查询配套
2. thinking block **不能**是内容块的最后一个元素
3. thinking blocks 在整个 assistant trajectory 期间必须保持（含 tool_use 的轮次）

违反这些规则会导致 API 返回 400 错误。

---

## 二、`query/config.ts` — 查询配置

```typescript
// 在 query() 入口快照一次，整个执行期间保持不变
type QueryConfig = {
  sessionId: SessionId
  gates: {
    streamingToolExecution: boolean  // 是否流式执行工具
    emitToolUseSummaries: boolean    // 是否生成工具使用摘要
    isAnt: boolean                   // 是否内部 Ant 版本
    fastModeEnabled: boolean         // Fast 模式
  }
}
```

**设计理由**：避免 query() 执行中途 Statsig/GrowthBook 刷新导致行为不一致。

---

## 三、`query/deps.ts` — 可注入依赖

```typescript
type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}
```

测试时可注入假实现，无需 spyOn 多个模块，这是一个解耦的好设计。

---

## 四、`query/tokenBudget.ts` — Token 预算

```typescript
const COMPLETION_THRESHOLD = 0.9      // 90% 已消耗 → 停止
const DIMINISHING_THRESHOLD = 500     // 最近增量 < 500 → 收益递减停止

type BudgetTracker = {
  continuationCount: number       // 已连续执行次数
  lastDeltaTokens: number         // 上一次增量 token 数
  lastGlobalTurnTokens: number    // 上一轮全局 token
  startedAt: number               // 开始时间（ms）
}
```

**决策逻辑**：
- 如果消耗 < 90% 且增量 > 500 → `continue`（发 nudge 继续）
- 如果消耗 ≥ 90% 或增量 < 500 → `stop`
- 停止时记录 `completionEvent`（包含 pct/tokens/diminishingReturns/duration）

---

## 五、`query/stopHooks.ts` — 停止钩子

每轮对话结束后（stop_reason = end_turn）执行的钩子链：

```
handleStopHooks()
  │
  ├─ executeStopHooks()           → settings.json 中配置的 Stop hooks
  ├─ extractMemories()            → (EXTRACT_MEMORIES feature) 提取记忆到 MEMORY.md
  ├─ executeAutoDream()           → 后台记忆整合（Dream Task）
  ├─ executePromptSuggestion()    → 生成下一步建议
  ├─ executeTaskCompletedHooks()  → 任务完成 hooks
  └─ executeTeammateIdleHooks()   → 团队成员空闲 hooks
```

---

## 六、`QueryEngine.ts` — SDK 封装层

`QueryEngine` 是面向 SDK 消费者的高级 API，在 `query()` 基础上：

### 主要功能

- **SDK 消息格式化**：内部 Message → `SDKMessage`
- **权限处理**：通过 `canUseTool` 回调集成权限系统
- **会话持久化**：自动记录/恢复（`flushSessionStorage`/`recordTranscript`）
- **进度流**：向消费者发送 `SDKStatus` 更新
- **Snip 投影**：HISTORY_SNIP 模式下裁剪历史（SDK 模式不需 UI 滚动历史）
- **多轮对话**：支持 `replayUserMessages`（恢复中断对话）

### 配置类型

```typescript
type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  jsonSchema?: Record<string, unknown>   // 结构化输出 JSON schema
  verbose?: boolean
  replayUserMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  orphanedPermission?: OrphanedPermission  // 恢复未完成的权限请求
}
```

---

## 七、服务层 API 调用 `services/api/claude.ts`

### `queryModelWithStreaming()` 流程

```typescript
// 1. 构建请求参数
params = {
  model,
  max_tokens,
  system,           // 系统提示数组
  messages,         // 对话历史
  tools,            // 工具 schema 列表
  betas,            // Beta features 数组
  thinking,         // { type: 'enabled', budget_tokens: N }
  temperature,      // 可选（thinking 模式下通常不设）
}

// 2. 流式处理 events：
//   content_block_start → 开始新内容块
//   content_block_delta → 增量内容（text_delta / input_json_delta）
//   content_block_stop  → 内容块结束
//   message_delta       → stop_reason / stop_sequence
//   message_stop        → 最终 usage 数据

// 3. 产出：AssistantMessage + StreamEvent[]
```

### Prompt Cache 策略

```typescript
type CacheScope = 'tool_based' | 'system_prompt' | 'none'
```

- **`tool_based`**：有 MCP 工具时，在工具列表末尾加 `cache_control: {type: 'ephemeral'}`
- **`system_prompt`**：在系统提示末尾加 cache_control
- **`none`**：无工具无系统提示时不缓存

### Beta Headers（`constants/betaHeaders.ts`）

目前使用的主要 Beta Headers：
```
claude-code-20250219
interleaved-thinking-2025-05-14
extended-cache-ttl-2025-04-11
fine-grained-tool-streaming-2025-05-14
token-efficient-tools-2025-02-19
web-search-2025-03-05
files-api-2025-04-14
```

---

## 八、重试策略 `services/api/withRetry.ts`

```typescript
DEFAULT_MAX_RETRIES = 10
MAX_529_RETRIES = 3    // 容量不足（短期限频）
BASE_DELAY_MS = 500
```

### 触发重试的条件

| HTTP 状态 | 原因 | 策略 |
|-----------|------|------|
| 429 | Rate Limit | 等待 `Retry-After` 头指定时间 |
| 529 | Capacity | 指数退避，最多 3 次 |
| 连接错误 | APIConnectionError | 立即重试 |
| 401 | OAuth 过期 | 刷新 token 后重试一次 |
| AWS 凭证过期 | - | 重新加载凭证后重试 |
| GCP 凭证过期 | - | 刷新 GCP credentials 后重试 |

### 不触发重试
- 400（参数错误）
- 403（权限拒绝）
- 404（资源不存在）
- `APIUserAbortError`（用户主动中断）

---

## 九、压缩系统 `services/compact/`

Claude Code 实现了三级压缩策略：

### 级别 1：Micro-compact（`microCompact.ts`）
- **时机**：每次 query() 主循环迭代开始前
- **策略**：清除较旧的工具结果，保留最近 N 个
- **可清除工具**：FileReadTool, BashTool, GrepTool, GlobTool 等（读取类）
- **不可清除**：最近 1-2 次的结果，写操作结果，错误结果

### 级别 2：时间触发 Micro-compact
- **时机**：距上次 API 调用超过 60 分钟（server-side cache 5分钟 TTL 已过期）
- **逻辑**：既然 cache miss 已确定，主动清除旧结果减小发送量，降低成本

### 级别 3：Auto/Manual Compact（`compact.ts`）
- **时机**：context 使用量超过阈值（默认 80%）
- **实现**：用 summarize prompt 让模型生成 1-2 段摘要
- **输出**：`SystemCompactBoundaryMessage` + 摘要作为新对话起始

**压缩后清理** `postCompactCleanup.ts`：
```
resetMicrocompactState()
clearClassifierApprovals()
clearCompactWarningSuppression()
clearSystemPromptSections()
clearBetaTracingState()
```

### Reactive Compact（`reactiveCompact.ts`，REACTIVE_COMPACT feature）
- 监控 `max_output_tokens` 错误
- 自动触发压缩，不中断用户对话

---

## 十、工具调度 `services/tools/toolOrchestration.ts`

```typescript
runTools(
  toolUseBlocks: ToolUseBlock[],
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn
): AsyncGenerator<ToolProgress, ToolResult[]>
```

**执行策略**：
- `isConcurrencySafe: true` 的工具可并发执行
- 默认串行执行（防止状态冲突）
- 每个工具调用前先 `canUseTool()`（权限检查）
- 工具结果通过 `applyToolResultBudget()` 截断超长输出

### StreamingToolExecutor（`services/tools/StreamingToolExecutor.ts`）
- 为支持流式工具调用的场景提供队列机制
- 保证工具结果按顺序返回给模型
- 支持工具执行进度实时流给 UI
