# AI 插件问题分析与修复计划

## 背景

当前插件已经具备以下新能力：

- Windsurf 风格步骤展示
- 文件 Diff 与变更汇总
- `View all changes` 在 IDE 中打开文件
- `↺` 重新生成按钮
- 自动注入项目背景（`README.md` / `package.json`）

在实际测试中，暴露出若干与产品稳定性、上下文控制、交互一致性有关的问题。为避免继续叠加复杂度，本计划将优先修复高风险问题，再处理体验一致性问题。

---

## 已确认的问题分析

### P0：高优先级问题

#### 1. tool_call 检测与解析不一致，可能导致界面持续转圈

现象：

- AI 回复中只要包含 `<tool_call>` 字样，就会进入工具续轮流程
- 但如果 XML 不完整、标签损坏或解析失败，`parseToolCalls()` 可能返回空数组
- 当前实现中，进入工具流程后 UI 已经切到 loading 状态，但解析失败时没有完整收尾逻辑

风险：

- 前端一直显示正在生成
- 用户误以为插件卡死
- 对产品稳定性伤害很大

修复方向：

- 让 `hasToolCalls()` 与 `parseToolCalls()` 的判定逻辑更一致
- 即使解析失败，也必须有明确的收尾逻辑：关闭 loading、恢复状态、输出可理解提示

#### 2. `@` 引用文件内容没有大小控制，容易把上下文撑爆

现象：

- `buildContextContent()` 会直接读取 `@` 文件的完整内容
- 没有文件大小限制、字符数限制，也没有文本类型校验

风险：

- 大文件直接导致上下文暴涨
- 与工具系统 `readFile()` 的 512KB 限制不一致
- 易造成首包极慢、长时间转圈、费用上升

修复方向：

- 增加 `@` 文件大小与字符数控制
- 对超限内容改为截断或摘要式注入
- 至少保证不会把超大文件全文直接塞进用户消息

#### 3. `read_file` 工具结果会把全文再次注入下一轮上下文

现象：

- 工具执行后的 `result.content` 会被 `formatToolResults()` 原样写回 `toolFeedback`
- 若工具读取的是大文件，则文件内容会再次进入续轮请求

风险：

- 文件内容重复注入
- 历史越长越肥
- 造成 token 激增与响应变慢

修复方向：

- 对工具结果做长度控制
- 对 `read_file` 的反馈优先保留摘要、片段、统计信息，而不是完整全文

#### 4. 上下文预算只裁剪历史，不裁剪整轮真实负载

现象：

- `trimChatHistory()` 只按历史消息长度做粗略估算
- 未把 system prompt、项目背景、当前 `@` 文件、选中代码、工具反馈等纳入预算

风险：

- 看起来已经 trim，但真实请求仍然过大
- 预算模型失真，难以稳定控制 token

修复方向：

- 先通过局部控制（`@` 文件、工具结果）降低爆炸风险
- 后续再补统一预算模型

---

### P1：中优先级问题

#### 5. `regenerate` 链路与普通发送链路不一致

现象：

- 普通发送时，如果 AI 回复包含 tool_call，会继续执行工具链
- 当前重新生成路径没有完全复用同样的处理流程

风险：

- `↺` 与正常发送行为不一致
- 影响用户理解与可预测性

修复方向：

- 尽量复用同一套流式完成与工具调用处理逻辑

#### 6. `View all changes` 当前语义偏向“打开文件”，不是“查看变更”

现象：

- 当前为了稳定性，修改文件也直接 `showTextDocument`
- 用户点的是 `View all changes`，但未必真的看到了“变更”本身

风险：

- 产品语义略有偏差

修复方向：

- 短期先保稳定
- 后续在稳定前提下恢复更稳妥的 diff 打开策略

---

## 修复顺序

### 第一阶段：先修稳定性（P0）

1. 修复 tool_call 解析失败时的 loading 残留问题
2. 给 `@` 文件注入增加大小/字符限制
3. 给工具结果回传增加长度控制，先止住 token 暴涨

### 第二阶段：修一致性（P1）

4. 统一 `regenerate` 与普通发送链路
5. 复查 `View all changes`、最终 summary、会话切换等边界行为

---

## 实施原则

- 每次只修一类问题，避免一次性大改引入新的风险
- 每完成一项都进行构建验证
- 优先保障：可用性 > 稳定性 > 体验增强
- 在没有完成 P0 前，不继续叠加复杂功能

---

## 当前执行状态

- [x] 完成问题分析
- [x] 修复 tool_call 解析失败导致的持续转圈
- [x] 修复 `@` 文件注入导致的上下文爆炸
- [x] 修复 `read_file` 工具反馈导致的上下文重复注入
- [x] 统一 regenerate 链路
- [x] 复查 View all changes / summary / 会话切换边界行为

---

# 会话系统交互重构计划（Windsurf 风格）

## 背景

当前插件已经支持基础的多会话能力：

- 顶部固定 Tab 切换会话
- 新建、删除、重命名会话
- 会话历史持久化恢复

但现有交互与目标产品体验仍有明显差异：

- 顶部固定 Tab 在进入对话后持续占用空间，界面不够聚焦
- `新建对话` 命令当前语义更接近“清空当前会话”，容易误导用户
- 会话入口缺少类似 Windsurf 的“启动态历史列表”体验
- 删除会话缺少更温和的行内二次确认交互

本阶段目标是在不影响现有核心 AI 能力的前提下，将会话入口改造成 Windsurf 风格，并为后续“多会话并发执行”预留清晰的架构边界。

---

## 第一阶段目标

### 1. 引入启动态历史会话列表

在“新建对话”场景下，输入框上方显示历史会话列表，用于：

- 继续之前的会话
- 或直接输入，自动开始一个新的会话

### 2. 避免打断当前工作流

用户重新打开插件时：

- 若当前已经处于某个会话中，则继续显示当前会话
- 不强制跳回历史会话列表

### 3. 新建对话语义改正

`新建对话` 的行为调整为：

- 进入启动态历史会话列表
- 不再直接清空当前会话内容

### 4. 会话标题自动命名

第一阶段采用轻量方案：

- 以首条用户消息为基础自动截断生成标题
- 不额外发起 AI 请求生成标题

### 5. 删除会话交互升级

历史列表项 hover 时显示：

- `继续`
- `删除`

删除采用：

- 行内二次确认
- 不使用弹窗确认

### 6. 历史会话按活跃时间排序

- 增加或维护 `updatedAt`
- 历史列表按 `updatedAt` 倒序展示
- 展示相对时间，如 `now`、`5h`

### 7. 删除当前活跃会话后的落点

若删除当前正在查看的会话：

- 回到启动态历史会话列表
- 不自动跳转到其他会话，避免造成理解混乱

### 8. 清空对话能力继续保留

语义拆分为：

- `新建对话`：进入启动态
- `清空对话`：清空当前会话内容

---

## 第一阶段明确规则

### 进入插件面板时

- 如果已有当前活跃会话，则继续显示当前会话内容
- 不主动展示历史会话列表

### 点击“新建对话”时

- 进入启动态
- 显示历史会话列表
- 当前会话内容不被直接清空

### 在启动态直接发送消息时

- 自动创建一个新会话
- 使用首条用户消息自动命名
- 发送成功后隐藏历史会话列表，进入正常聊天态

### 点击历史会话项的“继续”时

- 恢复该会话历史内容
- 隐藏历史会话列表
- 进入该会话的正常聊天态

### 历史会话项 hover 时

- 显示 `继续`
- 显示 `删除`
- 不显示 `编辑`

### 点击“删除”时

- 当前行切换到删除确认状态
- 用户再次确认后才真正删除
- 取消则恢复普通 hover 状态

### 当前存在进行中的生成任务时

第一阶段不支持多会话并发执行，因此：

- 若当前会话仍在生成或工具执行中，不允许切到启动态后再启动另一个会话执行
- 应提示用户先停止当前生成，或等待当前任务完成

---

## 第一阶段影响范围

### `src/webview/ChatViewProvider.ts`

- 增加“启动态 / 会话态”状态控制
- 调整会话创建、切换、删除、恢复逻辑
- 调整 `newChat` 相关语义
- 增加 `updatedAt` 的维护与下发
- 调整删除当前会话后的回退逻辑

### `media/chat.js`

- 将固定 Tab 渲染改造成启动态历史列表渲染
- 增加启动态与正常聊天态的显示切换
- 增加 hover 操作按钮与行内删除确认交互
- 增加继续会话与直接输入开新会话的前端逻辑

### `media/chat.css`

- 增加 Windsurf 风格历史列表样式
- 增加 hover 操作区样式
- 增加删除确认态样式
- 清理或收敛旧固定 Tab 相关样式

### `src/webview/messageTypes.ts`

- 根据前后端交互需要补充或调整消息结构
- 明确历史列表、启动态切换、删除确认所需的数据类型

### `src/extension.ts`

- 调整 `my-ai-plugin.newChat` 命令语义
- 确保与 `focusChat`、`clearChat` 的职责边界清晰

### `package.json`

- 如有必要，校对命令标题与描述，确保“新建对话”不再被误解为“清空对话”

---

## 第一阶段数据结构调整建议

当前 `ChatSession` 至少需要具备：

- `id`
- `name`
- `createdAt`
- `updatedAt`
- `history`

其中：

- `name`：由首条用户消息自动截断生成
- `updatedAt`：在发送消息、收到回复、继续会话后按需要更新

需要兼容旧数据：

- 若旧会话缺少 `updatedAt`，需在加载时回填默认值
- 保证旧版本持久化数据可平滑迁移

---

## 第一阶段回归验证清单

### 基础路径

- 首次安装或无历史会话时，界面是否正常
- 已有历史会话时，重新打开插件是否继续显示当前会话
- 点击“新建对话”后是否进入启动态历史列表
- 在启动态直接输入是否自动创建新会话
- 新会话标题是否按首条消息自动生成

### 会话继续与删除

- 点击历史会话“继续”是否正确恢复历史消息
- hover 是否只显示 `继续` 和 `删除`
- 删除是否走行内二次确认
- 删除取消后是否正确恢复普通状态
- 删除非当前会话是否不影响当前会话展示
- 删除当前会话后是否回到启动态历史列表

### 持久化与排序

- 会话是否按 `updatedAt` 正确排序
- 相对时间展示是否正确
- 重启 VS Code 后会话列表、排序、当前活跃状态是否正确恢复
- 旧版本会话数据迁移后是否正常

### 与现有能力的兼容

- `清空对话` 是否仍只清空当前会话内容
- `新建对话` 是否不再误清空当前会话
- 工具调用、Diff 展示、会话切换、重新生成是否不受影响
- 生成中尝试切换启动态或启动其他会话时，是否给出正确提示

---

## 第二阶段预留：多会话并发执行

> ⏸ **状态：待开发者确认后再进行研发改动**

第一阶段暂不实现多会话并发执行，但必须在设计上预留扩展空间。

第二阶段目标：

- 支持多个会话同时进行流式生成
- 支持多个会话独立进行工具调用链
- 支持多个会话独立维护待确认变更状态
- 支持在历史列表中展示后台运行状态

第二阶段需要重点处理：

### 1. 会话级运行时状态隔离

将以下状态从全局单例迁移为按会话维护：

- `activeRunId`
- `abortStream`
- `toolCallsInProgress`
- `toolCallRound`
- `pendingConfirms`
- `pendingBatchConfirms`

### 2. 后台状态展示

在历史会话列表中展示会话状态，例如：

- 生成中
- 待确认变更
- 已完成
- 失败

### 3. 文件变更冲突控制

需要处理两个会话可能同时修改同一文件的场景，明确：

- 是否允许并发写同一文件
- 是否提示冲突
- 是否阻止后发请求覆盖前一个会话结果

### 4. 工具确认与交互隔离

避免不同会话之间的接受/拒绝操作串扰，确保确认按钮只作用于所属会话。

---

## 当前执行状态

- [x] 完成会话交互目标讨论并确认第一阶段规则
- [x] 明确自动命名、排序、删除落点、清空对话语义
- [x] 明确第一阶段暂不支持多会话并发执行
- [x] 记录第二阶段“多会话并发执行”需求
- [x] 完成第一阶段代码改造
- [x] 完成第一阶段构建验证（`npm run build`）
- [x] 完成第一阶段类型检查（`npx tsc --noEmit`）
- [x] 开始下一阶段交互增强改造

---

# 下一阶段交互增强计划（清单版）

## 标记说明

- [x] 已完成 / 已确认
- [ ] 未开始 / 待实现

## 总览清单

- [x] 第一阶段会话系统改造已完成
- [x] 第一阶段构建验证已完成
- [x] 第一阶段类型检查已完成
- [x] 已确认下一阶段的 3 个改造方向
- [x] 开始第一子阶段：文件改动聚合展示升级
- [x] 开始第二子阶段：模型 `contextWindow` 与上下文占用展示
- [x] 开始第三子阶段：折叠过程展示

## 执行顺序清单

- [x] 优先级 1：文件改动聚合展示
- [x] 优先级 2：上下文占用展示
- [x] 优先级 3：折叠过程展示

---

## 第一子阶段：文件改动聚合展示升级

### 目标清单

- [x] 将本轮修改文件集中展示在一个汇总面板中
- [x] 支持 `Accept all` / `Reject all`
- [x] 每行文件支持单独接受 / 拒绝
- [x] 每行文件支持点击后在 IDE 中打开

### 交互语义清单

- [x] 汇总区展示的是“预览后的待确认改动”
- [x] `Accept all` 表示确认写入当前汇总中的全部文件
- [x] `Reject all` 表示拒绝写入当前汇总中的全部文件
- [x] 行级 `✓ / X` 仅作用于当前文件，不影响其他文件
- [x] 单击文件行优先执行“在 IDE 中打开文件 / Diff”，不直接改变确认状态

### 实现清单

- [x] 扩展汇总数据结构，支持文件级操作状态与唯一标识
- [x] 将当前“整批确认”的后端链路拆分为“批量 + 单文件”两级确认能力
- [x] 前端汇总区增加文件列表行、状态展示、hover 操作和批量操作区
- [x] 明确文件被单独接受 / 拒绝后，汇总状态如何更新

### 涉及文件清单

- [x] `src/webview/ChatViewProvider.ts`：调整批量变更确认的数据结构与状态流转
- [x] `src/webview/ChatViewProvider.ts`：支持汇总级与单文件级接受 / 拒绝消息
- [x] `src/webview/ChatViewProvider.ts`：统一“打开文件”“批量接受”“单文件接受”的处理逻辑
- [x] `src/webview/messageTypes.ts`：扩展 `showChangeSummary` 的文件项结构
- [x] `src/webview/messageTypes.ts`：增加单文件级确认与状态更新消息类型
- [x] `media/chat_b_steps.js`：重构 change summary 渲染
- [x] `media/chat_b_steps.js`：增加文件行点击打开、单文件 `✓ / X`、批量确认状态更新
- [x] `media/chat.css`：为聚合文件列表、行级按钮、状态反馈补充样式

