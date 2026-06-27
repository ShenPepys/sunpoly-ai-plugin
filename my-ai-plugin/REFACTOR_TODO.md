# 项目改进待办清单

> 整合自 `improvement-analysis.md`（已删除）和 `workplan.md` 中未覆盖的改进项。
> 所有项按优先级排序，可独立执行。

---

## 一、d_fileChanges.ts 拆分（最高优先级）

`ChatViewProvider_d_fileChanges.ts` 已从 1572 行降至 **1052 行**（阶段 A 完成）。

### 已完成（阶段 A：TASK-1 ~ TASK-5）

- [x] `ChatViewProvider_u_undo.ts` 已创建（373 行），包含所有 Undo/Backup 类型和函数
  - 类型：`UndoAllWriteBackupsResult`、`UndoAllWriteBackupsFeedback`、`UndoSingleWriteBackupResult`、`UndoExecutionNotification`、`UndoAllWriteBackupsExecution`、`UndoSingleWriteBackupExecution`
  - 函数：`isChangeSummaryFileUndoable`、`collectWriteBackupMessageIds`、`executeUndoAllWriteBackupsWithFeedback`、`executeUndoSingleWriteBackupWithFeedback`、`executeUndoAllWriteBackupsFlow`、`executeUndoSingleWriteBackupFlow`、`undoAllWriteBackups`、`undoSingleWriteBackup`、`buildUndoAllStartLogMessage`、`buildUndoAllChangeSummaryResponse`、`buildUndoAllResultFeedback`、`buildUndoSingleChangeSummaryResponse`、`buildExpiredChangeSummaryResponse`
  - 从 `d_fileChanges.ts` 导入 `ChangeSummaryFile`、`WriteBackupEntry` 类型
  - Re-export `WriteBackupEntry`
- [x] **TASK-1**：`ChatViewProvider_w_diff.ts` 已创建（~190 行），提取 6 个 Diff 算法函数
- [x] **TASK-2**：从 `d_fileChanges.ts` 移除 Undo 代码，添加 re-export，清理 `error` import
- [x] **TASK-3**：从 `d_fileChanges.ts` 移除 Diff 代码，`calculateDiffStats` 改为从 `w_diff` 导入
- [x] **TASK-4**：6 个外部文件 import 改为直接引用 `u_undo`
- [x] **TASK-5**：`tsc --noEmit` 通过，测试 244 pass / 0 fail，`d_fileChanges.ts` 降至 **1052 行**

### 阶段 A 实际结果

| 文件 | 修改前行数 | 修改后行数 |
|------|-----------|-----------|
| `ChatViewProvider_d_fileChanges.ts` | 1572 | **1052**（含 re-export） |
| `ChatViewProvider_u_undo.ts` | — | 373 |
| `ChatViewProvider_w_diff.ts` | — | 190 |

---

## 二、ChatEngine.ts 继续瘦身

**当前**：**1198 行**（已达标，项目规范 ≤1200 行）

### TASK-6：提取运行时状态 getter/setter（已完成）

- [x] 新建 `ChatViewProvider_runtimeAccess.ts`（`SessionRuntimeManager`）
- [x] 运行时状态 Map、运行锁管理方法已迁入
- [x] `handleUserMessage` / `handleToolCalls` 委托 `ChatViewProvider_requestFlow.ts`
- [x] `regenerateResponse` 方法替换为已有的 `executeRegenerateFlow`（消除 141 行重复代码）
- [x] 清理 ~20 个未使用导入
- [x] `tsc --noEmit` + 测试 **244 pass / 0 fail**
- [x] **ChatEngine.ts 从 1328 行降至 1198 行（-9.8%），达标 ≤1200 行**

### TASK-7：提取公开 API + UI 桥接（已完成）

- [x] 新建 `ChatViewProvider_engineHostApi.ts`（`initializeEngineWebviewState`、`buildEngineHtml` 等）
- [x] 新建 `ChatViewProvider_uiTranscriptBridge.ts`（`createUiTranscriptBridge`）
- [x] `ChatEngine.ts` 公开 API 与 UI transcript 逻辑已委托上述模块
- [x] 事故恢复：`git checkout` 误还原的 2467 行单体文件已重建为模块化编排层

