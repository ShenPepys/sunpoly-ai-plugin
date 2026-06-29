# my-ai-plugin 与 cline-chinese 差距分析

> 对比基准：本仓库内的 `cline-chinese` 工程（Cline 中文版 fork）  
> 分析日期：2026-06-29  
> 背景：用户反馈在 Windows + PowerShell + conda 环境下，同样问题 cline-chinese 正常，my-ai-plugin 报终端相关错误。  
> **执行队列**：[RUNQUEUE.md](./RUNQUEUE.md)（按 RUNQUEUE 执行，遵循 runqueue-executor skill）

---

## 1. 用户反馈问题根因

### 1.1 现象

用户在 Windows 上提问（如「检查 movefile_test.py 是否有逻辑错误」）时，底部终端出现：

```
无法加载 conda-hook.ps1，因为在此系统上禁止运行脚本 (PSSecurityException)
conda 无法识别为 cmdlet、函数、脚本文件或可运行程序的名称
```

### 1.2 根因（非 VS Code 插件 API 权限问题）

| 维度 | my-ai-plugin 现状 | cline-chinese 做法 |
|------|-------------------|-------------------|
| 命令执行方式 | `child_process.exec()` 在独立子进程中执行 | 默认走 **VS Code 集成终端** + Shell Integration API |
| 环境继承 | 仅继承 `process.env`，不含 conda/nvm 等 shell 初始化 | 复用用户终端 session，PATH/conda 通常已就绪 |
| Windows PowerShell | 无 `-NoProfile` / `-ExecutionPolicy Bypass` | Hook 脚本显式绕过；终端模式走集成终端 |
| Shell 选择 | 隐式使用系统默认（Windows 多为 cmd） | 读取 `terminal.integrated` 配置，支持 pwsh/cmd/bash/WSL/Git Bash |

**结论**：问题出在**终端命令执行架构**，不是插件「没有调用工具的权限」。

当前实现见 `src/tools/terminalExec.ts`：使用 `exec(command, { cwd, env: { ...process.env } })`，与用户交互式终端环境隔离。

### 1.3 用户侧临时 workaround

