# Claude Code 源码分析 - 05 服务层

---

## 一、分析与遥测 `services/analytics/`

### 事件记录 `services/analytics/index.ts`

```typescript
// 主要分析函数
logEvent(name: string, metadata: AnalyticsMetadata)
logEventAsync(name: string, metadata)  // 异步版（不阻塞）

// 类型强制（防止误传代码/路径等 PII 数据）
type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = {
  [key: string]: string | number | boolean | null | undefined
}
```

**特殊类型标注**：代码中有 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 和 `AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED` 这两个很长的类型名称，强制开发者在每次记录事件时声明"我已核实此数据不含代码/路径/PII"。

### GrowthBook A/B 测试 `services/analytics/growthbook.ts`

```typescript
// 特性门控（cached，可能 stale）
getFeatureValue_CACHED_MAY_BE_STALE(key, defaultValue)
getFeatureValue_CACHED_WITH_REFRESH(key, defaultValue)  // 触发刷新

// Statsig 门控
checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate: string): boolean
checkGate_CACHED_OR_BLOCKING(gate: string): Promise<boolean>

// 动态配置
getDynamicConfig_CACHED_MAY_BE_STALE(config: string)

// 刷新信号（用于 useMainLoopModel 订阅刷新后更新模型）
onGrowthBookRefresh(callback: () => void): () => void
```

GrowthBook 用于：
- 模型别名解析（`tengu_ant_model_override`）
- 特性开关（bridge/auto-mode/etc.）
- 实验分组
- 自动压缩阈值配置

### Datadog 遥测 `services/analytics/datadog.ts`

- 收集会话级别的错误和性能数据
- 在会话结束时上报（`shutdownDatadog()`）
- 使用 `node-dogstatsd` 客户端

### OpenTelemetry 第一方日志 `services/analytics/firstPartyEventLogger.ts`

- 使用 OTel SDK Logs API
- 通过 OTLP HTTP 导出器发送到 Anthropic 内部
- 包含详细的会话追踪信息

---

## 二、MCP 集成 `services/mcp/`

### MCP 连接管理 `services/mcp/client.ts`

```typescript
// 连接类型
type MCPTransport =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'ws'; url: string }
  | { type: 'ipc'; socketPath: string }

// 主要 API
connectMCPServer(config): Promise<MCPServerConnection>
callIdeRpc(method, params): Promise<unknown>  // 调用 IDE MCP RPC
getConnectedIdeClient(): MCPServerConnection | undefined
getConnectedIdeName(): string | undefined
```

### MCPServerConnection 结构

```typescript
type MCPServerConnection = {
  name: string
  client: Client              // MCP SDK Client 实例
  tools: Tool[]               // 此 MCP server 提供的工具列表
  resources: ServerResource[] // 此 MCP server 的资源
  commands: Command[]         // 技能/命令（从 MCP 技能 API 加载）
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  error?: string
  transportConfig: TransportConfig
}
```

### IDE MCP 集成

```typescript
// claude --ide 模式下，连接 VS Code / JetBrains MCP 服务器
// IDE 服务器提供的 RPC：
// - openDiff(filePath, originalContent, newContent): 打开 diff 视图
// - acceptDiff(id): 接受 diff
// - rejectDiff(id): 拒绝 diff
// - getDiagnostics(filePath): 获取 LSP 诊断
// - openFile(filePath): 在 IDE 中打开文件
// - executeCommand(command): 执行 IDE 命令
```

### MCP 工具代理 `tools/MCPTool/`

每个 MCP 工具动态创建一个对应的 `MCPTool` 实例：
```typescript
// 创建 MCP 工具代理
createMCPTool(serverName, toolDefinition) → Tool
  → name: `mcp__${serverName}__${toolName}`
  → call(): 转发到 MCPServerConnection.client.callTool()
  → checkPermissions(): 基于 toolPermissionContext 检查
```

### MCP Elicitation 处理

MCP 服务器可以通过 `-32042` 错误码请求用户输入：

```typescript
// handleElicitation 在 SDK 模式下注入
// REPL 模式下使用 AskUserQuestionTool 队列
handleElicitation(serverName, params, signal)
  → 显示对话框让用户输入
  → 将用户输入返回给 MCP 服务器
```

---

## 三、LSP 集成 `services/lsp/`

### LSP 服务器管理 `services/lsp/manager.ts`

```typescript
// 启动/停止 LSP 服务器
startLspServer(serverConfig: LspServerConfig): Promise<LspClient>
shutdownLspServerManager(): Promise<void>

// LSP 服务器配置（来自插件定义）
type LspServerConfig = {
  name: string
  command: string
  args?: string[]
  extensions: string[]      // 触发的文件扩展名
  rootUri?: string
  initializationOptions?: Record<string, unknown>
}
```

### 诊断追踪 `services/diagnosticTracking.ts`

```typescript
// DiagnosticTrackingService 单例
class DiagnosticTrackingService {
  // 订阅 LSP publishDiagnostics 通知
  subscribe(client: LspClient): void
  
  // 获取文件的最新诊断
  getDiagnostics(filePath: string): Diagnostic[]
  
  // 模型读取文件后自动附加诊断
  onFileRead(filePath: string): void
}
```

诊断信息在 FileReadTool 读取文件后自动附加到工具结果，让模型能看到文件的 errors/warnings。

---

## 四、OAuth 认证 `services/oauth/`

### OAuth 流程 `services/oauth/client.ts`