### 回归验证清单

- [x] 多文件改动是否始终聚合到同一个汇总区
- [x] `Accept all` / `Reject all` 是否只作用于当前汇总
- [x] 行级 `✓ / X` 是否只作用于当前文件
- [x] 单击文件行是否正确在 IDE 中打开
- [x] 部分接受、部分拒绝后的汇总状态是否正确
- [x] 与现有 Diff 预览、步骤流、最终 summary 是否不冲突

---

## 第二子阶段：模型 `contextWindow` 与上下文占用展示

### 目标清单

- [x] 为每个模型配置 `contextWindow`
- [x] 前端展示已使用上下文
- [x] 前端展示上下文上限
- [x] 前端展示使用百分比
- [x] 前端展示阈值颜色提醒

### 展示规则清单

- [x] 展示值属于估算值，文案应避免伪装成绝对精确
- [x] 前端可以显示“约 `201K / 272K`”这类形式
- [x] 使用率按阈值着色
- [x] 60% 以下：正常
- [x] 60% ~ 80%：提醒
- [x] 80% 以上：警告
- [x] 不伪造模型供应商侧的 `prompt cache expired` 这类状态提示，除非后端真实可得

### 实现清单

- [x] 在模型配置层增加 `contextWindow`
- [x] 统一默认模型与用户自定义模型的兼容逻辑
- [x] 后端根据当前活跃会话历史估算使用量并推送结构化数据
- [x] 前端将现有 token 展示升级为“已使用 / 上限 / 百分比 / 颜色阈值”展示

### 涉及文件清单

- [x] `src/config.ts`：为 `ModelProfile` 与 `getModelConfig()` 增加 `contextWindow`
- [x] `src/config.ts`：为默认模型补充合理的默认上下文窗口配置
- [x] `src/webview/ChatViewProvider.ts`：调整 `pushTokenCount()`，改为推送更完整的上下文占用结构
- [x] `src/webview/messageTypes.ts`：扩展 `updateTokenCount` 响应结构
- [x] `media/chat.js`：渲染“已使用 / 上限 / 百分比”与 hover 提示
- [x] `media/chat.css`：补充不同使用率阈值下的颜色样式

### 回归验证清单

- [x] 默认模型是否带有正确的 `contextWindow`
- [x] 用户自定义模型未配置 `contextWindow` 时是否有合理兜底
- [x] 会话越长，使用率是否同步增长
- [x] 切换模型后展示是否立即更新
- [x] 不同阈值颜色是否正确变化

---

## 第三子阶段：折叠过程展示

### 目标清单

- [x] 基于现有 `Thinking`、步骤流、工具执行状态整理为可折叠的过程展示区
- [x] 让用户知道当前正在执行什么
- [x] 让用户在需要时可展开查看
- [x] 让用户在不需要时可折叠减少视觉噪音

### 设计原则清单

- [x] 学习 Windsurf 的“折叠过程容器”形式
- [x] 不直接照搬完整原始 thinking 文本
- [x] 优先展示结构化过程信息，而不是模型原始自言自语

### 建议交互清单

- [x] 生成中显示 `Thinking` 或 `执行过程` 折叠标题
- [x] 展开后展示当前阶段、已完成步骤、耗时等结构化信息
- [x] 生成完成后默认收拢为摘要态，用户仍可手动展开回看

### 实现清单

- [x] 将现有 `Thinking` / `steps` / `summary` 的展示关系重新编排
- [x] 为消息气泡增加过程容器层级，而不是把所有过程信息散落在正文中
- [x] 支持折叠状态切换与完成后的摘要态展示

### 涉及文件清单

- [x] `src/webview/ChatViewProvider.ts`：统一发送“过程开始 / 更新 / 完成”消息
- [x] `src/webview/ChatViewProvider.ts`：复用现有步骤数据，避免重复构造另一套流程数据
- [x] `src/webview/messageTypes.ts`：根据前端需要扩展折叠过程展示消息
- [x] `media/chat_b_steps.js`：将步骤流渲染为可折叠的过程区
- [x] `media/chat_b_steps.js`：增加摘要态与展开态切换
- [x] `media/chat.js`：协调消息气泡、过程区、正文区的插入顺序
- [x] `media/chat.css`：补充折叠容器、摘要态、展开态样式

### 回归验证清单

- [x] 生成中是否能清楚看到当前过程状态
- [x] 折叠 / 展开是否稳定
- [x] 完成后默认展开（实时）/ 折叠（历史），用户可手动切换
- [x] 工具调用很多时是否仍保持可读性
- [x] 不展示完整原始 thinking 文本时，用户是否仍能理解执行过程

---

## 阶段性执行清单

- [x] 第一子阶段完成后执行构建验证
- [x] 第一子阶段完成后执行类型检查
- [x] 第一子阶段完成后执行人工回归验证
- [x] 第二子阶段完成后执行构建验证
- [x] 第二子阶段完成后执行类型检查
- [x] 第二子阶段完成后执行人工回归验证
- [x] 第三子阶段完成后执行构建验证
- [x] 第三子阶段完成后执行类型检查
- [x] 第三子阶段完成后执行人工回归验证

---

## 当前执行状态

- [x] 完成下一阶段交互增强方向确认
- [x] 输出下一阶段 workplan
- [x] 开始第一子阶段：文件改动聚合展示升级
- [x] 完成第二子阶段：模型 `contextWindow` 与上下文占用展示
- [x] 历史会话恢复采用方案 B：最终结果 + 可折叠过程摘要
- [x] 继续第三子阶段：统一生成中与完成态的折叠过程展示
- [x] 完成第三子阶段静态检查（`npx tsc --noEmit`、`node --check media/chat.js`、`node --check media/chat_b_steps.js`）
- [x] 进入第三子阶段最后一轮验证（构建验证 + 人工回归）
- [x] 修复 Ask/Code 模式切换链路（模式快照 + 历史污染注入提醒）
- [x] 实时完成后执行过程默认展开

---

## 下一轮修复：历史聊天恢复一致性增强

### 目标

让历史会话在重新打开或切换进入时，尽量与用户离开前在会话窗口中看到的内容保持一致。

### 当前实现 vs 下一轮目标

| 维度 | 当前实现 | 下一轮目标 |
|------|------|------|
| 用户 / AI 最终消息 | 已通过 `displayHistory` 恢复 | 保持不变，继续作为稳定兜底 |
| 过程摘要 | 已恢复 `processSummary`，历史默认折叠 | 保持不变，并与更完整的 UI 恢复兼容 |
| 步骤流 / 错误 / diff / 变更汇总 | 主链路未统一恢复，旧 `uiTranscript` 逻辑未接回 `ChatEngine` | 会话级恢复用户实际看过的主要过程元素 |
| 历史恢复优先级 | `displayHistory` → `history` 回填 | `uiTranscript` → `displayHistory` → `history` 回填 |
| 一致性目标 | 恢复“最终结果 + 摘要” | 恢复“用户实际看过的主要界面元素”，但不强求流式瞬时动画完全重放 |

### 范围约束

- [x] 保留现有方案 B：`displayHistory` 仍是旧会话兼容与导出兜底
- [x] 本轮优先恢复用户可见且有业务价值的 UI 元素，不追求滚动位置、光标闪烁、瞬时 loading 动画的 1:1 还原
- [x] 不破坏当前多 Tab、会话切换、导出、重新生成与折叠过程展示逻辑

### 实现清单

- [x] 盘点并收口当前会话需要持久化的 UI 元素：消息正文、错误消息、步骤流、diff、变更汇总、过程完成态
- [x] 评估并复用旧 `uiTranscript` 结构，避免重新发明第二套临时协议
- [x] 在 `ChatEngine` 主链路重新接入会话级 `uiTranscript` 持久化写入
- [x] 初始化聊天面板与切换历史会话时，优先按 `uiTranscript` 恢复界面
- [x] 为历史恢复后的过程区、diff 区、变更汇总区补齐只读态，避免误触发当前会话操作
- [x] 明确 `uiTranscript` 缺失或不完整时的回退链：`uiTranscript` → `displayHistory` → `history`

### 涉及文件清单

- [x] `src/webview/ChatEngine.ts`：补齐 `uiTranscript` 读写、恢复优先级与会话切换恢复链路
- [x] `src/webview/messageTypes.ts`：复核并补齐 `PersistedUiEntry` / `PersistedUiEvent` 所需字段
- [x] `src/webview/SessionStore.ts`：确认 `uiTranscript` 随会话正常加载、共享与持久化
- [x] `media/chat.js`：确认历史恢复消息的只读态与消息渲染顺序稳定
- [x] `media/chat_b_steps.js`：确认历史步骤流、过程摘要、变更汇总恢复后的折叠态与只读交互稳定
- [x] `workplan.md`：按批次更新完成状态与回归结果

### 分批执行建议

- [x] 第一批：先恢复 `uiTranscript` 主链路接入与初始化 / 切换会话恢复优先级
- [x] 第二批：补齐步骤流、错误、diff、变更汇总等历史只读恢复
- [ ] 第三批：人工回归并收口边界情况（旧会话、重生成后会话、切换会话、删除会话、清空会话）

### 本轮补充修复进展（2026-04-15）

- [x] `src/webview/SessionStore.ts`：增加共享运行锁与串行持久化队列，修复多 Tab 运行态串扰和 `globalState` 高并发写入竞争
- [x] `src/webview/ChatEngine.ts`：接入共享运行锁，补齐清空/删除/切换会话与 `regenerate` 的跨 Tab 运行保护，并修复流式启动异常后的运行态残留
 - [x] `src/webview/ChatTabManager.ts`：命令路由优先回到最近聚焦的聊天 Tab，避免误落到旧 Tab
 
 - [x] `src/api/client.ts`：保留 `apiPath` 中的 query 参数，覆盖流式与非流式请求链路
 - [x] `src/config.ts`、`src/webview/ChatViewProvider_l_webviewDispatch.ts`：补齐模型索引越界与异常数值兜底
 - [x] 完成本轮静态校验：`npx tsc --noEmit`、`node --check .\media\chat.js`、`node --check .\media\chat_b_steps.js`
 - [x] 待执行完整构建验证：`npm run build`
 
 ### 回归验证清单
 
 - [ ] 打开已有历史会话时，用户消息与 AI 最终消息是否与离开前一致
 - [ ] 历史会话中的过程摘要、步骤流、diff、变更汇总是否按预期恢复
 - [ ] 历史恢复内容是否为只读，不会误触发当前会话的确认 / Undo / 重试操作
 
 ---
 
 ## 下一轮修复：内部标签真实多会话并发
 
 ### 目标
 
 - [x] 将 `Alt+T` 创建的内部标签从“共享同一活动会话的 UI 页签”升级为“真正独立的会话运行单元”
 - [x] 每个内部标签默认绑定一条独立会话记录；新建标签时进入空白新对话态，不复用当前标签内容
 - [x] 切换内部标签时恢复该标签绑定会话的 `uiTranscript` / `displayHistory`，保证历史、过程摘要、diff、错误态都各自独立
 - [x] 允许同一原生聊天面板内的不同内部标签并发对话；`A` 生成时 `B` 可以继续发送和生成，且两边互不串屏、互不串记录
 - [x] 继续保留“同一 `sessionId` 不得在多个位置同时运行”的保护，避免同一会话被重复并发执行
 
 ### 实现清单
 
 - [x] `src/webview/SessionStore.ts`：将第一阶段“全局单运行锁”升级为“按 `sessionId` 管理的多运行锁”，保留 `ownerId + runId` 精确释放能力
 - [x] `src/webview/ChatEngine.ts`：将 `activeRunId`、`abortStream`、`toolCallsInProgress`、`stepSequence`、`toolCallRound`、`activeHistoryProcessSummary`、`turnWriteFiles`、`turnWriteRounds`、`pendingRegenerateState` 等运行态收口为“按会话维护”的 runtime 映射
 - [x] `src/webview/ChatEngine.ts`：为流式首轮、工具续轮、重新生成、停止生成、异常回滚建立“绑定 `sessionId` 的消息桥”，确保后台运行中的会话仍写回自己的 `uiTranscript`
 - [x] `src/webview/ChatEngine.ts`：放开内部标签切换 / 新建时对“当前引擎存在运行任务”的全局阻断，改为只阻止会影响同一会话一致性的操作
 - [x] `src/webview/messageTypes.ts`：为需要落到特定会话的前后端消息补充 `sessionId` 或等价的会话定向字段，避免共享面板内消息误投到当前活动标签
 - [x] `src/webview/ChatViewProvider_f_sessions.ts`、`src/webview/ChatViewProvider_m_webviewRouting.ts`：调整切换会话、重试、删除、清空等计划函数与路由判断，改为按目标会话判断是否允许执行
 - [x] `media/chat.js`：内部标签状态改为“标签绑定固定 `sessionId`，前端只渲染当前活动标签对应会话的消息流”，后台会话只更新状态，不抢占当前 `messagesContainer`
 - [x] `media/chat.js`：新建内部标签时默认进入空白新对话；切换标签时主动请求恢复该会话 transcript；非当前标签收到后台运行更新时仅更新标签标题/状态，不污染当前界面
 - [x] `media/chat.js`：补齐内部标签与会话解绑、删除会话后回退、恢复前端状态、排队消息与草稿文本的按标签隔离
 
 ### 分批执行建议
 
 - [x] 第一批：先改 `SessionStore` 锁粒度与 `ChatEngine` 会话级 runtime 容器，打通“不同会话可并发运行”的后端基础
 - [x] 第二批：补会话定向消息桥与 transcript 写回，确保后台运行的会话不会把消息写到当前活动标签或错误会话
 - [x] 第三批：重做 `media/chat.js` 内部标签绑定 / 恢复 / 新建逻辑，保证新标签空白、切换恢复独立历史、活动界面不串屏
 - [ ] 第四批：收口重试 / 重生成 / 删除 / 清空 / 关闭标签 / 面板恢复等边界，并执行静态校验与人工回归
 
 ### 回归验证清单
 
 - [ ] `Alt+T` 新建内部标签时，是否默认进入空白新对话而不是复用当前标签内容
 - [ ] `A` 正在生成时切到 `B`，`B` 是否不显示 `A` 的流式内容、步骤流、错误消息和变更汇总
 - [ ] `A` 正在生成时，`B` 是否可以正常发送消息并独立生成结果
 - [ ] `A` 与 `B` 同时生成时，停止 / 出错 / 工具调用 / 重生成是否都只影响各自会话
 - [ ] 切回历史标签时，是否恢复该标签绑定会话自己的 `uiTranscript`、`displayHistory`、草稿文本和滚动位置
 - [ ] 删除或清空某个会话后，是否只影响绑定该会话的内部标签，不破坏其他标签的运行态
 - [x] 同一 `sessionId` 在两个内部标签或两个原生面板中是否仍被正确阻止重复并发运行（锁逻辑已通过 12 条自动化测试验证；当前架构下普通用户只有一个原生面板，内部标签共享同一 ChatEngine，不存在跨引擎同 sessionId 并发场景；已保留 `devCreateSecondPanel` 开发者命令供将来验证）
 - [x] `npx tsc --noEmit`、`node --check .\media\chat.js`、`npm run build` 是否通过
 
 ---

