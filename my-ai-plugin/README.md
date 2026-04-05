# AI 助理 - VS Code 插件

基于 OpenAI 兼容 API 的 AI 助理，支持 DeepSeek、豆包、GPT 等多模型，提供代码解释、Bug 修复、代码优化、续写和单测生成等功能。

## 功能一览

### 核心功能
- **多模型支持**：配置多个 AI 模型，快速切换（DeepSeek / 豆包 / OpenAI / Claude 等）
- **三种工作模式**：Code（可修改文件）、Ask（只读对话）、Plan（先规划后执行）
- **流式对话**：实时显示 AI 回复，支持 SSE 流式传输
- **工具调用**：AI 可读写文件、列出目录，自动执行多轮工具调用
- **Thinking 动画**：AI 思考过程可视化

### 代码操作（右键菜单 + 快捷键）
| 功能 | 快捷键 |
|------|--------|
| 解释代码 | `Alt+E` |
| 修复代码 | `Alt+F` |
| 优化代码 | 右键菜单 |
| 续写代码 | 右键菜单 |
| 生成单测 | 右键菜单 |

### 聊天增强
- **@ Mentions**：输入 `@` 引用工作区文件作为上下文
- **拖拽文件**：从资源管理器拖拽文件到输入区域，自动添加为上下文
- **Slash 命令**：输入 `/` 触发快捷命令（`/explain` `/fix` `/optimize` `/test` `/complete` `/clear`）
- **聊天内搜索**：`Ctrl+F` 搜索对话内容，高亮匹配，上下导航
- **对话历史持久化**：重启 VS Code 后对话不丢失
- **输入历史回溯**：`↑` / `↓` 箭头浏览之前的输入
- **导出对话**：一键导出为 Markdown 文件
- **Token 用量估算**：实时显示当前对话的 Token 消耗
- **输入框字符计数**：实时显示输入字符数，超长时变色警告

### UI 体验
- **代码块增强**：语法高亮 + 复制/插入按钮 + 行号显示（>5 行时）
- **Markdown 表格渲染**：支持对齐方式
- **停止生成**：点击按钮或按 `Escape` 中断 AI 回复（已接收内容保留）
- **复制 AI 回复**：hover 时显示复制全文按钮
- **消息时间戳**：hover 显示发送时间
- **智能自动滚动**：用户上翻时暂停，回底部后恢复
- **欢迎页**：功能引导和快捷键提示
- **输入框提示轮换**：定期切换提示文本，引导发现功能
- **错误重试**：失败消息显示重试按钮

### 快捷键
| 快捷键 | 功能 |
|--------|------|
| `Alt+Q` | 聚焦聊天输入框 |
| `Alt+M` | 切换工作模式（Code → Ask → Plan） |
| `Alt+N` | 新建对话 |
| `Ctrl+F` | 搜索对话内容 |
| `Escape` | 停止 AI 生成 / 关闭搜索 |
| `↑` / `↓` | 浏览输入历史 |

### 智能特性
- **状态栏模型指示器**：底部显示当前模型名，切换时自动同步
- **项目类型自动检测**：识别 Node.js/TypeScript/Python/Go/Rust 等技术栈，增强 AI 上下文
- **Git 状态感知**：自动检测当前分支和未提交变更文件，注入 AI 上下文
- **上下文窗口管理**：长对话自动截断旧消息，防止 Token 超限
- **网络代理支持**：HTTP/HTTPS 代理（CONNECT 隧道），兼容 VS Code `http.proxy` 配置
- **API 双重超时**：连接超时（30s）+ 流式空闲超时（60s）
- **启动配置校验**：缺少 API Key 时自动提示
- **Webview 状态持久化**：切换标签页后输入内容和滚动位置不丢失

## 配置

在 VS Code 设置中搜索 `myAiPlugin`：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `myAiPlugin.models` | AI 模型列表（数组） | DeepSeek Chat |
| `myAiPlugin.activeModelIndex` | 当前激活的模型索引 | 0 |
| `myAiPlugin.maxTokens` | 最大输出 Token 数 | 4096 |
| `myAiPlugin.temperature` | 温度参数 | 0.3 |
| `myAiPlugin.language` | 回复语言 | 中文 |
| `myAiPlugin.proxy` | 代理地址（如 `http://127.0.0.1:7890`） | 空 |

### 模型配置示例

```json
{
  "myAiPlugin.models": [
    {
      "name": "DeepSeek Chat",
      "modelId": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-xxx"
    },
    {
      "name": "GPT-4o",
      "modelId": "gpt-4o",
      "baseUrl": "https://api.openai.com",
      "apiKey": "sk-xxx"
    }
  ]
}
```

