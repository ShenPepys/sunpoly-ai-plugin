# AI 编程 IDE 插件 — 开发计划（Workplan）

> **文档版本**：V1.0
> **创建日期**：2026 年 04 月 04 日
> **项目路径**：`d:\PluginProject\my-ai-plugin\`
> **参考源码**：`d:\PluginProject\claude-code-main\`（仅作参考，不直接复用代码）

---

## 一、项目概览

### 1.1 产品定位

开发一款 **VS Code 侧边栏 AI 编程助手插件**，通过对接第三方大模型 API（DeepSeek / 豆包 / OpenAI），
为开发者提供代码解释、Bug 修复、代码优化、代码续写、单测生成等功能。

### 1.2 核心技术栈

| 层级 | 技术选择 | 说明 |
|---|---|---|
| **插件框架** | VS Code Extension API | 官方标准，稳定成熟 |
| **开发语言** | TypeScript | VS Code 插件标准语言 |
| **聊天界面** | Webview (HTML + CSS + JS) | 嵌入侧边栏，支持 Markdown 渲染 |
| **Markdown 渲染** | marked + highlight.js | 轻量级，支持代码高亮 |
| **AI API** | OpenAI 兼容协议 | DeepSeek / 豆包 / OpenAI 都兼容此协议 |
| **流式输出** | Server-Sent Events (SSE) | 打字机效果逐字显示 |
| **打包工具** | esbuild | 快速打包，VS Code 官方推荐 |
| **包管理** | npm | 标准 Node.js 包管理 |

### 1.3 项目结构设计

```
my-ai-plugin/
├── package.json                 ← VS Code 插件配置清单（命令、菜单、侧边栏注册）
├── tsconfig.json                ← TypeScript 编译配置
├── esbuild.js                   ← 打包脚本
├── .vscodeignore                ← 打包排除文件
├── README.md                    ← 插件说明
├── CHANGELOG.md                 ← 版本更新记录
├── resources/                   ← 静态资源
│   └── icon.png                 ← 插件图标
├── src/
│   ├── extension.ts             ← 插件入口：激活/销毁、注册命令和侧边栏
│   ├── config.ts                ← 配置管理：API Key、模型选择、自定义设置
│   ├── logger.ts                ← 日志管理：OutputChannel 输出日志
│   │
│   ├── webview/                 ← 聊天界面（Webview 前端）
│   │   ├── index.html           ← 主页面模板
│   │   ├── main.js              ← 前端交互逻辑（消息收发、DOM 操作）
│   │   ├── styles.css           ← 样式（适配 VS Code 明暗主题）
│   │   └── markdown.js          ← Markdown 渲染 + 代码高亮
│   │
│   ├── api/                     ← AI 模型 API 对接层
│   │   ├── types.ts             ← API 请求/响应类型定义
│   │   ├── base.ts              ← 统一 API 适配器（OpenAI 兼容协议）
│   │   ├── stream.ts            ← 流式输出处理（SSE 解析）
│   │   └── models.ts            ← 模型配置（各厂商 endpoint、模型名）
│   │
│   ├── prompts/                 ← Prompt 模板（借鉴 Claude 源码设计）
│   │   ├── system.ts            ← 系统提示词（身份定义 + 行为规则）
│   │   ├── explain.ts           ← 代码解释 Prompt
│   │   ├── fix.ts               ← Bug 修复 Prompt
│   │   ├── optimize.ts          ← 代码优化 Prompt
│   │   ├── complete.ts          ← 代码续写 Prompt
│   │   └── test.ts              ← 单测生成 Prompt
│   │
│   ├── commands/                ← VS Code 命令注册
│   │   ├── index.ts             ← 命令统一注册入口
│   │   ├── explain.ts           ← "解释代码" 命令
│   │   ├── fix.ts               ← "修复代码" 命令
│   │   ├── optimize.ts          ← "优化代码" 命令
│   │   ├── complete.ts          ← "续写代码" 命令
│   │   └── test.ts              ← "生成单测" 命令
│   │
│   ├── providers/               ← VS Code 功能提供者
│   │   └── sidebarProvider.ts   ← 侧边栏 WebviewViewProvider
│   │
│   └── utils/                   ← 工具函数
│       ├── editor.ts            ← 编辑器交互（获取选中代码、插入代码、获取文件信息）
│       └── context.ts           ← 上下文构建（当前文件语言、项目结构）
│
└── test/                        ← 测试目录（后续添加）
    └── extension.test.ts        ← 插件基础测试