## 架构重构：静默执行 + Undo all（方案四）

### 目标

移除所有写操作确认对话框，文件立即写入磁盘，AI 零阻塞地完成整个任务。
AI 完成后展示统一的变更汇总面板，提供 **Undo all** 和**单文件撤销**入口。
用户如果满意直接继续对话；如不满意点 Undo 一键还原。

### 现状 vs 目标对比

| 维度 | 现状 | 目标 |
|------|------|------|
| 写文件时 | 停住等用户确认 | 立即写入，不打断 AI |
| 确认次数 | N 个文件 = N 次弹窗 | 0 次（改为事后撤销） |
| 用户干预时机 | 事前：逐步批准 | 事后：整体撤销 |
| 体验 | 烦躁，多次点击 | 流畅，不满意再撤 |

### 核心设计

**写前备份，写后可撤**

```
AI 调用 write_file("A") → 备份原内容到内存 → 立即写入磁盘 → 继续
AI 调用 edit_file("B") → 备份原内容到内存 → 立即写入磁盘 → 继续
AI 调用 run_command    → 正常执行 → 继续
AI 全部完成，输出文本
  ↓
展示汇总面板（只读，无 Accept/Reject）
  ├─ [Undo all]      → 恢复所有备份文件
  └─ 每行 [↩ Undo]  → 恢复单个文件
用户发送下一条消息 → 备份清空
```

**备份结构（内存）**

```typescript
// 写前备份：key = 文件路径
private writeBackups = new Map<string, WriteBackup>();

interface WriteBackup {
  originalContent: string | null;  // null 表示文件原本不存在（新建文件）
  messageId: string;               // 属于哪一轮 AI 对话
}
```

### 详细实现清单

#### 阶段 1：删除旧的确认流程（ChatViewProvider.ts）

- [x] 删除 `deferredSteps`、`deferRemainingSteps` 相关逻辑
- [x] 删除 `pendingBatchConfirms`、`pendingConfirms` Map 和等待逻辑
- [x] 删除 `autoAcceptRun` 字段及相关重置逻辑
- [x] 删除 `handleWebviewMessage` 中 `acceptChange`、`rejectChange`、`acceptAllChanges`、`rejectAllChanges`、`resolveChangeSummary`、`setAutoAcceptRun` 的处理

#### 阶段 2：写操作改为立即执行 + 备份（handleToolCalls）

- [x] 遇到 `write_file` / `edit_file` → 先读原文件内容存入 `writeBackups`
- [x] 立即执行写操作（不再 defer）
- [x] 写成功后步骤状态正常显示为 done/error
- [x] 无需等待任何 Promise

#### 阶段 3：汇总面板改为只读 + Undo 入口

- [x] `showChangeSummary` 的 `needsConfirm` 永远为 `false`
- [x] 面板操作区改为：`[View all changes]` + `[↩ Undo all]`
- [x] 每个文件行右侧增加 `[↩]` 单文件撤销按钮
- [x] 点 Undo all → 发送 `undoAllChanges` 消息
- [x] 点单行 ↩ → 发送 `undoFileChange` 消息（带文件路径）

#### 阶段 4：Undo 逻辑（ChatViewProvider.ts）

- [x] 收到 `undoAllChanges` → 遍历 `writeBackups` 恢复所有文件
  - 原内容为 `null`（新建文件）→ 删除该文件
  - 原内容非空 → 写回原内容
- [x] 收到 `undoFileChange` → 只恢复指定文件
- [x] 恢复完成后发送 `updateChangeSummary`（status: 'undone'，text: '↩ Undone'）
- [x] 更新对应步骤状态为 error/cancelled（表示已回退）

#### 阶段 5：备份生命周期管理

- [x] 用户发送新消息时 → 清空 `writeBackups`（上一轮修改不再可撤）
- [x] 重新生成时 → 清空 `writeBackups`
- [x] 停止生成时 → 保留已执行的备份（文件已写，允许撤销）
- [x] 切换会话时 → 清空 `writeBackups`

#### 阶段 6：清理前端旧代码（chat_b_steps.js / chat.css）

- [x] 删除 `bindSummaryInteractions`（含行级 ✓/✗ 按钮绑定）
- [x] 删除 `⚡ Auto` 按钮及相关逻辑
- [x] 删除 `fileDecisions`、`checkAutoSubmit`、`submitDecisions` 相关代码
- [x] `showChangeSummary` 统一走 `needsConfirm = false` 的只读分支
- [x] 添加 Undo all / 单文件 ↩ 按钮及点击处理

#### 阶段 7：消息类型清理（messageTypes.ts）

- [x] 新增 `UndoAllChangesRequest`（type: 'undoAllChanges', summaryId）
- [x] 新增 `UndoFileChangeRequest`（type: 'undoFileChange', filePath）
- [x] 新增 status = 'undone' 到 `UpdateChangeSummaryResponse`
- [x] 删除 `AcceptChangeRequest`、`RejectChangeRequest`、`AcceptAllChangesRequest`、`RejectAllChangesRequest`、`ResolveChangeSummaryRequest`、`SetAutoAcceptRunRequest`
- [x] 从 `WebviewMessage` 联合类型中移除上述已删消息

### 涉及文件清单

- [x] `src/webview/ChatViewProvider.ts`：核心重构（删除 defer/confirm，加 backup/undo）
- [x] `src/webview/messageTypes.ts`：删旧消息类型，加 undo 消息类型
- [x] `media/chat_b_steps.js`：删 confirm 交互，加 Undo 按钮
- [x] `media/chat.css`：删 confirm 样式，加 undo 按钮样式

### 风险与注意事项

- [x] **新建文件的撤销**：backup 存 `null`，undo 时删除该文件，需用 `fs.unlinkSync`
- [x] **用户在 AI 写完后手动编辑了文件**：Undo 会覆盖用户的手动编辑，暂不处理（V1 不做校验）
- [x] **run_command 的副作用不可撤销**：如 `npm install` 无法 undo，这是 V1 的已知局限，可在面板上加说明
- [x] **会话切换/刷新**：备份在内存，刷新后不可撤，这是可接受行为

### 回归验证清单

- [x] AI 修改多个文件 → 全程无弹窗 → 文件直接写入
- [x] AI 完成后展示只读汇总面板 + Undo all 按钮
- [x] Undo all → 所有文件恢复原状
- [x] 单文件 ↩ → 只还原该文件
- [x] 新建文件 undo → 文件被删除
- [x] 发送下一条消息 → Undo 不再可用（按钮消失或灰显）
- [x] 停止生成 → 已写文件仍可 undo
- [x] 普通聊天、只读工具不受影响

---

# 缺陷与 BUG

## 背景

在对插件核心代码进行系统性审查后，发现以下缺陷与 BUG。按严重程度分为三类：确定性 BUG（会导致错误行为）、中等问题（可能导致异常或数据不一致）、架构与工程问题。

---

## 确定性 BUG（会导致错误行为）

### BUG-1：🔴 图片错误检测的运算符优先级错误

文件：`src/webview/ChatViewProvider.ts`（约第 837 行）

```typescript
const isImageError = errorMessage.includes('image_url') || errorMessage.includes('image') && errorMessage.includes('unknown');
```

由于 `&&` 优先级高于 `||`，实际等价于：

```typescript
errorMessage.includes('image_url') || (errorMessage.includes('image') && errorMessage.includes('unknown'))
```

问题：任何包含 `image_url` 字样的错误（如限流错误提到该端点）都会被误判为"模型不支持图片"，吞掉真实错误信息。应补充括号明确意图。

- [x] 修复运算符优先级，补充括号

### BUG-2：🔴 `ensureApiKey` 会将 `.env` 模型污染到 settings

文件：`src/config.ts`（约第 296-303 行）

`getAllModels()` 在有 `.env` 时会在数组前插入 `.env` 模型。`ensureApiKey` 中将合并后的数组直接写回 `settings.json`，会导致 `.env` 模型被持久化到用户设置中。之后即使删除 `.env`，该模型也会重复出现。

- [x] 修复 `ensureApiKey`，写回 settings 时排除 `.env` 来源的模型

### BUG-3：🟡 `handleRegenerate` 忽略传入的 `targetAssistantMessageId`

文件：`src/webview/ChatViewProvider.ts`（约第 1861-1867 行）

无论前端传来哪个 `targetAssistantMessageId`，后端始终查找最后一条 assistant 消息进行重新生成。如果用户要重新生成非末尾的 AI 回复，行为与预期不一致。

- [x] 修复为根据 `targetAssistantMessageId` 定位目标消息

### BUG-4：🟡 `editFile` 只替换首个匹配

文件：`src/tools/fileOps.ts`（约第 150 行）

```typescript
const updatedContent = fileContent.replace(oldContent, newContent);
```

JavaScript `String.replace(string, string)` 只替换第一个匹配。如果文件中有多处相同代码片段，AI 指定的 `oldContent` 只有第一处被替换，可能导致修改不完整。

- [x] 改为“多处命中时报错，不再静默只替换首个”，并在提示词中要求 `old` 内容唯一命中

### BUG-5：🟡 `regenerateResponse` 使用闭包累积内容而非回调参数

文件：`src/webview/ChatViewProvider.ts`（约第 1983-2001 行）

`regenerateResponse` 在闭包中自行累积 `fullContent`，忽略了 `sendStreamRequest` 的 `onDone` 回调传入的参数。而 `handleUserMessage` 使用的是回调参数。在中断等场景下，两份 `fullContent` 可能不一致。

- [x] 统一为使用 `onDone` 回调参数

### BUG-6：🔴 `handleToolCalls` 多个提前 return 路径未清理 loading 状态

文件：`src/webview/ChatViewProvider.ts`（约第 880-882、906-908、1007-1009 行）

如果用户在工具执行过程中停止生成（`stopGeneration` 修改了 `activeRunId`），`handleToolCalls` 循环中的 guard 会触发提前返回，但不会调用 `postMessage({ type: 'setLoading', loading: false })`，导致前端一直显示加载状态。

- [x] 在所有提前 return 路径中补充 `setLoading(false)`

### BUG-7：🟡 `writeBackups` 在会话切换时未清空

文件：`src/webview/ChatViewProvider.ts`（约第 2861-2883 行）

`switchSession` 方法中未清空 `this.writeBackups`。切换到其他会话后，如果用户点击 Undo，实际恢复的是前一个会话产生的文件变更，可能造成误操作。

- [x] 在 `switchSession` 中清空 `writeBackups`

### BUG-8：🟡 同一文件多次 edit 的 diff 基准错误

文件：`src/webview/ChatViewProvider.ts`（约第 940-941 行）

对于 `edit_file`，diff 的 `oldContent` 始终是最初的原始备份。如果同一批次内 AI 对同一个文件执行了两次 `edit_file`，第二次展示的 diff 仍以原始文件为基准，而不是第一次编辑后的状态，导致 diff 展示不准确。

- [x] 评估是否为每次 edit 记录中间态，或改为以实际磁盘文件为 diff 基准

---

## 中等问题（可能导致异常或数据不一致）

### 问题-1：🟡 `context.ts` 存在废弃的 `getModelConfig()` 函数

文件：`src/utils/context.ts`（约第 38-51 行）

此函数读取 `myAiPlugin.modelId`、`myAiPlugin.modelName` 等不存在的单独配置项（实际配置使用 `myAiPlugin.models` 数组），与 `config.ts` 中的同名函数冲突。虽然当前代码未调用此处版本，但导出会造成混淆，被其他模块误引用时会返回错误数据。

- [x] 删除 `context.ts` 中废弃的 `getModelConfig()` 函数

### 问题-2：🟠 `turnWriteFiles` 去重但不更新统计值

文件：`src/webview/ChatViewProvider.ts`（约第 986-988 行）

同一文件在多轮工具调用中被修改时，只保留首次的 `additions`/`deletions` 统计。最终汇总显示的行数变化可能与实际不符。

- [x] 修复去重逻辑，更新为最终累计统计值

### 问题-3：🟠 `retryableRequests` 在会话切换/删除时未清理

文件：`src/webview/ChatViewProvider.ts`（约第 1197-1213 行）

虽有 20 条上限，但切换/删除会话后，旧会话的 retry 快照仍留在 map 中。过期对象持续占用内存。

- [x] 在会话切换/删除时清理已失效的 retry 快照

### 问题-4：🟠 `readContextFilePreview` 未处理文件不存在

文件：`src/webview/ChatViewProvider.ts`（约第 2224 行）

```typescript
const stat = fs.statSync(filePath);
```

如果文件在添加上下文后被删除，`statSync` 会抛异常。虽然外层 `buildContextContent` 有 `try-catch`，但 `readContextFilePreview` 本身异常信息不够精确。

- [x] 在 `readContextFilePreview` 内部增加文件存在性检查或更精确的异常处理

---

## 架构与工程问题

### 架构-1：🔴 `ChatViewProvider.ts` 严重超长 — 3557 行（已完成收敛）

按项目规则（单文件不超 1200 行），此文件曾严重超标。主要承载了：

- 会话管理逻辑
- 消息处理与流式通信
- 工具调用执行与 diff 计算
- Undo/Redo 备份系统
- 文件搜索与上下文构建
- Workflow 发现与执行
- History 恢复与导出
- 完整 HTML 模板

- [x] 按功能拆分 `ChatViewProvider` 主链路逻辑为多个模块，并在当时阶段将主链路文件收敛到 `1181` 行、通过 `tsc -p . --noEmit`；后续在右侧 Tab 主入口稳定后，遗留的 `ChatViewProvider.ts` 参考文件也已完成清理

### 架构-2：🟠 备份文件残留在源码目录中

以下 copy 文件不应长期留在代码库中，影响搜索和误导开发：

- `src/extension copy.ts`
- `src/commands/handler copy.ts`
- `src/webview/ChatViewProvider copy.ts`
- `src/webview/ChatViewProvider latest copy.ts`

- [x] 已完成早期与后续阶段 copy 备份文件清理

### 架构-3：🟡 运行时状态未做会话级隔离

`activeRunId`、`abortStream`、`toolCallsInProgress`、`toolCallRound`、`writeBackups`、`turnWriteFiles` 等全部是 `ChatViewProvider` 的实例属性。切换会话时只切换了 `activeSessionId`，这些运行时状态未重置，导致跨会话状态残留。

