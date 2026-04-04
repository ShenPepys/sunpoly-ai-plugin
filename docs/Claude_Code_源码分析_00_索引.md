# Claude Code 源码深度分析 — 总索引

> 基于 `claude-code-main/src/` 全量代码阅读（250+ TypeScript/TSX 文件）  
> 分析日期：2026-04-04  
> 文档版本：V1.0

---

## 文档目录

| 序号 | 文件名 | 内容 |
|------|--------|------|
| 00 | 本文件 | 总索引 |
| 01 | `Claude_Code_源码分析_01_架构概览.md` | 技术栈、目录结构、启动流程、全局状态 |
| 02 | `Claude_Code_源码分析_02_查询引擎.md` | query.ts 执行循环、API 调用、压缩系统 |
| 03 | `Claude_Code_源码分析_03_工具系统.md` | 40+ 工具清单、BashTool/AgentTool 详解 |
| 04 | `Claude_Code_源码分析_04_权限系统.md` | 权限模式、检查流程、Auto 分类器 |
| 05 | `Claude_Code_源码分析_05_服务层.md` | Analytics、MCP、LSP、OAuth、压缩、记忆提取 |
| 06 | `Claude_Code_源码分析_06_UI组件层.md` | REPL 界面、消息渲染、设计系统、权限对话框 |
| 07 | `Claude_Code_源码分析_07_Hooks层.md` | 80+ React Hooks、输入处理、自动完成、历史导航 |
| 08 | `Claude_Code_源码分析_08_任务系统.md` | 后台任务（Shell/Agent/Remote/Teammate/Dream）|
| 09 | `Claude_Code_源码分析_09_Bridge远程控制.md` | claude.ai Bridge、WebSocket、Daemon 模式 |
| 10 | `Claude_Code_源码分析_10_扩展机制.md` | 技能、插件、Hooks 系统、CLAUDE.md、键盘绑定 |
| 11 | `Claude_Code_源码分析_11_设计模式与关键工具.md` | feature 宏、React Compiler、安全模型、数据流 |

---

## 快速参考：核心文件索引

### 最重要的 10 个文件

| 文件 | 重要性 | 说明 |
|------|--------|------|
| `src/query.ts` | ⭐⭐⭐⭐⭐ | 整个系统的心脏，LLM 对话执行循环 |
| `src/main.tsx` | ⭐⭐⭐⭐⭐ | 程序入口，4684 行，CLI 决策树 |
| `src/bootstrap/state.ts` | ⭐⭐⭐⭐⭐ | 全局单例状态，1759 行 |
| `src/Tool.ts` | ⭐⭐⭐⭐⭐ | 工具接口定义，ToolUseContext |
| `src/screens/REPL.tsx` | ⭐⭐⭐⭐⭐ | 主 REPL 界面，1700+ 行 |
| `src/tools/AgentTool/AgentTool.ts` | ⭐⭐⭐⭐ | 子代理工具，234KB 最大文件 |
| `src/utils/permissions/permissions.ts` | ⭐⭐⭐⭐ | 权限检查核心逻辑 |
| `src/services/api/claude.ts` | ⭐⭐⭐⭐ | Anthropic API 调用 |
| `src/QueryEngine.ts` | ⭐⭐⭐⭐ | SDK 层封装 |
| `src/bridge/replBridge.ts` | ⭐⭐⭐ | claude.ai 远程控制，2407 行 |

---

## 快速参考：关键常量

### Context 窗口与 Token 限制

```typescript
MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3      // max_tokens 错误最多恢复 3 次
COMPLETION_THRESHOLD = 0.9                // Token 预算 90% → 停止
DIMINISHING_THRESHOLD = 500              // 增量 < 500 tokens → 停止

// Micro-compact 时间触发阈值
IDLE_TIMEOUT_MS = 60 * 60 * 1000        // 60 分钟无活动

// Auto-compact 触发
DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8     // Context 80% 时自动压缩

// MEMORY.md 限制
MAX_ENTRYPOINT_LINES = 200
MAX_ENTRYPOINT_BYTES = 25_000           // 25KB

// 历史记录
MAX_HISTORY_ITEMS = 100
MAX_PASTED_CONTENT_LENGTH = 1024
```

### 重要路径

```
~/.claude.json                          # 全局配置（OAuth token、会话历史等）
~/.claude/settings.json                 # 用户设置
~/.claude/memories/{hash}/MEMORY.md     # 项目记忆
~/.claude/projects/{hash}/              # 项目会话存储
~/.claude/plugins/                      # 已安装插件
~/.claude/skills/                       # 用户自定义技能
~/.claude/history.jsonl                 # 输入历史
~/.claude/logs/                         # 日志文件

.claude/settings.json                   # 项目设置（提交到 git）
.claude/settings.local.json             # 本地设置（gitignore）
.claude/skills/                         # 项目技能
.claude/agents/                         # 代理定义
.claude/tasks/                          # 任务输出
.claude/scheduled_tasks.json            # 定时任务配置
CLAUDE.md                               # 项目指令（提交到 git）
CLAUDE.local.md                         # 本地指令（gitignore）

/etc/claude-code/managed-settings.json  # 企业策略设置（只读）
/etc/claude-code/CLAUDE.md              # 企业统一指令
```

