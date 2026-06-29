# my-ai-plugin 执行队列（cline 差距补齐）

> 自动化只处理本文件**第一个** `- [ ]` 项。背景见 [GAP_ANALYSIS_VS_CLINE.zh-CN.md](./GAP_ANALYSIS_VS_CLINE.zh-CN.md)。
>
> **队列约定**
> - **自动检查**：Hook 续跑唯一依据
> - **手动检查**：不阻塞自动化
> - **验收标准**：只写机器可判断的条目
>
> 启用：「**按 RUNQUEUE 执行**，遵循 runqueue-executor skill」。

---

## 已完成

### [P0-1] 终端模块骨架与 Shell 路径检测

- [x] 状态：已完成（`src/terminal/shell.ts`、`powershell.ts`、`index.ts` + `test/terminalShell.test.ts`）

### [P0-2] VS Code 集成终端执行（Shell Integration）

- [x] 状态：已完成（`vscodeTerminalManager/Process`、`getLatestTerminalOutput` + `test/vscodeTerminalProcess.test.ts`）

### [P0-3] 子进程 Fallback 与 Windows PowerShell 安全参数

- [x] 状态：已完成（`spawnTerminalProcess.ts` + `test/spawnTerminalProcess.test.ts`）

---

## 队列（按顺序执行，勿跳项）

### [P0-4] 替换 terminalExec 并保持 execCommand API 兼容

- [x] 状态：完成

**目标**

将 `src/tools/terminalExec.ts` 改为调用 `src/terminal/` 统一执行层（优先集成终端，fallback 子进程），保持 `execCommand(command, timeoutMs)` 签名不变，`toolExecutor` 无需改动调用方；移除或外提当前硬编码的 **30s 超时 / 8KB 输出截断**（先用合理默认值，完整可配置项由 P1-2 承接）。

**范围**

- 改：`src/tools/terminalExec.ts`
- 改/增：`test/terminalExec.test.ts`
- 不改：`src/tools/toolExecutor.ts` 对外签名

**验收标准**

- `terminalExec.ts` import 来自 `src/terminal/`
- `execCommand` 仍导出且测试覆盖成功/超时/危险命令拒绝
- 不再使用裸 `child_process.exec` 作为主路径
- 超时与输出上限通过常量或配置读取，非魔法数散落（`DEFAULT_TIMEOUT_MS` / `MAX_OUTPUT_CHARS` 可保留但须可被 P1-2 覆盖）
- 全量 `npm test` 通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/terminalExec.test.ts -q && npm test && node -e "const fs=require('fs'); const s=fs.readFileSync('src/tools/terminalExec.ts','utf8'); process.exit(/from ['\"].*terminal/.test(s)&&!/child_process['\"].*exec\(/.test(s.replace(/\/\/.*$/gm,''))?0:1)"
```

**手动检查**

- 用户反馈场景：Windows + conda 环境，`run_command echo test` 不再因 Profile 失败（勿用 `dir`/`ls` 测文件探索，见 P0-5）

**提交信息模板**

`feat(terminal): wire terminalExec to integrated terminal layer (P0-4)`

---

### [P0-5] 系统 Prompt 禁止用终端探索文件

- [x] 状态：完成

**目标**

更新 `src/prompts/system.ts`：探索目录、读文件必须优先 `list_dir` / `read_file` / `search_file`，禁止 `run_command` 执行 `ls`/`dir`/`Get-ChildItem` 等。

**范围**

- 改：`src/prompts/system.ts`
- 可选：补一句到 `docs/GAP_ANALYSIS_VS_CLINE.zh-CN.md` 实施记录（非必须）

**验收标准**

- `system.ts` 含明确禁止终端列目录的条文
- `npm run build` 成功

**自动检查**

```bash
npm run build && node -e "const fs=require('fs'); const s=fs.readFileSync('src/prompts/system.ts','utf8'); process.exit(/list_dir|read_file/.test(s)&&/禁止|不要|不得/.test(s)&&/run_command|ls|dir|Get-ChildItem/.test(s)?0:1)"
```

**手动检查**

- 新会话中问「列出当前目录文件」，模型应优先调用 `list_dir` 而非 `run_command`

**提交信息模板**

`docs(prompt): forbid terminal ls/dir for file exploration (P0-5)`

---

### [P0-6] 终端故障排查用户文档

- [ ] 状态：待做

**目标**

新增面向用户的终端问题自助文档，说明 Windows ExecutionPolicy、conda、默认终端 Profile 等常见现象与处理。

**范围**

- 新增：`docs/TERMINAL_TROUBLESHOOTING.zh-CN.md`
- 在 `GAP_ANALYSIS_VS_CLINE.zh-CN.md` 增加链接

**验收标准**

- 文档存在且包含 ExecutionPolicy、conda-hook、集成终端说明三类关键词

**自动检查**

```bash
node -e "const fs=require('fs'); const p='docs/TERMINAL_TROUBLESHOOTING.zh-CN.md'; const ok=fs.existsSync(p)&&/ExecutionPolicy/.test(fs.readFileSync(p,'utf8'))&&/conda/.test(fs.readFileSync(p,'utf8'))&&/集成终端|Shell Integration/.test(fs.readFileSync(p,'utf8')); process.exit(ok?0:1)"
```

**手动检查**

- 文档可读，步骤与插件实际行为一致

**提交信息模板**

`docs: add terminal troubleshooting guide (P0-6)`

---

### [P1-1] run_command 执行前用户确认

- [ ] 状态：待做

**目标**

Code 模式下执行 `run_command` 前弹出 VS Code 确认框，展示完整命令；用户拒绝则返回失败信息给模型。

**范围**

- 改：`src/webview/fileChanges/index.ts` 或专用 `commandApproval.ts`
- 改：`src/tools/toolExecutor.ts`（若确认逻辑下沉）
- 新增：`test/commandApproval.test.ts`（纯函数层）

**验收标准**

- 存在 `confirmRunCommand(command): Promise<boolean>` 或等价逻辑
- 拒绝时不调用 `execCommand`
- 相关测试通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/commandApproval.test.ts -q
```

