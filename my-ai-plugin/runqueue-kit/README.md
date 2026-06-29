# RUNQUEUE Kit

跨平台分发包：把 **RUNQUEUE 自动化**（Skill + Stop Hook）装到本机 Cursor，**不含任何业务代码**。

适合：不同仓库、不同同事，无法共享业务源码，只需同一套「按计划 MD 生成队列 → 自动执行」能力。

---

## 一键在新项目启用（推荐）

只需拷贝本文件夹，在**目标仓库**执行一条命令即可完成：**项目 hook + runqueue.json + gitignore**（自动续跑所需项）。

```bash
node /path/to/runqueue-kit/bootstrap-project.mjs --project /path/to/other-repo
```

Windows 也可双击或：

```bat
bootstrap-project.cmd --project D:\work\my-other-app
```

**本机 Cursor 里还没有 `runqueue-executor` skill 时**，加 `--install-user-skill`：

```bash
node bootstrap-project.mjs --project /path/to/other-repo --install-user-skill
```

Monorepo 手动指定路径：

```bash
node bootstrap-project.mjs --project . --scope-cwd apps/my-app --queue-path apps/my-app/docs/RUNQUEUE.md
```

完成后 **Reload Window**：

1. 命令行自检：`verify-install.cmd --project .`（bootstrap 结束时会自动跑一遍）
2. 阅读项目内 **`docs/RUNQUEUE-QUICKSTART.zh-CN.md`**
3. 对话跑演示：「**按 RUNQUEUE 执行**，遵循 runqueue-executor skill」（约 1 分钟，可体验自动续跑）
4. 演示通过后：从计划 MD 生成正式 RUNQUEUE，并把 `runqueue.json` 的 `queuePath` 改回 `docs/RUNQUEUE.md`

不需要演示文件时：`bootstrap-project.cmd --project . --no-demo`

脚本**不会**自动生成正式 `RUNQUEUE.md`（由对话从计划 MD 生成）；**不会**写入 `runqueue.active`（开跑时由 Agent 写入）。

---

## 安装自检

```bat
verify-install.cmd --project D:\path\to\your-repo
```

全部 `✓` 表示 hook、配置、演示队列就绪；任一项 `✗` 则按提示重跑 bootstrap（可加 `--force`）。

---

## 前提

- 已安装 [Cursor](https://cursor.com/)
- 已安装 **Node.js**（`node -v` 有输出即可）

---

## 安装（Windows / Linux / macOS 相同）

```bash
node install.mjs
```

在当前项目写入配置范例：

```bash
node install.mjs --project .
```

只在当前仓库装 hook（不用用户级）：

```bash
node install.mjs --no-user --project . --project-hooks
```

覆盖已安装文件：

```bash
node install.mjs --force
```

---

## 安装后

**用户级（默认）**

| 位置 | 内容 |
|------|------|
| `~/.cursor/skills/runqueue-executor/` | Skill |
| `~/.cursor/hooks/stop-runqueue.mjs` | 自动续跑脚本 |
| `~/.cursor/hooks/stop-runqueue.cmd` | Windows 启动器 |
| `~/.cursor/hooks.json` | stop hook 注册 |

**`--project` 时 additionally**（默认会装，推荐）

| 位置 | 内容 |
|------|------|
| `<项目>/.cursor/runqueue.json` | 配置范例（需改 queuePath、scopeCwd） |
| `<项目>/.cursor/hooks.json` | **项目级 stop hook**（Windows 上更可靠） |
| `<项目>/.cursor/hooks/stop-runqueue.*` | 续跑脚本 |

> **Windows 注意**：`--project` 务必执行（会写项目 hook）。仅用户级 hook 时，Cursor 可能读不到 stdout，续跑会静默失败。装完后打开 **View → Output → Hooks** 看是否有 `followup_message`。

---

## 使用

1. `Developer: Reload Window`
2. 改 `.cursor/runqueue.json`（按需）
3. 「从 docs/计划.md 生成 RUNQUEUE，遵循 runqueue-executor，先不执行」
4. Review 后：「按 RUNQUEUE 执行」

---

## 分发给同事（如张三）

1. 只打包 `runqueue-kit` 文件夹（zip / 网盘），**不要**附带业务仓库
2. 对方解压后执行：`node install.mjs`（装到 `~/.cursor/`，本机通用）
3. 进入**自己的项目根**，再执行：`node install.mjs --no-user --project .`（写入 `runqueue.json` + **项目 hook**）
4. 编辑 `runqueue.json` 的 `queuePath`、`scopeCwd`（monorepo 示例见 skill 第四节）
5. 用模式 A 从自己的计划 MD 生成 `RUNQUEUE.md`，Review 后开跑

`kit/hooks.user.json`、`kit/hooks.project.json` 仅为参考快照；安装器会**合并**进已有 `hooks.json`，不会整文件覆盖。

更新 kit：`node install.mjs --force` 后重载 Cursor。