```

---

## 二、功能规划

### 2.1 MVP 核心功能（第一版）

#### F1：侧边栏 AI 聊天面板

| 项目 | 内容 |
|---|---|
| **描述** | 在 VS Code 侧边栏注册一个 AI 聊天面板，用户可以直接输入问题与 AI 对话 |
| **交互** | 输入框 + 发送按钮 + 消息列表，支持 Markdown 渲染和代码高亮 |
| **主题** | 自动适配 VS Code 明/暗主题（使用 CSS 变量 `--vscode-*`） |
| **流式** | AI 回复以打字机效果逐字显示 |

#### F2：代码解释（/explain）

| 项目 | 内容 |
|---|---|
| **触发方式** | ① 选中代码 → 右键菜单 "AI: 解释代码"<br>② 在聊天面板输入 `/explain`<br>③ 快捷键 `Ctrl+Shift+E` |
| **行为** | 获取选中代码 + 文件语言 + 文件名，拼接到解释 Prompt，调用 AI API，在面板展示结果 |
| **Prompt 策略** | 要求 AI 用通俗易懂的语言解释代码的功能、逻辑和关键细节 |

#### F3：Bug 修复（/fix）

| 项目 | 内容 |
|---|---|
| **触发方式** | ① 选中代码 → 右键 "AI: 修复代码"<br>② 聊天面板输入 `/fix`<br>③ 快捷键 `Ctrl+Shift+F` |
| **行为** | 获取代码 + 错误信息（如果有诊断信息），AI 分析问题并给出修复方案 |
| **Prompt 策略** | 先诊断根本原因，给出最小化修复，不趁机重构（借鉴 Claude 的任务执行原则） |

#### F4：代码优化（/optimize）

| 项目 | 内容 |
|---|---|
| **触发方式** | ① 右键 "AI: 优化代码"<br>② 聊天面板输入 `/optimize` |
| **行为** | AI 从性能、可读性、最佳实践三个维度分析代码并给出优化建议 |
| **Prompt 策略** | 借鉴 Claude `/simplify` 的三维审查思路（复用、质量、效率） |

#### F5：代码续写（/complete）

| 项目 | 内容 |
|---|---|
| **触发方式** | ① 光标位置 → 命令面板 "AI: 续写代码"<br>② 聊天面板输入 `/complete` |
| **行为** | 获取光标前的上下文代码（当前文件前 100 行 + 光标后 20 行），AI 生成续写代码 |
| **结果** | 续写结果可一键插入编辑器光标位置 |

#### F6：单测生成（/test）

| 项目 | 内容 |
|---|---|
| **触发方式** | ① 选中函数 → 右键 "AI: 生成单测"<br>② 聊天面板输入 `/test` |
| **行为** | 获取选中的函数/类代码，AI 生成对应的单元测试代码 |
| **Prompt 策略** | 根据文件语言自动选择测试框架（如 TS → Jest，Python → pytest） |

#### F7：多模型支持

| 项目 | 内容 |
|---|---|
| **描述** | 支持配置多个 AI 模型，通过设置切换 |
| **初期支持** | DeepSeek Chat / DeepSeek Coder / OpenAI GPT-4o / 豆包 |
| **统一协议** | 所有模型通过 OpenAI 兼容协议（`/v1/chat/completions`）对接 |
| **配置方式** | VS Code 设置中配置 API Key、Endpoint、模型名 |

#### F8：快捷指令系统

| 指令 | 功能 | 快捷键 |
|---|---|---|
| `/explain` | 解释选中代码 | `Ctrl+Shift+E` |
| `/fix` | 修复选中代码 | `Ctrl+Shift+F` |
| `/optimize` | 优化选中代码 | — |
| `/complete` | 续写代码 | — |
| `/test` | 生成单测 | — |
| `/clear` | 清空对话 | — |
| `/model` | 切换模型 | — |

### 2.2 后续扩展功能（第二版以后）

| 优先级 | 功能 | 说明 |
|---|---|---|
| P1 | **对话历史持久化** | 对话记录保存到本地文件，重启后可恢复 |
| P1 | **代码 Diff 预览** | AI 修改建议以 Diff 形式展示，一键应用 |
| P2 | **项目上下文感知** | 自动读取项目 README、package.json 等作为上下文 |
| P2 | **自定义 Prompt** | 用户可在设置中自定义系统提示词 |
| P2 | **多文件分析** | 支持分析多个相关文件的逻辑关系 |
| P3 | ~~**内联补全**~~ | ~~类似 Copilot 的行内灰色提示补全~~ **（不开发，与 Copilot 功能重叠，ROI 低）** |
| P3 | **终端错误分析** | 自动捕获终端错误信息并分析 |

---

## 三、开发阶段计划

### 阶段 1：项目初始化与基础框架（预计 1 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 1.1 | 初始化 VS Code 插件项目（package.json, tsconfig, esbuild） | 可编译运行的空插件 |
| 1.2 | 实现插件入口 `extension.ts`，注册激活/销毁生命周期 | 插件可加载 |
| 1.3 | 实现配置管理 `config.ts`，读取 VS Code settings | API Key 等配置可读写 |
| 1.4 | 实现日志管理 `logger.ts`，使用 OutputChannel | 可在"输出"面板查看日志 |
| 1.5 | 注册侧边栏 WebviewViewProvider | 侧边栏出现空面板 |

**验收标准**：`F5` 运行插件后，侧边栏出现空的 AI 面板，输出面板有日志。

---

### 阶段 2：聊天界面开发（预计 1.5 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 2.1 | 编写 Webview HTML/CSS 主框架 | 聊天界面基本布局 |
| 2.2 | 实现 VS Code 明暗主题适配 | 跟随 IDE 主题切换 |
| 2.3 | 实现消息收发机制（Webview ↔ Extension 双向通信） | 用户发消息、收到回复 |
| 2.4 | 集成 Markdown 渲染 + 代码高亮 | AI 回复的代码块有高亮 |
| 2.5 | 实现流式输出的前端展示（逐字显示） | 打字机效果 |
| 2.6 | 实现"复制代码"和"插入到编辑器"按钮 | 代码块右上角操作按钮 |

**验收标准**：可以在聊天面板发送消息，收到模拟回复，Markdown 正确渲染，代码有高亮。

---

### 阶段 3：AI API 对接层（预计 1 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 3.1 | 定义 API 请求/响应类型 `types.ts` | 统一的类型定义 |
| 3.2 | 实现 OpenAI 兼容协议的 API 适配器 `base.ts` | 可发送请求并获取回复 |
| 3.3 | 实现 SSE 流式响应解析 `stream.ts` | 流式逐字返回 |
| 3.4 | 实现模型配置管理 `models.ts` | 支持多模型切换 |
| 3.5 | 错误处理：网络错误、API 限流、Key 无效等 | 友好的错误提示 |

**验收标准**：配置 API Key 后，在聊天面板发问能收到真实 AI 回复，流式显示正常。

---

### 阶段 4：Prompt 工程与核心命令（预计 2 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 4.1 | 编写系统提示词 `system.ts`（借鉴 Claude 的设计模式） | 高质量系统 Prompt |
| 4.2 | 编写各功能 Prompt 模板（explain/fix/optimize/complete/test） | 5 套 Prompt |
| 4.3 | 实现编辑器交互工具 `editor.ts`（获取选中代码、文件信息、诊断信息） | 编辑器数据获取 |
| 4.4 | 实现上下文构建 `context.ts`（文件语言、项目信息） | 智能上下文 |
| 4.5 | 注册所有 VS Code 命令和右键菜单 | 右键菜单和命令面板可用 |
| 4.6 | 实现快捷指令解析（聊天面板输入 `/fix` 等自动触发对应功能） | 指令系统工作 |
| 4.7 | 实现"代码插入编辑器"功能 | AI 生成的代码可一键插入 |

**验收标准**：选中代码 → 右键 → 各功能菜单正常工作，AI 给出高质量的回复。

---

### 阶段 5：打磨与测试（预计 1.5 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 5.1 | UI 打磨：加载状态、错误提示、空状态、滚动行为 | 完善的交互体验 |
| 5.2 | 快捷键绑定 | 键盘快捷操作 |
| 5.3 | 插件设置页面完善（contributes.configuration） | 可在设置中配置所有选项 |
| 5.4 | 基础测试编写 | 核心功能测试覆盖 |
| 5.5 | README.md 编写 | 使用说明和截图 |
| 5.6 | 打包为 .vsix 文件测试 | 可分发的安装包 |

**验收标准**：完整的插件体验，可打包分发，README 完善。

---

## 四、工期汇总

| 阶段 | 预估时间 | 累计 |
|---|---|---|
| 阶段 1：项目初始化与基础框架 | 1 天 | 1 天 |
| 阶段 2：聊天界面开发 | 1.5 天 | 2.5 天 |
| 阶段 3：AI API 对接层 | 1 天 | 3.5 天 |
| 阶段 4：Prompt 工程与核心命令 | 2 天 | 5.5 天 |
| 阶段 5：打磨与测试 | 1.5 天 | **7 天** |

**总计：约 7 个工作日**完成 MVP 版本。

---

## 五、技术要点与设计决策

### 5.1 为什么选择 OpenAI 兼容协议？

DeepSeek、豆包、OpenAI、很多国内大模型厂商都提供了 OpenAI 兼容的 API 接口，
使用统一的 `/v1/chat/completions` 端点。这意味着：

- 只需要编写**一套 API 调用代码**
- 切换模型只需修改 `baseUrl` + `model` + `apiKey` 三个参数
- 未来接入新模型几乎零成本

### 5.2 Webview 通信机制

```
┌─────────────┐     postMessage      ┌─────────────────┐
│  Webview     │ ◄──────────────────► │  Extension Host  │
│  (前端 UI)   │                      │  (Node.js 后端)   │
│              │  ← AI 流式回复        │                   │
│  用户输入 →  │  → 获取选中代码       │  → 调用 AI API    │
│              │  ← 渲染回复消息       │  ← 解析 SSE 响应  │
└─────────────┘                      └─────────────────┘
```

VS Code Webview 通过 `vscode.postMessage()` 和 `onDidReceiveMessage` 进行双向通信。
Extension Host 负责调用 AI API 和访问 VS Code API（编辑器、文件系统等）。

### 5.3 主题适配策略

使用 VS Code 提供的 CSS 变量自动适配明暗主题：

```css
/* 自动适配用户的 VS Code 主题 */
body {
  color: var(--vscode-foreground);
  background-color: var(--vscode-sideBar-background);
  font-family: var(--vscode-font-family);
}