- [x] 会话切换时统一重置所有运行时状态（第二阶段多会话并发执行时进一步做会话级隔离）

### 架构-4：🟡 `getEditorContext()` 未选中代码时返回整个文件

文件：`src/utils/editor.ts`（约第 22-25 行）

当用户未选中任何代码时，`selectedCode` 返回整个文件内容。对于大文件（数万行），会在命令调用链路中注入大量 token，可能超出模型上下文窗口。

- [x] 增加未选中代码时的大小限制或截断提示

---

## 缺陷汇总表

| 编号 | 严重度 | 类别 | 简述 | 状态 |
|------|--------|------|------|------|
| BUG-1 | 🔴 高 | 逻辑错误 | 图片错误检测运算符优先级问题 | [x] |
| BUG-2 | 🔴 高 | 数据污染 | ensureApiKey 将 .env 模型写入 settings | [x] |
| BUG-3 | 🟡 中 | 逻辑错误 | handleRegenerate 忽略目标消息 ID | [x] |
| BUG-4 | 🟡 中 | 功能缺陷 | editFile 只替换首个匹配 | [x] |
| BUG-5 | 🟡 中 | 一致性 | regenerateResponse 双份 fullContent 可能不一致 | [x] |
| BUG-6 | 🔴 高 | UI 状态 | handleToolCalls 提前 return 未清理 loading | [x] |
| BUG-7 | 🟡 中 | 状态泄漏 | writeBackups 在会话切换时未清空 | [x] |
| BUG-8 | 🟡 中 | 展示错误 | 同文件多次 edit 的 diff 基准错误 | [x] |
| 问题-1 | 🟡 中 | 死代码 | context.ts 废弃 getModelConfig 导出 | [x] |
| 问题-2 | 🟠 低 | 数据不准 | turnWriteFiles 去重不更新统计 | [x] |
| 问题-3 | 🟠 低 | 内存 | retryableRequests 未随会话清理 | [x] |
| 问题-4 | 🟠 低 | 健壮性 | readContextFilePreview 未处理文件不存在 | [x] |
| 架构-1 | 🔴 高 | 工程规范 | ChatViewProvider 3557 行远超 1200 行限制 | [x] |
| 架构-2 | 🟠 低 | 代码卫生 | 历史与后续阶段 copy / 参考备份均已完成清理 | [x] |
| 架构-3 | 🟡 中 | 状态隔离 | 运行时状态未做会话级隔离 | [x] |
| 架构-4 | 🟡 中 | 性能 | 未选中代码时注入整个文件内容 | [x] |

---

## 建议修复顺序

### 第一批：高优先级 BUG（🔴）

1. BUG-6：`handleToolCalls` 提前 return 未清理 loading
2. BUG-1：图片错误检测运算符优先级
3. BUG-2：`ensureApiKey` 污染 settings

### 第二批：中优先级 BUG（🟡）

4. BUG-7：`writeBackups` 会话切换未清空
5. BUG-5：`regenerateResponse` 双份 fullContent
6. BUG-3：`handleRegenerate` 忽略目标消息 ID
7. BUG-4：`editFile` 只替换首个匹配
8. BUG-8：同文件多次 edit diff 基准错误
9. 问题-1：删除 `context.ts` 废弃函数
10. 架构-3：会话切换时统一重置运行时状态

### 第三批：工程优化

11. 架构-1：拆分 `ChatViewProvider.ts`
12. 架构-4：大文件截断
13. 问题-2 ~ 问题-4：低优先级修复
14. 架构-2：清理 copy 备份文件

---

## 当前执行状态

- [x] 完成缺陷与 BUG 系统性分析
- [x] 输出缺陷清单到 workplan
- [x] 第一批高优先级 BUG 修复
- [x] 第二批中优先级 BUG 修复
- [x] 完成 `ChatViewProvider.ts` 第 20 阶段两轮收尾，主文件降到 `1181` 行并通过 `tsc -p . --noEmit`
- [x] 第三批工程优化完成（含 `架构-2`：copy 备份文件清理）
- [x] 已补修停止生成中断后已写文件缺少 change summary / Undo 入口，以及单文件 Undo 失败静默无反馈的问题，并再次通过 `tsc -p . --noEmit`

---

## 架构-1 分阶段执行计划

说明：以下阶段属于 `架构-1：拆分 ChatViewProvider.ts` 的内部执行计划，用于按低耦合、低风险方式分批推进，不替代上方总任务项。

- [x] 第一阶段：创建最新备份并抽离低耦合模块（`context usage`、Webview HTML）
- [x] 第二阶段：抽离会话恢复 / 展示层辅助逻辑，继续缩小 `ChatViewProvider.ts`
- [x] 第三阶段：抽离工具预览 / diff / 文件变更汇总相关逻辑
- [x] 第四阶段：抽离工作区文件搜索 / workflow 扫描 / 上下文文件预览 / Markdown 导出等边缘辅助逻辑
- [x] 第五阶段：抽离会话辅助逻辑与重新生成前置校验 / 快照构建
- [x] 第六阶段：抽离命令分发辅助逻辑与 `retryableRequests` 管理逻辑
- [x] 第七阶段：抽离 IDE / 编辑器交互相关低耦合逻辑（终端错误分析 Prompt、文件打开、工作流选择、代码插入）
- [x] 第八阶段：抽离运行时状态辅助逻辑（运行中判断、重做回滚状态消费、过程摘要状态读写）
- [x] 第九阶段：抽离 Webview 消息分发路由（轻量分支分发与剩余分支 router）
- [x] 第十阶段：抽离模型列表响应构建、模式提醒与会话保存前整理逻辑
- [x] 第十一阶段：抽离活跃会话访问 / displayHistory 解析，以及 token / sessions 响应构建逻辑
- [x] 第十二阶段：归并 session 领域 helper，并下沉上下文窗口裁剪包装逻辑
- [x] 第十三阶段：收口 displayHistory / regenerate / sessions 相关纯 helper 包装
- [x] 第十四阶段：下沉 session 领域 Webview 响应构建，并收口会话切换 / 历史恢复编排
- [x] 第十五阶段：继续清理纯转手 helper 包装与无用 preview 桥接代码
- [x] 第十六阶段：继续收口 Undo / 文件备份恢复逻辑到 `fileChanges` 领域 helper
- [x] 第十七阶段：继续评估上下文操作 / 导出 / 其他低耦合编排逻辑
- [x] 第十八阶段：继续评估模型 / 模式 / 其他低耦合编排逻辑
- [x] 第十九阶段：继续评估停止生成 / 运行时状态编排的下沉空间
- [x] 第二十阶段：继续评估 displayHistory / 会话访问 / 运行时与会话交界处的残余桥接
- [x] 收尾阶段：继续缩小 `ChatViewProvider.ts`，直到低于 1200 行，并完成编译验证
- [x] `架构-2` 收尾：已完成早期与后续阶段 `copy` / 参考备份清理

当前进度：`ChatViewProvider` 主链路重构目标已在当时阶段完成并通过 `tsc -p . --noEmit`；后续遗留的 `ChatViewProvider.ts` 与相关参考 `copy` 文件也已完成清理，当前主链路保持为 `ChatEngine` + `ChatTabPanel` + `ChatTabManager`。

---

## v0.2.0 Bug 修复批次

### 已完成修复

- [x] BUG-3：流式请求 onDone/onError 双触发互斥 → `client.ts` 添加 `settled` 互斥标志
- [x] BUG-5：regenerateResponse 缺少 retryRequestId → 生成并传递 retryRequestId
- [x] BUG-1：ensureApiKey 中 .env model 的 settingsIndex=-1 不保存 → 检测 .env 模型时提示用户
- [x] DEFECT-8：editFile 的 .replace() 特殊字符问题 → 改用 indexOf + slice 拼接
- [x] DEFECT-11：handleToolCalls 递归调用缺少 await → 添加 .catch() 错误处理
- [x] BUG-4：onStopGeneration 不发送多轮全量变更汇总 → 停止时检查 turnWriteRounds 并发送
- [x] BUG-2：CUTOFF_MAP 查表缺少 toLowerCase → 查表前统一 .toLowerCase()

### 已完成的运行时修复

- [x] Webview localResourceRoots 未包含 `dist/media/` → 添加 `dist/media` 到允许列表
- [x] 工具调用轮次上限从 10 提升到 200（兜底保护，正常不触发）
- [x] 工具执行改为读操作并行、写操作串行 → `toolExecutor.ts` 中 `Promise.all` 并行只读批次

---

## 多 Tab 聊天功能（v0.2.0 新功能）

### 目标

支持在 VS Code 编辑器中打开多个独立的 AI 聊天 Tab，每个 Tab 拥有独立的会话状态和对话流程，与侧边栏聊天面板并存。

### 依赖关系

```
阶段 0（准备） → 阶段 1（引擎抽离） → 阶段 2（Tab 新增） → 阶段 3（隔离与共享） → 阶段 4（前端适配）
```

### 阶段 0：准备工作

> 低风险，为后续重构建立安全网和接口契约

- [x] **0-1 备份源文件**
  - 操作：创建 `src/webview/ChatViewProvider latest copy.ts`（已于后续收尾阶段删除）
  - 验证：文件存在且内容与源文件一致

- [x] **0-2 定义 IChatHost 接口**
  - 新建文件：`src/webview/IChatHost.ts`
  - 定义 Webview 容器必须提供的能力：
    - `postMessage(message: ExtensionMessage): void` — 向前端发送消息
    - `getWebview(): vscode.Webview | undefined` — 获取 Webview 实例
    - `getExtensionUri(): vscode.Uri` — 获取插件根目录 URI
    - `getGlobalState(): vscode.Memento` — 获取持久化存储
    - `reveal(): void` — 使面板可见
  - 验证：`tsc -p . --noEmit` 通过

### 阶段 1：抽离聊天引擎 ChatEngine

> 核心阶段，最大改动量。将 ChatViewProvider 的业务逻辑全部迁移到独立引擎类。
> 完成后侧边栏功能必须与改动前完全一致。

- [x] **1-1 新建 ChatEngine.ts 骨架**
  - 新建文件：`src/webview/ChatEngine.ts`
  - 迁移所有实例状态字段（约 20 个）：
    - `sessions`, `activeSessionId`, `currentMode`, `contextFiles`
    - `abortStream`, `activeRunId`, `toolCallsInProgress`, `stepSequence`, `toolCallRound`
    - `writeBackups`, `sessionLauncherVisible`, `turnWriteFiles`, `turnWriteRounds`
    - `activeHistoryProcessSummary`, `pendingRegenerateState`, `retryableRequests`
    - `sessionDisplayHistoryAccessors`
    - `displayHistory` getter/setter, `chatHistory` getter/setter
  - 构造函数接收 `IChatHost` 实例而非 `vscode.ExtensionContext`
  - 验证：tsc 通过（此时 ChatEngine 只有字段，无方法）

- [x] **1-2 迁移业务方法到 ChatEngine**
  - 迁移以下 private 方法：
    - `handleUserMessage` — 用户消息处理主流程
    - `handleToolCalls` — 工具调用执行与续轮
    - `handleRegenerate` — 重新生成入口
    - `regenerateResponse` — 重新生成请求发起
    - `handleWebviewMessage` — Webview 消息分发
    - `resetSessionScopedRuntimeState` — 会话级运行时重置
    - `rollbackPendingRegenerateState` — 重做回滚
    - `hasRunningTask` — 运行中判断
  - 迁移以下 public/private 会话管理方法：
    - `clearCurrentSession`, `openSessionLauncher`, `switchSession`, `deleteSession`
    - `loadSessions`, `saveSessions`, `saveChatHistory`
  - 迁移以下辅助方法：
    - `sendModelList`, `pushTokenCount`, `exportChatToMarkdown`
  - 所有方法中 `this.postMessage(...)` 改为 `this.host.postMessage(...)`
  - 所有方法中 `this.context.globalState` 改为 `this.host.getGlobalState()`
  - 验证：tsc 通过

- [x] **1-3 ChatViewProvider 改为薄壳**
  - `ChatViewProvider` 内部持有 `private engine: ChatEngine`
  - 构造函数中创建 `ChatEngine` 实例，传入自身作为 `IChatHost`
  - `ChatViewProvider` 实现 `IChatHost` 接口
  - `resolveWebviewView` 保留在 Provider 中（VS Code API 要求）
  - 所有公开方法委托到 `this.engine.xxx()`：
    - `runCommandRequest` → `this.engine.runCommandRequest()`
    - `clearCurrentSession` → `this.engine.clearCurrentSession()`
    - `getMode` → `this.engine.getMode()`
    - `switchMode` → `this.engine.switchMode()`
    - `openSessionLauncher` → `this.engine.openSessionLauncher()`
    - `postMessage` → 保留在 Provider（直接调 webviewView.webview.postMessage）
  - `onModelSwitch` 回调保留在 Provider，通过 engine 事件桥接
  - 验证：tsc 通过 + 打包安装测试侧边栏功能完全正常

- [x] **1-4 外部调用者适配**
  - `extension.ts`：无需改动（ChatViewProvider 公开 API 不变）
  - `commands/handler.ts`：无需改动（依赖 ChatViewProvider 类型不变）
  - 验证：tsc 通过 + 所有右键命令可用

### 阶段 2：新增 Tab 面板能力

> 增量新增，不修改已有侧边栏逻辑。

- [x] **2-1 新建 ChatTabPanel.ts**
  - 新建文件：`src/webview/ChatTabPanel.ts`
  - 类实现 `IChatHost` 接口
  - 内部持有：
    - `vscode.WebviewPanel` 实例
    - 独立的 `ChatEngine` 实例
  - 构造函数：
    - 创建 `vscode.window.createWebviewPanel(...)` 
    - 配置 `localResourceRoots`（复用 Provider 逻辑）
    - 设置 HTML（复用 `buildChatViewHtml`）
    - 绑定消息监听到 `this.engine.handleWebviewMessage`
    - 监听 `onDidDispose` 清理资源
  - 实现 `IChatHost` 方法
  - 验证：tsc 通过

- [x] **2-2 新建 ChatTabManager.ts**
  - 新建文件：`src/webview/ChatTabManager.ts`
  - 管理所有打开的 Tab：
    - `private tabs: Map<string, ChatTabPanel>`
    - `createTab(context: vscode.ExtensionContext): ChatTabPanel`
    - `closeTab(tabId: string): void`
    - `getActiveTab(): ChatTabPanel | undefined`
    - `dispose(): void` — 关闭所有 Tab
  - 监听 Tab 关闭事件，自动从 Map 中移除
  - 验证：tsc 通过

