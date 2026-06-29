# RUNQUEUE 快速入门（安装后必读）

> 本文由 `runqueue-kit` bootstrap 自动生成。完整说明见 kit 内 `README.md`。

---

## 第一步：命令行自检（30 秒）

在项目根目录执行（路径按你解压 kit 的位置改）：

```bat
node path\to\runqueue-kit\verify-install.mjs --project .
```

全部显示 `✓` 即表示 **hook / 配置 / 演示队列** 文件就绪。  
若有 `✗`，按提示修复或重新执行 `bootstrap-project.cmd --project . --force`。

---

## 第二步：Reload Cursor

1. 用 Cursor 打开**项目根目录**（含 `.cursor` 文件夹的那一层）
2. `Developer` → `Reload Window`
3. （可选）`View` → `Output` → 选择 **Hooks**，便于观察续跑

---

## 第三步：跑演示队列（体验自动续跑）

当前 `.cursor/runqueue.json` 默认指向 **`docs/RUNQUEUE-DEMO.md`**（2 项，约 1 分钟）。

在 Agent 对话输入：

```text
按 RUNQUEUE 执行，遵循 runqueue-executor skill
```

**预期过程：**

| 步骤 | 你应看到 |
|------|----------|
| 1 | Agent 完成 DEMO-1 → 勾选 → commit（消息含 `DEMO-1`）→ **停止本轮** |
| 2 | stop hook 发出 **【RUNQUEUE 自动续跑】…执行 DEMO-2**（无需你手动说「继续」） |
| 3 | Agent 完成 DEMO-2 → 队列全部 `[x]` |

若 DEMO-1 完成后 **没有** 续跑：

- 确认已 Reload Window
- 确认存在 `.cursor/runqueue.active`（开跑后由 Agent 创建，gitignore 已忽略）
- Windows：确认项目级 `.cursor/hooks/stop-runqueue.mjs` 存在（bootstrap 已装）
- 查看 **Output → Hooks** 是否有报错

---

## 第四步：接入你的真实任务

演示通过后：

1. 编写或已有计划 MD，例如 `docs/plan.md`
2. 对话：

   ```text
   从 docs/plan.md 生成 RUNQUEUE，遵循 runqueue-executor，先不执行
   ```

3. Review 生成的 `docs/RUNQUEUE.md`
4. 修改 `.cursor/runqueue.json`：

   ```json
   "queuePath": "docs/RUNQUEUE.md"
   ```

5. 对话：「**按 RUNQUEUE 执行**」

---

## 常用命令

| 目的 | 命令 |
|------|------|
| 重新 bootstrap | `bootstrap-project.cmd --project . --force` |
| 安装自检 | `verify-install.mjs --project .` |
| 本机无 skill | bootstrap 时加 `--install-user-skill` |

---

## 仍移出 RUNQUEUE 的项

需产品/架构决策的不要写进队列：跨仓库改造、对外 API 鉴权选型等。见各项目 gap/plan 文档。
