# Claude Code 源码分析 - 09 Bridge 远程控制

---

## 一、架构概述

```
本地 CLI ──WebSocket──→ CCR（Claude Control Router）──→ claude.ai 网页
```

Bridge 允许 claude.ai 网页界面控制本地运行的 Claude Code：
- 查看实时对话内容
- 从网页发送消息
- 在网页响应权限请求
- 切换权限模式
- 查看任务进度

---

## 二、Bridge 模块结构（`bridge/`）

| 文件 | 说明 |
|------|------|
| `bridgeMain.ts` | Daemon 模式主循环（3000 行），CCR 接受连接并派生子进程 |
| `replBridge.ts` | REPL 模式 bridge（2400 行），WebSocket 连接管理 |
| `initReplBridge.ts` | REPL bridge 初始化（读取 git/OAuth/session 信息）|
| `bridgeApi.ts` | CCR HTTP API 客户端 |
| `bridgeEnabled.ts` | 权限检查（是否有 claude.ai 订阅）|
| `bridgeMessaging.ts` | 消息处理（解析/格式化/路由）|
| `bridgeUI.ts` | Bridge 状态 UI（连接状态显示）|
| `bridgeConfig.ts` | Bridge 配置（URL/token 来源）|
| `bridgeDebug.ts` | Bridge 调试工具（故障注入）|
| `bridgePointer.ts` | Bridge 实例指针管理 |
| `bridgeStatusUtil.ts` | 状态格式化工具 |
| `bridgePermissionCallbacks.ts` | 权限响应回调注册 |
| `createSession.ts` | 会话创建流程 |
| `sessionRunner.ts` | 会话运行器（接收工作并执行）|
| `remoteBridgeCore.ts` | 远程 bridge 核心逻辑（3900 行）|
| `replBridgeTransport.ts` | 传输层（V1/V2 WebSocket）|
| `replBridgeHandle.ts` | Bridge handle（暴露给 REPL 的 API）|
| `trustedDevice.ts` | 设备信任 token 管理 |
| `jwtUtils.ts` | JWT token 解析/刷新 |
| `workSecret.ts` | Work secret（一次性 token，安全凭证）|
| `sessionIdCompat.ts` | Session ID 格式兼容（新旧 infra）|
| `pollConfig.ts` | 轮询配置（间隔/超时）|
| `pollConfigDefaults.ts` | 默认轮询参数 |
| `flushGate.ts` | 输出刷新门控（防止竞态）|
| `capacityWake.ts` | 容量唤醒信号（CCR 恢复可用时通知）|
| `inboundMessages.ts` | 入站消息类型定义 |
| `inboundAttachments.ts` | 入站附件处理（图片/文件）|
| `envLessBridgeConfig.ts` | 无环境变量的 bridge 配置（容器模式）|
| `debugUtils.ts` | 调试工具函数 |
| `codeSessionApi.ts` | Code session API（CCR 子路径）|

---

## 三、权限检查 `bridgeEnabled.ts`

```typescript
// 同步检查（可能 stale）
isBridgeEnabled(): boolean
  → feature('BRIDGE_MODE')           // 构建时 flag
    && isClaudeAISubscriber()         // 有 OAuth token（非 API Key）
    && getFeatureValue_CACHED('tengu_ccr_bridge', false)  // GrowthBook 门控

// 阻塞检查（等待 GrowthBook 初始化）
isBridgeEnabledBlocking(): Promise<boolean>

// 诊断信息（为什么不可用）
getBridgeDisabledReason(): Promise<string | null>
  → 返回具体原因（未登录 / 未订阅 / 门控关闭 / 版本太低）
```

---

## 四、REPL Bridge 初始化 `initReplBridge.ts`

### 初始化流程