- [x] **2-3 注册命令与快捷键**
  - 修改文件：`src/extension.ts`
  - 新增操作：
    - 创建 `ChatTabManager` 实例
    - 注册命令 `myAiPlugin.newChatTab`，调用 `tabManager.createTab(context)`
  - 修改文件：`package.json`
  - 新增操作：
    - `contributes.commands` 添加 `myAiPlugin.newChatTab`（标题："AI 助理：新建聊天 Tab"）
    - `contributes.keybindings` 添加快捷键绑定（`Ctrl+Shift+T`）
  - 验证：tsc 通过 + 打包后按快捷键能弹出新 Tab 并正常对话

### 阶段 3：会话隔离与共享资源

> 确保多个 ChatEngine 实例并发运行时数据安全。

- [x] **3-1 新建 SessionStore 单例**
  - 新建文件：`src/webview/SessionStore.ts`
  - 统一管理 sessions 的读写和 globalState 持久化
  - 所有 ChatEngine 实例通过 SessionStore 读写会话数据
  - 防止并发 saveSessions 导致数据覆盖
  - 验证：tsc 通过

- [x] **3-2 ChatEngine 改用 SessionStore**
  - `ChatEngine.sessions` 改为委托 store 的 getter/setter，多引擎共享同一引用
  - `loadSessions` 通过 store.load 加载（首个引擎实际读 globalState，后续复用缓存）
  - `saveSessions` 通过 store.persist 持久化
  - `ChatTabPanel` / `ChatTabManager` 创建并传递单一 SessionStore 实例
  - 验证：tsc 通过

- [x] **3-3 状态栏同步**
  - `ChatTabManager.createTab` 监听 `onDidChangeViewState`，Tab 获得焦点时触发 `onModelSwitch`
  - `ChatEngine` / `ChatTabPanel` 新增 `getActiveModelName()` 方法
  - 验证：tsc 通过

### 阶段 4：前端适配与体验优化

> 细节打磨，提升多 Tab 使用体验。

- [x] **4-1 Tab 标题动态显示**
  - `IChatHost` 新增可选 `setTitle?()` 方法
  - `ChatEngine` 新增 `syncHostTitle()` 在 6 个会话变更点调用（初始化/创建/切换/重命名/删除/清空）
  - 验证：tsc 通过

- [x] **4-2 右键命令路由**
  - 已在前一轮完成：所有命令统一通过 `tabManager.getOrCreateTab()` 路由到 Tab
  - 验证：tsc 通过

- [x] **4-3 Tab 间切换体验**
  - `retainContextWhenHidden` 已启用，切换时保持状态
  - `ChatTabManager.dispose` 关闭所有 Tab，`onDispose` 回调清理事件监听
  - 验证：tsc 通过

---

### 里程碑检查点

| 检查点 | 触发条件 | 操作 |
|--------|---------|------|
| **M1** | 阶段 1 完成 | 打包安装，验证侧边栏所有功能与改前一致 |
| **M2** | 阶段 2 完成 | 打包安装，验证新 Tab 能独立对话 |
| **M3** | 阶段 3 完成 | 多 Tab + 侧边栏同时使用，会话不串扰 |
| **M4** | 阶段 4 完成 | 完整体验测试，发布 v0.2.0 |

---

## 右侧 Tab 主入口改造（Windsurf / Cursor 风格）

### 背景

Windsurf 和 Cursor 的 AI 聊天面板始终固定在编辑器右侧区域，而非左侧侧边栏。本次改造将插件主入口从侧边栏 `WebviewViewProvider` 切换为右侧编辑器 Tab（`ViewColumn.Two`），多个对话在同一右侧编辑器分组内以 Tab 形式切换。

### 已完成改动

- [x] `ChatTabPanel.ts`：`ViewColumn.One` → `ViewColumn.Two`（固定右侧）；补齐 `runCommandRequest`/`clearCurrentSession`/`getMode`/`switchMode`/`openSessionLauncher` 公开 API
- [x] `ChatTabManager.ts`：新增 `getOrCreateTab()` 作为统一命令路由入口
- [x] `handler.ts`：`executeCommand` 参数类型从 `ChatViewProvider` 改为通用接口 `CommandTarget`
- [x] `extension.ts`：移除 `ChatViewProvider` 侧边栏注册；`Alt+Q`/`Alt+N`/AI 命令/清空/切换模式全部路由到 `tabManager`
- [x] `package.json`：移除 `viewsContainers` 和 `views` 配置；添加 `onStartupFinished` 激活事件
- [x] TypeScript 编译验证通过（`tsc -p . --noEmit`）
- [x] `Alt+N` / `Alt+T` 快捷键语义已重新区分：`Alt+N` 在当前聊天标签打开会话启动器，`Alt+T` 在当前聊天面板新增聊天标签
- [x] 历史会话列表分页：默认显示最近 20 条，超出时显示"显示更多"按钮
- [x] `SessionStore.ts`：多 Tab 共享同一个 sessions 池，防止并发保存数据覆盖
- [x] `ChatEngine` 的 `sessions` 改为委托 store 的 getter/setter，`loadSessions`/`saveSessions` 改用 store
- [x] Tab 标题动态显示：`IChatHost.setTitle?()` + `ChatEngine.syncHostTitle()` 在 6 个会话变更点同步

### 已完成清理

以下文件已在人工确认后完成清理：

- `src/webview/ChatViewProvider.ts` — 原侧边栏入口遗留文件
- `src/webview/ChatViewProvider latest copy.ts` — 历史备份
- `src/prompts/system copy.ts` — Prompt 阶段性备份

当前仓库未发现此前记录的 `.bak` 参考备份文件；`src/webview/` 下保留的 `ChatViewProvider_*` 文件均为当前主链路仍在使用的领域模块。

---

## v0.3.5 测试与开发者工具进展（2026-04-16）

### 自动化测试基础

- [x] 接入 `node:test` + `tsc -p tsconfig.test.json` 最小自动化测试基础，未新增第三方测试依赖
- [x] 新增 `package.json` 脚本：`test:build` 与 `test`
- [x] 新增 `tsconfig.test.json`、`scripts/run-node-tests.cjs`、`scripts/vscode-mock.cjs`
- [x] `.gitignore` 忽略 `.test-dist/`
- [x] `src/webview/ChatViewProvider_c_displayHistory.ts` 收紧工具解析导入为 `../tools/toolParser`，避免测试加载时被 `vscode` 依赖链牵连

### 自动化测试用例

- [x] `test/ChatViewProvider_f_sessions.test.ts`：sessions 恢复与会话计划（9 条）
- [x] `test/ChatViewProvider_i_retryRequests.test.ts`：retryRequests 请求记忆与清理（9 条）
- [x] `test/SessionStore_runLock.test.ts`：运行锁并发阻断（12 条），覆盖同一 sessionId 不同 owner 阻断、锁释放后获取、owner 保护、runId 匹配、完整并发场景等
- [x] `test/toolParser.test.ts`：工具 XML 示例展示解耦回归，覆盖 fenced code block 中的 XML 不执行、`hasToolCalls()` 忽略代码块内示例、`stripToolCalls()` 保留示例 XML
- [x] `test/ChatViewProvider_p_requestExecution.test.ts`：写失败收敛回归，覆盖 `executeToolCallBatchRound()` 在写失败后直接 `halted` 且不再写入 follow-up `chatHistory`

### 并发阻断验证结论

- [x] `SessionStore` 锁逻辑自动化测试 21/21 全部通过，逻辑正确无误
- [x] 当前架构下普通用户只有一个原生面板，内部标签共享同一 `ChatEngine`，不存在跨引擎同 `sessionId` 并发场景
- [x] 已保留 `AI: [开发] 创建第二个独立聊天面板` 命令（`devCreateSecondPanel`）供开发者验证跨 Tab 锁逻辑
- [x] 已在 `handleUserMessage` 和 `switchSession` 关键锁检查点添加 `[锁诊断]` 前缀日志

### 项目元信息

- [x] `package.json` 添加作者信息：`Mr.shen` / `sqf_163@163.com`
- [x] 新增 `LICENSE` 文件（MIT，Copyright 2025-2026 Mr.shen）

---

## 下一轮修复：真实文件写入与最小变更策略（2026-04-17）

### 再分析结论

- [x] `src/prompts/system.ts` 当前只强调 `edit_file` 必须唯一命中，未明确要求“已有文件优先局部修改、不要轻易整文件重写、不要把工具 XML 放进 Markdown 代码块”
- [x] `src/tools/toolParser.ts` 当前会在整段回复上全局解析 / 剥离工具 XML，不区分 fenced code block，导致示例 XML 可能被误执行且展示区被剥空
- [x] `src/tools/fileOps.ts` 的 `editFile()` 仍是严格字符串精确匹配，对 `CRLF/LF`、缩进差异、重复片段非常敏感
- [x] `src/webview/ChatViewProvider_d_fileChanges.ts` 已有 `buildPreviewContent()` / `issueText` 能提前判断部分 `edit_file` 一定失败，但当前未接入真实执行拦截
- [x] `src/webview/messageTypes.ts` 的 `UpdateStepResponse.description?` 与 `PersistedUiChangeSummaryFile.issueText?` 已能承载失败原因，`media/chat_b_steps.js` 也已有对应渲染入口
- [x] `src/webview/ChatViewProvider_p_requestExecution.ts` 当前无论写成功或失败都会继续 follow-up，缺少写失败收敛

### 本轮目标

- [ ] 对已有文件优先做局部修改，尽量只改相关代码块，不轻易整文件重写
- [ ] 提升 `edit_file` 真正写入成功率，让改动先落到文件中
- [x] 把工具 XML 示例与真实执行彻底分离，避免“展示示例被当真执行”
- [x] 写失败后及时收敛，并把真实原因展示给用户

### 分阶段实施

#### 阶段 1：真实写入优先 + 最小变更策略

- [x] `src/prompts/system.ts`：强化规则，明确“已有文件优先 `edit_file`，`write_file` 主要用于新文件；不要把工具 XML 放进 Markdown 代码块；定位失败先诊断，不要盲目整文件重写”
- [x] `src/tools/fileOps.ts`：增强 `editFile()` 的匹配鲁棒性，至少先处理 `CRLF/LF` 归一化，降低 Windows 项目中的精确匹配失败
- [x] `src/webview/ChatViewProvider_d_fileChanges.ts`：把现有 `buildPreviewContent()` / `issueText` 接入真实执行前预检；对必失败的 `edit_file` 直接拦截，不再明知失败还继续写
- [x] `src/webview/ChatViewProvider_d_fileChanges.ts`：为“已有文件却使用 `write_file` 覆盖”增加保护策略，优先迫使模型改回局部编辑路径

#### 阶段 2：工具 XML / 示例展示解耦

- [x] `src/tools/toolParser.ts`：`parseToolCalls()`、`hasToolCalls()`、`stripToolCalls()` 已统一忽略 fenced code block 中的 XML，示例代码不再被误执行
- [x] 展示链路：`ChatViewProvider_c_displayHistory.ts` 继续复用共享 `toolParser`，示例 XML 如果只是展示内容，不会再被 strip 成空代码块；本轮无需单独改该文件
- [x] `media/chat.js`、`src/webview/ChatViewProvider_l_webviewDispatch.ts`、`src/webview/ChatViewProvider_j_ideActions.ts`：空代码块已禁止复制 / 插入，插入改为等待真实 `editor.edit()` 结果后再由 Extension 提示成功

#### 阶段 3：失败收敛 + 原因可见

- [x] `src/webview/ChatViewProvider_p_requestExecution.ts`：写失败后已增加收敛条件；本轮一旦出现写失败，就不再继续 follow-up，避免同一失败摘要无限续轮
- [x] `src/webview/ChatViewProvider_d_fileChanges.ts`：失败原因已写入步骤描述，并同步进 change summary 的 `issueText`
- [x] 对同一路径 / 同一失败原因的重复重试已改为更强收敛：当前 run 在首次写失败后直接停止续轮，由步骤区与 summary 展示失败原因

### 回归验证清单

- [ ] 修改已有文件中的单个函数时，模型是否优先生成局部 `edit_file`，而不是整文件 `write_file`
- [ ] Windows `CRLF` 文件上的 `edit_file` 是否比当前更容易成功写入
- [x] fenced code block 中的 XML 示例是否不再被执行，也不会被剥空
- [x] 代码块为空时，复制 / 插入是否不再假成功
- [x] 写失败后是否会停止重复读写，而不是继续续轮到高轮次
- [x] 步骤区 / 汇总区是否能看到真实失败原因

### 执行顺序

- [x] 先完成阶段 1，再开始阶段 2
- [x] 阶段 2 稳定后再处理阶段 3
- [x] 每阶段完成后执行 `npx tsc --noEmit`
- [x] 已补最小自动化测试：`toolParser` 与 `requestExecution` 回归已落地并通过 `node:test`
- [ ] 人工回归待执行

---

## 再分析补记：静默执行 / Undo / 提示词真实调用链复核（2026-04-17）

### 本轮已确认的真实调用链

- [x] 主聊天请求链路已确认：`ChatEngine.handleUserMessage` → `prepareUserTurnRequest` → `prepareChatRequestExecution` → `buildRequestSystemPrompt` → `buildSystemPrompt`
- [x] 用户上下文注入链路已确认：`buildUserContentWithContext` → `buildContextContent` → `readContextFilePreview`，`@` 文件上下文并不经过 `fileOps.readFile()`
- [x] 工具续轮链路已确认：`ChatEngine.handleToolCalls` → `executeToolCallBatchRound` → `executeToolCallBatch` → `executeWriteToolCall` / `toolExecutor.executeToolCalls`
- [x] Undo 链路已确认：`handleRemainingWebviewMessage` → `executeUndoAllWriteBackupsFlow` / `executeUndoSingleWriteBackupFlow`

### 本轮已确认：当前代码已经闭环的点

- [x] `ChatViewProvider_e_workspaceContext.ts` 已对上下文文件预览做体积限制、字符截断、二进制跳过与不存在文件报错细化
- [x] `ChatViewProvider_p_requestExecution.ts` 已对工具反馈做摘要压缩，`read_file` / `list_dir` 结果不会再整段灌回续轮上下文
- [x] 静默执行 + `Undo all` / 单文件 `↩` 主链路已经存在，停止生成时多轮写入也会补发最终 change summary
- [x] `ChatEngine` 当前的 `activeRunId`、`abortStream`、`toolCallsInProgress`、`writeBackups`、`turnWriteFiles` 等运行时状态，已通过会话级 runtime accessor 绑定到当前 session，不再是简单的全局实例字段共享

### 本轮已确认：workplan 与代码现状存在偏差的点

- [x] `发送下一条消息 → Undo 不再可用（按钮消失或灰显）`（已在收口结果中修复：新消息/重生成前主动失效旧 summary + sibling 联动失效）
  - 已确认：新消息开始、重新生成开始时，后端会清空 `writeBackups`
  - 已确认：旧 summary 上的 `↩ Undo all` / 单文件 `↩` 按钮不会被主动失效，用户仍可点击，直到后端返回"无可撤销备份"类提示
  - 已确认：同一条 assistant 消息内可能存在多个 summary（每轮写入一个 `summary-*`，多轮结束后可能再补一个 `final-summary-*`），当前点击 Undo 只会更新被点击的那个 summary，其他同轮 summary 可能残留为陈旧 UI
  - 结论：这一项不应继续视为完全完成，应作为下一轮修补目标