---

## 快速参考：权限模式速查

| 模式 | Shift+Tab | 文件编辑 | Bash 命令 | MCP 工具 |
|------|-----------|---------|----------|---------|
| `default` | ← | 询问 | 询问 | 询问 |
| `acceptEdits` | ← | **自动允许** | 询问 | 询问 |
| `plan` | ← | **自动拒绝** | **自动拒绝** | 询问 |
| `auto` | ← | AI 分类 | AI 分类 | AI 分类 |
| `bypassPermissions` | — | **跳过** | **跳过** | **跳过** |
| `dontAsk` | — | 允许（无提示）| 允许（无提示）| 允许（无提示）|

---

## 快速参考：工具权限规则格式

```
允许/拒绝所有 BashTool 调用：
  "Bash"

允许 git 开头的所有命令：
  "Bash(git *)"

允许 src/ 目录下的文件编辑：
  "Edit(src/**)"

允许特定 MCP 工具：
  "mcp__server-name__tool-name"

拒绝修改 .env 文件：
  "Edit(.env)"
  "Write(.env)"
```

---

## 快速参考：Hook 事件触发时机

| 事件 | 触发时机 | 常见用途 |
|------|---------|---------|
| `PreToolUse` | 工具调用前 | 验证输入、拒绝危险操作 |
| `PostToolUse` | 工具调用后 | 审计日志、格式化输出 |
| `Stop` | AI 停止后 | 提取记忆、生成摘要、通知 |
| `UserPromptSubmit` | 用户提交前 | 修改 prompt、注入上下文 |
| `SessionStart` | 会话开始 | 初始化、依赖检查 |
| `SessionEnd` | 会话结束 | 清理、上报 |
| `FileChanged` | 文件修改后 | 触发 lint/format/test |
| `PermissionRequest` | 权限询问时 | 自动批准特定规则 |

---

## 快速参考：重要 Feature Flags

| 开启方式 | 控制内容 |
|---------|---------|
| `BRIDGE_MODE=true`（build flag）| claude.ai 远程控制 |
| `KAIROS=true`（build flag）| Kairos/Assistant 模式 |
| `CLAUDE_DEBUG=true`（env）| 启用调试日志 |
| `CLAUDE_CODE_SIMPLE=1`（env）| bare 模式（最小化）|
| `CLAUDE_CODE_REMOTE=true`（env）| CCR 容器模式 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（env）| 禁用自动记忆 |
| `CLAUDE_CODE_DISABLE_FAST_MODE=1`（env）| 禁用 fast 模式 |
| `DISABLE_AUTO_COMPACT=1`（env）| 禁用自动压缩 |
| `CLAUDE_CODE_VERIFY_PLAN=true`（env）| 启用计划验证工具 |
| `USER_TYPE=ant`（env）| 启用 ant-only 工具（REPL/SuggestPR）|

---

## 系统整体数据流图

```
用户键盘输入
    │
    ▼
[useTextInput / useVimInput / usePasteHandler]
    │
    ▼
[useTypeahead] ──── 自动完成建议
    │
  Enter
    │
    ▼
[REPL.tsx onQuery()] ──── 更新 messages state
    │
    ▼
[processUserInput()] ──── 检测斜杠命令
    │
  普通消息
    │
    ▼
[query() / QueryEngine.query()]
    │
    ├── fetchSystemPromptParts() ──→ CLAUDE.md + Git 状态 + 记忆
    │
    ├── microcompactMessages()   ──→ 清除旧工具结果
    │
    ▼
[services/api/claude.ts queryModelWithStreaming()]
    │
    ▼
Anthropic API（流式）
    │
    ├── text → AssistantTextMessage
    ├── thinking → ThinkingBlock
    └── tool_use → ToolUseBlock
             │
             ▼
    [canUseTool()] ──── 权限检查
             │
             ├── allow → tool.call()
             │               │
             │               ▼
             │         工具执行结果
             │
             └── ask → [PermissionRequest UI]
                            │
                          用户选择
                            │
                         allow/deny
    │
    ▼
[handleStopHooks()] ──→ extractMemories / autoDream / promptSuggestion
    │
    ▼
[useLogMessages] ──→ recordTranscript (disk)
    │
    ▼
[useReplBridge] ──→ push to claude.ai
    │
    ▼
[Messages.tsx] ──→ 虚拟滚动渲染
```

---

*文档基于代码库的全量分析，所有内容均来自实际代码，不含推测性内容。*