**剩余**：✅ ChatEngine.ts 已降至 **1198 行**，达标 ≤1200 行

---

## 三、工程卫生

### TASK-8：清理 `devCreateSecondPanel` 开发命令（已完成）

- [x] 移除 `extension.ts` 命令注册
- [x] 移除 `package.json` 中 `contributes.commands` 条目

### TASK-9：`[锁诊断]` 日志审查（已完成）

- [x] 确认 `debug()` 无级别过滤，会写入 Output 面板
- [x] 已删除 4 处 `[锁诊断]` 日志（随 TASK-8 开发命令一并清理）
- [x] 移除 `ChatEngine.ts` 中未使用的 `debug` import

---

## 四、安全性

### TASK-10：API Key 安全存储（已完成）

- [x] 添加 `SecretStorage` 支持（`setSecretStorage` + `getSecretApiKey` / `setSecretApiKey`）
- [x] `ensureApiKey()` 优先从 SecretStorage 读取，回退明文配置
- [x] 新输入 API Key 同时写入 SecretStorage + settings（降级兼容）
- [x] `migrateApiKeysToSecretStorage()` 迁移函数，激活时自动将明文 key 移入 SecretStorage
- [x] `extension.ts` 激活时注入 `context.secrets` + 触发迁移
- [x] `tsc --noEmit` + 测试 244 pass / 0 fail

---

## 五、性能

### TASK-11：文件操作改异步 API

**当前**：`fileOps.ts` 中 `readFile`/`writeFile` 使用同步 API，`undoAll/SingleWriteBackup` 也需要同步改造

**风险**：改动面广，需仔细验证并发安全

### TASK-12：`getGitStatus` 改异步（已完成）

- [x] `getGitStatus()` 改为 async，`execSync` → `exec` (Promise)
- [x] `.git/HEAD` 读取 `fs.readFileSync` → `fs.promises.readFile`
- [x] 调用链 `buildRequestSystemPrompt` / `buildChatRequestMessages` / `prepareChatRequestExecution` 全部改 async
- [x] 3 个调用方（requestFlow / requestExecution / regenerate）添加 `await`
- [x] `tsc --noEmit` + 测试 244 pass / 0 fail

---

## 六、其他改进（低优先级）

### TASK-13：`.env` 缓存过期

**当前**：`.env` 文件加载后缓存在内存中，修改后需重载 VS Code

**方案**：添加 `fs.watch` 监听或 `mtime` 检测

### TASK-14：messageTypes.ts 拆分（642 行）

**方案**：按消息方向拆分为 `webviewToExtension.ts` 和 `extensionToWebview.ts`

### TASK-15：429 自动重试（已完成）

- [x] 流式请求（`sendStreamRequest`）：429 时自动重试，最多 3 次，指数退避
- [x] 读取 `Retry-After` header，无则用 `5 * 2^n` 秒退避
- [x] 用户中断时取消重试 timer
- [x] 非流式请求（`doHttpRequest`）：同样支持 429 自动重试
- [x] `tsc --noEmit` + 测试 244 pass / 0 fail

### TASK-16：上下文窗口摘要压缩

**当前**：`trimChatHistory` 只按长度裁剪历史

**方案**：对较早的对话做 AI 摘要压缩后再裁剪

---

## 汇总

| 编号 | 任务 | 优先级 | 状态 |
|------|------|--------|------|
| TASK-1~5 | d_fileChanges.ts 拆分 | 高 | ✅ 已完成 |
| TASK-6 | ChatEngine 运行时状态提取 | 中 | ✅ 已完成（1198行） |
| TASK-7 | ChatEngine 公开 API 提取 | 中 | ✅ 已完成 |
| TASK-8 | 清理 devCreateSecondPanel | 低 | ✅ 已完成 |
| TASK-9 | 锁诊断日志审查 | 低 | ✅ 已完成 |
| TASK-10 | API Key SecretStorage | 中 | ✅ 已完成 |
| TASK-11 | 文件操作改异步 | 中 | ⏳ 待执行 |
| TASK-12 | getGitStatus 改异步 | 低 | ✅ 已完成 |
| TASK-13 | .env 缓存过期 | 低 | ⏳ 待执行 |
| TASK-14 | messageTypes.ts 拆分 | 低 | ⏳ 待执行 |
| TASK-15 | 429 自动重试 | 低 | ✅ 已完成 |
| TASK-16 | 上下文窗口摘要压缩 | 低 | ⏳ 待执行 |