- [x] `Undo 后更新对应步骤状态为 error/cancelled` 当前与代码实现不一致（已明确：Undo 保持在 summary 层，不回写历史 step 状态）
  - 已确认：当前 Undo 只会发送 `updateChangeSummary`
  - 已确认：当前没有把历史工具步骤统一改写为 `cancelled` 的后端逻辑
  - 已确认：`markUiMessageStopped()` 只会在“停止生成”场景，把仍在 running 的 step 改成 `error` 并补 `(已取消)`
  - 已确认：过程面板中的“撤销”统计来自 change summary 的状态文字（如 `↩ ...`），而不是来自 step 状态本身
  - 结论：从当前前端结构看，Undo 更偏向 summary 层状态；下一轮应优先确认是否直接修正文档语义，而不是先扩展 step 状态机
- [ ] “copy 备份文件已清理” 当前与仓库现状不一致
  - 已确认：仓库中仍存在 `src/webview/ChatEngine copy.ts`
  - 结论：这是明确的工程卫生残留，需要纳入下一轮修补
- [x] 旧 summary 的 Undo 入口"理论上无法主动失效"这一判断不成立
  - 已确认：`WriteBackupEntry` 目前虽然不记录 `summaryId`
  - 已确认：`ChatEngine` 运行时已维护 `summaryToMessageId` 索引，`uiTranscript` 也持久化了 `showChangeSummary` / `updateChangeSummary` 事件
  - 结论：后端具备定位旧 summary 并发送 `updateChangeSummary` 使其失效的基础条件，当前缺的是编排逻辑，而不是数据无法拿到
  - 结论：下一轮若要做联动失效，按 assistant `messageId` 统一扫描并更新该消息下全部 summary，结构上比逐个 `summaryId` 零散处理更自然
- [x] 失败写入项的前端 Undo 入口也存在误导风险
  - 已确认：写失败时 `createWriteFailureSummaryEntry()` 仍会把文件状态记成 `created` / `modified`
  - 已确认：前端 summary 渲染逻辑只要状态是 `created` / `modified` 就会显示单文件 `↩`
  - 已确认：当前数据模型把“写入类型（created/modified）”与“是否存在可撤销落盘结果”混用为同一个 `status` 字段，前端只能据此粗略判断是否显示 `↩`
  - 已确认：部分失败路径会先建立备份、后执行写入、最终返回失败，此时单文件 `↩` 可能只是把文件恢复成原样的“空操作式 Undo”；另一些预检失败路径则根本不会建立备份，点击后只会得到 missing/warning
  - 结论：下一轮需要区分“可撤销的已落盘写入”和“未真正写入成功的失败项”，否则 summary 会继续暴露无意义 Undo 入口
- [x] 直接复用 `cancelled` 状态还不足以完成旧 Undo 入口失效
  - 已确认：`messageTypes.ts`、`chat_b_steps.js`、`chat.css` 已存在 `cancelled` summary 状态映射与样式
  - 已确认：`setSummaryStatusState()` 当前只会在 `undone` / `partial-undone` 且文字以 `↩` 开头时隐藏 Undo 按钮，不会因为 `cancelled` 自动隐藏按钮
  - 已确认：过程面板构建逻辑会把所有以 `↩` 开头的 summary 状态文字归入 `undoing` 分组，而 `cancelled` 既不会归入 `undoing`，也不会自动归入 `failed`
  - 结论：若下一轮复用 `cancelled` 表达“Undo 已过期 / 已失效”，仍需同步补前端按钮禁用或隐藏逻辑，不能只改后端状态
- [x] "失效状态是否必须持久化"需要按场景区分（已明确策略：当前活动会话聚焦在线 UI 一致性，历史恢复已有 readOnly 兜底）
  - 已确认：`ChatEngine` 在恢复历史 `uiTranscript` 到 Webview 时，会把历史 `showDiff` / `showChangeSummary` 一律按 `readOnly: true` 渲染
  - 已确认：这意味着切会话或重开面板后的历史记录本身不会再暴露可点击的 Undo 入口
  - 结论：下一轮若只处理"当前活动会话、当前实时面板"的旧 Undo 失效，可以先聚焦在线 UI 与当前 `uiTranscript` 的一致性；是否额外持久化"已过期"状态，可作为次级决策，不必先入为主

### 下一轮优先分析 / 修补边界

- [x] 优先分析并修补：`writeBackups` 生命周期变化后，旧 change summary 的 Undo 入口如何主动失效并同步到前端
- [x] 优先分析并修补：同一条 assistant 消息内多个 summary 按 `messageId` 联动失效的策略，避免只更新当前点击 summary、其余 summary 残留陈旧状态
- [x] 优先分析并修补：失败写入项是否应继续显示单文件 `↩`，还是改为仅展示失败原因
- [x] 优先分析并确认：过期 / 失效 summary 的状态文案是否应避免使用 `↩` 前缀，防止过程面板误归类为 `undoing`
- [x] 优先分析并确认：Undo 影响范围只到 summary，还是需要回写历史 step 状态
- [ ] 优先清理：`src/webview/ChatEngine copy.ts`
- [x] 优先清理：`ChatEngine.ts` 中已确认未使用的残留导入 / 类型（`sendStreamRequest`、`formatToolResults`、`DeferredToolStep`）
- [x] 次优先修正：`system.ts` 在 Code / Ask / Plan 三种模式里仍写着"查看目录下所有代码时批量读取所有文件"，与当前只读限流 + 摘要续轮策略不一致

### 当前结论

- [x] 真正的半成品重点已不在 `system.ts` 或 `fileOps.ts` 的主能力本身
- [x] 下一轮应聚焦 `Undo` 生命周期、前端状态同步、文档语义统一与工程卫生收尾
- [x] 下一轮应聚焦区分 stop-generation 的 step 取消逻辑与 Undo 语义、说明 cancelled/↩ 文案对过程面板分组的影响，并补充已确认的 ChatEngine 残留导入与 system.ts 批量读取提示不一致问题

### 本轮收口结果（Undo 生命周期与前端状态同步）

- [x] 新消息开始、重新生成开始前，`ChatEngine` 会先按 assistant `messageId` 扫描当前仍可撤销的 summary，再发送 `updateChangeSummary(status: 'cancelled', text: 'Undo expired')`，随后清空 `writeBackups`
- [x] 同一条 assistant 消息内，`Undo all` 完成后会保留当前点击 summary 的 `↩` 结果，同时把 sibling summary 标记为已失效，避免同轮多个 summary 长时间残留陈旧 Undo 入口
- [x] 单文件 Undo 的 `partial-undone` 不再把同一个 summary 里的剩余 `↩` 按钮全部隐藏；前端现在只会按 `filePath` 隐藏已撤销文件对应的按钮
- [x] 失败写入项已通过 `undoable` 元数据与前端渲染条件区分开来，不再因为 `created` / `modified` 状态复用而误显示单文件 `↩`
- [x] 过期 / 失效 summary 不再使用 `↩` 前缀文案，过程面板不会再把这类状态误归到 `undoing`
- [x] 本轮明确收口语义：`stop-generation` 仍负责把运行中 step 标记为取消；Undo 保持在 change summary 层，不回写历史 step 状态
- [x] `ChatEngine.ts` 中已确认未使用的残留导入 / 类型（`sendStreamRequest`、`formatToolResults`、`DeferredToolStep`）已清理
- [x] `system.ts` 已改为“先探索目录，再分批读取最关键的 1~3 个源码文件”，与当前只读限流策略一致
- [x] 静态校验通过：`.\node_modules\.bin\tsc.cmd --noEmit`、`node --check d:\PluginProject\my-ai-plugin\media\chat.js`、`node --check d:\PluginProject\my-ai-plugin\media\chat_b_steps.js`
- [ ] `src/webview/ChatEngine copy.ts` 仍保留；按备份文件规则，本轮不自动删除，需人工确认后手动处理
- [ ] 仍建议人工回归：同一消息多轮写入后先单文件 Undo 再继续其它 Undo、Undo 与 stop-generation 交替触发、切会话/重开面板后的只读恢复展示

---

## 全面代码缺陷审查（2026-04-17）

> 审查范围：`ChatEngine.ts`、`SessionStore.ts`、`config.ts`、`api/client.ts`、`fileOps.ts`、`ChatViewProvider_m_webviewRouting.ts`、`ChatViewProvider_f_sessions.ts`、`ChatViewProvider_l_webviewDispatch.ts`、`ChatViewProvider_n_modelAndSession.ts`、`media/chat.js`
> 前置测试：45/45 自动化测试通过（fileOps CRLF、uiTranscript 恢复一致性/只读、sessionRuntime 隔离、postSessionMessage 隔离）

### P0 - 影响正确性

- [x] **BUG-1: `persistUiTranscript` 不能用后台会话的 `sessionId` 覆盖持久化的活跃会话 ID**
  - 位置：`ChatEngine.ts` L691-697
  - 现状：`persistUiTranscript(sessionId)` 会在指定会话写入 `uiTranscript` 后触发 `store.persist(...)`，但 `SessionStore.persist()` 的参数语义是“当前活跃会话 ID”，不是“被修改会话 ID”
  - 影响：如果把后台会话 `sessionId` 直接传给 `store.persist(...)`，会把 `globalState.activeSessionId` 错误覆盖成后台会话，导致下次恢复时活跃会话漂移
  - 修复：保持 `this.store.persist(this.activeSessionId)`，并补自动化测试锁定该语义

- [x] **BUG-5: `switchSession` 未清理旧会话的 `retryableRequests`**
  - 位置：`ChatEngine.ts` L2259-2311
  - 现状：`planSwitchSession` 返回 `clearRetryableSessionId`，但 `switchSession` 没有调用 `clearRetryableRequestsForSessionHelper`
  - 对比：`deleteSession` 和 `clearCurrentSession` 都有此调用
  - 影响：切换会话后旧会话的重试请求驻留在内存中，可能导致重试按钮指向已不活跃的上下文
  - 修复：在 `switchSession` 中补调 `clearRetryableRequestsForSessionHelper(this.retryableRequests, switchPlan.clearRetryableSessionId)`

### P1 - 状态残留 / 逻辑不完整

- [x] **BUG-2: `deleteSession` 未清理被删会话的运行时状态**
  - 位置：`ChatEngine.ts` L2313-2365
  - 现状：删除会话后不调 `clearSessionRuntimeState(sessionId)`，被删会话的 `SessionRuntimeState` 永远留在 `sessionRuntimeBySessionId` Map 中
  - 影响：内存泄漏；多次创建/删除会话后 Map 无限增长
  - 修复：在 `deleteSession` 中补调 `this.clearSessionRuntimeState(deletePlan.deletedSessionId)`

- [x] **BUG-3: `sendModelList` 未做索引越界保护**
  - 位置：`ChatEngine.ts` L1249-1258
  - 现状：`getActiveModelIndex()` 返回值可能超出 `models.length`，`sendModelList` 直接传给前端
  - 对比：`getModelConfig()` 已做越界保护，但 `sendModelList` 没有
  - 影响：前端可能高亮不存在的模型位置
  - 修复：在 `sendModelList` 中加 `Math.min(activeIndex, models.length - 1)` 保护（`buildUpdateModelsResponse` 内部已有保护，此项实际安全，但 `getActiveModelName` 需补 safeIndex）

- [x] **WARN-3: `regenerateResponse` catch 块未回滚 `pendingRegenerateState` 和 `ownedRunState`**
  - 位置：`ChatEngine.ts` L2138-2146
  - 现状：`regenerateResponse` 的 try 块内获取了运行锁且设置了 `pendingRegenerateState`，但 catch 块只发了错误消息，没有回滚状态
  - 对比：`handleUserMessage` 的 catch 块调了 `resetOwnedRunState`
  - 影响：重生成启动异常后运行锁残留 + `pendingRegenerateState` 残留，会话变为"永远在生成中"
  - 修复：在 catch 块中补调 `this.resetOwnedRunState(sessionId)` 和 `this.rollbackPendingRegenerateState(regenMsgId, sessionId)`

### P2 - 代码质量 / 死代码

- [x] **BUG-4: `getCrossTabRunConflictMessage` if/else 两分支返回完全相同的字符串**
  - 位置：`ChatEngine.ts` L448-455
  - 现状：无论 `runLock.ownerId !== this.engineId` 是否成立，返回值都是同一句
  - 修复：else 分支改为更准确的描述（如"当前会话已被占用，请稍后再试"），或去掉冗余的条件分支

- [x] **WARN-1: `currentMode` 和 `contextFiles` 不是会话隔离的**
  - 位置：`ChatEngine.ts` L247-250
  - 现状：这两个字段是引擎级，而非会话级。`handleUserMessage` 会修改 `this.currentMode`，影响后续所有会话
  - 影响：多会话场景下一个会话的 ask 模式会覆盖另一个会话的 code 模式
  - 修复：已下沉到 `SessionRuntimeState`，按会话分别维护 `currentMode/contextFiles`，并补齐 `initializeWebviewState`、`openSessionLauncher`、`switchSession`、`handleUserMessage`、`handleToolCalls`、`handleRegenerate` 的状态同步
  - 说明：本轮修复的是会话级运行时隔离，不改 `ChatSession` 持久化结构

- [x] **WARN-4: `api/client.ts` 超时回调直接调用 `onError` 而非 `callOnError`**
  - 位置：`api/client.ts` L294-299
  - 现状：因为先设了 `settled = true`，当前不会导致双重回调，但绕过了 `callOnError` 的统一守卫
  - 修复：改为 `callOnError(...)` 并移除手动 `settled = true`

- [ ] **WARN-5: `ChatEngine copy.ts` 残留备份文件**
  - 位置：`src/webview/ChatEngine copy.ts`（1874 行）
  - 现状：已被 `tsconfig.json` 排除编译，但占据仓库空间
  - 处置：需人工确认后手动删除

### 已确认正常

- SessionStore 运行锁获取/释放逻辑正确
- SessionStore 串行持久化队列正确
- `postSessionMessage` 会话隔离正确
- `capturePersistedUiState` 覆盖所有关键消息类型
- `restoreUiTranscriptToWebview` 只读标记和索引重建正确
- `fileOps.buildEditedContent` CRLF 归一化逻辑正确
- `config.ts` `getModelConfig` 已做越界保护
- `retryableRequests` 会话隔离校验和清理逻辑完整
- `clearSessionConversation` 同步清空 `history`/`displayHistory`/`uiTranscript`

