# Claude Code 源码分析 - 04 权限系统

---

## 一、权限模式（PermissionMode）

```typescript
type PermissionMode =
  | 'default'            // 每次工具调用都询问用户
  | 'acceptEdits'        // 自动接受文件编辑，询问命令执行
  | 'bypassPermissions'  // 跳过所有权限检查（危险！）
  | 'dontAsk'            // 不询问但不 bypass 安全检查
  | 'plan'               // 计划模式：只读，拒绝所有写操作
  | 'auto'               // 自动模式：AI 分类器判断是否安全
  | 'bubble'             // 内部模式（coordinator worker 用）
```

### 模式转换规则

| 触发方式 | 目标模式 |
|---------|---------|
| Shift+Tab 循环 | default → acceptEdits → plan → default |
| EnterPlanModeTool / /plan 命令 | 当前 → plan |
| ExitPlanModeV2Tool | plan → 原模式（prePlanMode 字段）|
| 用户同意 auto mode 对话框 | 任何 → auto |
| --bypass-permissions 命令行 | 任何 → bypassPermissions |
| /permissions 命令 | 手动切换 |

### 模式说明

**`acceptEdits`**：
- FileEditTool/FileWriteTool 自动允许
- BashTool 仍需询问
- 适合代码生成场景

**`plan`**：
- 只允许 FileReadTool/GlobTool/GrepTool 等读工具
- FileEditTool/BashTool 等写操作返回 `behavior: 'deny'`
- 模型被告知"处于计划模式，请只生成计划不执行"

**`auto`**：
- 每次工具调用触发 yoloClassifier（Haiku 模型分类）
- 分类为"安全"则自动允许
- 分类为"危险"则显示权限对话框
- 有30秒缓存（同一工具+输入不重复分类）

**`bypassPermissions`**：
- 完全跳过所有权限检查
- 仅在 `--dangerously-skip-permissions` 或 CCR 容器环境下可用
- 所有调用记入审计日志

---

## 二、权限检查流程 `utils/permissions/permissions.ts`

```
hasPermissionsToUseTool(tool, input, context, assistantMsg, toolUseID)
  │
  ├─ bypassPermissions 模式
  │   → behavior: 'allow'（记录审计日志）
  │
  ├─ 检查 alwaysDenyRules（来自 settings.json / policy）
  │   → 匹配 → behavior: 'deny'（附带规则来源说明）
  │
  ├─ 检查 alwaysAllowRules
  │   → 匹配 → behavior: 'allow'
  │
  ├─ tool.checkPermissions(input, context)
  │   ├─ BashTool → bashToolHasPermission()
  │   │   → 检查命令前缀是否在 always-allow 列表
  │   ├─ FileEditTool → checkWritePermissionForTool()
  │   │   → 检查路径是否在允许的写目录内
  │   └─ MCPTool → passthrough（MCP server 自身控制权限）
  │
  ├─ auto/bubble 模式 → yoloClassifier()
  │   → Haiku 分类 → allow 或 confirm
  │
  └─ 其余 → behavior: 'ask'（需用户确认）
      → 队列化到 toolUseConfirmQueue
      → 渲染权限对话框
      → 等待用户选择
```

---

## 三、权限规则系统

### 规则来源（SettingSource 优先级）

```
policySettings   # /etc/claude-code/managed-settings.json（最高优先级）
  ↓
userSettings     # ~/.claude/settings.json
  ↓
projectSettings  # .claude/settings.json
  ↓
localSettings    # .claude/settings.local.json（gitignore 中）
  ↓
flagSettings     # --settings 命令行参数
  ↓
session          # 本次会话临时规则（不持久化）
  ↓
cliArg           # 命令行直接传入的规则
```

