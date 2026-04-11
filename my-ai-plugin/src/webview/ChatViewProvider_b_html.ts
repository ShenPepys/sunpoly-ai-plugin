import * as vscode from 'vscode';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}

export function buildChatViewHtml(options: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  panelTitle: string;
  shouldShowWelcomeOnInitialRender: boolean;
}): string {
  const cssUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.extensionUri, 'media', 'chat.css')
  );
  const renderJsUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.extensionUri, 'dist', 'media', 'chat_a_render.js')
  );
  const stepsJsUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.extensionUri, 'dist', 'media', 'chat_b_steps.js')
  );
  const jsUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.extensionUri, 'dist', 'media', 'chat.js')
  );

  const nonce = getNonce();
  const initialMessagesHtml = options.shouldShowWelcomeOnInitialRender
    ? `<div class="welcome-message">
        <p><strong>👋 你好！我是 ${options.panelTitle}</strong></p>
        <div class="welcome-section">
          <p class="welcome-subtitle">快捷键</p>
          <div class="welcome-shortcuts">
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>Q</kbd><span>聚焦聊天</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>E</kbd><span>解释代码</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>F</kbd><span>修复代码</span></div>
            <div class="shortcut-item"><kbd>Alt</kbd>+<kbd>M</kbd><span>切换模式</span></div>
          </div>
        </div>
        <div class="welcome-section">
          <p class="welcome-subtitle">快速操作</p>
          <div class="welcome-shortcuts">
            <div class="shortcut-item"><kbd>@</kbd><span>引用工作区文件</span></div>
            <div class="shortcut-item"><kbd>/</kbd><span>Slash 快捷命令</span></div>
          </div>
        </div>
        <p class="welcome-hint">选中代码后右键也可使用 AI 功能</p>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${options.webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      img-src ${options.webview.cspSource} data:;
      font-src ${options.webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>AI 聊天</title>
</head>
<body>
  <div id="chat-container">
    <div id="search-bar" class="search-bar hidden">
      <input id="search-input" type="text" placeholder="搜索对话内容..." />
      <span id="search-count" class="search-count"></span>
      <button id="search-prev" class="search-nav-btn" title="上一个">▲</button>
      <button id="search-next" class="search-nav-btn" title="下一个">▼</button>
      <button id="search-close" class="search-nav-btn" title="关闭搜索">✕</button>
    </div>
    <div id="session-tabs-bar" class="session-tabs-bar hidden">
      <div id="session-tabs" class="session-tabs"></div>
    </div>
    <div id="messages">
      ${initialMessagesHtml}
    </div>

    <div id="loading" class="hidden">
      <div class="loading-dots">
        <span></span><span></span><span></span>
      </div>
    </div>

    <div id="model-panel" class="model-panel hidden">
      <div class="model-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="model-search" type="text" placeholder="搜索模型..." />
      </div>
      <div id="model-panel-list" class="model-panel-list"></div>
    </div>

    <div id="context-panel" class="context-panel hidden">
      <div class="context-panel-group-label">添加上下文</div>
      <div class="context-panel-item" data-action="mentions">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>
        </div>
        <span class="context-item-label">@ 引用文件</span>
      </div>
      <div class="context-panel-item" data-action="upload">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
        <span class="context-item-label">上传图片</span>
      </div>
      <div class="context-panel-separator"></div>
      <div class="context-panel-group-label">执行动作</div>
      <div class="context-panel-item" data-action="workflow">
        <div class="context-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
        </div>
        <span class="context-item-label">运行工作流</span>
      </div>
    </div>

    <div id="mode-panel" class="mode-panel hidden">
      <div class="mode-panel-item active" data-mode="code">
        <div class="mode-item-icon">&lt;&gt;</div>
        <div class="mode-item-info">
          <div class="mode-item-name">Code<span class="mode-item-check">✓</span></div>
          <div class="mode-item-desc">Can write and edit code</div>
        </div>
      </div>
      <div class="mode-panel-item" data-mode="ask">
        <div class="mode-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="mode-item-info">
          <div class="mode-item-name">Ask</div>
          <div class="mode-item-desc">Reads but won't edit</div>
        </div>
      </div>
      <div class="mode-panel-item" data-mode="plan">
        <div class="mode-item-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="16" x2="12" y2="16"/></svg>
        </div>
        <div class="mode-item-info">
          <div class="mode-item-name">Plan</div>
          <div class="mode-item-desc">Plan changes before implementing</div>
        </div>
      </div>
      <div class="mode-panel-hint">Use <kbd>Ctrl</kbd> <kbd>.</kbd> to switch modes</div>
    </div>

    <div id="input-area">
      <div id="mention-dropdown" class="mention-dropdown hidden"></div>
      <div id="context-files" class="context-files"></div>
      <div id="image-attachments" class="image-attachments"></div>
      <textarea
        id="user-input"
        placeholder="输入任何问题...（Ctrl+L）"
        rows="2"
      ></textarea>
      <div id="input-toolbar">
        <div class="input-toolbar-left">
          <button id="btn-add-context" class="toolbar-icon-btn" title="添加上下文">+</button>
          <button id="btn-terminal-error" class="toolbar-icon-btn" title="分析终端错误（先在终端复制错误文本）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="7 9 12 12 17 9" style="stroke-width:1.5"/></svg>
          </button>
          <button id="btn-code-mode" class="toolbar-icon-btn" title="切换工作模式">&lt;&gt;<span class="toolbar-text"> Code</span></button>
          <div id="model-selector" class="model-selector">
            <span id="model-label" class="model-label"><span class="toolbar-text">DeepSeek Chat</span></span>
          </div>
          <button id="btn-settings" class="toolbar-icon-btn" title="配置模型与 API Key">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </button>
        </div>
        <div class="input-toolbar-right">
          <span id="char-count" class="char-count" title="输入字符数"></span>
          <span id="token-count" class="token-count" title="当前对话估算 Token 数"></span>
          <button id="btn-export" class="toolbar-icon-btn" title="导出对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button id="btn-new-session" class="toolbar-icon-btn session-new-btn" title="新建对话 (Ctrl+Shift+N)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button id="btn-clear" class="toolbar-icon-btn" title="清空对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
          <button id="btn-send" class="send-btn" title="发送消息">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${renderJsUri}"></script>
  <script nonce="${nonce}" src="${stepsJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