**手动检查**

- 触发 `run_command` 时出现确认对话框，取消后聊天显示被拒绝

**提交信息模板**

`feat(tools): confirm before run_command execution (P1-1)`

---

### [P1-2] 终端与命令相关 VS Code 设置项

- [ ] 状态：待做

**目标**

在 `package.json` 增加可配置项（对齐 GAP §3.3）：**默认终端 Profile**、Shell Integration 超时、命令默认超时、长命令超时、是否复用终端、输出行数上限；并接入 P0 终端层与 `terminalExec`。

**范围**

- 改：`package.json`（`contributes.configuration`）
- 改：`src/config.ts` 读取配置
- 改：`src/terminal/`、`src/tools/terminalExec.ts` 使用配置值

**验收标准**

- `package.json` 含 `my-ai-plugin.terminal.defaultProfile`（enum：default / pwsh / cmd / bash / wsl 等）
- `package.json` 含 `my-ai-plugin.terminal.shellIntegrationTimeoutSeconds` 等键（终端相关配置 ≥4 项）
- `src/config.ts` 有对应读取函数；P0 终端层读取这些值而非仅硬编码
- `npm run build` 通过

**自动检查**

```bash
npm run build && node -e "const p=require('./package.json'); const k=Object.keys(p.contributes.configuration.properties||{}).filter(x=>x.includes('terminal')); const hasProfile=k.some(x=>x.includes('Profile')||x.includes('profile')); process.exit(k.length>=4&&hasProfile?0:1)"
```

**手动检查**

- VS Code 设置页可搜索到「终端」相关 my-ai-plugin 配置，切换 Profile 后新终端行为变化

**提交信息模板**

`feat(config): terminal execution settings (P1-2)`

---

### [P1-3] grep_code 迁移至 ripgrep

- [ ] 状态：待做

**目标**

`grep_code` 优先调用 ripgrep（bundled 或系统 `rg`），保留 JS 逐文件 fallback；性能与结果上限优于现状。

**范围**

- 新增：`src/tools/ripgrep.ts` 或 `src/tools/ripgrep/`
- 改：`src/tools/searchTools.ts`
- 改/增：`test/searchTools.test.ts`、`test/ripgrep.test.ts`

**验收标准**

