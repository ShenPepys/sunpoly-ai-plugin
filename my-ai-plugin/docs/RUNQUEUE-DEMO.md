# RUNQUEUE 安装验证队列（演示用）

> **用途**：bootstrap 后快速验证「执行 → 勾选 → commit → stop 自动续跑」是否可用。  
> **约 1 分钟完成**。验证通过后请从自己的计划 MD 生成正式 `RUNQUEUE.md`，并改 `.cursor/runqueue.json` 的 `queuePath`。

启用方式：在 Cursor 对话中说「**按 RUNQUEUE 执行**，遵循 runqueue-executor skill」。

---

## 队列（按顺序执行，勿跳项）

### [DEMO-1] 写入安装验证标记

- [ ] 状态：待做

**目标**

在项目 `docs/` 下创建空文件 `.runqueue-install-ok`，证明自动检查与 scopeCwd 配置正确。

**范围**

- 仅创建/更新 `docs/.runqueue-install-ok`

**验收标准**

- 文件存在

**自动检查**

```bash
node -e "const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/.runqueue-install-ok',''); process.exit(fs.existsSync('docs/.runqueue-install-ok')?0:1)"
```

**手动检查**

- 无

**提交信息模板**

`chore: runqueue install demo marker (DEMO-1)`

---

### [DEMO-2] 确认快速入门文档存在

- [ ] 状态：待做

**目标**

确认 `docs/RUNQUEUE-QUICKSTART.zh-CN.md` 存在；演示队列第二项，用于观察 **DEMO-1 完成后 stop 是否触发【RUNQUEUE 自动续跑】**。

**范围**

- 文档 only（本项不应删改 QUICKSTART）

**验收标准**

- QUICKSTART 文件存在

**自动检查**

```bash
node -e "const fs=require('fs'); process.exit(fs.existsSync('docs/RUNQUEUE-QUICKSTART.zh-CN.md')?0:1)"
```

**手动检查**

- DEMO-1 提交并 stop 后，是否收到「请执行下一项 DEMO-2」类续跑消息

**提交信息模板**

`chore: runqueue install demo complete (DEMO-2)`

---

## 演示完成后

1. 删除或归档本文件（可选）
2. 编辑 `.cursor/runqueue.json`，将 `queuePath` 改为正式队列（如 `docs/RUNQUEUE.md`）
3. 对话：「从 `docs/你的计划.md` 生成 RUNQUEUE，遵循 runqueue-executor，先不执行」