```powershell
# 以管理员身份运行（放宽当前用户脚本策略）
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

或在 VS Code 设置中将默认终端改为 **Git Bash** / **cmd**，减少 PowerShell Profile 加载问题。

长期应在插件侧修复终端架构，而非依赖用户改系统策略。

**终端问题自助排查**：[TERMINAL_TROUBLESHOOTING.zh-CN.md](./TERMINAL_TROUBLESHOOTING.zh-CN.md)

---

## 2. 全面对比总览

| 模块 | my-ai-plugin | cline-chinese | 差距等级 |
|------|-------------|---------------|----------|
| 终端命令执行 | `child_process.exec` | 集成终端 + Shell Integration | **P0 缺陷** |
| 读文件 | fs + 行号 + 截断 | 分段读、图片/PDF 等 | P2 增强 |
| 写/编辑文件 | write/edit/ast_edit | write/replace/patch | 各有优势 |
| 列目录 | `fs.readdir` | globby BFS + gitignore | P2 增强 |
| 内容搜索 | 逐文件 RegExp | bundled ripgrep | **P1 缺陷** |
| 文件名搜索 | `workspace.findFiles` | ripgrep + fzf | P2 增强 |
| 命令执行确认 | 无（Code 模式直接执行） | ask 批准 + auto-approve | **P1 缺陷** |
| 危险命令拦截 | 简单 regex | CommandPermissionController | P2 增强 |
| 多根工作区 | 仅 `workspaceFolders[0]` | 完整 multi-root | P2 增强 |
| ignore 规则 | 硬编码 skip 列表 | `.clineignore` + `.gitignore` | P2 增强 |
| MCP | 无 | 完整 MCP Hub | 新功能 |
| Browser 工具 | 无 | 有 | 新功能 |
| Hooks | 无 | Pre/Post ToolUse | 新功能 |
| 终端设置 UI | 无 | 超时/shell/复用等可配置 | P1 增强 |
| AST 结构化编辑 | **有（独有优势）** | 无同等能力 | 我方优势 |
| 工作模式 | Ask / Plan / Code | Plan / Act | 各有特点 |

---

## 3. 需修复的缺陷

### P0 — 终端执行（对应用户反馈）

**现状**：`src/tools/terminalExec.ts` 使用裸 `child_process.exec`。

**问题**：

1. 与用户集成终端环境隔离，conda/nvm/pyenv 等未初始化
2. Windows 上若命令触发 PowerShell，会加载 Profile（含 conda-hook.ps1），ExecutionPolicy 受限时报错
3. 用户看不到真实执行过程，易误判为「插件没权限」
4. 固定 30s 超时、8KB 输出截断，长命令易失败

**应对**（参考 cline `src/hosts/vscode/terminal/`、`src/integrations/terminal/`）：

- [ ] 新建 `src/terminal/` 模块，实现 VS Code 集成终端执行
- [ ] 使用 `terminal.shellIntegration.executeCommand()` 获取输出流
- [ ] 终端复用、CWD 切换、Shell Integration 超时等待
- [ ] Shell Integration 失败时，读取终端快照作为 fallback
- [ ] 子进程 fallback（Windows PowerShell）使用：
  ```text
  pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "..."
  ```
- [ ] 从 `terminal.integrated.defaultProfile.windows` 读取用户 shell 配置（参考 cline `src/utils/shell.ts`）
- [ ] 系统 Prompt 强化：探索目录/读文件必须用 `list_dir`/`read_file`，禁止 `run_command` 跑 `ls`/`dir`/`Get-ChildItem`

**参考文件**：

- cline: `VscodeTerminalManager.ts`, `VscodeTerminalProcess.ts`, `CommandExecutor.ts`, `CommandOrchestrator.ts`
- cline 文档: `docs-zh/troubleshooting/terminal-quick-fixes.md`

---

### P1 — 安全与体验

#### 3.1 命令执行前用户确认

**现状**：Code 模式下 `run_command` 直接执行，无二次确认。

**cline 做法**：`ExecuteCommandToolHandler` 在执行前 `askApproval`；支持 auto-approve 白名单。

**待办**：

- [ ] `run_command` 执行前弹出确认（显示完整命令）
- [ ] 设置项：自动批准安全命令 / 只读命令白名单
- [ ] UI 步骤中展示命令与输出（与写文件 diff 步骤一致）

#### 3.2 grep 性能

**现状**：`src/tools/searchTools.ts` 中 `grep_code` 逐文件 `readFile` + `RegExp`，大仓库极慢，上限 100 条。

**cline 做法**：`src/services/ripgrep/` 使用 bundled `rg` 二进制。

**待办**：

- [ ] 引入 ripgrep（打包或依赖 VS Code 内置）
- [ ] `grep_code` 改为调用 ripgrep
- [ ] 保留 JS fallback 供无 rg 环境使用

#### 3.3 终端相关设置页

**待办**：

- [ ] 默认终端 Profile（default / pwsh / cmd / bash / WSL）
- [ ] Shell Integration 超时（秒）
- [ ] 命令默认超时 / 长命令超时
- [ ] 是否启用终端复用
- [ ] 输出行数上限

---

### P2 — 能力与健壮性增强

#### 3.4 读文件

**待办**：

- [ ] 大文件分段读取（`start_line` / `end_line` 参数，参考 cline `ReadFileToolHandler`）
- [ ] 读图片/PDF 等（若模型支持多模态）
- [ ] 读后缓存失效策略（命令执行后清空缓存，参考 cline）

#### 3.5 列目录

**待办**：

- [ ] 支持递归列目录选项
- [ ] 增量解析 `.gitignore`，避免扫描 `node_modules` 等
- [ ] 可选 `.aiignore` / 复用 `.gitignore` 规则

#### 3.6 多根工作区

**现状**：`fileOps.ts`、`terminalExec.ts`、`searchTools.ts` 等均只使用 `workspaceFolders[0]`。

**待办**：

- [ ] 路径解析支持多 root
- [ ] 工具参数可指定 workspace root 或自动推断

#### 3.7 命令权限控制

**cline 做法**：`CommandPermissionController` — allow/deny glob、链式命令分段校验、重定向检测。

**待办**：

- [ ] 可配置的命令 allow/deny 列表
- [ ] 链式命令（`&&`、`||`、`|`、`;`）逐段校验
- [ ] 环境变量或设置项注入权限规则

#### 3.8 危险命令拦截增强

**现状**：`terminalExec.ts` 仅拦截 `rm -rf /` 等少量模式。

**待办**：

- [ ] 扩展危险模式（格式化磁盘、fork bomb、写 `/dev/` 等）
- [ ] 与权限控制器统一，避免两处规则不一致

---

## 4. 建议新增功能

以下 cline 已有、我方暂无，按业务优先级排列。

### 4.1 高价值（建议纳入路线图）

| 功能 | 说明 | cline 参考 |
|------|------|-----------|
| 终端集成架构 | 见 P0 | `integrations/terminal/` |
| 命令批准流程 | 见 P1 | `ExecuteCommandToolHandler` |
| ripgrep 搜索 | 见 P1 | `services/ripgrep/` |
| 终端故障文档 | 用户自助排查 | `docs-zh/troubleshooting/` |

### 4.2 中价值（按产品方向选做）

| 功能 | 说明 |
|------|------|
| MCP 支持 | 连接外部工具服务器，扩展 AI 能力 |
| 长命令「后台继续」 | 用户可先 Proceed，命令在后台跑并持续收集输出 |
| 命令执行后缓存失效 | 避免 `npm install` / `git checkout` 后读到旧文件内容 |
| Subagent | 子任务委派给独立 agent |
| 多 Provider / 模型路由 | 按任务类型切换模型（我方已有基础模型配置，可深化） |

### 4.3 低优先级 / 非核心

| 功能 | 说明 |
|------|------|
| Browser 自动化 | 网页操作，与代码助理场景关联较弱 |
| Hooks（Pre/Post ToolUse） | 企业级扩展，复杂度高 |
| Worktree 管理 | Git 高级工作流 |
| Telemetry 体系 | 可参考其终端失败分类埋点思路 |

---

## 5. 我方已有优势（不必照搬 cline）

以下能力为 my-ai-plugin 差异化优势，改造时须保留并继续投入：

| 能力 | 说明 |
|------|------|
| **AST 结构化编辑** | `ast_edit` + 多语言适配器（TS/Python/C#/Java 等），cline 无同等能力 |
| **行号编辑模式** | `edit_file` + `start_line`/`end_line`，降低文本匹配失败率 |
| **读前校验缓存** | `FileReadStateCache`，编辑前校验文件是否已读、是否变更 |
| **工具执行计划** | 只读并行、同文件写操作延后、重复 read 去重 |
| **三工作模式** | Ask / Plan / Code，权限边界清晰 |
| **编辑失败自动重读** | edit 失败后自动附带最新带行号内容 |
| **体量可控** | 代码规模小于 cline，P0 终端改造可局部借鉴而非全盘复制 |

---

## 6. 模块级对照（便于开发分工）

### 6.1 终端

```
my-ai-plugin                          cline-chinese
─────────────────────────────────────────────────────────────
src/tools/terminalExec.ts      →      src/hosts/vscode/terminal/
                                      src/integrations/terminal/
                                      src/utils/shell.ts
                                      src/utils/powershell.ts