### 规则格式

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm run *)",
      "Edit(src/**/*.ts)",
      "Edit(tests/**)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Edit(.env)",
      "Edit(*.pem)"
    ]
  }
}
```

### 规则匹配语法（`utils/permissions/permissionRules.ts`）

| 规则格式 | 说明 |
|---------|------|
| `ToolName` | 匹配工具名，所有输入 |
| `ToolName(pattern)` | 匹配工具名 + 输入模式（glob 语法）|
| `ToolName(key:value)` | 匹配特定键值（如 `Edit(path:src/*)`）|

**Bash 规则特殊处理**：
- `Bash(git *)` — 允许所有 `git` 开头的命令
- `Bash(npm run *)` — 允许所有 `npm run` 开头的命令
- 使用 `micromatch` 库进行 glob 匹配

---

## 四、Auto 模式分类器 `utils/permissions/yoloClassifier.ts`

### 工作原理

```typescript
yoloClassifier(tool, input, messages, toolPermissionContext)
  │
  ├─ 检查 30秒缓存（同 tool+input 不重复分类）
  ├─ 构建 transcript（最近 N 条消息的简化摘要）
  ├─ 发送给 claude-haiku-4-5 模型
  │   → 系统提示：auto_mode_system_prompt.txt
  │   → 用户消息：当前工具调用描述
  │
  ├─ Haiku 返回：
  │   { action: 'allow' | 'confirm', reason: string }
  │
  └─ 允许 → 自动执行（无 UI 提示）
     确认 → 显示权限对话框（带 Haiku 的建议和原因）
```

### 分类器提示内容（auto_mode_system_prompt.txt）

分类规则包含：
- **允许的操作**：读文件、运行测试、git 操作、安装 npm 包等
- **需要确认的操作**：修改敏感配置、运行副作用命令等
- **拒绝的操作**：rm -rf、sudo 危险命令等
- **Prompt injection 检测**：检测工具输出中嵌入的恶意指令

### 性能优化

- 与主循环共享 CacheSafeParams，利用 prompt cache
- 分类器调用计入 `turnClassifierDurationMs` 统计
- 结果缓存 30 秒（同 tool+inputHash）

---

## 五、文件路径权限 `utils/permissions/filesystem.ts`

### 危险文件列表 `DANGEROUS_FILES`

```typescript
DANGEROUS_FILES = [
  // 系统关键文件
  '/etc/passwd', '/etc/shadow', '/etc/sudoers',
  // SSH 密钥
  '~/.ssh/id_rsa', '~/.ssh/id_ed25519',
  // 环境变量
  '.env', '.env.local', '.env.production',
  // 敏感配置
  '*.pem', '*.key', '*.p12', '*.pfx',
  // Claude 配置
  '~/.claude.json', '.claude/settings.json',
  // ...更多
]
```

### 可写目录检查

```typescript
checkWritePermissionForTool(filePath, toolPermissionContext)
  │
  ├─ 检查 additionalWorkingDirectories（--add-dir 添加的目录）
  ├─ 检查是否在 originalCwd 子目录内
  ├─ 检查 DANGEROUS_FILES 列表
  └─ 检查 alwaysDenyRules 中的路径规则
```

### 路径安全 `sanitizePath()`

```typescript
// 防止路径遍历攻击
sanitizePath(userPath) → absolutePath
  → realpath（解析符号链接）
  → normalize（处理 ./ ../）
  → 确保在允许目录内
```

---

## 六、Swarm Worker 权限流转

在 swarm 模式下，worker 的权限请求需要转发给 leader：

```
Worker 触发权限请求
  ↓
swarmWorkerHandler（useCanUseTool.ts）
  ↓
写入 mailbox（UNIX domain socket 或共享文件）
  ↓
Leader 进程监听 mailbox
  ↓
Leader 渲染权限对话框
  ↓
用户在 Leader 界面操作
  ↓
Leader 写入权限响应到 mailbox
  ↓
Worker 轮询（useSwarmPermissionPoller，500ms）读取响应
  ↓
调用 onAllow / onReject 回调
```

### 权限响应格式（`utils/swarm/permissionSync.ts`）

```typescript
type PermissionResponse = {
  requestId: string
  decision: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>  // 允许时可修改输入
  message?: string                         // 拒绝时的原因
}
```

### PermissionUpdate 验证（防恶意数据）

```typescript
// 解析外部来源（mailbox/磁盘）的权限更新时验证
parsePermissionUpdates(raw) → PermissionUpdate[]
  → permissionUpdateSchema().safeParse(entry)
  → 解析失败 → 丢弃并记录 warn 日志（不崩溃）
```

---

## 七、Coordinator 模式权限（COORDINATOR_MODE feature）

协调器模式下，多个 worker 代理运行，权限通过协调器汇聚：

```
Worker 1 ─┐
Worker 2 ─┼─→ coordinator（集中处理权限）→ Leader UI
Worker N ─┘
```

`coordinatorHandler`：
- worker 发送权限请求到 coordinator 进程
- coordinator 保持权限请求队列
- coordinator 的 UI 展示汇总的权限请求
- coordinator 收到用户响应后，通过 mailbox 广播到对应 worker

---

## 八、权限对话框 UI 组件

### PermissionRequest.tsx（总入口）

```typescript
// 根据 tool 类型路由到对应对话框
PermissionRequest({ confirmations, ... })
  ├─ BashPermissionRequest  → Bash 命令权限
  ├─ FileEditPermissionRequest → 文件编辑权限（显示 diff）
  ├─ FileWritePermissionRequest → 文件写入权限
  ├─ SandboxPermissionRequest → 沙盒网络访问
  ├─ SkillPermissionRequest → 技能/工具权限
  └─ GenericPermissionRequest → 通用权限
```

### 权限响应选项

| 选项 | 效果 |
|------|------|
| `allow once` | 本次允许，下次仍询问 |
| `allow always` | 添加到 alwaysAllow 规则（本 session）|
| `allow always for project` | 保存到 .claude/settings.json |
| `allow always for this user` | 保存到 ~/.claude/settings.json |
| `deny` | 本次拒绝，下次仍询问 |
| `deny always` | 添加到 alwaysDeny 规则 |

### PermissionRuleExplanation.tsx

显示权限规则的来源（"Allowed by user settings at ~/.claude/settings.json"），帮助用户理解为何某个操作被自动允许/拒绝。
