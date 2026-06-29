# 终端命令故障排查（Windows / conda / PowerShell）

> 当 AI 助手通过 `run_command` 执行终端命令失败时，可按本文自助排查。  
> 背景与架构对比见 [GAP_ANALYSIS_VS_CLINE.zh-CN.md](./GAP_ANALYSIS_VS_CLINE.zh-CN.md)。

---

## 插件如何执行命令

当前版本（P0 终端改造后）的执行顺序：

1. **优先：VS Code 集成终端 + Shell Integration**  
   命令在编辑器底部「终端」面板中运行，复用你已打开的 shell 会话（PATH、conda、nvm 等通常已初始化）。

2. **Fallback：安全子进程**  
   若 Shell Integration 不可用，插件会 spawn 子进程。Windows PowerShell 使用  
   `-NoProfile -NonInteractive -ExecutionPolicy Bypass`，**不会**加载用户 Profile（含 `conda-hook.ps1`）。

3. **探索文件请用专用工具**  
   列出目录请用 `list_dir`，读文件请用 `read_file`，不要用 `run_command` 跑 `ls` / `dir` / `Get-ChildItem`。

---

## 现象 1：`PSSecurityException` / ExecutionPolicy 禁止运行脚本

### 典型报错

```text
无法加载文件 ...\conda-hook.ps1，因为在此系统上禁止运行脚本
PSSecurityException
```

### 原因

- 旧版本或外部工具在**独立子进程**里启动 PowerShell 并加载用户 Profile。
- 系统 `ExecutionPolicy` 为 `Restricted` 时，Profile 中的 `.ps1` 脚本（含 conda 初始化）无法执行。

### 处理建议

**A. 升级插件到含 P0 终端改造的版本**（集成终端优先 + spawn 时 `-ExecutionPolicy Bypass`）。

**B. 放宽当前用户脚本策略**（需自行评估安全策略）：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**C. 更换 VS Code 默认终端**（减少 PowerShell Profile 依赖）：

1. 打开 VS Code 设置，搜索 `terminal.integrated.defaultProfile.windows`
2. 改为 `Command Prompt`、`Git Bash` 或已配置好的 `PowerShell` Profile

---

## 现象 2：`conda` 无法识别

### 典型报错

```text
conda : 无法将“conda”项识别为 cmdlet、函数、脚本文件或可运行程序的名称
```

### 原因

- 命令在**未初始化 conda 的环境**中执行（子进程未跑 `conda init` 后的 hook）。
- Profile 加载失败（见上文 ExecutionPolicy）导致 conda 未注入 PATH。

### 处理建议

1. **先在 VS Code 集成终端手动验证**  
   打开终端（`` Ctrl+` ``），执行 `conda --version`。若此处也失败，需先在本机正确安装并 `conda init powershell`（或对应 shell）。

2. **确保集成终端可用**  
   插件优先使用集成终端；若底部终端里 conda 正常而 `run_command` 仍失败，查看是否触发了 spawn fallback（见下文「Shell Integration」）。

3. **临时指定 conda 完整路径**（不推荐长期使用）  
   例如：`C:\Users\<你>\miniconda3\Scripts\conda.exe activate myenv`

---

## 现象 3：集成终端 / Shell Integration 相关

### 插件行为

- 创建或复用工作区对应 CWD 的集成终端实例。
- 通过 **Shell Integration** API 采集命令输出与退出码。
- 若 Shell Integration 在超时内未就绪，会尝试读取终端快照，再 fallback 到子进程。

### 若输出为空或命令「像没执行」

1. 确认 VS Code 版本较新（Shell Integration 需较新版本支持）。
2. 在设置中确认未禁用 `terminal.integrated.shellIntegration.enabled`。
3. 观察底部终端面板：命令是否实际出现；若终端被关闭或异常，可重启 VS Code 再试。
4. 简单探测：`run_command` 执行 `echo plugin-terminal-test`，应在终端看到输出。

### 默认限制

- 单次命令默认超时 **30 秒**（后续版本可在设置中调整）。
- 返回给模型的输出默认最多 **8192 字符**，超出会截断。

---

## 现象 4：命令超时或输出被截断

| 情况 | 说明 |
|------|------|
| `命令执行超时（30000ms）` | 命令运行超过默认 30s；长任务可拆分步骤或稍后通过设置调大超时（P1-2 规划） |
| `[输出已截断...]` | 输出超过 8KB；可对命令加过滤，如 `npm test 2>&1 \| Select-Object -First 50` |

---

## 推荐 VS Code 设置（Windows）

```json
{
  "terminal.integrated.defaultProfile.windows": "PowerShell",
  "terminal.integrated.shellIntegration.enabled": true
}
```

若 conda 仅在特定 Profile 下可用，请将该 Profile 设为默认，并保证在**手动打开的集成终端**中能正常使用 conda。

---

## 仍无法解决？

请收集以下信息反馈：

1. 操作系统与 VS Code 版本  
2. 默认终端 Profile（`terminal.integrated.defaultProfile.windows`）  
3. `Get-ExecutionPolicy -List` 输出（PowerShell）  
4. 集成终端中 `conda --version` 是否成功  
5. `run_command` 的完整命令与返回错误原文  

相关实现代码：`src/terminal/`、`src/tools/terminalExec.ts`。