/* 代码块样式 */
pre {
  background-color: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-widget-border);
}
```

### 5.4 流式输出实现方案

```
用户发送 → Extension 构建请求 → fetch(stream: true) → 逐块读取 SSE
    ↓
每收到一块数据 → postMessage 到 Webview → 追加到当前消息 DOM → 滚动到底部
    ↓
收到 [DONE] 信号 → 标记消息完成 → 启用操作按钮（复制、插入）
```

### 5.5 从 Claude 源码借鉴的设计模式

| 借鉴点 | Claude 源码位置 | 我们的应用 |
|---|---|---|
| **Prompt 分层设计** | `prompts.ts` 的静态/动态分区 | 系统 Prompt + 功能 Prompt + 上下文拼接 |
| **代码风格指导** | `getSimpleDoingTasksSection()` | 系统 Prompt 中的行为规则 |
| **最小化改动原则** | "三行相似代码比过早抽象更好" | 写入 fix/optimize Prompt |
| **操作安全规则** | `getActionsSection()` | 参考其风险评估思路 |
| **技能系统** | `skills/bundled/*.ts` | 快捷指令系统 `/fix` `/explain` 等 |
| **Section 注册模式** | `systemPromptSections.ts` | Prompt 模块化组装方式 |

---

## 六、前置准备

### 6.1 开发环境要求

- **Node.js** >= 18.x
- **VS Code** >= 1.85.0
- **npm** >= 9.x
- **TypeScript** >= 5.x

### 6.2 需要用户提前准备的

| 项目 | 说明 |
|---|---|
| **AI API Key** | 至少准备一个：DeepSeek API Key / OpenAI API Key / 豆包 API Key |
| **插件名称** | 你希望插件叫什么名字？（如 "MyAI Coder"、"AI 编程助手" 等） |
| **插件 ID** | VS Code 插件的唯一标识符（如 `yourname.my-ai-plugin`） |

---

## 七、风险与注意事项

| 风险 | 应对策略 |
|---|---|
| API 调用费用 | 使用 DeepSeek 作为默认模型（性价比最高），Prompt 精简控制 token |
| 网络不稳定 | 实现请求超时、自动重试、友好的错误提示 |
| 模型回复质量 | 精心设计 Prompt，借鉴 Claude 的成熟 Prompt 工程经验 |
| VS Code 版本兼容 | 使用稳定 API，设置最低兼容版本 |
| 大文件上下文 | 限制发送的代码行数，避免超出模型 token 限制 |

---

> **下一步**：确认此开发计划后，我将立即开始阶段 1 的开发工作。
> 如有需要调整的内容（如插件名称、优先功能、技术选择等），请告知。

---

## 八、原始阶段完成情况

以下各阶段已全部交付完成，统一打勾归档：

- [x] 阶段 1：项目初始化与基础框架
- [x] 阶段 2：聊天界面开发（流式输出、Markdown 渲染、主题适配）
- [x] 阶段 3：AI API 对接层（OpenAI 兼容协议、SSE 流式解析、多模型）
- [x] 阶段 4：Prompt 工程与核心命令（系统 Prompt、slash 命令、编辑器交互）
- [x] 阶段 5：打磨与测试（UI 完善、打包为 `my-ai-plugin-0.1.0.vsix`）

### 统一变更栏二次修复（阶段 5 后追加）

- [x] 修复：生成中按 `Enter` 不应绕过停止语义
- [x] 修复：`edit_file` 预览与真实执行一致（`oldContent` 为空 / 匹配失败时给出明确提示）
- [x] 补充：summary 增加 applying / accepted / partial / failed / rejected / cancelled 状态
- [x] 补充：summary 显示相对路径，避免同名文件混淆
- [x] 验证：`tsc --noEmit` 与关键前端脚本语法检查通过
- [x] 重新构建打包：已生成最新 `my-ai-plugin-0.1.0.vsix`

---

## 九、第二轮迭代：输入区三大能力扩展

### 9.1 背景与目标

围绕输入区左下角 `+` 菜单，对三个已有骨架但尚未实现的能力进行完整落地：

| 入口 | 当前状态 | 目标 |
|---|---|---|
| `Mentions` | 已有 `showOpenDialog` 实现，但与 `@` 逻辑独立 | 统一两个入口，支持下拉搜索 |
| `Trigger Workflow` | stub（只弹提示"开发中"） | 发现并触发 workflow，含确认机制 |
| `Upload Image` | stub（只弹提示"开发中"） | 完整图片上传、预览、发送链路 |

### 9.2 现状盘点（Stage A 调查结果）

#### `+` 菜单现状

- HTML 已有三个 `context-panel-item`，`data-action` 分别为 `mentions` / `workflow` / `upload`
- 前端点击后统一通过 `vscode.postMessage({ type: 'contextAction', action })` 发消息
- 后端 `handleContextAction` 已处理 `mentions`（`showOpenDialog` 多选文件），`workflow` 和 `upload` 是 stub

#### `@` mention 现状

- 前端有完整状态机：`mentionActive` / `mentionStartPos` / `mentionActiveIndex`
- `input` 事件检测光标前 `@` 符号，防抖 200ms 后发 `searchWorkspaceFiles` 请求
- 键盘导航完整（↑↓ Enter Escape）
- **关键差距**：`+` 的 Mentions 走系统文件对话框，`@` 走下拉搜索，两条路径独立

#### 发送链路现状

- `sendMessage` 只发 `{ type: 'sendMessage', text }`，**没有 images 字段**
- `buildContextContent` 读取 `contextFiles` 拼入文本 Prompt，读后清空
- 图片暂无任何注入路径

#### 模型配置现状

- `ModelConfig`（`src/prompts/types.ts`）当前字段：`modelName` / `modelId` / `baseUrl` / `apiKey` / `knowledgeCutoff`
- **无视觉能力标识字段**，需要扩展 `supportsVision?: boolean`

### 9.3 三个能力的分析与建议

#### Mentions

**定位**：给当前对话补充上下文，是三个入口里最核心、最高频的能力。

**设计建议**：
- `+` 菜单中的 Mentions 与输入框 `@` 必须复用同一套下拉搜索逻辑
- 选择结果绑定真实路径（URI），不依赖文件名
- 展示为可删除标签，方便用户确认当前上下文
- 存在同名文件时必须展示相对路径

**风险点**：
- 两个入口逻辑不一致导致状态不同步
- 文件移动或重命名后旧引用无法恢复

#### Trigger Workflow

**定位**：触发一套预定义动作（非"补充上下文"），属于"执行动作"语义层。

**设计建议**：
- 与"添加上下文"入口在菜单中做分组区分
- 点击后先展示工作流名称、说明、是否修改文件/执行命令，再二次确认
- 当前无可用 workflow 时置灰或隐藏，不留空入口

**风险点**：
- 点击后直接执行，用户缺少控制感
- 工作流来源不清晰时用户不知道触发了什么

#### Upload Image

**定位**：把截图、设计稿、错误界面等非文本内容作为上下文传给模型。

**设计建议**：
- 支持点击选择、拖拽上传、`Ctrl+V` 粘贴三种入口
- 上传后展示缩略图 + 删除按钮 + 大小提示
- 发送前校验：当前模型是否支持视觉输入、图片大小/数量是否超限
- 明确提示图片会发送给模型提供方

**风险点**：
- 当前模型不支持视觉却允许上传导致用户误解
- 图片过大/过多导致上下文开销陡增

### 9.4 推荐的菜单信息架构

```
+ 菜单
├── [添加上下文]
│   ├── @ 引用文件     ← Mentions
│   └── 上传图片       ← Upload Image
└── [执行动作]
    └── 运行工作流     ← Trigger Workflow
```

**推荐实现顺序**：Mentions → Upload Image → Trigger Workflow

### 9.5 影响范围

| 模块 | 影响 |
|---|---|
| `media/chat.js` | `+` 菜单 Mentions 复用 `@` 下拉逻辑；sendMessage 扩展 images 字段 |
| `media/chat.css` | 图片附件缩略图样式；菜单分组样式 |
| `src/webview/ChatViewProvider.ts` | `handleContextAction` 补完 workflow 和 upload；`buildContextContent` 支持图片 |
| `src/webview/messageTypes.ts` | 新增图片相关消息类型 |
| `src/prompts/types.ts` | `ModelConfig` 扩展 `supportsVision` 字段 |
| `src/utils/context.ts` | `getModelConfig` 补充视觉能力识别逻辑 |

### 9.6 执行计划

#### 阶段 A：梳理现状与约束 ✅

- [x] 盘点当前 `+` 菜单、`@` 触发、发送链路现状
- [x] 明确三个入口各自的前后端边界与复用点
- [x] 确认当前模型配置中是否具备视觉能力标识的扩展空间

#### 阶段 B：Mentions 统一落地 ✅

- [x] 把 `+` 菜单 Mentions 改为触发与 `@` 相同的下拉搜索（复用前端 mention 状态机）
- [x] 统一 Mentions 标签状态：添加、删除、恢复行为一致
- [x] 处理同名文件展示，默认使用相对路径
- [x] 确认 Mentions 选中内容如何拼接到发送上下文

#### 阶段 C：Upload Image 设计与落地 ✅

- [x] 扩展 `ModelConfig` 添加 `supportsVision?: boolean` 字段
- [x] 在 `getModelConfig` 中根据 `modelId` 识别视觉支持（GPT-4o、doubao-vision-* 等）
- [x] 设计图片附件的数据结构与前后端消息格式
- [x] 前端支持点击选择、拖拽上传、粘贴截图三种入口
- [x] 增加缩略图展示、删除按钮、大小/数量校验
- [x] 增加模型视觉能力检测与用户提示
- [x] 扩展 `sendMessage` 消息支持传递 images 数组
- [x] `handleUserMessage` 根据视觉能力组装多模态 ContentPart 消息

#### 阶段 D：Trigger Workflow 设计与落地 ✅

- [x] 盘点 `.windsurf/workflows/` 发现机制，实现 `discoverWorkflows` 后端方法
- [x] 使用 VS Code QuickPick 展示可用工作流（空态显示提示信息）
- [x] 增加执行前确认弹窗，展示名称、说明、副作用标注（可能修改文件/执行命令）
- [x] workflow 执行后通过 `handleUserMessage` 进入正常 AI 发送链路

#### 阶段 E：统一体验收尾 ✅

- [x] 重新整理 `+` 菜单结构与分组顺序（添加上下文 / 执行动作），中文化标签
- [x] 补充异常提示：视觉不支持警告、图片大小/数量超限、工作流空态提示
- [x] 构建通过，输入区交互逻辑无回归
- [ ] 同步 README / CHANGELOG（待用户确认后执行）

### 9.7 执行原则

- 先高频基础能力（Mentions），再做图片，最后做 Workflow
- 所有会改文件、执行命令的流程必须有明确确认链路
- 尽量复用现有输入区逻辑，避免新增平行状态
- 每完成一个阶段，做局部验证再推进下一阶段