```
1. 检查权限（isBridgeEnabledBlocking）
2. 读取 Git 信息（branch / remote URL）
3. 读取 OAuth token
4. 生成或恢复 session title（generateSessionTitle）
5. 调用 POST /v1/environments 创建 bridge 环境
   → 返回 environmentId + accessToken + websocketUrl
6. 建立 WebSocket 连接（replBridgeTransport）
7. 注册到 CCR：发送会话元数据
   → sessionId, gitBranch, remoteUrl, title, cwd, model, permissionMode
8. 开始推送现有消息历史
9. 返回 ReplBridgeHandle
```

### ReplBridgeHandle

```typescript
type ReplBridgeHandle = {
  push(message: Message): void           // 推送新消息
  updatePermissionMode(mode): void       // 权限模式变化通知
  updateSessionTitle(title): void        // 更新标题
  updateModel(model): void               // 模型变化通知
  sendPermissionRequest(req): void       // 发送权限请求
  sendPermissionResponse(resp): void     // 发送权限响应
  stop(): void                           // 停止 bridge
  onIncomingMessage(handler): void       // 注册入站消息处理器
}
```

---

## 五、消息处理 `bridgeMessaging.ts`

### 出站消息格式（CLI → CCR）

```typescript
// 每条本地消息转换为 bridge 格式推送
makeResultMessage(message: Message) → BridgeMessage
  ├─ user 消息 → { type: 'user', content: [...] }
  ├─ assistant 消息 → { type: 'assistant', content: [...] }
  ├─ tool_use → { type: 'tool_use', name, input }
  ├─ tool_result → { type: 'tool_result', content }
  └─ system 消息 → { type: 'status', ... }
```

### 入站消息处理 `handleIngressMessage`

```typescript
handleIngressMessage(message: BridgeIngressMessage)
  ├─ type: 'user_message'
  │   → 注入到本地输入队列（messageQueueManager）
  │
  ├─ type: 'permission_response'
  │   → 调用 bridgePermissionCallbacks.resolve(requestId, response)
  │
  ├─ type: 'cancel'
  │   → abortController.abort()
  │
  ├─ type: 'set_permission_mode'
  │   → setAppState({ toolPermissionContext: { mode: ... } })
  │
  └─ type: 'session_control'
      → clear / resume / etc.
```

### BoundedUUIDSet（去重机制）

```typescript
// 防止同一消息被重复处理（WebSocket 重连时服务端可能重发）
class BoundedUUIDSet {
  private readonly max: number = 1000
  private readonly set = new Set<string>()
  
  has(uuid: string): boolean
  add(uuid: string): void
  // 超出 max 时自动清除旧 UUID（LRU 策略）
}
```

---

## 六、Daemon 模式 `bridgeMain.ts`（3000行）

### 适用场景

Daemon 模式下，Claude Code 作为后台服务运行，CCR 发来工作任务时派生子进程执行：

```
CCR ──HTTP Polling──→ BridgeMain（本地 daemon）
                           ├─ GET /work → 检查是否有待处理工作
                           ├─ POST /spawn → 派生新的 claude 子进程
                           └─ STREAM /output → 流式返回执行结果
```

### 连接状态机

```
disconnected
  ↓ (启动)
connecting → register with CCR
  ↓
idle（等待工作）
  ↓ (收到工作)
spawning（派生子进程）
  ↓
running（监控子进程）
  ↓
done / failed
  ↓ (继续轮询)
idle
```

### BackoffConfig（退避配置）

```typescript
type BackoffConfig = {
  connInitialMs: number      // 初始连接重试间隔
  connCapMs: number          // 最大连接重试间隔
  connGiveUpMs: number       // 放弃连接的总时长
  generalInitialMs: number   // 一般错误初始重试间隔
  generalCapMs: number       // 一般错误最大间隔
  generalGiveUpMs: number    // 放弃的总时长
  shutdownGraceMs?: number   // SIGTERM→SIGKILL 宽限期（默认 30s）
  stopWorkBaseDelayMs?: number // stopWork 基础延迟（1s/2s/4s）
}
```

---

## 七、传输层 `replBridgeTransport.ts`

