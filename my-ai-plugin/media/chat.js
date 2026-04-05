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
  const modelLabel = document.getElementById('model-label');
  const modelPanel = document.getElementById('model-panel');
  const modelPanelList = document.getElementById('model-panel-list');
  const modelSearch = document.getElementById('model-search');
  const btnCodeMode = document.getElementById('btn-code-mode');
  const modePanel = document.getElementById('mode-panel');
  const btnAddContext = document.getElementById('btn-add-context');
  const contextPanel = document.getElementById('context-panel');
  const contextFilesContainer = document.getElementById('context-files');
  const mentionDropdown = document.getElementById('mention-dropdown');
  const tokenCountEl = document.getElementById('token-count');
  const charCountEl = document.getElementById('char-count');
  const btnExport = document.getElementById('btn-export');

  /**
   * 关闭所有弹出面板
   * 三个面板互斥显示，每次只能打开一个
   */
  function closeAllPanels() {
    modelPanel.classList.add('hidden');
    modePanel.classList.add('hidden');
    contextPanel.classList.add('hidden');
  }

  // ==================== 流式消息缓冲 ====================
  /** 存储流式传输中的消息 ID 对应的原始文本，渲染完成后删除 */
  const streamBuffers = {};

  // ==================== 事件绑定 ====================

  // ==================== 输入框字符计数 ====================
  /** 更新输入框字符计数显示，超过 500 字符时变色警告 */
  function updateCharCount() {
    var len = userInput.value.length;
    if (len === 0) {
      charCountEl.textContent = '';
      charCountEl.classList.remove('char-warn');
    } else {
      charCountEl.textContent = len + ' 字';
      if (len > 5000) {
        charCountEl.classList.add('char-warn');
      } else {
        charCountEl.classList.remove('char-warn');
      }
    }
  }
  userInput.addEventListener('input', updateCharCount);

  /** 发送按钮点击 */
  btnSend.addEventListener('click', function () {
    if (isGenerating) {
      vscode.postMessage({ type: 'stopGeneration' });
      setLoading(false);
    } else {
      sendMessage();
    }
  });

  /** 清空按钮点击 */
  btnClear.addEventListener('click', function () {
    vscode.postMessage({ type: 'clearChat' });
  });

  /** 模型标签点击：展开/收起模型选择面板（互斥关闭其他面板） */
  modelLabel.addEventListener('click', function (e) {
    e.stopPropagation();
    var isHidden = modelPanel.classList.contains('hidden');
    closeAllPanels();
    if (isHidden) {
      vscode.postMessage({ type: 'requestModels' });
      modelPanel.classList.remove('hidden');
      modelSearch.value = '';
      modelSearch.focus();
    }
  });

  /** Code 按钮点击：展开/收起模式面板（互斥关闭其他面板） */
  btnCodeMode.addEventListener('click', function (e) {
    e.stopPropagation();
    var isHidden = modePanel.classList.contains('hidden');
    closeAllPanels();
    if (isHidden) {
      modePanel.classList.remove('hidden');
    }
  });

  /** + 按钮点击：展开/收起上下文面板（互斥关闭其他面板） */
  btnAddContext.addEventListener('click', function (e) {
    e.stopPropagation();
    var isHidden = contextPanel.classList.contains('hidden');
    closeAllPanels();
    if (isHidden) {
      contextPanel.classList.remove('hidden');
    }
  });

  /** 所有面板内部点击不冒泡（防止关闭） */
  [modelPanel, modePanel, contextPanel].forEach(function (panel) {
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  });

  /** 点击页面其他区域时关闭所有面板 */
  document.addEventListener('click', function () {
    closeAllPanels();
  });

  /** 上下文面板选项点击（功能待实现，先关闭面板） */
  contextPanel.querySelectorAll('.context-panel-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var action = item.getAttribute('data-action');
      vscode.postMessage({ type: 'contextAction', action: action });
      closeAllPanels();
    });
  });

  /** 模式面板选项点击：切换模式 */
  modePanel.querySelectorAll('.mode-panel-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var mode = item.getAttribute('data-mode');
      vscode.postMessage({ type: 'switchMode', mode: mode });
      modePanel.classList.add('hidden');
    });
  });

  /** 快捷键 Ctrl+. 切换模式 */
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === '.') {
      e.preventDefault();
      var modes = ['code', 'ask', 'plan'];
      var currentBtn = btnCodeMode.getAttribute('data-mode') || 'code';
      var nextIndex = (modes.indexOf(currentBtn) + 1) % modes.length;
      vscode.postMessage({ type: 'switchMode', mode: modes[nextIndex] });
    }
  });

  /** 搜索框实时过滤模型列表 */
  modelSearch.addEventListener('input', function () {
    var keyword = modelSearch.value.toLowerCase();
    var items = modelPanelList.querySelectorAll('.model-panel-item');
    var groupTitles = modelPanelList.querySelectorAll('.model-group-title');
    items.forEach(function (item) {
      var name = item.getAttribute('data-name') || '';
      item.style.display = name.toLowerCase().includes(keyword) ? '' : 'none';
    });
    // 隐藏没有可见子项的分组标题
    groupTitles.forEach(function (title) {
      var next = title.nextElementSibling;
      var hasVisible = false;
      while (next && !next.classList.contains('model-group-title')) {
        if (next.style.display !== 'none') { hasVisible = true; }
        next = next.nextElementSibling;
      }
      title.style.display = hasVisible ? '' : 'none';
    });
  });

  // ==================== 输入历史回溯 ====================
  /** 已发送消息的历史列表 */
  var inputHistory = [];
  /** 当前浏览历史的索引（-1 表示不在回溯中） */
  var inputHistoryIndex = -1;
  /** 回溯前暂存的当前输入 */
  var inputHistoryDraft = '';

  // ==================== Slash 命令 ====================
  /** 可用的 slash 命令列表 */
  var slashCommands = [
    { cmd: '/explain', label: '解释代码', desc: '解释选中的代码逻辑' },
    { cmd: '/fix', label: '修复代码', desc: '查找并修复代码 Bug' },
    { cmd: '/optimize', label: '优化代码', desc: '提升代码性能和可读性' },
    { cmd: '/test', label: '生成单测', desc: '为选中代码生成单元测试' },
    { cmd: '/complete', label: '续写代码', desc: '在光标处续写代码' },
    { cmd: '/clear', label: '清空对话', desc: '清空当前对话历史' },
  ];
  /** 当前是否正在 slash 命令模式 */
  var slashActive = false;

  // ==================== @ Mention 搜索状态 ====================
  /** 当前是否正在 @ mention 搜索模式 */
  var mentionActive = false;
  /** @ 符号在输入框中的位置 */
  var mentionStartPos = -1;
  /** 当前高亮的下拉菜单项索引 */
  var mentionActiveIndex = -1;
  /** 防抖定时器 */
  var mentionDebounceTimer = null;

  /** 输入框键盘事件 */
  userInput.addEventListener('keydown', function (e) {
    // Escape 键：优先停止生成，其次关闭菜单
    if (e.key === 'Escape' && isGenerating && !slashActive && !mentionActive) {
      e.preventDefault();
      vscode.postMessage({ type: 'stopGeneration' });
      setLoading(false);
      return;
    }

    // slash 命令下拉菜单打开时的键盘导航
    if (slashActive && !mentionDropdown.classList.contains('hidden')) {
      var items = mentionDropdown.querySelectorAll('.mention-item');

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIndex = Math.min(mentionActiveIndex + 1, items.length - 1);
        updateMentionActiveItem(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActiveIndex = Math.max(mentionActiveIndex - 1, 0);
        updateMentionActiveItem(items);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (mentionActiveIndex >= 0 && items[mentionActiveIndex]) {
          items[mentionActiveIndex].click();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashActive = false;
        closeMentionDropdown();
        return;
      }
    }

    // @ mention 下拉菜单打开时的键盘导航
    if (mentionActive && !mentionDropdown.classList.contains('hidden')) {
      var items = mentionDropdown.querySelectorAll('.mention-item');

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIndex = Math.min(mentionActiveIndex + 1, items.length - 1);
        updateMentionActiveItem(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActiveIndex = Math.max(mentionActiveIndex - 1, 0);
        updateMentionActiveItem(items);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 选中当前高亮项
        if (mentionActiveIndex >= 0 && items[mentionActiveIndex]) {
          items[mentionActiveIndex].click();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionDropdown();
        return;
      }
    }

    // ↑ 箭头：回溯上一条发送的消息（输入框为空或已在回溯中）
    if (e.key === 'ArrowUp' && inputHistory.length > 0) {
      var isEmpty = userInput.value.trim() === '' || inputHistoryIndex >= 0;
      if (isEmpty) {
        e.preventDefault();
        if (inputHistoryIndex < 0) {
          inputHistoryDraft = userInput.value;
          inputHistoryIndex = inputHistory.length - 1;
        } else if (inputHistoryIndex > 0) {
          inputHistoryIndex--;
        }
        userInput.value = inputHistory[inputHistoryIndex];
        return;
      }
    }

    // ↓ 箭头：回溯下一条或恢复草稿
    if (e.key === 'ArrowDown' && inputHistoryIndex >= 0) {
      e.preventDefault();
      if (inputHistoryIndex < inputHistory.length - 1) {
        inputHistoryIndex++;
        userInput.value = inputHistory[inputHistoryIndex];
      } else {
        inputHistoryIndex = -1;
        userInput.value = inputHistoryDraft;
      }
      return;
    }

    // 正常 Enter 发送消息
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  /** 输入框 input 事件：自动调整高度 + 检测 @ 触发 */
  userInput.addEventListener('input', function () {
    // 自动调整高度
    this.style.height = 'auto';
    var maxHeight = 150;
    this.style.height = Math.min(this.scrollHeight, maxHeight) + 'px';

    // 检测 slash 命令（仅在输入以 / 开头时触发）
    var currentText = this.value;
    if (currentText.startsWith('/')) {
      var keyword = currentText.toLowerCase();
      var filtered = slashCommands.filter(function (c) {
        return c.cmd.startsWith(keyword) || c.label.includes(keyword.slice(1));
      });
      if (filtered.length > 0) {
        slashActive = true;
        mentionActiveIndex = 0;
        renderSlashDropdown(filtered);
        return;
      }
    }
    // 不在 slash 模式时关闭
    if (slashActive) {
      slashActive = false;
      closeMentionDropdown();
    }

    // 检测 @ mention
    var cursorPos = this.selectionStart;
    var textBeforeCursor = this.value.substring(0, cursorPos);

    // 查找光标前最近的 @ 符号
    var atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex >= 0) {
      // @ 前面必须是空格、换行或在行首
      var charBefore = atIndex > 0 ? textBeforeCursor[atIndex - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || atIndex === 0) {
        var keyword = textBeforeCursor.substring(atIndex + 1);
        // 关键词中不能有空格（有空格说明已经结束了 @mention）
        if (!keyword.includes(' ') && !keyword.includes('\n')) {
          mentionActive = true;
          mentionStartPos = atIndex;
          // 防抖搜索：避免每个字符都请求
          clearTimeout(mentionDebounceTimer);
          mentionDebounceTimer = setTimeout(function () {
            vscode.postMessage({ type: 'searchWorkspaceFiles', keyword: keyword });
          }, 200);
          return;
        }
      }
    }

    // 不在 @mention 模式，关闭下拉菜单
    if (mentionActive) {
      closeMentionDropdown();
    }
  });

  /** 点击输入框外部时关闭 @ 下拉菜单 */
  document.addEventListener('click', function (e) {
    if (!mentionDropdown.contains(e.target) && e.target !== userInput) {
      closeMentionDropdown();
    }
  });

  // ==================== 消息发送 ====================

  /** 发送用户消息到 Extension */
  function sendMessage() {
    const text = userInput.value.trim();
    if (!text) {
      return;
    }

    // 记录到输入历史（最多保存 50 条）
    inputHistory.push(text);
    if (inputHistory.length > 50) { inputHistory.shift(); }
    inputHistoryIndex = -1;
    inputHistoryDraft = '';

    // 保存用于重试
    lastUserMessage = text;

    vscode.postMessage({
      type: 'sendMessage',
      text: text,
    });

    // 清空输入框并重置高度
    userInput.value = '';
    userInput.style.height = 'auto';
    updateCharCount();
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

      case 'updateModels':
        updateModelDropdown(message.models, message.activeIndex);
        break;

      case 'updateMessage':
        updateMessageContent(message.messageId, message.content);
        break;

      case 'showThinking':
        showThinkingInMessage(message.messageId);
        break;

      case 'addContextFile':
        addContextFileTag(message.filePath, message.fileName);
        break;

      case 'clearContextFiles':
        contextFilesContainer.innerHTML = '';
        break;

      case 'workspaceFiles':
        renderMentionDropdown(message.files);
        break;

      case 'updateTokenCount':
        updateTokenCount(message.tokenCount);
        break;

      case 'focusInput':
        userInput.focus();
        break;

      case 'generationStopped':
        // 用户停止生成：对所有活跃的流缓冲区执行最终渲染，保留已接收内容
        Object.keys(streamBuffers).forEach(function (msgId) {
          handleStreamDone(msgId);
        });
        setLoading(false);
        break;

      case 'updateMode':
        updateModeUI(message.mode);
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
    // 时间戳（HH:MM 格式）
    var now = new Date();
    var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    // AI 消息在消息体右上角添加悬浮操作栏（含复制按钮和时间戳）
    var msgActionsHtml = role === 'assistant'
      ? '<div class="msg-actions"><span class="msg-time">' + timeStr + '</span><button class="btn-copy-msg" title="复制全文">复制</button></div>'
      : '<div class="msg-actions"><span class="msg-time">' + timeStr + '</span></div>';

    messageEl.innerHTML =
      '<div class="role-icon">' + roleIcon + '</div>' +
      '<div class="message-content">' +
        '<div class="message-header">' + roleLabel + '</div>' +
        msgActionsHtml +
        '<div class="message-body">' + window.chatRender.renderMarkdown(content) + '</div>' +
      '</div>';

    messagesContainer.appendChild(messageEl);
    scrollToBottom();
  }

  /**
   * 更新已有消息的显示内容（用于剥离 tool_call 标签后刷新）
   */
  function updateMessageContent(messageId, content) {
    const messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (messageEl) {
      const bodyEl = messageEl.querySelector('.message-body');
      if (bodyEl) {
        bodyEl.innerHTML = window.chatRender.renderMarkdown(content);
      }
    }
    // 同步更新流缓冲区（防止 streamDone 时回退到旧内容）
    if (streamBuffers[messageId] !== undefined) {
      streamBuffers[messageId] = content;
    }
  }

  /**
   * 渲染 @ mention 文件搜索下拉菜单
   */
  function renderMentionDropdown(files) {
    if (!mentionActive) { return; }

    mentionDropdown.innerHTML = '';
    mentionActiveIndex = 0;

    if (files.length === 0) {
      mentionDropdown.innerHTML = '<div class="mention-empty">没有匹配的文件</div>';
      mentionDropdown.classList.remove('hidden');
      return;
    }

    var header = document.createElement('div');
    header.className = 'mention-header';
    header.textContent = '选择文件添加为上下文';
    mentionDropdown.appendChild(header);

    files.forEach(function (file, index) {
      var item = document.createElement('div');
      item.className = 'mention-item' + (index === 0 ? ' active' : '');
      item.setAttribute('data-file-path', file.filePath);
      item.setAttribute('data-file-name', file.fileName);
      item.innerHTML =
        '<span class="mention-icon">📄</span>' +
        '<span class="mention-name" title="' + file.filePath + '">' + file.fileName + '</span>';

      item.addEventListener('click', function () {
        selectMentionFile(file.filePath, file.fileName);
      });

      mentionDropdown.appendChild(item);
    });

    mentionDropdown.classList.remove('hidden');
  }

  /**
   * 选中 @ mention 文件：移除输入框中的 @keyword，添加文件标签
   */
  function selectMentionFile(filePath, fileName) {
    // 从输入框中删除 @keyword 文本
    var text = userInput.value;
    var cursorPos = userInput.selectionStart;
    var before = text.substring(0, mentionStartPos);
    var after = text.substring(cursorPos);
    userInput.value = before + after;
    userInput.selectionStart = mentionStartPos;
    userInput.selectionEnd = mentionStartPos;

    // 前端显示文件标签
    addContextFileTag(filePath, fileName);
    // 通知 Extension 将路径添加到 contextFiles 列表
    vscode.postMessage({ type: 'addContextFile', filePath: filePath });

    closeMentionDropdown();
    userInput.focus();
  }

  /**
   * 渲染 slash 命令下拉菜单
   * @param {{ cmd: string, label: string, desc: string }[]} commands 匹配的命令列表
   */
  function renderSlashDropdown(commands) {
    mentionDropdown.innerHTML = '';
    mentionActiveIndex = 0;

    var header = document.createElement('div');
    header.className = 'mention-header';
    header.textContent = '快捷命令';
    mentionDropdown.appendChild(header);

    commands.forEach(function (command, index) {
      var item = document.createElement('div');
      item.className = 'mention-item' + (index === 0 ? ' active' : '');
      item.setAttribute('data-cmd', command.cmd);
      item.innerHTML =
        '<span class="mention-icon">⚡</span>' +
        '<span class="mention-name">' + command.cmd + ' — ' + command.label + '</span>' +
        '<span class="slash-desc">' + command.desc + '</span>';

      item.addEventListener('click', function () {
        executeSlashCommand(command.cmd);
      });
      mentionDropdown.appendChild(item);
    });

    mentionDropdown.classList.remove('hidden');
  }

  /**
   * 执行 slash 命令
   * @param {string} cmd 命令名称，如 /explain
   */
  function executeSlashCommand(cmd) {
    // 清空输入框
    userInput.value = '';
    userInput.style.height = 'auto';
    slashActive = false;
    closeMentionDropdown();

    // 映射到 VS Code 命令
    var commandMap = {
      '/explain': 'my-ai-plugin.explain',
      '/fix': 'my-ai-plugin.fix',
      '/optimize': 'my-ai-plugin.optimize',
      '/test': 'my-ai-plugin.test',
      '/complete': 'my-ai-plugin.complete',
      '/clear': 'clearChat',
    };

    var vscodeCmd = commandMap[cmd];
    if (vscodeCmd === 'clearChat') {
      vscode.postMessage({ type: 'clearChat' });
    } else if (vscodeCmd) {
      vscode.postMessage({ type: 'executeCommand', command: vscodeCmd });
    }

    userInput.focus();
  }

  /**
   * 关闭 @ mention 下拉菜单并重置状态
   */
  function closeMentionDropdown() {
    mentionActive = false;
    mentionStartPos = -1;
    mentionActiveIndex = -1;
    mentionDropdown.classList.add('hidden');
    mentionDropdown.innerHTML = '';
    clearTimeout(mentionDebounceTimer);
  }

  /**
   * 更新下拉菜单中高亮项
   */
  function updateMentionActiveItem(items) {
    items.forEach(function (item, i) {
      if (i === mentionActiveIndex) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  /**
   * 添加上下文文件标签到输入区
   * 显示文件名和关闭按钮，点击关闭移除标签并通知 Extension
   */
  function addContextFileTag(filePath, fileName) {
    // 防止重复添加
    var existing = contextFilesContainer.querySelector('[data-file-path="' + CSS.escape(filePath) + '"]');
    if (existing) { return; }

    var tag = document.createElement('div');
    tag.className = 'context-file-tag';
    tag.setAttribute('data-file-path', filePath);
    tag.innerHTML =
      '<span class="file-name" title="' + filePath + '">' + fileName + '</span>' +
      '<button class="remove-btn" title="移除">×</button>';

    // 点击关闭按钮：移除标签并通知 Extension
    tag.querySelector('.remove-btn').addEventListener('click', function () {
      tag.remove();
      vscode.postMessage({ type: 'removeContextFile', filePath: filePath });
    });

    contextFilesContainer.appendChild(tag);
  }

  /**
   * 在指定气泡中显示 Thinking 动画
   */
  function showThinkingInMessage(messageId) {
    var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (messageEl) {
      var bodyEl = messageEl.querySelector('.message-body');
      if (bodyEl) {
        bodyEl.innerHTML =
          '<div class="thinking-indicator">' +
            '<span>Thinking</span>' +
            '<span class="dots"><span></span><span></span><span></span></span>' +
          '</div>';
      }
    }
    scrollToBottom();
  }

  /** 流式渲染节流定时器 */
  var streamRenderTimers = {};

  /**
   * 处理流式追加的文本片段
   * 节流渲染：每 50ms 最多渲染一次，减少 DOM 更新频率
   */
  function handleStreamChunk(messageId, chunk) {
    // 初始化缓冲区
    if (!streamBuffers[messageId]) {
      streamBuffers[messageId] = '';

      // 创建消息容器（如果不存在）
      var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (!messageEl) {
        addMessageToUI('assistant', '', messageId);
      }
    }

    // 追加文本到缓冲区
    streamBuffers[messageId] += chunk;

    // 节流渲染：50ms 内只渲染一次
    if (!streamRenderTimers[messageId]) {
      streamRenderTimers[messageId] = setTimeout(function () {
        streamRenderTimers[messageId] = null;
        renderStreamContent(messageId);
      }, 50);
    }

    scrollToBottom();
  }

  /**
   * 渲染流式内容（处理未闭合代码块）
   * 将未闭合的 ``` 代码块临时闭合后渲染，避免布局混乱
   */
  function renderStreamContent(messageId) {
    var text = streamBuffers[messageId];
    if (!text) { return; }

    // 检测未闭合的代码块：统计 ``` 出现次数，奇数说明最后一个未闭合
    var fenceCount = (text.match(/```/g) || []).length;
    var renderText = text;
    if (fenceCount % 2 !== 0) {
      // 临时闭合代码块用于渲染
      renderText = text + '\n```';
    }

    var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (messageEl) {
      var bodyEl = messageEl.querySelector('.message-body');
      if (bodyEl) {
        bodyEl.innerHTML = window.chatRender.renderMarkdown(renderText);
      }
    }
  }

  /**
   * 流式传输完成后的清理工作
   */
  function handleStreamDone(messageId) {
    // 清除节流定时器
    if (streamRenderTimers[messageId]) {
      clearTimeout(streamRenderTimers[messageId]);
      delete streamRenderTimers[messageId];
    }

    // 做一次最终渲染，确保 Markdown 完整
    if (streamBuffers[messageId]) {
      const messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (messageEl) {
        const bodyEl = messageEl.querySelector('.message-body');
        if (bodyEl) {
          bodyEl.innerHTML = window.chatRender.renderMarkdown(streamBuffers[messageId]);
          // 为代码块绑定按钮事件
          bindCodeBlockButtons(bodyEl);
        }
      }
    }

    // 清除缓冲
    delete streamBuffers[messageId];
    setLoading(false);
  }

  /** 最近一次发送的用户消息文本（用于重试） */
  var lastUserMessage = '';

  /** 显示错误消息（带重试按钮） */
  function showError(errorMessage) {
    var errorEl = document.createElement('div');
    errorEl.className = 'message assistant error-message';
    errorEl.innerHTML =
      '<div class="message-body" style="color: var(--vscode-errorForeground, #f44);">' +
        '⚠️ ' + escapeHtml(errorMessage) +
        '<button class="btn-retry" title="重新发送">重试</button>' +
      '</div>';

    messagesContainer.appendChild(errorEl);
    scrollToBottom();
    setLoading(false);
  }

  /** 是否正在生成中 */
  var isGenerating = false;

  /** 发送按钮原始 SVG 内容 */
  var sendBtnOriginalHtml = btnSend.innerHTML;
  /** 停止按钮 SVG（红色方块） */
  var stopBtnHtml = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  /** 设置加载状态：生成时发送按钮变为停止按钮 */
  function setLoading(loading) {
    isGenerating = loading;
    if (loading) {
      loadingEl.classList.remove('hidden');
      btnSend.innerHTML = stopBtnHtml;
      btnSend.classList.add('stop-btn');
      btnSend.title = '停止生成';
      btnSend.disabled = false;
    } else {
      loadingEl.classList.add('hidden');
      btnSend.innerHTML = sendBtnOriginalHtml;
      btnSend.classList.remove('stop-btn');
      btnSend.title = '发送消息';
      btnSend.disabled = false;
    }
    scrollToBottom();
  }

  /** 清空聊天界面，恢复欢迎页 */
  function clearChat() {
    messagesContainer.innerHTML =
      '<div class="welcome-message">' +
        '<p><strong>👋 你好！我是 AI 编程助手</strong></p>' +
        '<div class="welcome-section">' +
          '<p class="welcome-subtitle">快捷键</p>' +
          '<div class="welcome-shortcuts">' +
            '<div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>L</kbd><span>聚焦聊天</span></div>' +
            '<div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd><span>解释代码</span></div>' +
            '<div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd><span>新建对话</span></div>' +
            '<div class="shortcut-item"><kbd>↑</kbd> / <kbd>↓</kbd><span>浏览历史输入</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="welcome-section">' +
          '<p class="welcome-subtitle">快速操作</p>' +
          '<div class="welcome-shortcuts">' +
            '<div class="shortcut-item"><kbd>@</kbd><span>引用工作区文件</span></div>' +
            '<div class="shortcut-item"><kbd>/</kbd><span>Slash 快捷命令</span></div>' +
          '</div>' +
        '</div>' +
        '<p class="welcome-hint">选中代码后右键也可使用 AI 功能</p>' +
      '</div>';
  }

  /** 是否自动滚动到底部（用户手动上翻时暂停） */
  var autoScrollEnabled = true;

  /** 监听消息区域滚动：判断用户是否在底部附近 */
  messagesContainer.addEventListener('scroll', function () {
    var distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    // 距底部 50px 以内视为"在底部"
    autoScrollEnabled = distanceFromBottom < 50;
  });

  /** 滚动到底部（仅在自动滚动启用时执行） */
  function scrollToBottom() {
    if (autoScrollEnabled) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // ==================== Token 计数 ====================

  /**
   * 更新 Token 用量显示
   * @param {number} count 估算的 Token 数
   */
  function updateTokenCount(count) {
    if (count > 0) {
      // 格式化：超过 1000 时显示为 1.2k
      var display = count >= 1000 ? (count / 1000).toFixed(1) + 'k' : String(count);
      tokenCountEl.textContent = '~' + display + ' tokens';
    } else {
      tokenCountEl.textContent = '';
    }
  }

  // ==================== 导出对话 ====================

  /** 导出按钮点击：通知 Extension 导出对话 */
  btnExport.addEventListener('click', function () {
    vscode.postMessage({ type: 'exportChat' });
  });

  // ==================== 拖拽文件到聊天 ====================

  /** 输入区域拖拽进入时高亮提示 */
  var inputArea = document.getElementById('input-area');

  inputArea.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.stopPropagation();
    inputArea.classList.add('drag-over');
  });

  inputArea.addEventListener('dragleave', function (e) {
    e.preventDefault();
    inputArea.classList.remove('drag-over');
  });

  inputArea.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    inputArea.classList.remove('drag-over');

    // VS Code Webview 中拖拽文件提供 text/uri-list 或 text/plain
    var uriList = e.dataTransfer.getData('text/uri-list');
    var textData = e.dataTransfer.getData('text/plain');
    var rawData = uriList || textData || '';

    // 解析 URI 列表（每行一个 file:// URI 或路径）
    var lines = rawData.split('\n').filter(function (line) {
      return line.trim() && !line.startsWith('#');
    });

    lines.forEach(function (line) {
      var filePath = line.trim();
      // 将 file:// URI 转为本地路径
      if (filePath.startsWith('file:///')) {
        filePath = decodeURIComponent(filePath.replace('file:///', ''));
        // Windows 路径修正：file:///d:/foo → d:/foo
        if (/^[a-zA-Z]:/.test(filePath)) {
          filePath = filePath; // 已经是正确路径
        }
      } else if (filePath.startsWith('file://')) {
        filePath = decodeURIComponent(filePath.replace('file://', ''));
      }

      if (filePath) {
        // 通知 Extension 添加上下文文件
        vscode.postMessage({
          type: 'addContextFile',
          filePath: filePath,
          fileName: filePath.split(/[/\\]/).pop() || filePath,
        });
      }
    });
  });

  // ==================== Markdown 渲染（已迁移到 chat_a_render.js） ====================
  // renderMarkdown / renderInline / renderCodeBlock / renderTable / highlightSyntax / escapeHtml
  // 通过 window.chatRender.renderMarkdown() 调用

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

    // 重试按钮：重新发送最后一条消息
    if (target.classList.contains('btn-retry')) {
      // 移除错误消息元素
      var errorMsg = target.closest('.error-message');
      if (errorMsg) { errorMsg.remove(); }
      // 重新发送
      if (lastUserMessage) {
        vscode.postMessage({ type: 'sendMessage', text: lastUserMessage });
      }
      return;
    }

    // 复制整条 AI 回复按钮
    if (target.classList.contains('btn-copy-msg')) {
      var msgContent = target.closest('.message-content');
      if (msgContent) {
        var bodyEl = msgContent.querySelector('.message-body');
        if (bodyEl) {
          vscode.postMessage({ type: 'copyCode', code: bodyEl.textContent });
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

  // ==================== 模型切换 ====================

  /**
   * 更新模型选择面板
   * @param {{ name: string, index: number }[]} models 模型列表
   * @param {number} activeIndex 当前活跃模型序号
   */
  function updateModelDropdown(models, activeIndex) {
    // 更新工具栏上的模型名称（保持 toolbar-text span 结构，窄屏时 CSS 可隐藏文字）
    var activeName = models[activeIndex] ? models[activeIndex].name : 'AI 模型';
    var modelTextSpan = modelLabel.querySelector('.toolbar-text');
    if (modelTextSpan) {
      modelTextSpan.textContent = activeName;
    } else {
      modelLabel.textContent = activeName;
    }

    // 渲染面板列表
    modelPanelList.innerHTML = '';

    // 分组标题
    var title = document.createElement('div');
    title.className = 'model-group-title';
    title.textContent = '可用模型';
    modelPanelList.appendChild(title);

    // 模型项
    models.forEach(function (model) {
      var item = document.createElement('div');
      item.className = 'model-panel-item';
      item.setAttribute('data-name', model.name);
      if (model.index === activeIndex) {
        item.classList.add('active');
      }

      // 左侧：模型名称
      var left = document.createElement('div');
      left.className = 'model-item-left';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'model-item-name';
      nameSpan.textContent = model.name;
      left.appendChild(nameSpan);

      // 右侧：选中标记
      var right = document.createElement('div');
      right.className = 'model-item-right';
      if (model.index === activeIndex) {
        var check = document.createElement('span');
        check.className = 'model-item-check';
        check.textContent = '✓';
        right.appendChild(check);
      }

      item.appendChild(left);
      item.appendChild(right);

      item.addEventListener('click', function () {
        vscode.postMessage({ type: 'switchModel', index: model.index });
        modelPanel.classList.add('hidden');
      });

      modelPanelList.appendChild(item);
    });

    // 如果没有模型，显示提示
    if (models.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'model-panel-empty';
      empty.textContent = '未配置模型，请在设置中添加';
      modelPanelList.appendChild(empty);
    }
  }

  // ==================== 模式切换 UI ====================

  /** 模式显示名称和图标映射 */
  var modeDisplayMap = {
    code: { label: '<> Code', icon: '<>' },
    ask: { label: '? Ask', icon: '?' },
    plan: { label: '▤ Plan', icon: '▤' },
  };

  /**
   * 更新模式相关的 UI
   * @param {string} mode 当前模式（code/ask/plan）
   */
  function updateModeUI(mode) {
    // 更新工具栏按钮（保持 icon + toolbar-text span 结构，窄屏时 CSS 可隐藏文字）
    var display = modeDisplayMap[mode] || modeDisplayMap.code;
    var modeTextPart = display.label.replace(display.icon, '');
    btnCodeMode.innerHTML = '';
    btnCodeMode.appendChild(document.createTextNode(display.icon));
    var modeSpan = document.createElement('span');
    modeSpan.className = 'toolbar-text';
    modeSpan.textContent = modeTextPart;
    btnCodeMode.appendChild(modeSpan);
    btnCodeMode.setAttribute('data-mode', mode);

    // 更新面板中的选中状态
    modePanel.querySelectorAll('.mode-panel-item').forEach(function (item) {
      var itemMode = item.getAttribute('data-mode');
      if (itemMode === mode) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
      // 显示/隐藏选中标记
      var check = item.querySelector('.mode-item-check');
      if (check) {
        check.style.display = (itemMode === mode) ? 'inline' : 'none';
      }
    });
  }

  // ==================== Webview 状态持久化 ====================
  // 使用 vscode.getState/setState 在 Webview 隐藏/恢复时保持状态

  /** 恢复之前保存的状态 */
  var previousState = vscode.getState();
  if (previousState) {
    if (previousState.inputText) {
      userInput.value = previousState.inputText;
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    }
    if (previousState.scrollTop !== undefined) {
      // 延迟恢复滚动位置，等待 DOM 完成渲染
      setTimeout(function () {
        messagesContainer.scrollTop = previousState.scrollTop;
      }, 100);
    }
  }

  /** 保存状态（防抖，避免频繁调用） */
  var saveStateTimer = null;
  function saveWebviewState() {
    if (saveStateTimer) { clearTimeout(saveStateTimer); }
    saveStateTimer = setTimeout(function () {
      vscode.setState({
        inputText: userInput.value,
        scrollTop: messagesContainer.scrollTop,
      });
    }, 300);
  }

  // 输入框内容变化时保存
  userInput.addEventListener('input', saveWebviewState);
  // 滚动时保存
  messagesContainer.addEventListener('scroll', saveWebviewState);

  // ==================== 聊天内搜索 ====================

  var searchBar = document.getElementById('search-bar');
  var searchInput = document.getElementById('search-input');
  var searchCountEl = document.getElementById('search-count');
  var searchPrevBtn = document.getElementById('search-prev');
  var searchNextBtn = document.getElementById('search-next');
  var searchCloseBtn = document.getElementById('search-close');

  /** 当前搜索匹配的元素列表和索引 */
  var searchMatches = [];
  var searchCurrentIndex = -1;

  /** 打开搜索栏 */
  function openSearchBar() {
    searchBar.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  }

  /** 关闭搜索栏并清除高亮 */
  function closeSearchBar() {
    searchBar.classList.add('hidden');
    searchInput.value = '';
    clearSearchHighlights();
    searchCountEl.textContent = '';
  }

  /** 清除所有搜索高亮 */
  function clearSearchHighlights() {
    var highlights = messagesContainer.querySelectorAll('.search-highlight, .search-highlight-current');
    highlights.forEach(function (el) {
      var parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    searchMatches = [];
    searchCurrentIndex = -1;
  }

  /** 执行搜索：在消息体中高亮匹配文本 */
  function performSearch(query) {
    clearSearchHighlights();
    if (!query) { searchCountEl.textContent = ''; return; }

    var bodies = messagesContainer.querySelectorAll('.message-body');
    var lowerQuery = query.toLowerCase();

    bodies.forEach(function (body) {
      highlightTextInNode(body, lowerQuery, query);
    });

    searchMatches = Array.from(messagesContainer.querySelectorAll('.search-highlight'));
    if (searchMatches.length > 0) {
      searchCurrentIndex = 0;
      updateSearchNavigation();
    } else {
      searchCountEl.textContent = '无匹配';
    }
  }

  /**
   * 递归遍历 DOM 文本节点，将匹配的文本用高亮 span 包裹
   * 跳过 code 和 pre 元素内的内容，避免破坏代码块
   */
  function highlightTextInNode(node, lowerQuery, originalQuery) {
    if (node.nodeType === 3) {
      // 文本节点
      var text = node.textContent;
      var lowerText = text.toLowerCase();
      var idx = lowerText.indexOf(lowerQuery);
      if (idx === -1) { return; }

      var frag = document.createDocumentFragment();
      var lastIdx = 0;
      while (idx !== -1) {
        // 匹配前的文本
        if (idx > lastIdx) { frag.appendChild(document.createTextNode(text.substring(lastIdx, idx))); }
        // 高亮 span
        var span = document.createElement('span');
        span.className = 'search-highlight';
        span.textContent = text.substring(idx, idx + originalQuery.length);
        frag.appendChild(span);
        lastIdx = idx + originalQuery.length;
        idx = lowerText.indexOf(lowerQuery, lastIdx);
      }
      if (lastIdx < text.length) { frag.appendChild(document.createTextNode(text.substring(lastIdx))); }
      node.parentNode.replaceChild(frag, node);
    } else if (node.nodeType === 1 && !/^(script|style|code|pre)$/i.test(node.tagName)) {
      // 元素节点（跳过 code/pre）
      var children = Array.from(node.childNodes);
      children.forEach(function (child) { highlightTextInNode(child, lowerQuery, originalQuery); });
    }
  }

  /** 更新搜索导航：高亮当前匹配项并滚动到可见区域 */
  function updateSearchNavigation() {
    // 移除前一个的 current 样式
    searchMatches.forEach(function (el) {
      el.className = 'search-highlight';
    });
    if (searchMatches.length === 0) { return; }

    var current = searchMatches[searchCurrentIndex];
    current.className = 'search-highlight-current';
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    searchCountEl.textContent = (searchCurrentIndex + 1) + '/' + searchMatches.length;
  }

  // 搜索框输入事件（节流 200ms）
  var searchDebounce = null;
  searchInput.addEventListener('input', function () {
    if (searchDebounce) { clearTimeout(searchDebounce); }
    searchDebounce = setTimeout(function () {
      performSearch(searchInput.value.trim());
    }, 200);
  });

  // Enter 跳转到下一个，Shift+Enter 上一个，Escape 关闭
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (searchMatches.length > 0) {
        searchCurrentIndex = (searchCurrentIndex + 1) % searchMatches.length;
        updateSearchNavigation();
      }
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (searchMatches.length > 0) {
        searchCurrentIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length;
        updateSearchNavigation();
      }
    } else if (e.key === 'Escape') {
      closeSearchBar();
    }
  });

  searchPrevBtn.addEventListener('click', function () {
    if (searchMatches.length > 0) {
      searchCurrentIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length;
      updateSearchNavigation();
    }
  });
  searchNextBtn.addEventListener('click', function () {
    if (searchMatches.length > 0) {
      searchCurrentIndex = (searchCurrentIndex + 1) % searchMatches.length;
      updateSearchNavigation();
    }
  });
  searchCloseBtn.addEventListener('click', closeSearchBar);

  // Ctrl+F 打开搜索栏（拦截 Webview 内的 Ctrl+F）
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearchBar();
    }
  });

  // ==================== 输入框轮换提示 ====================
  var placeholderTexts = [
    '输入消息，或按 / 查看快捷命令...',
    '输入 @ 引用工作区文件...',
    '按 Alt+Q 随时聚焦到这里...',
    '选中代码后右键可快速调用 AI...',
    '按 Alt+M 切换工作模式...',
  ];
  var placeholderIndex = 0;
  setInterval(function () {
    // 输入框有内容时不更新 placeholder
    if (userInput.value) { return; }
    placeholderIndex = (placeholderIndex + 1) % placeholderTexts.length;
    userInput.placeholder = placeholderTexts[placeholderIndex];
  }, 6000);

})();
