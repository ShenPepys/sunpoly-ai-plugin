/**
 * AI 聊天面板前端逻辑
 * 
 * 运行在 VS Code Webview 沙箱中，负责：
 * 1. 用户输入处理（发送消息、快捷键）
 * 2. 消息渲染（Markdown → HTML）
 * 3. 与 Extension Host 的 postMessage 通信
 * 4. 流式输出的逐字显示
 */

// @ts-nocheck
(function () {
  'use strict';

  // VS Code Webview API（由 VS Code 注入）
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ==================== DOM 元素引用 ====================
  const messagesContainer = document.getElementById('messages');
  const userInput = document.getElementById('user-input');
  const btnSend = document.getElementById('btn-send');
  const btnClear = document.getElementById('btn-clear');
  const loadingEl = document.getElementById('loading');

  // ==================== 流式消息缓冲 ====================
  /** 存储流式传输中的消息 ID 对应的原始文本，渲染完成后删除 */
  const streamBuffers = {};

  // ==================== 事件绑定 ====================

  /** 发送按钮点击 */
  btnSend.addEventListener('click', sendMessage);

  /** 清空按钮点击 */
  btnClear.addEventListener('click', function () {
    vscode.postMessage({ type: 'clearChat' });
  });

  /** 输入框键盘事件：Enter 发送，Shift+Enter 换行 */
  userInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  /** 输入框自动调整高度 */
  userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    const maxHeight = 150;
    this.style.height = Math.min(this.scrollHeight, maxHeight) + 'px';
  });

  // ==================== 消息发送 ====================

  /** 发送用户消息到 Extension */
  function sendMessage() {
    const text = userInput.value.trim();
    if (!text) {
      return;
    }

    vscode.postMessage({
      type: 'sendMessage',
      text: text,
    });

    // 清空输入框并重置高度
    userInput.value = '';
    userInput.style.height = 'auto';
    userInput.focus();
  }

  // ==================== 接收 Extension 消息 ====================

  window.addEventListener('message', function (event) {
    const message = event.data;

    switch (message.type) {
      case 'addMessage':
        addMessageToUI(message.role, message.content, message.messageId);
        break;

      case 'streamChunk':
        handleStreamChunk(message.messageId, message.chunk);
        break;

      case 'streamDone':
        handleStreamDone(message.messageId);
        break;

      case 'showError':
        showError(message.message);
        break;

      case 'setLoading':
        setLoading(message.loading);
        break;

      case 'clearChat':
        clearChat();
        break;
    }
  });

  // ==================== UI 渲染函数 ====================

  /**
   * 添加一条消息到聊天界面
   * @param {'user' | 'assistant'} role 消息角色
   * @param {string} content 消息内容（Markdown 格式）
   * @param {string} messageId 消息唯一 ID
   */
  function addMessageToUI(role, content, messageId) {
    // 移除欢迎消息（只在第一条消息时）
    const welcome = messagesContainer.querySelector('.welcome-message');
    if (welcome) {
      welcome.remove();
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'message ' + role;
    messageEl.setAttribute('data-message-id', messageId);

    const roleLabel = role === 'user' ? '你' : 'AI';
    const roleIcon = role === 'user' ? '👤' : '🤖';

    messageEl.innerHTML =
      '<div class="message-header">' +
        '<span class="role-icon">' + roleIcon + '</span>' +
        '<span>' + roleLabel + '</span>' +
      '</div>' +
      '<div class="message-body">' + renderMarkdown(content) + '</div>';

    messagesContainer.appendChild(messageEl);
    scrollToBottom();
  }

  /**
   * 处理流式追加的文本片段
   * 将新的 chunk 追加到对应消息，重新渲染 Markdown
   */
  function handleStreamChunk(messageId, chunk) {
    // 初始化缓冲区
    if (!streamBuffers[messageId]) {
      streamBuffers[messageId] = '';

      // 创建消息容器（如果不存在）
      let messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (!messageEl) {
        addMessageToUI('assistant', '', messageId);
      }
    }

    // 追加文本到缓冲区
    streamBuffers[messageId] += chunk;

    // 重新渲染消息内容
    const messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (messageEl) {
      const bodyEl = messageEl.querySelector('.message-body');
      if (bodyEl) {
        bodyEl.innerHTML = renderMarkdown(streamBuffers[messageId]);
      }
    }

    scrollToBottom();
  }

  /**
   * 流式传输完成后的清理工作
   */
  function handleStreamDone(messageId) {
    // 做一次最终渲染，确保 Markdown 完整
    if (streamBuffers[messageId]) {
      const messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (messageEl) {
        const bodyEl = messageEl.querySelector('.message-body');
        if (bodyEl) {
          bodyEl.innerHTML = renderMarkdown(streamBuffers[messageId]);
          // 为代码块绑定按钮事件
          bindCodeBlockButtons(bodyEl);
        }
      }
    }

    // 清除缓冲
    delete streamBuffers[messageId];
    setLoading(false);
  }

  /** 显示错误消息 */
  function showError(errorMessage) {
    const errorEl = document.createElement('div');
    errorEl.className = 'message assistant';
    errorEl.innerHTML =
      '<div class="message-header">' +
        '<span class="role-icon">⚠️</span>' +
        '<span>错误</span>' +
      '</div>' +
      '<div class="message-body" style="color: var(--vscode-errorForeground, #f44);">' +
        escapeHtml(errorMessage) +
      '</div>';

    messagesContainer.appendChild(errorEl);
    scrollToBottom();
    setLoading(false);
  }

  /** 设置加载状态 */
  function setLoading(loading) {
    if (loading) {
      loadingEl.classList.remove('hidden');
      btnSend.disabled = true;
    } else {
      loadingEl.classList.add('hidden');
      btnSend.disabled = false;
    }
    scrollToBottom();
  }

  /** 清空聊天界面 */
  function clearChat() {
    messagesContainer.innerHTML =
      '<div class="welcome-message">' +
        '<p><strong>对话已清空</strong></p>' +
        '<p>你可以开始新的对话。</p>' +
      '</div>';
  }

  /** 滚动到底部 */
  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ==================== Markdown 渲染 ====================

  /**
   * 简易 Markdown → HTML 转换器
   * 支持：代码块、行内代码、加粗、斜体、标题、列表、引用、分隔线、链接
   * 注意：这是一个轻量实现，覆盖常见场景。后续可替换为 marked.js
   */
  function renderMarkdown(text) {
    if (!text) {
      return '';
    }

    // 第一步：提取代码块，用占位符替代（避免块内内容被其他规则误处理）
    var codeBlocks = [];
    var processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var index = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code: code });
      return '___CODE_BLOCK_' + index + '___';
    });

    // 第二步：按行处理
    var lines = processed.split('\n');
    var html = '';
    var inList = false;
    var listType = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 标题
      if (/^### (.+)/.test(line)) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<h3>' + renderInline(line.slice(4)) + '</h3>';
        continue;
      }
      if (/^## (.+)/.test(line)) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<h2>' + renderInline(line.slice(3)) + '</h2>';
        continue;
      }
      if (/^# (.+)/.test(line)) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<h1>' + renderInline(line.slice(2)) + '</h1>';
        continue;
      }

      // 分隔线
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<hr>';
        continue;
      }

      // 引用
      if (/^> (.+)/.test(line)) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<blockquote>' + renderInline(line.slice(2)) + '</blockquote>';
        continue;
      }

      // 无序列表
      if (/^[-*] (.+)/.test(line)) {
        if (!inList || listType !== 'ul') {
          if (inList) { html += '</' + listType + '>'; }
          html += '<ul>';
          inList = true;
          listType = 'ul';
        }
        html += '<li>' + renderInline(line.replace(/^[-*] /, '')) + '</li>';
        continue;
      }

      // 有序列表
      if (/^\d+\. (.+)/.test(line)) {
        if (!inList || listType !== 'ol') {
          if (inList) { html += '</' + listType + '>'; }
          html += '<ol>';
          inList = true;
          listType = 'ol';
        }
        html += '<li>' + renderInline(line.replace(/^\d+\. /, '')) + '</li>';
        continue;
      }

      // 结束列表
      if (inList && line.trim() === '') {
        html += '</' + listType + '>';
        inList = false;
        continue;
      }

      // 代码块占位符
      var blockMatch = line.match(/^___CODE_BLOCK_(\d+)___$/);
      if (blockMatch) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        var blockIndex = parseInt(blockMatch[1], 10);
        var block = codeBlocks[blockIndex];
        html += renderCodeBlock(block.lang, block.code);
        continue;
      }

      // 空行
      if (line.trim() === '') {
        continue;
      }

      // 普通段落
      if (inList) { html += '</' + listType + '>'; inList = false; }
      html += '<p>' + renderInline(line) + '</p>';
    }

    // 关闭未闭合的列表
    if (inList) {
      html += '</' + listType + '>';
    }

    return html;
  }

  /**
   * 渲染行内 Markdown 元素
   * 支持：行内代码、加粗、斜体、链接
   */
  function renderInline(text) {
    var result = escapeHtml(text);

    // 行内代码（必须在加粗/斜体之前处理）
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 加粗
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 斜体
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 链接
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" title="$1">$1</a>');

    return result;
  }

  /**
   * 渲染代码块
   * 带有语言标签、复制按钮和插入按钮
   */
  function renderCodeBlock(lang, code) {
    var langLabel = lang || '代码';
    var escapedCode = escapeHtml(code.replace(/\n$/, ''));

    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' +
        '<span>' + langLabel + '</span>' +
        '<div class="code-block-actions">' +
          '<button class="btn-copy-code" title="复制代码">复制</button>' +
          '<button class="btn-insert-code" title="插入到编辑器">插入</button>' +
        '</div>' +
      '</div>' +
      '<pre><code>' + escapedCode + '</code></pre>' +
    '</div>';
  }

  /**
   * HTML 转义，防止 XSS
   */
  function escapeHtml(text) {
    var map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, function (c) { return map[c]; });
  }

  // ==================== 代码块按钮事件 ====================

  /**
   * 为消息体内的代码块按钮绑定事件
   * 使用事件委托，避免每个按钮单独绑定
   */
  messagesContainer.addEventListener('click', function (e) {
    var target = e.target;

    // 复制代码按钮
    if (target.classList.contains('btn-copy-code')) {
      var wrapper = target.closest('.code-block-wrapper');
      if (wrapper) {
        var codeEl = wrapper.querySelector('pre code');
        if (codeEl) {
          vscode.postMessage({
            type: 'copyCode',
            code: codeEl.textContent,
          });
          target.textContent = '已复制 ✓';
          setTimeout(function () { target.textContent = '复制'; }, 1500);
        }
      }
    }

    // 插入代码按钮
    if (target.classList.contains('btn-insert-code')) {
      var wrapper = target.closest('.code-block-wrapper');
      if (wrapper) {
        var codeEl = wrapper.querySelector('pre code');
        if (codeEl) {
          vscode.postMessage({
            type: 'insertCode',
            code: codeEl.textContent,
          });
          target.textContent = '已插入 ✓';
          setTimeout(function () { target.textContent = '插入'; }, 1500);
        }
      }
    }
  });

  /**
   * 为指定元素内的代码块绑定按钮事件
   * 流式传输完成后调用，确保新渲染的代码块也有事件
   */
  function bindCodeBlockButtons(container) {
    // 事件已通过委托处理，此函数保留用于未来扩展
  }

})();