```typescript
// PKCE 授权流程
initiateOAuthFlow(): Promise<void>
  → 生成 code_verifier + code_challenge
  → 打开浏览器到 claude.ai/oauth/authorize
  → 本地监听 callback（默认端口 47893）
  → 交换 code → access_token + refresh_token
  → 保存到 ~/.claude.json

// Token 刷新
refreshOAuthToken(refreshToken): Promise<TokenResponse>
checkAndRefreshOAuthTokenIfNeeded(): Promise<void>

// 账户信息
getOrganizationUUID(): Promise<string>
populateOAuthAccountInfoIfNeeded(): Promise<void>
```

### OAuth Token 存储 `utils/auth.ts`

Token 存储位置（按优先级）：
1. `--oauth-token-from-fd` 命令行参数（从 fd 读取）
2. `ANTHROPIC_API_KEY` 环境变量（API Key 模式）
3. `~/.claude.json` 中的 OAuth token
4. Bedrock/Vertex 凭证

```typescript
// 判断是否为 claude.ai 订阅用户（能使用 bridge）
isClaudeAISubscriber(): boolean
  → 有 OAuth token 且不是 API Key
  
// 判断是否使用第三方服务
isUsing3PServices(): boolean
  → Bedrock / Vertex / 自定义 base URL
```

---

## 五、策略限制 `services/policyLimits/`

企业级策略限制，通过 GrowthBook 动态配置：

```typescript
// 策略限制类型
type PolicyLimits = {
  maxTurns?: number              // 最大对话轮次
  maxCostUSD?: number            // 最大成本（USD）
  maxTokens?: number             // 最大 token 数
  disabledTools?: string[]       // 禁用的工具列表
  disabledCommands?: string[]    // 禁用的命令列表
  allowedBaseUrls?: string[]     // 允许的 API base URL
}

// 检查特定操作是否在策略允许范围内
isPolicyAllowed(action: 'tool' | 'command', name: string): boolean
waitForPolicyLimitsToLoad(): Promise<PolicyLimits>
```

---

## 六、远程托管设置 `services/remoteManagedSettings/`

企业管理员可以通过 GrowthBook 远程推送设置：

```typescript
// 初始化远程设置加载
initializeRemoteManagedSettingsLoadingPromise(): void

// 等待加载完成
waitForRemoteManagedSettingsToLoad(): Promise<RemoteManagedSettings>

// 判断是否有资格使用远程设置（有效 OAuth 且在 allowlist 中）
isEligibleForRemoteManagedSettings(): boolean
```

远程设置可覆盖的字段（例如）：
- `disableAutoUpdates` — 禁止自动更新
- `forcePermissionMode` — 强制特定权限模式
- `disabledTools` — 禁用工具列表

---

## 七、Token 估算 `services/tokenEstimation.ts`

```typescript
// 精确估算（调用 API）
countTokensForMessages(messages, model): Promise<number>
  ├─ Anthropic: POST /v1/messages/count_tokens
  ├─ Bedrock: InvokeModelWithResponseStream count_tokens 模式
  └─ Vertex: POST /countTokens

// 粗略估算（本地，无 API 调用）
roughTokenCountEstimation(text: string): number
  → text.length / 3（平均英文约 3 字符/token）
  → 用于快速预估（误差 ±30%）
```

---

## 八、会话标题生成 `utils/sessionTitle.ts`

```typescript
// 从对话内容生成会话标题（显示在 bridge 和历史记录）
generateSessionTitle(messages): Promise<string>
  → 取前几条消息的 transcript
  → 发给 claude-haiku 生成 5-10 词的标题
  → 缓存到 sessionStorage

// 简短词汇 slug（用于 worktree 目录名）
generateShortWordSlug(): string
  → "fix-auth-token-refresh"（2-3 个单词）
```

---

## 九、工具使用摘要 `services/toolUseSummary/`

```typescript
// 生成工具使用摘要（gate: emitToolUseSummaries）
generateToolUseSummary(toolUseBlocks, toolResults): Promise<ToolUseSummaryMessage>
  → 发给 claude-haiku 生成 2-3 句话的摘要
  → "Read 5 files, edited 2 TypeScript files, ran tests"
  → 注入到对话中作为 ToolUseSummaryMessage

// 摘要消息类型（注入在对话中）
type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
  turnIndex: number
}
```

---

## 十、自动梦境 `services/autoDream/`

每次会话结束时，自动触发"梦境"过程（记忆整合）：

```typescript
executeAutoDream(messages, toolUseContext)
  → 检查是否需要梦境（距上次 > 2 小时 || 对话轮次 > 5）
  → 创建 DreamTask（后台运行）
  → DreamTask 读取最近对话和 MEMORY.md
  → 调用子代理生成记忆摘要
  → 更新 ~/.claude/memories/{projectHash}/MEMORY.md
```

---

## 十一、Prompt 建议 `services/PromptSuggestion/`

```typescript
executePromptSuggestion(messages, context)
  → 分析当前对话状态
  → 生成 3 个后续行动建议
  → 显示在 REPL 底部（可快捷键选择）
```

---

## 十二、技能搜索 `services/skillSearch/`（EXPERIMENTAL_SKILL_SEARCH）

```typescript
// 为技能构建本地向量索引（基于 embedding）
buildSkillIndex(skills): Promise<void>

// 在技能库中语义搜索
searchSkills(query: string): Promise<SkillSearchResult[]>

// 自动预取（在对话中预测下一个可能用到的技能）
prefetchSkills(messages): Promise<void>
```

---

## 十三、记忆提取 `services/extractMemories/`（EXTRACT_MEMORIES feature）

每轮对话结束后，分析消息提取值得记忆的信息：

```typescript
extractMemories(messages, existingMemory)
  → 识别：用户偏好/技术决策/项目规范/常见错误
  → 生成 MEMORY.md 的增量更新
  → 以追加/替换方式更新 MEMORY.md
```