### 本轮自动化测试补全（2026-04-17）

- [x] 为 `ChatEngine` 补充 `persistUiTranscript(sessionId)` 回归测试
  - 目标：验证后台会话写入 `uiTranscript` 时，不会错误覆盖 `globalState.activeSessionId`

- [x] 为 `ChatEngine` 补充 `switchSession` 回归测试
  - 目标：验证切换会话后会清理旧会话的 `retryableRequests`
  - 目标：验证切换后前端 transient 状态会同步到目标会话的 `mode/contextFiles`

- [x] 为 `ChatEngine` 补充 `deleteSession` 回归测试
  - 目标：验证删除会话后会清理被删会话的 `SessionRuntimeState`

- [x] 为 `ChatEngine` 补充 `regenerateResponse` 启动异常回滚测试
  - 目标：验证重生成启动异常时会回收 owned run state，并回滚 `pendingRegenerateState`

- [x] 为 `ChatEngine` 补充 `currentMode/contextFiles` 会话级隔离测试
  - 目标：验证不同会话的 mode 不互串
  - 目标：验证不同会话的 contextFiles 不互串

- [x] 运行测试与静态校验
  - `node .\scripts\run-node-tests.cjs`
  - `.\node_modules\.bin\tsc.cmd -p tsconfig.test.json`
  - `.\node_modules\.bin\tsc.cmd --noEmit`
  - 结果：50/50 测试通过

---

## AST 级代码编辑能力升级方案

> 目标：把当前基于 `old/new` 文本替换的代码修改能力，升级为基于 AST 的结构化编辑能力。
> 架构设计为**语言无关接口 + 语言适配器**模式，首批实现 TS/JS 适配器，后续按需扩展 Python、C#、Java 等语言。
> 升级后文本替换降级为不支持 AST 的语言/文件类型的兜底方案。
> 分 7 个阶段：阶段 1-5 完成核心框架 + TS/JS 适配器，阶段 6 扩展 Python，阶段 7 扩展 C#/Java。
> 每阶段可独立验收、独立提交。

### 当前架构概要（升级前基线）

```
模型输出 XML
  ↓
toolParser.ts        → 解析 <edit_file><old>...</old><new>...</new></edit_file>
  ↓
toolExecutor.ts      → 分派到 fileOps.editFile()
  ↓
fileOps.ts           → buildEditedContent() 文本查找替换
  ↓
ChatViewProvider_d   → executeWriteToolCall() 预检 + 备份 + diff + 变更摘要
  ↓
requestExecution     → executeToolCallBatchRound() 决定 halted / follow-up
```

升级核心思路：**不重写上层调度框架**，只在 `toolParser → toolExecutor → fileOps` 这一层**插入 AST 编辑器**，上层的预检、备份、diff、变更摘要、halted/follow-up 判定全部复用。

### 升级后架构概要

```
模型输出 XML
  ↓
toolParser.ts          → 解析 <ast_edit> 或 <edit_file>
  ↓
toolExecutor.ts        → 分派到 astRouter 或 fileOps
  ↓
astRouter.ts           → 根据文件扩展名选择语言适配器        ← 新增（语言无关路由层）
  ↓
astAdapter_typescript  → ts-morph 处理 .ts/.tsx/.js/.jsx   ← 阶段 1-2 实现
astAdapter_python      → 子进程 + libcst 处理 .py          ← 阶段 6 实现
astAdapter_csharp      → 子进程 + Roslyn 处理 .cs          ← 阶段 7 实现
astAdapter_java        → 子进程 + javaparser 处理 .java    ← 阶段 7 实现
textFallback           → 不支持的语言降级到 edit_file
  ↓
ChatViewProvider_d     → executeWriteToolCall() 预检 + 备份 + diff + 变更摘要（复用）
  ↓
requestExecution       → executeToolCallBatchRound() 决定 halted / follow-up（复用）
```

---

### 阶段一：引入 ts-morph 与 AST 基础设施

**目标**：引入 AST 解析能力，建立项目级 TypeScript 解析上下文，但不改变任何现有功能。

- [x] **TASK-AST-1.1: 安装 ts-morph 依赖**
  - `npm install ts-morph`
  - ts-morph 内置 TypeScript compiler，不需要额外装 typescript 运行时依赖
  - 确认 esbuild 打包不会出问题（ts-morph 是纯 JS，但体积较大，需验证）

- [x] **TASK-AST-1.2: 创建 `src/tools/astContext.ts` 模块**
  - 职责：管理项目级 `Project` 实例（ts-morph 的核心对象）
  - 提供 `getOrCreateProject(workspaceRoot: string): Project`
  - 提供 `getSourceFile(filePath: string): SourceFile | undefined`
  - 提供 `refreshSourceFile(filePath: string): SourceFile`（文件被修改后重新加载）
  - 提供 `disposeProject(): void`（插件停用时释放）
  - 使用惰性初始化：第一次需要 AST 时才创建 Project
  - Project 配置：读取工作区的 `tsconfig.json`，如果不存在则用合理默认值

- [x] **TASK-AST-1.3: 在插件 activate/deactivate 中管理 AST 上下文生命周期**
  - activate 时不需要立即初始化（惰性）
  - deactivate 时调用 `disposeProject()` 释放内存

- [x] **TASK-AST-1.4: 为 astContext 编写基础测试**
  - 验证能从内存中的 TS 源码创建 SourceFile
  - 验证能解析函数声明、import 声明、class 声明
  - 验证 dispose 后不会内存泄漏

- [x] **TASK-AST-1.5: 验证 esbuild 打包兼容性**
  - 运行 `npm run build` 确认 ts-morph 可被正确打包
  - 如果 ts-morph 太大导致包体膨胀，评估是否需要 external 化或换用更轻量的 `@ts-morph/bootstrap`
  - 验证结果：
    - `tsc --noEmit` 通过
    - `tsc -p tsconfig.test.json --noEmit` 通过
    - `npm run build` 通过
    - `npm run test` 通过，`54/54` 测试通过

**产出**：`astContext.ts` 模块 + 基础测试，不影响现有功能。

---

### 阶段二：实现多语言 AST 编辑接口与 TS/JS 适配器

**目标**：定义语言无关的 AST 编辑接口，实现语言路由层，并完成 TS/JS 适配器的全部原子操作。

- [x] **TASK-AST-2.1a: 创建 `src/tools/astEditorTypes.ts` — 语言无关接口定义**
  - 定义 `AstEditAction` 枚举：`add_import | remove_import | insert_function | edit_function_body | add_function_param | add_object_property | add_class_member | rename_symbol`
  - 定义 `AstEditRequest`：`{ filePath, action, params }`
  - 定义 `AstEditResult`：
    - 成功：`{ success: true, files: Array<{ filePath, newContent }> }`
    - 失败：`{ success: false, reason: string }`
  - 定义 `AstLanguageAdapter` 接口：
    - `supportsFile(filePath: string): boolean`
    - `execute(request: AstEditRequest, fileContent: string): Promise<AstEditResult>`
    - `dispose?(): void`

- [x] **TASK-AST-2.1b: 创建 `src/tools/astRouter.ts` — 语言路由层**
  - 维护已注册的 `AstLanguageAdapter` 列表
  - 提供 `registerAdapter(adapter: AstLanguageAdapter): void`
  - 提供 `routeAstEdit(request: AstEditRequest, fileContent: string): Promise<AstEditResult | { supported: false }>`
  - 按注册顺序查找第一个 `supportsFile` 返回 true 的适配器
  - 如果没有匹配的适配器，返回 `{ supported: false }`，由上层降级到 `edit_file`
  - 提供 `disposeAll(): void`

- [x] **TASK-AST-2.1c: 创建 `src/tools/astAdapter_typescript.ts` — TS/JS 适配器**
  - 实现 `AstLanguageAdapter` 接口
  - `supportsFile`：匹配 `.ts / .tsx / .js / .jsx`
  - 内部使用 `astContext.ts` 获取 SourceFile
  - 每个操作接收 SourceFile + 参数，返回修改后的文件内容字符串
  - 不直接写磁盘，只返回新内容，由上层决定是否落盘

- [x] **TASK-AST-2.2: 实现 `astAddImport` 操作**
  - 输入：`{ filePath, modulePath, namedImports?, defaultImport? }`
  - 行为：
    - 如果目标 import 已存在，合并 namedImports
    - 如果不存在，在文件顶部 import 区域末尾插入
    - 不重复添加已有的 import
  - 返回修改后的完整文件内容

- [x] **TASK-AST-2.3: 实现 `astRemoveImport` 操作**
  - 输入：`{ filePath, modulePath, namedImports? }`
  - 行为：
    - 如果指定 namedImports，只移除指定的导入符号
    - 如果移除后该 import 声明为空，删除整行
    - 如果不指定 namedImports，删除整条 import 声明

- [x] **TASK-AST-2.4: 实现 `astInsertFunction` 操作**
  - 输入：`{ filePath, functionCode, insertAfter?, insertBefore? }`
  - 行为：
    - 把一段完整的函数代码插入到指定位置
    - insertAfter/insertBefore 用函数名定位
    - 如果不指定位置，默认插入到文件末尾（export 之前）

- [x] **TASK-AST-2.5: 实现 `astEditFunction` 操作**
  - 输入：`{ filePath, functionName, newBody }`
  - 行为：
    - 找到指定名称的函数声明或箭头函数
    - 替换其函数体（保留签名和 JSDoc）
    - 如果找不到，返回失败
    - 如果同名函数有多个（重载），返回失败并提示

- [x] **TASK-AST-2.6: 实现 `astAddFunctionParam` 操作**
  - 输入：`{ filePath, functionName, paramCode, position? }`
  - 行为：
    - 在指定函数的参数列表中插入新参数
    - position 默认末尾
    - 如果参数已存在（同名），返回失败

- [x] **TASK-AST-2.7: 实现 `astAddObjectProperty` 操作**
  - 输入：`{ filePath, objectLocator, propertyCode }`
  - objectLocator 格式：`{ variableName }` 或 `{ functionName, paramIndex }` 等
  - 行为：
    - 找到目标对象字面量
    - 在末尾插入新属性
    - 如果属性已存在，返回失败

- [x] **TASK-AST-2.8: 实现 `astAddClassMember` 操作**
  - 输入：`{ filePath, className, memberCode, insertAfter? }`
  - 行为：
    - 在指定 class 中插入方法或属性
    - 如果同名成员已存在，返回失败

- [x] **TASK-AST-2.9: 实现 `astRenameSymbol` 操作（语义级）**
  - 输入：`{ filePath, oldName, newName, line?, column? }`
  - 行为：
    - 利用 ts-morph 的 `findReferences` 找到符号的定义和所有引用
    - 统一重命名
    - 如果是跨文件引用，返回所有被修改文件的路径和新内容
  - 返回：`Array<{ filePath, newContent }>` 支持多文件修改

- [x] **TASK-AST-2.10: 为每个 AST 操作编写单元测试**
  - 每个操作至少 3 个测试用例：
    - 正常操作
    - 目标不存在时的失败处理
    - 边界情况（已存在、重复、空文件等）
  - 验证结果：
    - `tsc --noEmit` 通过
    - `tsc -p tsconfig.test.json --noEmit` 通过
    - `npm run test` 通过，`75/75` 测试通过

**产出**：`astEditorTypes.ts`（语言无关接口）+ `astRouter.ts`（路由层）+ `astAdapter_typescript.ts`（TS/JS 适配器）+ 完整测试，不改现有编辑链路。

---

### 阶段三：新增 AST 工具类型并对接解析与执行链路

**目标**：让模型可以输出 AST 级工具调用，插件可以解析并执行。

- [x] **TASK-AST-3.1: 扩展 `ParsedToolCall` 类型**
  - 新增 `type: 'ast_edit'`
  - 新增 `astAction` 字段，枚举值：
    - `add_import`
    - `remove_import`
    - `insert_function`
    - `edit_function_body`
    - `add_function_param`
    - `add_object_property`
    - `add_class_member`
    - `rename_symbol`
  - 新增 `astParams` 字段：对应各操作的参数（联合类型）

- [x] **TASK-AST-3.2: 在 `toolParser.ts` 中新增 AST 工具调用解析**
  - 新增 XML 格式：
    ```xml
    <tool_call>
      <ast_edit path="src/foo.ts" action="add_import">
        <param name="modulePath">./utils</param>
        <param name="namedImports">helper,format</param>
      </ast_edit>
    </tool_call>
    ```
  - 或者用 JSON 参数格式（更灵活）：
    ```xml
    <tool_call>
      <ast_edit path="src/foo.ts" action="add_import">
        {"modulePath": "./utils", "namedImports": ["helper", "format"]}
      </ast_edit>
    </tool_call>
    ```
  - 保留对旧 `edit_file` 格式的完全兼容

- [x] **TASK-AST-3.3: 在 `toolExecutor.ts` 中新增 `ast_edit` 分派**
  - 在 `executeSingleToolCall` 的 switch 中新增 `case 'ast_edit'`
  - 调用 `astRouter.routeAstEdit()` 路由到对应语言适配器
  - 如果路由返回 `{ supported: false }`，自动降级到 `edit_file` 的文本替换逻辑
  - 返回标准 `FileOpResult`

- [x] **TASK-AST-3.4: 在 `ChatViewProvider_d_fileChanges.ts` 中适配 AST 写操作**
  - `executeWriteToolCall` 中：`ast_edit` 视为写操作
  - 预检逻辑：AST 操作自带结构校验，预检可以直接用 AST 编辑函数的"干跑"模式
  - 备份逻辑：与 `edit_file` 复用，不需要改
  - diff 逻辑：与 `edit_file` 复用（都是拿旧内容和新内容做 diff）

- [x] **TASK-AST-3.5: 处理 `ast_edit` 的多文件修改情况**
  - `rename_symbol` 可能改多个文件
  - 需要扩展 `ExecuteWriteToolCallResult` 支持返回多个文件的 diff
  - 上层 `executeToolCallBatch` 需要能处理单个工具调用产生多个文件变更
  - 备份和 undo 需要覆盖所有被改文件

- [x] **TASK-AST-3.6: 为 AST 工具调用的解析和执行编写集成测试**
  - 从 XML 输入到最终文件内容的端到端验证
  - 覆盖：正常执行、解析失败、AST 操作失败、权限拦截
  - 验证结果：
    - `tsc --noEmit` 通过
    - `tsc -p tsconfig.test.json --noEmit` 通过
    - `npm run test` 通过，`80/80` 测试通过

**产出**：AST 工具调用可被解析和执行，但模型还不知道有这些工具。

---

### 阶段四：更新系统提示词，让模型输出 AST 工具调用

**目标**：让模型知道有 AST 编辑工具可用，并优先使用。