### V1 传输（旧版，基于 HTTP 轮询）

```typescript
createV1ReplTransport(config): ReplBridgeTransport
  → 轮询 CCR REST API
  → GET /bridge/{bridgeId}/messages
  → POST /bridge/{bridgeId}/messages
  → 每 POLL_INTERVAL_MS 轮询一次
```

### V2 传输（新版，WebSocket）

```typescript
createV2ReplTransport(config): ReplBridgeTransport
  → 建立 WebSocket 连接到 CCR
  → 持久连接，推送/接收消息
  → 自动重连（带指数退避）
  → Ping/Pong 心跳（30s 间隔）
```

### HybridTransport（同时支持 V1/V2）

```typescript
// 优先使用 V2（WebSocket），V2 不可用时降级到 V1
class HybridTransport {
  private v2: V2Transport
  private v1: V1Transport
  
  // V2 连接失败后自动切换到 V1
  async send(message): Promise<void>
  async receive(): AsyncGenerator<BridgeMessage>
}
```

---

## 八、远程 `remote/` 目录

### RemoteSessionManager.ts（查看器模式）

```typescript
// claude assistant 命令使用
// 只读查看，不发送消息，不中断
type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  hasInitialPrompt?: boolean
  isViewerOnly?: boolean     // true = 只读查看，不能发 ctrl+c
}
```

### SessionsWebSocket.ts

```typescript
// 与 CCR 的 WebSocket 连接管理
class SessionsWebSocket {
  connect(sessionId: string): Promise<void>
  disconnect(): void
  sendMessage(content: RemoteMessageContent): Promise<boolean>
  onMessage(handler: MessageHandler): void
  onDisconnect(handler: () => void): void
  
  // 重连策略
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY_MS = 1000
}
```

### sdkMessageAdapter.ts

```typescript
// SDK 消息格式 → 内部 Message 格式转换
convertSDKMessage(sdkMsg: SDKMessage) → Message | null
isSessionEndMessage(msg): boolean
```

### remotePermissionBridge.ts

```typescript
// 将 CCR 权限请求转换为本地权限请求格式
createSyntheticAssistantMessage(toolUseBlocks) → AssistantMessage
createToolStub(toolUseBlock) → Tool
```

---

## 九、Session Runner `sessionRunner.ts`

### Daemon 模式下的会话执行

```typescript
// 每个 CCR 下发的任务创建一个独立的会话运行器
createSessionSpawner(config): SessionSpawner

type SessionSpawnOpts = {
  sessionId: string
  workSecret: string         // 一次性安全凭证
  prompt?: string            // 初始提示词
  workDir: string
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  tools?: string[]           // 工具限制
}

// 派生子进程，传递 work secret 通过 env var
spawnSession(opts) → ChildProcess
```

---

## 十、信任设备 `trustedDevice.ts`

```typescript
// 设备信任 token（用于 CCR SecurityTier=ELEVATED）
getTrustedDeviceToken(): string | undefined
  → 读取本地存储的设备 token
  → 每次与 CCR 通信时附加到 X-Trusted-Device-Token 头

// 设备 token 由 bridge 握手时 CCR 颁发
// 存储在 ~/.claude.json 中（encrypted）
```

---

## 十一、Work Secret `workSecret.ts`

```typescript
// Work secret 是一次性安全凭证，用于：
// 1. Daemon 模式：CCR 发给 daemon，daemon 派生子进程时注入
// 2. 子进程用 work secret 向 CCR 注册自己

// 编码/解码（Base64 URL-safe）
encodeWorkSecret(secret: WorkSecret): string
decodeWorkSecret(encoded: string): WorkSecret

// 注册子进程到 CCR
registerWorker(workSecret, sessionId) → Promise<WorkerRegistration>

// 构建 SDK URL（注入 work secret）
buildSdkUrl(workSecret): URL
buildCCRv2SdkUrl(workSecret): URL
```