```

### 6.2 文件操作

```
my-ai-plugin                          cline-chinese
─────────────────────────────────────────────────────────────
src/tools/fileOps.ts           →      handlers/ReadFileToolHandler.ts
                                      handlers/WriteToFileToolHandler.ts
                                      handlers/ListFilesToolHandler.ts
                                      integrations/misc/extract-file-content.ts
```

### 6.3 搜索

```
my-ai-plugin                          cline-chinese
─────────────────────────────────────────────────────────────
src/tools/searchTools.ts       →      services/ripgrep/index.ts
                                      services/search/file-search.ts
                                      services/glob/list-files.ts
```

### 6.4 工具编排

```
my-ai-plugin                          cline-chinese
─────────────────────────────────────────────────────────────
src/tools/toolExecutor.ts      →      core/task/ToolExecutor.ts
src/webview/fileChanges/       →      core/task/tools/handlers/*
```

---

## 7. 建议实施路线

### Phase 1 — 修复用户反馈（P0）

1. 实现 `src/terminal/`：集成终端执行 + Windows spawn fallback
2. 替换 `terminalExec.ts` 对外接口，保持 `execCommand()` 签名兼容
3. 更新 `system.ts` Prompt：禁止用终端做文件探索
4. 补充 `docs/TERMINAL_TROUBLESHOOTING.zh-CN.md`（可选，面向用户）

**验收**：Windows + Restricted ExecutionPolicy + conda 环境下，`run_command` 与 cline 行为一致；读文件类任务优先走 `read_file` 不报错。

### Phase 2 — 安全与可配置（P1）

1. `run_command` 执行前确认 UI
2. 终端相关设置项（package.json contributes.configuration）
3. `grep_code` 迁移至 ripgrep

### Phase 3 — 能力增强（P2）

1. 大文件分段读
2. 多根工作区
3. ignore 规则与列目录优化
4. 命令权限控制器
5. 命令执行后读缓存失效
6. 危险命令内置拦截增强

### 执行队列明细（RUNQUEUE.md）

自动化执行见 [RUNQUEUE.md](./RUNQUEUE.md)。当前 **16 项入队**，与上文 Phase 对应关系：

| Phase | RUNQUEUE | 标题摘要 |
|-------|----------|----------|
| P0 | P0-1 | 终端模块骨架与 Shell 路径检测 |
| P0 | P0-2 | VS Code 集成终端（含复用、CWD、快照 fallback） |
| P0 | P0-3 | 子进程 Fallback + PowerShell 安全参数 |
| P0 | P0-4 | 替换 terminalExec，去除裸 exec 硬编码 |
| P0 | P0-5 | 系统 Prompt 禁止终端探索文件 |
| P0 | P0-6 | 终端故障排查用户文档 |
| P1 | P1-1 | run_command 执行前用户确认 |
| P1 | P1-2 | 终端与命令 VS Code 设置（含默认 Profile） |
| P1 | P1-3 | grep_code 迁移 ripgrep |
| P1 | P1-4 | 命令执行结果 UI 步骤展示 |
| P2 | P2-1 | 大文件分段读取 |
| P2 | P2-2 | 列目录递归 + gitignore |
| P2 | P2-3 | 多根工作区路径解析 |
| P2 | P2-4 | 命令权限控制器（含环境变量/设置注入） |
| P2 | P2-5 | 命令执行后文件读缓存失效 |
| P2 | P2-6 | 危险命令内置拦截增强 |

### 已移出本队列（不纳入 RUNQUEUE 自动执行）

以下项在差距分析中有记录，但**暂不进入执行队列**；原因见说明列。完整表亦见 [RUNQUEUE.md#已移出本队列](./RUNQUEUE.md#已移出本队列)。

| 项 | 对应本文 | 移出原因 |
|----|----------|----------|
| MCP Hub | §4.2 | 新功能，需产品拍板与长期维护 |
| Browser 自动化 | §4.3 | 与核心代码助理场景弱相关 |
| Pre/Post ToolUse Hooks | §4.3 | 企业级扩展，复杂度高 |
| Subagent / Worktree | §4.2 / §4.3 | 架构级能力，超出 Phase 1–3 |
| Telemetry 体系 | §4.3 | 非用户反馈阻塞项，可参考埋点思路 |
| 读图片/PDF 多模态 | §3.4 / P2 | 依赖模型 vision 能力，需产品确认 |
| auto-approve 白名单 UI | §3.1 第二条 | 依赖 P1-1 确认流程，P1-1 后单独立项 |
| 长命令「Proceed While Running」 | §4.2 | 终端编排复杂，P0 完成后再立项 |
| `.aiignore` 独立规则文件 | §3.5 | 与 P2-2 gitignore 列目录重叠，可合并 |
| 文件名搜索 ripgrep+fzf | §2 总览 P2 | 增强项，非用户反馈主路径 |
| 多 Provider / 模型路由 | §4.2 | 已有基础模型配置，产品选型后单独立项 |

---

## 8. 相关源码索引

### my-ai-plugin

| 文件 | 职责 |
|------|------|
| `src/tools/terminalExec.ts` | 当前命令执行（待重构） |
| `src/tools/toolExecutor.ts` | 工具分派 |
| `src/tools/fileOps.ts` | 读写列目录 |
| `src/tools/searchTools.ts` | 搜索 |
| `src/prompts/system.ts` | 系统 Prompt / 工具说明 |
| `src/webview/fileChanges/index.ts` | 工具批执行与 UI 步骤 |

### cline-chinese（对照阅读）

| 文件 | 职责 |
|------|------|
| `src/hosts/vscode/terminal/VscodeTerminalManager.ts` | 终端创建与命令调度 |
| `src/hosts/vscode/terminal/VscodeTerminalProcess.ts` | Shell Integration 输出流 |
| `src/integrations/terminal/CommandExecutor.ts` | 统一命令执行入口 |
| `src/integrations/terminal/CommandOrchestrator.ts` | 缓冲、超时、用户交互 |
| `src/utils/shell.ts` | Shell 路径检测 |
| `src/utils/powershell.ts` | PowerShell 可执行文件探测 |
| `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts` | 命令工具 handler |
| `src/services/ripgrep/index.ts` | ripgrep 封装 |
| `docs-zh/troubleshooting/terminal-quick-fixes.md` | 终端快速修复指南 |

---

## 9. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-29 | 初版：基于用户反馈与 cline-chinese 源码对比撰写 |
| 2026-06-29 | 生成执行队列 `RUNQUEUE.md`（15 项入队） |
| 2026-06-29 | 与 RUNQUEUE 对齐：§7 补 16 项映射表与 11 项移出说明；Phase 3 补缓存失效与危险命令 |