- `grepCode()` 在可用 rg 时走 ripgrep 路径
- 无 rg 时 fallback 不抛未捕获异常
- 搜索相关测试通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/searchTools.test.ts test/ripgrep.test.ts -q
```

**手动检查**

- 大仓库 grep 明显快于改前

**提交信息模板**

`perf(search): grep_code via ripgrep with js fallback (P1-3)`

---

### [P1-4] 命令执行结果 UI 步骤展示

- [ ] 状态：待做

**目标**

`run_command` 在聊天步骤区展示命令与输出摘要（类似读/写文件步骤），不仅埋在模型反馈文本里。

**范围**

- 改：`src/webview/fileChanges/index.ts`
- 改：`media/chat.js` 或步骤渲染相关（若需）
- 改：`src/webview/messageTypes.ts`（若需新字段）

**验收标准**

- `run_command` 成功/失败均产生 `AddStepResponse` 且 description 含命令前缀
- `npm run build` 通过

**自动检查**

```bash
npm run build && node -e "const fs=require('fs'); const s=fs.readFileSync('src/webview/fileChanges/index.ts','utf8'); process.exit(/run_command/.test(s)&&/AddStepResponse|postMessage/.test(s)?0:1)"
```

**手动检查**

- 执行命令后侧边栏可见独立步骤卡片与输出片段

**提交信息模板**

`feat(ui): show run_command output in tool steps (P1-4)`

---

### [P2-1] 大文件分段读取（start_line / end_line）

- [ ] 状态：待做

**目标**

`read_file` 工具支持 `start_line` / `end_line` 参数，大文件按段返回并提示续读行号。

**范围**

- 改：`src/tools/toolParser.ts`、`src/tools/fileOps.ts`、`src/prompts/system.ts`
- 新增：`test/readFileRange.test.ts`

**验收标准**

- 解析器识别 `start_line`/`end_line` 属性
- `readFile` 只返回请求行范围 + 续读提示
- 测试通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/readFileRange.test.ts -q
```

**手动检查**

- 对超大文件只读前 200 行，上下文不爆 token

**提交信息模板**

`feat(tools): read_file line range support (P2-1)`

---

### [P2-2] 列目录增强（递归与 gitignore）

- [ ] 状态：待做

**目标**

`list_dir` 支持 `recursive` 参数；扫描时尊重 `.gitignore` 规则，跳过 `node_modules` 等。

**范围**

- 改：`src/tools/fileOps.ts`、`src/tools/toolParser.ts`
- 新增：`test/listDirIgnore.test.ts`

**验收标准**

- `list_dir` 带 `recursive="true"` 时深度列出（有深度/数量上限）
- `node_modules` 默认不出现
- 测试通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/listDirIgnore.test.ts -q
```

**手动检查**

- 递归列目录不卡死、不刷屏

**提交信息模板**

`feat(tools): list_dir recursive with gitignore (P2-2)`

---

### [P2-3] 多根工作区路径解析

- [ ] 状态：待做

**目标**

文件/终端/搜索工具不再写死 `workspaceFolders[0]`，按相对路径自动匹配正确的 workspace root。

**范围**

- 改：`src/tools/fileOps.ts`、`src/tools/terminalExec.ts`、`src/tools/searchTools.ts`
- 新增：`src/utils/workspaceRoot.ts`、`test/workspaceRoot.test.ts`

**验收标准**

- 存在 `resolveWorkspaceFolderForPath(relPath)` 并在三处工具使用
- 多 root 单测通过

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/workspaceRoot.test.ts -q
```

**手动检查**

- 打开 `.code-workspace` 多文件夹时，读写非主 root 文件正常

**提交信息模板**

`feat(workspace): multi-root path resolution (P2-3)`

---

### [P2-4] 命令权限控制器

- [ ] 状态：待做

**目标**

实现可配置的命令 allow/deny glob；链式命令（`&&`、`||`、`|`、`;`）逐段校验；支持通过 **VS Code 设置项或环境变量** 注入权限规则（对齐 GAP §3.7）；与 `terminalExec` 内置危险模式对接，具体模式扩展见 P2-6。

**范围**

- 新增：`src/tools/commandPermissions.ts`
- 改：`src/tools/terminalExec.ts`（调用 `validateCommand`）
- 改：`package.json` / `src/config.ts`（可选 permissions 配置键）
- 新增：`test/commandPermissions.test.ts`

**验收标准**