---

## 七、阶段 B：拆分结构归并（TASK-1~5 完成后执行）

> **背景**：`global-coding-guidelines.md` 要求 `原文件名_a_`、`原文件名_b_` 字母序号命名，与 `refactor-guidelines.md`（按领域/职责命名）冲突，导致 `ChatViewProvider` 被拆成 21 个 `a`~`u` 碎文件，难以定位和维护。阶段 A（TASK-1~5）先完成功能提取，阶段 B 集中做结构归并。

### TASK-17：统一规则文件（已完成）

**目标**：消除两套规则的命名冲突，防止继续产生 `w_`、`x_` 字母文件。

- [x] `global-coding-guidelines.md` 已删除字母序号命名条款，改为引用 `refactor-guidelines.md`

---

### TASK-18：去掉字母前缀，改为领域命名（已完成）

**目标**：22 个 `ChatViewProvider_x_*.ts` 批量改名为领域名，不改逻辑。

- [x] 全部文件已 `git mv` / `Move-Item` 重命名
- [x] 全局 import 路径已更新
- [x] 测试文件同步重命名（`sessions`、`retryRequests`、`requestExecution`）
- [x] `tsc --noEmit` + 测试 244 pass / 0 fail

---

### TASK-19a：文件变更领域子目录（已完成）

```
webview/fileChanges/
  index.ts    ← 原 ChatViewProvider_fileChanges
  diff.ts     ← 原 ChatViewProvider_fileChangesDiff
  undo.ts     ← 原 ChatViewProvider_fileChangesUndo
```

- [x] 子目录创建，三文件迁入，内部/外部 import 已更新
- [x] 外部统一从 `./fileChanges` 导入（含 undo re-export）
- [x] `tsc --noEmit` + 测试通过

---

### TASK-19b~19d：同领域模块归并

#### 19b. 会话领域（部分完成）

- [x] `sessionAccess` 已并入 `ChatViewProvider_sessions.ts`（~677 行）
- [ ] `modelAndSession`（373 行）保持独立

#### 19c. Webview 通信领域（部分完成）

- [x] `webviewDispatch` 已并入 `ChatViewProvider_webviewMessaging.ts`（~445 行）
- [ ] `html` / `persistedUi` / `uiTranscript` 保持独立

#### 19d. 请求执行领域（部分完成）

- [x] `userMessage` + `toolCalls` 已归并为 `ChatViewProvider_requestFlow.ts`（~580 行）
- [ ] `requestExecution`（855 行）保持独立编排层

**当前**：`ChatViewProvider_*.ts` **16 个** + `fileChanges/` **3 个** = **19 个模块**（原 23 个）

---

### TASK-20：更新文档（已完成）

- [x] `workplan.md` 中旧字母文件名引用已批量更新为新路径
- [ ] `CHANGELOG.md` 结构归并记录（按需）

---

### 阶段 B 执行顺序

```
TASK-17（统一规则）
  ↓
TASK-18（去掉字母前缀改名）
  ↓
TASK-19a（fileChanges 子目录）
  ↓
TASK-19b~19d（领域归并，逐步评估）
  ↓
TASK-20（文档同步）
  ↓
编译 + 测试验证
```

### 阶段 B 预估结果

| 指标 | 阶段 A 后 | 阶段 B 后 |
|------|----------|----------|
| ChatViewProvider 碎文件数 | ~23（含 w_diff） | **19**（16 + fileChanges/3） |
| 文件命名 | `x_字母_功能` | `领域/职责` |
| ChatEngine import 行数 | ~20 行 | ~18 行 |
| 规则一致性 | 两套冲突 | 单一权威 |