- [x] **TASK-AST-4.1: 在 `system.ts` Code 模式中新增 AST 工具说明**
  - 在工具列表中新增 `ast_edit` 的格式说明和使用规则
  - 明确告知模型：
    - 对 `.ts/.tsx/.js/.jsx` 文件，**优先使用 `ast_edit`**
    - 只有当 AST 操作不能覆盖修改需求时，才降级用 `edit_file`
    - 对 `.json/.md/.yaml/.css/.html` 等非 JS/TS 文件，继续用 `edit_file`

- [x] **TASK-AST-4.2: 提供 AST 工具调用示例**
  - 在系统提示词中给 2-3 个典型示例：
    - 添加 import
    - 修改函数体
    - 重命名

- [x] **TASK-AST-4.3: 更新失败反馈格式**
  - 当 AST 操作失败时，反馈信息应包含：
    - 失败原因（找不到目标、重复、类型不匹配等）
    - 建议的修正方式
  - 让模型可以根据反馈自行纠正

- [x] **TASK-AST-4.4: 引导模型正确选择工具**
  - 在提示词中明确决策规则：
    - 结构化修改（加 import、改签名、加方法） → `ast_edit`
    - 逻辑修改（改函数体内部实现、改条件表达式） → `edit_file`（仍然是文本级最合适）
    - 新建文件 → `write_file`
    - 非 TS/JS 文件 → `edit_file` 或 `write_file`

**产出**：模型可以正确输出 AST 工具调用，端到端可用。

**验证结果**：
- `tsc --noEmit` 通过
- `tsc -p tsconfig.test.json --noEmit` 通过
- `npm run test` 通过，`80/80` 测试通过

---

### 阶段五：验证、优化与边界收尾

**目标**：在真实项目场景下验收 AST 编辑能力，处理边界情况。

- [x] **TASK-AST-5.1: 真实场景端到端验收**
  - 用插件自身代码作为测试项目，验证以下场景：
    - 给现有文件添加 import
    - 给函数添加参数
    - 给 class 添加方法
    - 重命名一个被多处引用的函数
    - 修改函数体实现（应降级到 edit_file）
    - 对 JSON/MD 文件的编辑（应走 edit_file）

- [x] **TASK-AST-5.2: AST 操作失败时的优雅降级**
  - 如果 AST 解析失败（语法错误的文件），自动降级到 `edit_file`
  - 如果 ts-morph Project 初始化失败（没有 tsconfig），用合理默认值
  - 在日志中记录降级原因

- [x] **TASK-AST-5.3: 性能优化**
  - ts-morph Project 的初始化可能较慢（大项目几秒）
  - 确认惰性初始化不会阻塞 UI
  - 评估是否需要用 Worker 线程隔离 AST 解析
  - 文件修改后的 SourceFile 刷新要增量而非全量重建

- [x] **TASK-AST-5.4: 处理 JavaScript 文件**
  - `.js/.jsx` 文件也应支持 AST 编辑
  - ts-morph 可以解析 JS 文件（设置 `allowJs: true`）
  - 验证 JS 文件的 AST 操作与 TS 一致

- [x] **TASK-AST-5.5: AST 编辑后的格式保持**
  - ts-morph 默认的代码生成格式可能与项目原有格式不一致
  - 策略：对于替换节点内容的操作，尽量使用 `replaceWithText` 保持原始格式
  - 对于插入操作，读取文件现有缩进风格（tab/space、宽度）并适配

- [x] **TASK-AST-5.6: 更新 workplan 和 README**
  - 记录 AST 编辑能力的使用方式
  - 记录支持的操作列表
  - 记录降级规则

**产出**：AST 编辑能力经过真实验收，边界情况处理完整。

**验收过程中的修复**：
- 修复 `insertStatements` 索引参数 bug：之前用行号作为语句索引，在 JS 文件中会超出范围，改为用 `getStatements().indexOf(anchor)`
- `withAstMutation` 将整个初始化流程包进 try/catch，语法错误文件也能优雅返回失败并提示降级

**验证结果**：
- `tsc --noEmit` 通过
- `tsc -p tsconfig.test.json --noEmit` 通过
- `npm run test` 通过，`93/93` 测试通过
- E2E 测试覆盖：class 添加方法、函数参数、import 合并、嵌套对象属性、XML 解析、JS/JSX 文件、箭头函数、rename 跨引用、部分删除 import、错误场景

---

### 阶段六：Python AST 适配器

**目标**：扩展 AST 编辑能力到 Python，通过子进程调用 Python + libcst 实现结构化编辑。

- [x] **TASK-AST-6.1: 设计 Python AST worker 通信协议**
  - 插件（Node.js）通过 `child_process.spawn` 启动 Python 子进程
  - 通信方式：stdin/stdout JSON 协议
  - 请求格式：`{ action, filePath, fileContent, params }`
  - 响应格式：`{ success, files?, reason? }`（与 `AstEditResult` 对齐）

- [x] **TASK-AST-6.2: 实现 Python 端 AST worker 脚本**
  - 创建 `resources/ast_workers/python_ast_worker.py`
  - 依赖 `libcst`（比标准库 `ast` 更适合做代码修改，因为 libcst 保留格式和注释）
  - 实现操作：
    - `add_import`：插入 import 语句，合并已有 import
    - `remove_import`：移除指定 import
    - `insert_function`：在模块级插入函数定义
    - `edit_function_body`：替换函数体
    - `add_function_param`：给函数添加参数
    - `add_class_member`：给 class 添加方法或属性
    - `rename_symbol`：基于作用域分析的安全重命名（libcst 的 `QualifiedNameProvider`）
  - 从 stdin 读 JSON 请求，向 stdout 写 JSON 响应

- [x] **TASK-AST-6.3: 创建 `src/tools/astAdapter_python.ts`**
  - 实现 `AstLanguageAdapter` 接口
  - `supportsFile`：匹配 `.py`
  - 内部管理 Python 子进程生命周期：
    - 惰性启动：第一次需要时才 spawn
    - 复用进程：不要每次操作都启动新进程
    - 超时处理：单次操作超过 10 秒视为失败
    - dispose 时 kill 子进程
  - 检测用户机器是否有 Python 3 和 libcst：
    - 如果没有，`supportsFile` 返回 false，自动降级到 edit_file
    - 在日志中记录原因

- [x] **TASK-AST-6.4: 在 `astRouter.ts` 中注册 Python 适配器**
  - 在适配器列表中追加 Python 适配器
  - 不需要改 router 逻辑，只需要注册

- [x] **TASK-AST-6.5: 更新系统提示词支持 Python 的 ast_edit**
  - 在工具说明中新增：对 `.py` 文件也可使用 `ast_edit`
  - 给出 Python 特有的示例（Python 的 import 格式与 TS 不同）

- [x] **TASK-AST-6.6: 为 Python 适配器编写测试**
  - 测试 Python worker 脚本的各操作
  - 测试 Node.js 端子进程通信的正常和异常路径
  - 测试 Python 不可用时的降级行为

**产出**：`.py` 文件可通过 `ast_edit` 进行结构化编辑。

**前置条件**：用户机器需安装 Python 3 + `pip install libcst`。

**实现摘要**：
- `resources/ast_workers/python_ast_worker.py`：Python 端 worker，支持 7 种 AST 操作 + ping/shutdown 协议
- `src/tools/astAdapter_python.ts`：Node.js 端适配器，惰性启动、复用子进程、超时处理、优雅关闭
- `extension.ts`：在 activate 中注册 TS + Python 适配器，deactivate 中 disposeAll
- `system.ts`：提示词已更新支持 .py 文件

**验证结果**：
- `tsc --noEmit` 通过
- `tsc -p tsconfig.test.json --noEmit` 通过
- `npm run test` 通过，101 测试（97 pass + 4 skip）
- 4 个跳过的测试需要 Python 3 + libcst 环境，当前 CI 未安装

---

### 阶段七：C# 和 Java AST 适配器

**目标**：扩展 AST 编辑能力到 C# 和 Java。两者都通过子进程 + 各自的 AST 库实现。

#### C# 适配器（Roslyn）

- [x] **TASK-AST-7.1: 实现 C# AST worker**
  - 创建 `resources/ast_workers/csharp_ast_worker/` .NET 控制台项目
  - 依赖 `Microsoft.CodeAnalysis.CSharp`（Roslyn）
  - 通信方式：stdin/stdout JSON 协议，与 Python worker 格式一致
  - 实现操作：
    - `add_import`：添加 `using` 声明
    - `remove_import`：移除 `using` 声明
    - `insert_function`：在 class 中插入方法
    - `edit_function_body`：替换方法体
    - `add_function_param`：给方法添加参数
    - `add_class_member`：给 class 添加字段/属性/方法
    - `rename_symbol`：基于 Roslyn 语义模型的安全重命名

- [x] **TASK-AST-7.2: 创建 `src/tools/astAdapter_csharp.ts`**
  - 实现 `AstLanguageAdapter` 接口
  - `supportsFile`：匹配 `.cs`
  - 子进程管理逻辑与 Python 适配器相似
  - 检测 `dotnet` CLI 是否可用
  - 首次使用时自动 build worker 项目（或内置预编译的 dll）

#### Java 适配器（javaparser）

- [x] **TASK-AST-7.3: 实现 Java AST worker**
  - 创建 `resources/ast_workers/java_ast_worker/` Maven/Gradle 项目
  - 依赖 `com.github.javaparser:javaparser-core`
  - 通信方式：stdin/stdout JSON 协议
  - 实现操作：与 C# 类似
    - `add_import`
    - `remove_import`
    - `insert_function`（在 class 中插入方法）
    - `edit_function_body`
    - `add_function_param`
    - `add_class_member`
    - `rename_symbol`（javaparser 的 symbol 解析能力有限，初版可只支持单文件重命名）

- [x] **TASK-AST-7.4: 创建 `src/tools/astAdapter_java.ts`**
  - 实现 `AstLanguageAdapter` 接口
  - `supportsFile`：匹配 `.java`
  - 检测 JVM 是否可用
  - 首次使用时自动 build worker 或内置 fat jar

- [x] **TASK-AST-7.5: 在 `astRouter.ts` 中注册 C# 和 Java 适配器**

- [x] **TASK-AST-7.6: 更新系统提示词**
  - 新增 `.cs` 和 `.java` 文件的 `ast_edit` 说明和示例
  - C# 的 `add_import` 对应 `using`
  - Java 的 `add_import` 对应 `import`

- [x] **TASK-AST-7.7: 为 C# 和 Java 适配器编写测试**
  - 各语言的 worker 操作测试
  - Node.js 端子进程通信测试
  - 运行时不可用时的降级测试

**产出**：`.cs` 和 `.java` 文件可通过 `ast_edit` 进行结构化编辑。

**前置条件**：
- C#：用户机器需安装 .NET SDK 6.0+
- Java：用户机器需安装 JDK 11+ 和 Maven 或 Gradle

**实现摘要**：
- `resources/ast_workers/csharp_ast_worker/`：.NET 6 控制台项目，使用 Roslyn (Microsoft.CodeAnalysis.CSharp) 实现 7 种 AST 操作
- `resources/ast_workers/java_ast_worker/`：Maven 项目，使用 javaparser-core 实现 7 种 AST 操作
- `src/tools/astAdapter_subprocess.ts`：通用子进程适配器基础设施（惰性启动、复用、超时、路径解析）
- `src/tools/astAdapter_csharp.ts` / `astAdapter_java.ts`：各语言适配器，使用通用基础设施
- `extension.ts`：在 activate 中注册 4 个语言适配器（TS/Python/C#/Java）
- `system.ts`：提示词已更新支持 .cs/.java 文件

**验证结果**：
- `tsc --noEmit` 通过
- `npm run test` 通过，112 测试（106 pass + 6 skip）
- C# 适配器测试：add_import、rename_symbol、错误场景均通过
- Java/Python 测试因环境跳过（需要对应运行时 + 已构建 worker）

**关键修复**：
- 解决了测试构建与正式构建的 `__dirname` 路径不一致问题，使用 `resolveFromProjectRoot` 向上查找 package.json 确定项目根
- `java --version` 替代 `-version` 避免 stderr 输出导致误判
- 子进程超时调整为 30s，容纳首次构建的启动时间

---

### 各阶段改动范围总结

| 阶段 | 新增文件 | 修改文件 | 新增依赖 |
|------|---------|---------|----------|
| 一 | `astContext.ts`, `astContext.test.ts` | `extension.ts`（deactivate） | `ts-morph` |
| 二 | `astEditorTypes.ts`, `astRouter.ts`, `astAdapter_typescript.ts`, 测试 | 无 | 无 |
| 三 | 无 | `toolParser.ts`, `toolExecutor.ts`, `ChatViewProvider_d_fileChanges.ts`, `index.ts` | 无 |
| 四 | 无 | `system.ts`, `toolExecutor.ts`（反馈格式） | 无 |
| 五 | 无 | 可能微调以上文件 | 无 |
| 六 | `astAdapter_python.ts`, `python_ast_worker.py`, 测试 | `astRouter.ts`（注册）, `system.ts`（提示词） | `libcst`（Python 端） |
| 七 | `astAdapter_csharp.ts`, `astAdapter_java.ts`, C#/Java worker 项目, 测试 | `astRouter.ts`（注册）, `system.ts`（提示词） | Roslyn（.NET 端）, javaparser（Java 端） |

### 各语言适配器技术选型

| 语言 | AST 库 | 运行方式 | 通信协议 |
|------|--------|---------|----------|
| TypeScript/JavaScript | `ts-morph`（内置 TS Compiler） | 进程内直接调用 | 无需（同进程） |
| Python | `libcst` | `child_process.spawn python` | stdin/stdout JSON |
| C# | `Roslyn`（Microsoft.CodeAnalysis） | `child_process.spawn dotnet run` | stdin/stdout JSON |
| Java | `javaparser` | `child_process.spawn java -jar` | stdin/stdout JSON |

### 关键设计决策

1. **AST 编辑器不直接写磁盘**：只返回新文件内容，由现有的 `executeWriteToolCall` 统一处理备份、diff、undo
2. **保持 `edit_file` 完全兼容**：AST 是增量能力，不替代文本编辑，两者长期共存
3. **AST 上下文惰性初始化**：不改变插件启动速度
4. **多文件修改（rename）需要特殊处理**：这是唯一需要扩展上层框架的点
5. **模型决策权交给提示词**：不做强制路由，让模型根据场景自己选工具
6. **语言无关接口 + 语言适配器**：上层调度代码（解析、备份、diff、undo、halted/follow-up）对语言无感知，新增语言只需加适配器
7. **非 TS/JS 语言通过子进程通信**：因为 Python/C#/Java 的 AST 库无法在 Node.js 内直接运行，必须通过 spawn 子进程 + stdin/stdout JSON 协议
8. **运行时检测与优雅降级**：如果用户机器没有对应语言运行时（如没装 Python），该语言的适配器自动禁用，降级到 `edit_file` 文本替换