- `validateCommand(cmd)` 返回 `{ allowed, reason }`
- deny 列表拦截；链式命令任一段失败则整体拒绝
- 支持从设置项或环境变量（如 `MY_AI_PLUGIN_COMMAND_PERMISSIONS`）加载 `{ allow?, deny?, allowRedirects? }` JSON
- 测试覆盖 allow/deny/链式/重定向/环境变量加载

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/commandPermissions.test.ts -q
```

**手动检查**

- 设置 deny `rm` 后模型发起 `rm -rf` 被拒绝且有明确提示
- 通过环境变量注入 allow 列表后，白名单命令可通过

**提交信息模板**

`feat(security): command permission controller (P2-4)`

---

### [P2-5] 命令执行后文件读缓存失效

- [ ] 状态：待做

**目标**

`run_command` 成功后清空 `FileReadStateCache`，避免 `npm install` / `git checkout` 后编辑仍基于旧内容。

**范围**

- 改：`src/webview/fileChanges/index.ts` 或 `ChatEngine` 工具回调
- 改：`src/tools/fileReadStateCache.ts`（若需 `clear()` API）
- 新增：`test/fileReadStateCacheInvalidate.test.ts`

**验收标准**

- `run_command` 成功执行后缓存被清空
- 测试断言缓存条目数为 0

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/fileReadStateCacheInvalidate.test.ts -q
```

**手动检查**

- 命令修改文件后，下一次 `edit_file` 强制重读或提示内容已变

**提交信息模板**

`fix(cache): invalidate file read cache after run_command (P2-5)`

---

### [P2-6] 危险命令内置拦截增强

- [ ] 状态：待做

**目标**

扩展 `terminalExec` 内置 `DANGEROUS_PATTERNS`（对齐 GAP §3.8）：覆盖格式化磁盘、fork bomb、向 `/dev/` 写入等；与 P2-4 权限控制器统一入口，避免两处规则漂移。

**范围**

- 改：`src/tools/terminalExec.ts` 或抽到 `src/tools/dangerousCommands.ts`
- 改：`src/tools/commandPermissions.ts`（与内置危险列表合并或委托）
- 新增：`test/dangerousCommands.test.ts`

**验收标准**

- 拦截 `format C:`、`mkfs.`、`dd ... of=/dev/`、fork bomb 模式等（测试用例列举）
- `validateCommand` / `isDangerousCommand` 单一来源，无重复维护两套 regex
- 测试覆盖至少 5 类危险模式

**自动检查**

```bash
npm run test:build && node scripts/run-node-tests.cjs test/dangerousCommands.test.ts -q
```

**手动检查**

- 模型尝试 `format C:` 或等价危险命令时，返回明确拒绝信息且不执行

**提交信息模板**

`feat(security): extend built-in dangerous command patterns (P2-6)`

---

## 已移出本队列

| ID | 项 | 说明 |
|----|-----|------|
| — | MCP Hub | 新功能，需产品拍板与长期维护，不纳入本差距补齐队列 |
| — | Browser 自动化 | 与核心代码助理场景弱相关，低优先级 |
| — | Pre/Post ToolUse Hooks | 企业级扩展，复杂度高，单独立项 |
| — | Subagent / Worktree | 架构级能力，超出 cline 差距 Phase 1–3 范围 |
| — | Telemetry 体系 | 可参考 cline 埋点思路，非用户反馈阻塞项 |
| — | 读图片/PDF 多模态 | 依赖模型是否支持 vision，需产品确认 |
| — | auto-approve 白名单 UI | 对应 GAP §3.1 第二条；依赖 P1-1 确认流程，P1-1 完成后单独立项 |
| — | 长命令「Proceed While Running」 | 终端编排复杂度高，P0 完成后再单独立项 |
| — | `.aiignore` 独立规则文件 | 与 P2-2 gitignore 列目录重叠，可合并规划 |
| — | 文件名搜索 ripgrep+fzf | GAP §2 P2 增强，非 P1 用户反馈路径 |
| — | 多 Provider / 模型路由 | GAP §4.2 中价值；已有基础模型配置，产品选型后单独立项 |

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-29 | 从 `GAP_ANALYSIS_VS_CLINE.zh-CN.md` 生成，共 15 项入队，10 项移出 |
| 2026-06-29 | 与 GAP 对齐修订：P0-2 补终端复用/CWD/快照 fallback；P0-4 补去 exec 硬编码；P1-2 补默认 Profile；P2-4 补环境变量权限；新增 P2-6 危险命令；移出表补多 Provider |
| 2026-06-29 | P0-1 完成：终端 Shell 检测模块与单元测试 |
| 2026-06-29 | P0-2 完成：VS Code 集成终端 Shell Integration 执行器 |
| 2026-06-29 | P0-3 完成：子进程 fallback 与 PowerShell 安全参数 |
| 2026-06-29 | P0-4 完成：terminalExec 接入集成终端统一执行层 |
| 2026-06-29 | P0-5 完成：系统 Prompt 禁止终端 ls/dir 探索文件 |
