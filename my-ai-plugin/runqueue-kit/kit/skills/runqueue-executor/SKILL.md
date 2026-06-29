---
name: runqueue-executor
description: >-
  RUNQUEUE 自动化：从用户指定的计划/缺口 MD 生成 RUNQUEUE.md，或按 RUNQUEUE 执行队列。
  在用户说「按 RUNQUEUE 执行」「执行队列」「runqueue」「从 xxx.md 生成 RUNQUEUE」
  「生成执行队列」「bootstrap runqueue」，或 stop hook 发出【RUNQUEUE 自动续跑】时使用。
---

# RUNQUEUE 执行器

本 skill 覆盖 **两种模式**。先判断用户意图，不要混在同一步里又生成又实现。

| 模式 | 何时进入 | 产出 |
|------|----------|------|
| **A 生成** | 指定了源 MD、或目标项目尚无合格 `RUNQUEUE.md` | 新建/更新 `RUNQUEUE.md` + 可选 `.cursor/runqueue.json` |
| **B 执行** | 已有 `RUNQUEUE.md`，用户要求开跑或 Hook 续跑 | 实现 → 自动检查 → 勾选 → commit |

模板全文见同目录 [RUNQUEUE-TEMPLATE.md](./RUNQUEUE-TEMPLATE.md)。

---

## 模式 A：从源 MD 生成 RUNQUEUE

### 触发话术（示例）

- 「从 `docs/plan.md` 生成 RUNQUEUE，先不执行」
- 「按 gap_analysis 生成执行队列」
- 「这个项目没有 RUNQUEUE，帮我从 WORKPLAN 生成」

### 第一步：收集参数（能从话里推断就别问）

| 参数 | 默认 | 说明 |
|------|------|------|
| **源 MD** | 用户指定的路径 | 计划、缺口分析、WORKPLAN 等 |
| **输出路径** | 与源 MD 同目录的 `RUNQUEUE.md` | 用户可改，如 `docs/RUNQUEUE.md` |
| **scopeCwd** | 含 `backend/` 或 `package.json` 的子项目根 | 写入 `.cursor/runqueue.json` |
| **是否立即执行** | 用户说「先不跑」则只生成 | 默认生成后询问一句即可，不要自动开跑 |

### 第二步：读源 MD，提取待办

按优先级识别任务（可并存）：

1. **建议实施顺序**、编号列表（P0-1 → P1-2）
2. **表格行**：`| P1-1 | 标题 | 说明 |`
3. **标题块**：`#### P0-5：标题`、`### [P1-1]`
4. **Checkbox**：`- [ ]`（未勾选的）

**排除 / 移入「已移出本队列」**（不生成 `- [ ]`）：

- 源文档或 git 已表明**已完成**（~~删除线~~、`- [x]`、结论里写已落地）
- **必须用户拍板**才能做（架构选型、是否接第三方）
- **跨仓库 / 跨 app** 且当前 `scopeCwd` 覆盖不到（如工厂队列里的 wechat 改造）
- **无法写出自动检查**且不能通过实现时新增测试来补齐

**已完成**项可归档到 `## 已完成`（`- [x]`），便于对照。

### 第三步：为每项填写 6 块（硬性要求）

```markdown
### [<ID>] <标题>
- [ ] 状态：待做
**目标** / **范围** / **验收标准** / **自动检查** / **手动检查** / **提交信息模板**
```

**三条铁律**（与 video_genfactory 约定一致）：

1. **自动检查** = Hook 续跑唯一依据（pytest、typecheck、`python -c` 断言、单行 shell）
2. **手动检查** = UI/联调建议，**不写**「等待用户确认」
3. **验收标准** = 只写机器可判断的；人眼才能验的放进 **手动检查**

**自动检查**推断（按项目结构选，命令相对于 `scopeCwd`）：

| 项目信号 | 自动检查示例 |
|----------|----------------|
| Python + `.venv` | `cd backend && .venv\Scripts\python.exe -m pytest tests/test_xxx.py -q`（Win） |
| Node `front/` | `cd front && pnpm run typecheck` |
| 新建 API | 约定测试文件路径，如 `tests/test_<feature>.py`（本项实现时创建） |
| 文档交付 | `python -c` 断言 `docs/xxx.md` 存在且含关键词（**必须单行**） |
| 前端无 Mock | `python -c` 扫描目录不含 `Mock` 等 |

**Hook 按行执行** bash 块：`python -c` 勿换行；多命令用 `&&` 连接。

**提交信息模板**必须含 `<ID>`（如 `P1-1`），供 Hook 核对 `git log`。

### 第四步：写配置文件

若仓库尚无 `.cursor/runqueue.json`，在**仓库根**创建：

```json
{
  "enabled": true,
  "queuePath": "apps/<app>/docs/RUNQUEUE.md",
  "scopeCwd": "apps/<app>",
  "maxRetriesPerItem": 3
}
```

`queuePath` 用**相对仓库根**的路径（与 Hook 解析方式一致）。

### 第五步：生成后收尾

1. 在源 MD 顶部或结论加一句：「执行队列见 [RUNQUEUE.md](./RUNQUEUE.md)」（若尚无）
2. 向用户简要列出：入队几项、移出几项、第一项 ID
3. **除非用户明确要求**，不要在本轮创建 `runqueue.active` 或开始实现

---

## 模式 B：执行 RUNQUEUE

### 配置发现

1. `.cursor/runqueue.json`（仓库根或子目录）
2. `queuePath` → 队列 Markdown
3. `scopeCwd` → 自动检查命令的工作目录

### 启用自动化

用户要求执行时，在**仓库根**写入 `.cursor/runqueue.active`：

```json
{
  "startedAt": "<ISO8601>",
  "queuePath": "<来自 runqueue.json 的 queuePath>"
}
```

### 执行规则

- 只处理**第一个** `- [ ]`（`### [ID] 标题`）
- 实现 → 跑 **自动检查** → `- [x]` → `git commit`（消息含 ID）→ 结束本轮
- **不要**问「是否继续」；交给 stop hook
- 收到 `【RUNQUEUE 自动续跑】` 仍遵循本规则

缺少 **自动检查** 的项不得标为完成。

### 停止条件

- 用户明确停止
- 需业务决策 / 范围外授权
- 同一项自动检查连续失败 3 次（hook 关闭 active）
- 队列全部 `- [x]`

---

## 跨项目迁移（复制清单）

**一次性复制（用户级或仓库级）**：

- `~/.cursor/skills/runqueue-executor/`（本 skill，含 `RUNQUEUE-TEMPLATE.md`）
- `.cursor/hooks.json` + `.cursor/hooks/stop-runqueue.mjs`

**每个项目一份**：

- `.cursor/runqueue.json`
- `RUNQUEUE.md` ← **无此文件时，用模式 A 从用户指定 MD 生成，不要手写凑合**

**推荐落地顺序**：

```text
复制 hooks → 指定源 plan.md → 模式 A 生成 RUNQUEUE + runqueue.json → 用户确认 → 模式 B 开跑
```

---

## 参考实现

video_genfactory 范例：

- 源文档：`apps/video_genfactory/docs/pipeline_short_video_gap_analysis.md`
- 队列：`apps/video_genfactory/docs/RUNQUEUE.md`
- 配置：`.cursor/runqueue.json`
