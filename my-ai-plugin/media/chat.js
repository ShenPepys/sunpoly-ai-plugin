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
  // 暴露到 window，供 chat_b_steps.js 等外部模块惰性读取
  window.vscodeApi = vscode;

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
  const imageAttachmentsContainer = document.getElementById('image-attachments');
  const sessionTabsBar = document.getElementById('session-tabs-bar');
  const sessionTabsEl = document.getElementById('session-tabs');
  const btnNewSession = document.getElementById('btn-new-session');
  const btnSettings = document.getElementById('btn-settings');
  const btnTerminalError = document.getElementById('btn-terminal-error');
  const internalTabsBar = document.getElementById('internal-tabs-bar');
  const internalTabsList = document.getElementById('internal-tabs-list');
  const btnInternalTabAdd = document.getElementById('internal-tab-add');
  const queueBar = document.getElementById('message-queue-bar');
  const queueText = document.getElementById('message-queue-text');
  const btnQueueResume = document.getElementById('message-queue-resume');
  const btnQueueClear = document.getElementById('message-queue-clear');
  const panelTitle = document.body.dataset.panelTitle || 'Sunpoly';
  var sessionLauncherRequestTimer = 0;

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
  var scheduledScrollFrame = 0;

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

  btnQueueResume.addEventListener('click', function () {
    var activeTab = getActiveInternalTab();
    if (!activeTab) {
      return;
    }

    setQueuePaused(activeTab.id, false);
    queueAwaitingRunTabId = activeTab.id;
    renderMessageQueueBar();
    saveWebviewState();
    trySendNextQueuedMessage();
  });

  btnQueueClear.addEventListener('click', function () {
    var activeTab = getActiveInternalTab();
    if (!activeTab) {
      return;
    }

    clearQueuedMessages(activeTab.id);
    renderMessageQueueBar();
    saveWebviewState();
  });

  /**
   * 内部标签栏使用鼠标滚轮横向滚动
   * 隐藏原生滚动条后，仍然保留滚轮浏览长标签列表的能力
   */
  internalTabsList.addEventListener('wheel', function (e) {
    if (internalTabsList.scrollWidth <= internalTabsList.clientWidth) {
      return;
    }

    var horizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!horizontalDelta) {
      return;
    }

    e.preventDefault();
    internalTabsList.scrollLeft += horizontalDelta;
  }, { passive: false });

  /**
   * 上下文面板选项点击
   * mentions 在本地处理（插入 @ 复用 mention 状态机），workflow/upload 发给后端
   * 这样两个入口（+ 菜单和直接输入 @）走完全相同的选择逻辑，状态不会出现分叉
   */
  contextPanel.querySelectorAll('.context-panel-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var action = item.getAttribute('data-action');
      closeAllPanels();

      if (action === 'mentions') {
        // 聚焦输入框，在末尾插入 @ 并触发 input 事件，让 @ 检测逻辑自动启动
        userInput.focus();
        var text = userInput.value;
        // @ 前面补一个空格，避免与前面的文字粘连
        var needSpace = text.length > 0 && text[text.length - 1] !== ' ' && text[text.length - 1] !== '\n';
        userInput.value = text + (needSpace ? ' ' : '') + '@';
        userInput.selectionStart = userInput.value.length;
        userInput.selectionEnd = userInput.value.length;
        userInput.dispatchEvent(new Event('input'));
        return;
      }

      if (action === 'upload') {
        // 图片上传全部在前端处理，不需要发送到后端
        imageFileInput.click();
        return;
      }

      vscode.postMessage({ type: 'contextAction', action: action });
    });
  });

  /** 模式面板选项点击：切换模式 */
  modePanel.querySelectorAll('.mode-panel-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var mode = item.getAttribute('data-mode');
      if (mode) {
        updateModeUI(mode);
      }
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
      updateModeUI(modes[nextIndex]);
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

  // ==================== 图片附件状态 ====================

  /** 当前待发送的图片附件列表 */
  var pendingImages = [];
  /** 图片 ID 计数器 */
  var imageIdCounter = 0;
  /** 单张图片最大允许大小（MB） */
  var MAX_IMAGE_SIZE_MB = 5;
  /** 每条消息最多可附加图片数量 */
  var MAX_IMAGE_COUNT = 3;
  /** 当前活跃模型是否支持图片输入，首次从 updateModels 消息中读取 */
  var currentModelSupportsVision = false;

  // ==================== 会话状态 ====================
  /** 当前所有会话的摘要列表（由后端推送 updateSessions 进行更新） */
  var sessionList = [];
  /** 当前活跃会话的 ID */
  var activeSessionId = '';
  var sessionLauncherVisible = false;
  var pendingDeleteSessionId = '';

  // ==================== 内部子标签状态 ====================
  /** 内部子标签列表，每项 { id, sessionId, title } */
  var internalTabs = [];
  /** 当前活跃的内部标签 ID */
  var activeInternalTabId = '';
  /** 内部标签 ID 计数器 */
  var internalTabCounter = 0;
  var pendingInternalTabId = '';
  var shouldRestoreInternalTabViewState = false;
  var sessionLauncherRequestInFlight = false;
  var queuedMessagesByTabId = Object.create(null);
  var queuePausedByTabId = Object.create(null);
  var queuedMessageCounter = 0;
  var queuedDispatchTimer = 0;
  var queueAwaitingRunTabId = '';

  /**
   * 生成内部标签唯一 ID
   */
  function generateInternalTabId() {
    internalTabCounter += 1;
    return 'itab-' + Date.now() + '-' + internalTabCounter;
  }

  function normalizeInternalTabState(tab) {
    var title = typeof tab.title === 'string' && tab.title.trim() ? tab.title : '新对话';
    return {
      id: tab.id,
      sessionId: typeof tab.sessionId === 'string' ? tab.sessionId : '',
      title: title,
      draftText: typeof tab.draftText === 'string' ? tab.draftText : '',
      scrollTop: typeof tab.scrollTop === 'number' ? tab.scrollTop : 0,
      awaitingSessionBind: Boolean(tab.awaitingSessionBind),
      launcherActivated: Boolean(tab.launcherActivated),
    };
  }

  function getActiveInternalTab() {
    if (!activeInternalTabId) {
      return null;
    }

    return internalTabs.find(function (tab) { return tab.id === activeInternalTabId; }) || null;
  }

  function generateQueuedMessageId() {
    queuedMessageCounter += 1;
    return 'qmsg-' + Date.now() + '-' + queuedMessageCounter;
  }

  function cloneQueuedImages(images) {
    if (!Array.isArray(images) || images.length === 0) {
      return [];
    }

    return images.map(function (image) {
      return {
        id: typeof image.id === 'string' ? image.id : '',
        fileName: typeof image.fileName === 'string' ? image.fileName : '',
        dataUrl: typeof image.dataUrl === 'string' ? image.dataUrl : '',
        mimeType: typeof image.mimeType === 'string' ? image.mimeType : 'image/png',
        sizeKB: typeof image.sizeKB === 'number' ? image.sizeKB : 0,
      };
    });
  }

  function getQueuedMessages(tabId) {
    if (!tabId) {
      return [];
    }

    if (!queuedMessagesByTabId[tabId]) {
      queuedMessagesByTabId[tabId] = [];
    }

    return queuedMessagesByTabId[tabId];
  }

  function isQueuePaused(tabId) {
    return Boolean(tabId && queuePausedByTabId[tabId]);
  }

  function setQueuePaused(tabId, paused) {
    if (!tabId) {
      return;
    }

    if (paused) {
      queuePausedByTabId[tabId] = true;
      return;
    }

    delete queuePausedByTabId[tabId];
  }

  function clearQueuedMessages(tabId) {
    if (!tabId) {
      return;
    }

    delete queuedMessagesByTabId[tabId];
    delete queuePausedByTabId[tabId];
    if (queueAwaitingRunTabId === tabId) {
      queueAwaitingRunTabId = '';
    }
  }

  function updateQueueWatchForTab(tabId) {
    if (!tabId) {
      queueAwaitingRunTabId = '';
      return;
    }

    queueAwaitingRunTabId = getQueuedMessages(tabId).length > 0 ? tabId : '';
  }

  function cancelQueuedDispatch() {
    if (!queuedDispatchTimer) {
      return;
    }

    clearTimeout(queuedDispatchTimer);
    queuedDispatchTimer = 0;
  }

  function renderMessageQueueBar() {
    var activeTab = getActiveInternalTab();
    var queuedMessages = activeTab ? getQueuedMessages(activeTab.id) : [];
    var queuedCount = queuedMessages.length;

    if (!activeTab || queuedCount === 0) {
      queueBar.classList.add('hidden');
      queueText.textContent = '';
      btnQueueResume.classList.add('hidden');
      return;
    }

    var paused = isQueuePaused(activeTab.id);
    queueBar.classList.remove('hidden');
    queueText.textContent = paused
      ? '排队已暂停，待发送 ' + queuedCount + ' 条'
      : '排队中，待发送 ' + queuedCount + ' 条';

    if (paused && !isGenerating) {
      btnQueueResume.classList.remove('hidden');
    } else {
      btnQueueResume.classList.add('hidden');
    }
  }

  function buildComposerMessageRequest() {
    return {
      text: userInput.value.trim(),
      mode: btnCodeMode.getAttribute('data-mode') || 'code',
      images: cloneQueuedImages(pendingImages),
    };
  }

  function recordSentInputHistory(text) {
    inputHistory.push(text);
    if (inputHistory.length > 50) {
      inputHistory.shift();
    }
    inputHistoryIndex = -1;
    inputHistoryDraft = '';
  }

  function clearComposerState() {
    pendingImages = [];
    renderImageAttachments();
    userInput.value = '';
    userInput.style.height = 'auto';
    updateCharCount();
    syncActiveInternalTabDraftFromInput();
    saveWebviewState();
    userInput.focus();
  }

  function postMessageRequest(request) {
    if (!request || !request.text) {
      return false;
    }

    if (sessionLauncherVisible) {
      setSessionLauncherVisible(false);
      messagesContainer.innerHTML = '';
    }

    vscode.postMessage({
      type: 'sendMessage',
      text: request.text,
      mode: request.mode,
      images: request.images && request.images.length > 0 ? cloneQueuedImages(request.images) : undefined,
    });
    return true;
  }

  function enqueuePreparedMessage(tabId, request) {
    if (!tabId || !request || !request.text) {
      return false;
    }

    getQueuedMessages(tabId).push({
      id: generateQueuedMessageId(),
      text: request.text,
      mode: request.mode,
      images: cloneQueuedImages(request.images),
    });
    updateQueueWatchForTab(tabId);
    renderMessageQueueBar();
    saveWebviewState();
    return true;
  }

  function trySendNextQueuedMessage() {
    if (isGenerating) {
      return false;
    }

    var activeTab = getActiveInternalTab();
    if (!activeTab || queueAwaitingRunTabId !== activeTab.id || isQueuePaused(activeTab.id)) {
      renderMessageQueueBar();
      return false;
    }

    var queuedMessages = getQueuedMessages(activeTab.id);
    if (queuedMessages.length === 0) {
      updateQueueWatchForTab(activeTab.id);
      renderMessageQueueBar();
      return false;
    }

    var nextMessage = queuedMessages.shift();
    updateQueueWatchForTab(activeTab.id);
    if (!postMessageRequest(nextMessage)) {
      renderMessageQueueBar();
      saveWebviewState();
      return false;
    }

    renderMessageQueueBar();
    saveWebviewState();
    userInput.focus();
    return true;
  }

  function scheduleQueuedMessageDispatch(tabId) {
    cancelQueuedDispatch();
    if (!tabId || queueAwaitingRunTabId !== tabId) {
      return;
    }

    queuedDispatchTimer = window.setTimeout(function () {
      queuedDispatchTimer = 0;
      trySendNextQueuedMessage();
    }, 80);
  }

  function pauseQueuedMessages(tabId) {
    if (!tabId || queueAwaitingRunTabId !== tabId) {
      return;
    }

    if (getQueuedMessages(tabId).length === 0) {
      queueAwaitingRunTabId = '';
      renderMessageQueueBar();
      return;
    }

    setQueuePaused(tabId, true);
    queueAwaitingRunTabId = '';
    renderMessageQueueBar();
    saveWebviewState();
  }

  function syncActiveInternalTabDraftFromInput() {
    var activeTab = getActiveInternalTab();
    if (!activeTab) {
      return;
    }

    activeTab.draftText = userInput.value;
  }

  function syncActiveInternalTabScrollFromView() {
    var activeTab = getActiveInternalTab();
    if (!activeTab) {
      return;
    }

    activeTab.scrollTop = messagesContainer.scrollTop;
  }

  function captureActiveInternalTabViewState() {
    syncActiveInternalTabDraftFromInput();
    syncActiveInternalTabScrollFromView();
  }

  function restoreInputDraft(text) {
    userInput.value = text || '';
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    updateCharCount();
  }

  function restoreActiveInternalTabViewState() {
    var activeTab = getActiveInternalTab();
    restoreInputDraft(activeTab ? activeTab.draftText : '');
    renderMessageQueueBar();

    if (sessionLauncherVisible) {
      return;
    }

    var scrollTop = activeTab && typeof activeTab.scrollTop === 'number'
      ? activeTab.scrollTop
      : 0;
    window.setTimeout(function () {
      if (sessionLauncherVisible) {
        return;
      }

      messagesContainer.scrollTop = scrollTop;
    }, 0);
  }

  function prepareActiveInternalTabForSessionLauncher() {
    var activeTab = getActiveInternalTab();
    if (!activeTab) {
      return;
    }

    clearQueuedMessages(activeTab.id);
    activeTab.sessionId = '';
    activeTab.title = '新对话';
    activeTab.awaitingSessionBind = true;
    activeTab.launcherActivated = true;
    activeTab.scrollTop = 0;
    renderInternalTabBar();
    renderMessageQueueBar();
  }

  function createInternalTab() {
    captureActiveInternalTabViewState();

    var currentTab = getActiveInternalTab();
    if (currentTab && currentTab.sessionId && !currentTab.awaitingSessionBind) {
      var currentSession = sessionList.find(function (session) { return session.id === currentTab.sessionId; });
      if (currentSession && currentSession.name) {
        currentTab.title = currentSession.name;
      }
    }

    var newTab = normalizeInternalTabState({
      id: generateInternalTabId(),
      sessionId: '',
      title: '新对话',
      draftText: '',
      scrollTop: 0,
      awaitingSessionBind: true,
      launcherActivated: false,
    });
    internalTabs.push(newTab);
    activeInternalTabId = newTab.id;
    pendingInternalTabId = '';
    shouldRestoreInternalTabViewState = false;
    renderInternalTabBar();
    clearChat();
    restoreActiveInternalTabViewState();
    saveWebviewState();
    requestSessionLauncherOpen();
  }

  function switchInternalTab(tabId) {
    var targetTab = internalTabs.find(function (tab) { return tab.id === tabId; });
    if (!targetTab || tabId === activeInternalTabId) {
      return;
    }

    var hadActiveTab = Boolean(activeInternalTabId);
    captureActiveInternalTabViewState();

    if (!targetTab.sessionId || targetTab.awaitingSessionBind) {
      activeInternalTabId = tabId;
      pendingInternalTabId = '';
      shouldRestoreInternalTabViewState = false;
      renderInternalTabBar();
      clearChat();
      restoreActiveInternalTabViewState();
      saveWebviewState();
      requestSessionLauncherOpen();
      return;
    }

    if (!hadActiveTab) {
      activeInternalTabId = tabId;
      renderInternalTabBar();
    }

    pendingInternalTabId = tabId;
    shouldRestoreInternalTabViewState = true;
    vscode.postMessage({ type: 'switchSession', sessionId: targetTab.sessionId });
  }

  function closeInternalTab(tabId) {
    if (internalTabs.length <= 1) {
      return;
    }

    if (tabId === activeInternalTabId && isGenerating) {
      showError('当前仍在生成，请先停止当前任务后再关闭当前标签。');
      return;
    }

    var closingIndex = -1;
    for (var i = 0; i < internalTabs.length; i++) {
      if (internalTabs[i].id === tabId) {
        closingIndex = i;
        break;
      }
    }
    if (closingIndex === -1) {
      return;
    }

    clearQueuedMessages(tabId);
    internalTabs.splice(closingIndex, 1);

    if (tabId === activeInternalTabId) {
      var nextIndex = Math.min(closingIndex, internalTabs.length - 1);
      activeInternalTabId = '';
      renderInternalTabBar();
      switchInternalTab(internalTabs[nextIndex].id);
      return;
    }

    if (pendingInternalTabId === tabId) {
      pendingInternalTabId = '';
    }
    renderInternalTabBar();
    saveWebviewState();
  }

  function renderInternalTabBar() {
    internalTabsList.innerHTML = '';

    if (internalTabs.length === 0) {
      internalTabsBar.classList.remove('visible');
      return;
    }

    internalTabsBar.classList.add('visible');

    internalTabs.forEach(function (tab, index) {
      var tabEl = document.createElement('div');
      tabEl.className = 'internal-tab' + (tab.id === activeInternalTabId ? ' active' : '');

      var labelEl = document.createElement('span');
      labelEl.className = 'internal-tab-label';
      labelEl.textContent = tab.title || ('对话 ' + (index + 1));
      tabEl.appendChild(labelEl);

      if (internalTabs.length > 1) {
        var closeBtn = document.createElement('button');
        closeBtn.className = 'internal-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          closeInternalTab(tab.id);
        });
        tabEl.appendChild(closeBtn);
      }

      tabEl.addEventListener('click', function () {
        switchInternalTab(tab.id);
      });

      internalTabsList.appendChild(tabEl);
    });
  }

  function syncActiveInternalTab() {
    var sessionMap = {};
    sessionList.forEach(function (session) {
      sessionMap[session.id] = session;
    });

    if (internalTabs.length === 0) {
      internalTabs.push(normalizeInternalTabState({
        id: generateInternalTabId(),
        sessionId: '',
        title: '新对话',
        draftText: '',
        scrollTop: 0,
        awaitingSessionBind: !activeSessionId,
      }));
    }

    internalTabs = internalTabs.map(function (tab) {
      var nextTab = normalizeInternalTabState(tab);
      var matchedSession = nextTab.sessionId ? sessionMap[nextTab.sessionId] : null;

      if (matchedSession && matchedSession.name) {
        nextTab.title = matchedSession.name;
      }

      if (nextTab.sessionId && !matchedSession && !nextTab.awaitingSessionBind) {
        clearQueuedMessages(nextTab.id);
        nextTab.sessionId = '';
        nextTab.title = '新对话';
        nextTab.awaitingSessionBind = true;
        nextTab.launcherActivated = false;
        nextTab.scrollTop = 0;
      }

      return nextTab;
    });

    if (pendingInternalTabId) {
      var pendingTab = internalTabs.find(function (tab) { return tab.id === pendingInternalTabId; });
      if (pendingTab && (pendingTab.awaitingSessionBind || pendingTab.sessionId === activeSessionId)) {
        activeInternalTabId = pendingInternalTabId;
        shouldRestoreInternalTabViewState = true;
      }
      pendingInternalTabId = '';
    }

    if (!activeInternalTabId || !internalTabs.some(function (tab) { return tab.id === activeInternalTabId; })) {
      var matchedActiveTab = activeSessionId
        ? internalTabs.find(function (tab) { return tab.sessionId === activeSessionId; })
        : null;
      activeInternalTabId = matchedActiveTab ? matchedActiveTab.id : internalTabs[0].id;
      shouldRestoreInternalTabViewState = true;
    }

    var activeTab = getActiveInternalTab();
    if (activeTab && activeTab.awaitingSessionBind && activeTab.launcherActivated && !sessionLauncherVisible && !sessionLauncherRequestInFlight && activeSessionId) {
      activeTab.sessionId = activeSessionId;
      activeTab.awaitingSessionBind = false;
      activeTab.launcherActivated = false;
    }

    activeTab = getActiveInternalTab();
    if (activeTab && activeTab.sessionId) {
      var activeSession = sessionMap[activeTab.sessionId];
      if (activeSession && activeSession.name) {
        activeTab.title = activeSession.name;
      }
    }

    renderInternalTabBar();
    renderMessageQueueBar();
    if (shouldRestoreInternalTabViewState) {
      restoreActiveInternalTabViewState();
      shouldRestoreInternalTabViewState = false;
    }
    saveWebviewState();
  }

  function getWelcomeMessageHtml() {
    return '<div class="welcome-message">' +
      '<p><strong>👋 你好！我是 ' + escapeHtml(panelTitle) + '</strong></p>' +
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

  function renderMessagesBaseState() {
    messagesContainer.innerHTML = '';

    if (sessionLauncherVisible) {
      renderSessionTabs();
      return;
    }

    messagesContainer.innerHTML = getWelcomeMessageHtml();
  }

  function syncSessionToolbarState() {
    btnExport.style.display = sessionLauncherVisible ? 'none' : '';
    btnClear.style.display = sessionLauncherVisible ? 'none' : '';
    btnNewSession.style.display = sessionLauncherVisible ? 'none' : '';
    // 设置按钮始终可见，不受启动态状态影响
    if (btnSettings) {
      btnSettings.style.display = '';
    }
  }

  function setSessionLauncherVisible(visible) {
    sessionLauncherVisible = visible;
    sessionLauncherRequestInFlight = false;
    pendingDeleteSessionId = '';
    // 每次打开启动器时重置分页计数，从最近的会话开始显示
    sessionDisplayCount = SESSION_PAGE_SIZE;
    sessionTabsBar.classList.add('hidden');
    syncSessionToolbarState();

    setLoading(false);
    renderMessagesBaseState();

    if (visible) {
      autoScrollEnabled = true;
      messagesContainer.scrollTop = 0;
      saveWebviewState();
      return;
    }

    scrollToBottom(true);
    saveWebviewState();
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) {
      return '';
    }

    var diffMs = Date.now() - timestamp;
    if (diffMs < 60 * 1000) {
      return 'now';
    }

    var diffMinutes = Math.floor(diffMs / (60 * 1000));
    if (diffMinutes < 60) {
      return diffMinutes + 'm';
    }

    var diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return diffHours + 'h';
    }

    var diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return diffDays + 'd';
    }

    var date = new Date(timestamp);
    return String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  /** 隐藏的文件输入框，用于触发图片选择对话框 */
  var imageFileInput = document.createElement('input');
  imageFileInput.type = 'file';
  imageFileInput.accept = 'image/*';
  imageFileInput.multiple = true;
  imageFileInput.style.display = 'none';
  document.body.appendChild(imageFileInput);

  /** 设置按钮点击 → 打开 VS Code 设置定位到 myAiPlugin */
  if (btnSettings) {
    btnSettings.addEventListener('click', function () {
      vscode.postMessage({ type: 'openSettings' });
    });
  }

  function clearSessionLauncherRequestTimer() {
    if (!sessionLauncherRequestTimer) {
      return;
    }

    clearTimeout(sessionLauncherRequestTimer);
    sessionLauncherRequestTimer = 0;
    sessionLauncherRequestInFlight = false;
  }

  function requestSessionLauncherOpen() {
    captureActiveInternalTabViewState();
    clearSessionLauncherRequestTimer();
    sessionLauncherRequestInFlight = true;
    sessionLauncherRequestTimer = window.setTimeout(function () {
      sessionLauncherRequestTimer = 0;
      sessionLauncherRequestInFlight = false;
    }, 150);

    saveWebviewState();
    vscode.postMessage({ type: 'createSession' });
  }

  /** 新建会话按鈕点击 */
  btnNewSession.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    requestSessionLauncherOpen();
  });

  /** 内部标签栏 "+" 按钮：创建新的内部子标签 */
  btnInternalTabAdd.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    createInternalTab();
  });

  /**
   * 分析终端错误按鈕点击
   * 后端会从剪贴板读取错误内容并直接发送给 AI
   * 前提：用户已在终端中选中并复制了错误文本
   */
  btnTerminalError.addEventListener('click', function () {
    vscode.postMessage({ type: 'analyzeTerminalError' });
  });

  /** 用户选择文件后处理 */
  imageFileInput.addEventListener('change', function () {
    Array.prototype.forEach.call(imageFileInput.files, function (file) {
      processImageFile(file);
    });
    imageFileInput.value = '';
  });

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

    // Enter：生成中时优先加入排队，否则发送消息
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isGenerating) {
        if (!sendMessage()) {
          vscode.postMessage({ type: 'stopGeneration' });
          setLoading(false);
        }
      } else {
        sendMessage();
      }
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
    var activeTab = getActiveInternalTab();
    var request = buildComposerMessageRequest();
    if (!activeTab || !request.text) {
      return false;
    }

    if (activeTab.awaitingSessionBind && !sessionLauncherVisible) {
      requestSessionLauncherOpen();
      showError('新对话尚未准备完成，请等待会话启动器打开后再发送。');
      return false;
    }

    recordSentInputHistory(request.text);

    if (isGenerating || getQueuedMessages(activeTab.id).length > 0) {
      enqueuePreparedMessage(activeTab.id, request);
      clearComposerState();
      if (!isGenerating && !isQueuePaused(activeTab.id)) {
        queueAwaitingRunTabId = activeTab.id;
        trySendNextQueuedMessage();
      }
      return true;
    }

    if (!postMessageRequest(request)) {
      return false;
    }

    clearComposerState();
    renderMessageQueueBar();
    return true;
  }

  // ==================== 接收 Extension 消息 ====================

  window.addEventListener('message', function (event) {
    const message = event.data;

    switch (message.type) {
      case 'addMessage':
        addMessageToUI(message.role, message.content, message.messageId, message.createdAt, {
          partial: message.partial,
          readOnly: message.readOnly,
        });
        break;

      case 'streamChunk':
        handleStreamChunk(message.messageId, message.chunk, message.createdAt);
        break;

      case 'streamDone':
        handleStreamDone(message.messageId);
        break;

      case 'showError':
        clearSessionLauncherRequestTimer();
        showError(message.message, {
          retryable: message.retryable,
          retryRequestId: message.retryRequestId,
          createdAt: message.createdAt,
          readOnly: message.readOnly,
        });
        break;

      case 'setLoading':
        setLoading(message.loading);
        break;

      case 'clearChat':
        clearChat();
        break;

      case 'updateModels':
        updateModelDropdown(message.models, message.activeIndex);
        // 缓存当前模型的视觉能力标识，用于上传图片时的提示
        currentModelSupportsVision = message.supportsVision || false;
        break;

      case 'updateSessions':
        sessionList = message.sessions;
        activeSessionId = message.activeSessionId;
        syncActiveInternalTab();
        renderSessionTabs();
        break;

      case 'createInternalTab':
        createInternalTab();
        break;

      case 'setSessionLauncher':
        if (message.visible) {
          prepareActiveInternalTabForSessionLauncher();
        }
        clearSessionLauncherRequestTimer();
        setSessionLauncherVisible(message.visible);
        break;

      case 'updateMessage':
        updateMessageContent(message.messageId, message.content);
        break;

      case 'resetMessageState':
        resetMessageState(message.messageId);
        break;

      case 'showHistoryProcessSummary':
        if (window.chatSteps && window.chatSteps.showHistoryProcessSummary) {
          window.chatSteps.showHistoryProcessSummary(message);
        } else {
          showHistoryProcessSummary(message.messageId, message.summary);
        }
        break;

      case 'removeLastAssistantMessage':
        removeLastAssistantMessage();
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

      case 'clearImageAttachments':
        // 后端确认图片已处理，再次确保清空（正常情况前端已自行清空）
        pendingImages = [];
        renderImageAttachments();
        break;

      case 'visionNotSupported': {
        // 根据可用视觉模型列表生成不同提示
        var visionList = message.visionModels || [];
        var tip;
        if (visionList.length > 0) {
          tip = '当前模型「' + message.modelName + '」不支持图片输入，图片已被忽略。\n' +
            '你可以切换到以下支持图片的模型：' + visionList.join('、');
        } else {
          tip = '当前模型「' + message.modelName + '」不支持图片输入，图片已被忽略。\n' +
            '你当前没有配置支持图片的模型，请删除图片后使用文字对话，或在设置中添加支持视觉的模型（如 GPT-4o、Claude 3 等）。';
        }
        showError(tip);
        break;
      }

      case 'updateTokenCount':
        updateTokenCount(message);
        break;

      case 'focusInput':
        userInput.focus();
        break;

      case 'generationStopped':
        // 用户停止生成：对所有活跃的流缓冲区执行最终渲染，保留已接收内容
        Object.keys(streamBuffers).forEach(function (msgId) {
          handleStreamDone(msgId);
        });
        if (window.chatSteps) {
          // 取消所有待确认的批量变更栏
          if (window.chatSteps.cancelPendingChangeSummaries) {
            window.chatSteps.cancelPendingChangeSummaries();
          }
          // 兜底：将所有仍在转圈的步骤标记为已取消
          if (window.chatSteps && window.chatSteps.cancelAllRunningSteps) {
            window.chatSteps.cancelAllRunningSteps();
          }
        }
        pauseQueuedMessages(activeInternalTabId);
        setLoading(false);
        syncRegenButtonForLatestTurn();
        break;

      case 'updateMode':
        updateModeUI(message.mode);
        break;

      // ---- Windsurf 风格步骤消息 ----
      case 'addStep':
        if (window.chatSteps) { window.chatSteps.addStep(message); }
        break;

      case 'updateStep':
        if (window.chatSteps) { window.chatSteps.updateStep(message); }
        break;

      case 'showDiff':
        if (window.chatSteps) { window.chatSteps.showDiff(message); }
        break;

      case 'showChangeSummary':
        if (window.chatSteps) { window.chatSteps.showChangeSummary(message); }
        break;

      case 'updateChangeSummary':
        if (window.chatSteps && window.chatSteps.updateChangeSummary) {
          window.chatSteps.updateChangeSummary(message);
        }
        break;

      case 'thinkingComplete':
        if (window.chatSteps) { window.chatSteps.showThinkingComplete(message); }
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
  function addMessageToUI(role, content, messageId, createdAt, options) {
    if (sessionLauncherVisible) {
      setSessionLauncherVisible(false);
    }

    // 新消息出现时移除旧的重新生成按钮（保持界面整洁）
    removeAllRegenButtons();
    // 移除欢迎消息（只在第一条消息时）
    const welcome = messagesContainer.querySelector('.welcome-message');
    if (welcome) {
      welcome.remove();
    }

    var safeOptions = options || {};

    const messageEl = document.createElement('div');
    messageEl.className = 'message ' + role;
    messageEl.setAttribute('data-message-id', messageId);
    if (safeOptions.readOnly) {
      messageEl.setAttribute('data-read-only', 'true');
    }
    if (safeOptions.partial) {
      messageEl.setAttribute('data-partial', 'true');
    }

    const roleLabel = role === 'user' ? '你' : 'AI';
    const roleIcon = role === 'user' ? '👤' : '🤖';
    // 时间戳（HH:MM 格式）
    var timeStr = formatMessageTime(createdAt);
    // AI 消息在消息体右上角添加悬浮操作栏（含复制按钮和时间戳）
    var copyButtonTitle = safeOptions.readOnly ? '历史记录只读' : '复制全文';
    var copyDisabledAttr = safeOptions.readOnly ? ' disabled' : '';
    var msgActionsHtml = role === 'assistant'
      ? '<div class="msg-actions"><span class="msg-time">' + timeStr + '</span><button class="msg-action-btn btn-copy-msg" title="' + copyButtonTitle + '"' + copyDisabledAttr + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>'
      : '<div class="msg-actions"><span class="msg-time">' + timeStr + '</span></div>';

    messageEl.innerHTML =
      '<div class="role-icon">' + roleIcon + '</div>' +
      '<div class="message-content">' +
        '<div class="message-header">' + roleLabel + '</div>' +
        msgActionsHtml +
        '<div class="message-body">' + window.chatRender.renderMarkdown(content) + '</div>' +
      '</div>';

    bindCodeBlockButtons(messageEl.querySelector('.message-body'));
    messagesContainer.appendChild(messageEl);
    if (typeof messageId === 'string' && messageId.indexOf('restored-') === 0) {
      scheduleRestoredHistoryRegenButtonSync();
    }
    scrollToBottom();
  }

  function formatMessageTime(createdAt) {
    var safeTimestamp = Number.isFinite(createdAt) ? createdAt : Date.now();
    var date = new Date(safeTimestamp);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function getOrCreateHistoryProcessSummary(messageId) {
    var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl) {
      return null;
    }

    var contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) {
      return null;
    }

    var summaryEl = contentEl.querySelector('.history-process-summary');
    if (!summaryEl) {
      summaryEl = document.createElement('div');
      summaryEl.className = 'history-process-summary';

      var stepsEl = contentEl.querySelector('.steps-container');
      var statusEl = contentEl.querySelector('.stream-status');
      if (stepsEl) {
        contentEl.insertBefore(summaryEl, stepsEl);
      } else if (statusEl) {
        contentEl.insertBefore(summaryEl, statusEl);
      } else {
        contentEl.appendChild(summaryEl);
      }
    }

    return summaryEl;
  }

  function buildHistoryProcessSummaryText(summary) {
    var parts = [];

    if (summary.totalSteps > 0) {
      parts.push('已执行 ' + summary.totalSteps + ' 步');
    }
    if (summary.readCount > 0) {
      parts.push('读取 ' + summary.readCount);
    }
    if (summary.listCount > 0) {
      parts.push('列目录 ' + summary.listCount);
    }
    if (summary.modifyCount > 0) {
      parts.push('修改 ' + summary.modifyCount);
    }
    if (summary.createCount > 0) {
      parts.push('创建 ' + summary.createCount);
    }
    if (summary.changedFiles && summary.changedFiles.length > 0) {
      parts.push('改动 ' + summary.changedFiles.length + ' 个文件');
    }
    if (summary.failedCount > 0) {
      parts.push('失败 ' + summary.failedCount + ' 步');
    }

    return parts.join(' · ') || '查看过程摘要';
  }

  function buildHistoryProcessMetricItems(summary) {
    var items = [];

    if (summary.readCount > 0) {
      items.push({ label: '读取', value: summary.readCount });
    }
    if (summary.listCount > 0) {
      items.push({ label: '列目录', value: summary.listCount });
    }
    if (summary.modifyCount > 0) {
      items.push({ label: '修改', value: summary.modifyCount });
    }
    if (summary.createCount > 0) {
      items.push({ label: '创建', value: summary.createCount });
    }
    if (summary.failedCount > 0) {
      items.push({ label: '失败', value: summary.failedCount, danger: true });
    }

    return items;
  }

  function showHistoryProcessSummary(messageId, summary) {
    if (!summary || !summary.totalSteps) {
      return;
    }

    var summaryEl = getOrCreateHistoryProcessSummary(messageId);
    if (!summaryEl) {
      return;
    }

    var summaryText = buildHistoryProcessSummaryText(summary);
    var metricItems = buildHistoryProcessMetricItems(summary);
    var metricHtml = metricItems.map(function (item) {
      return '<span class="history-process-chip' + (item.danger ? ' danger' : '') + '">' +
        '<span class="history-process-chip-label">' + escapeHtml(item.label) + '</span>' +
        '<span class="history-process-chip-value">' + item.value + '</span>' +
      '</span>';
    }).join('');
    var filesHtml = '';

    if (summary.changedFiles && summary.changedFiles.length > 0) {
      filesHtml =
        '<div class="history-process-files">' +
          '<div class="history-process-section-title">改动文件</div>' +
          '<div class="history-process-file-list">' +
            summary.changedFiles.map(function (filePath) {
              return '<span class="history-process-file" title="' + escapeAttr(filePath) + '">' + escapeHtml(filePath) + '</span>';
            }).join('') +
          '</div>' +
        '</div>';
    }

    summaryEl.innerHTML =
      '<button type="button" class="history-process-toggle" aria-expanded="false" title="展开或折叠过程摘要">' +
        '<span class="history-process-toggle-text">' + escapeHtml(summaryText) + '</span>' +
        '<span class="history-process-toggle-icon">▶</span>' +
      '</button>' +
      '<div class="history-process-details collapsed">' +
        '<div class="history-process-section">' +
          '<div class="history-process-section-title">过程摘要</div>' +
          '<div class="history-process-metrics">' + metricHtml + '</div>' +
        '</div>' +
        filesHtml +
      '</div>';

    var toggleBtn = summaryEl.querySelector('.history-process-toggle');
    var detailsEl = summaryEl.querySelector('.history-process-details');
    var iconEl = summaryEl.querySelector('.history-process-toggle-icon');
    if (toggleBtn && detailsEl && iconEl) {
      toggleBtn.addEventListener('click', function () {
        var collapsed = detailsEl.classList.toggle('collapsed');
        toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        iconEl.textContent = collapsed ? '▶' : '▼';
      });
    }
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
        bindCodeBlockButtons(bodyEl);
      }
    }
    // 同步更新流缓冲区（防止 streamDone 时回退到旧内容）
    if (streamBuffers[messageId] !== undefined) {
      streamBuffers[messageId] = content;
    }
    scrollToBottom();
  }

  function clearMessageStreamState(messageId) {
    if (streamRenderTimers[messageId]) {
      clearTimeout(streamRenderTimers[messageId]);
      delete streamRenderTimers[messageId];
    }

    if (streamBuffers.hasOwnProperty(messageId)) {
      delete streamBuffers[messageId];
    }
  }

  function resetMessageState(messageId) {
    if (!messageId) {
      return;
    }

    clearMessageStreamState(messageId);

    var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl) {
      return;
    }

    var bodyEl = messageEl.querySelector('.message-body');
    if (bodyEl) {
      bodyEl.classList.remove('streaming');
    }

    var statusEls = messageEl.querySelectorAll('.stream-status');
    Array.prototype.forEach.call(statusEls, function (statusEl) {
      statusEl.remove();
    });

    if (window.chatSteps && window.chatSteps.resetMessageState) {
      window.chatSteps.resetMessageState(messageId);
    }
  }

  function removeLastAssistantMessage() {
    var assistantMessages = messagesContainer.querySelectorAll('.message.assistant');
    if (assistantMessages.length === 0) {
      return;
    }

    var lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    if (lastAssistantMessage) {
      lastAssistantMessage.remove();
    }
    syncRegenButtonForLatestTurn();
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

  // ==================== 会话 Tab 渲染 ====================

  /**
   * 重新渲染会话 Tab 标签条
   * 每个 Tab 显示：会话名称 + 对话轮数徽章 + × 删除按钮（仅在多会话时显示）
   * 支持单击切换、双击重命名（内联 input）
   */
  /** 历史会话列表每次显示的条数上限 */
  var SESSION_PAGE_SIZE = 20;
  /** 当前历史列表已展示的数量 */
  var sessionDisplayCount = SESSION_PAGE_SIZE;

  /**
   * 构建单个会话项 DOM
   * @param {Object} session 会话摘要
   * @param {HTMLElement} listEl 列表容器
   */
  function buildSessionItem(session, listEl) {
    var isActive = session.id === activeSessionId;
    var isPendingDelete = pendingDeleteSessionId === session.id;
    var sessionItem = document.createElement('div');
    sessionItem.className = 'session-launcher-item' + (isActive ? ' active' : '');
    sessionItem.setAttribute('data-session-id', session.id);

    if (isPendingDelete) {
      var confirmRow = document.createElement('div');
      confirmRow.className = 'session-launcher-confirm';
      confirmRow.innerHTML =
        '<span class="session-launcher-confirm-text">确认删除这个会话？</span>' +
        '<div class="session-launcher-confirm-actions">' +
          '<button class="session-launcher-btn danger">删除</button>' +
          '<button class="session-launcher-btn ghost">取消</button>' +
        '</div>';

      confirmRow.querySelector('.session-launcher-btn.danger').addEventListener('click', function (e) {
        e.stopPropagation();
        pendingDeleteSessionId = '';
        vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
      });

      confirmRow.querySelector('.session-launcher-btn.ghost').addEventListener('click', function (e) {
        e.stopPropagation();
        pendingDeleteSessionId = '';
        renderSessionTabs();
      });

      sessionItem.appendChild(confirmRow);
      listEl.appendChild(sessionItem);
      return;
    }

    var infoWrap = document.createElement('div');
    infoWrap.className = 'session-launcher-info';
    infoWrap.innerHTML =
      '<div class="session-launcher-title" title="' + escapeAttr(session.name) + '">' + escapeHtml(session.name) + '</div>' +
      '<div class="session-launcher-meta">' + (session.messageCount > 0 ? (Math.ceil(session.messageCount / 2) + ' 轮对话') : '暂无消息') + '</div>';

    var rightWrap = document.createElement('div');
    rightWrap.className = 'session-launcher-right';
    rightWrap.innerHTML =
      '<span class="session-launcher-time">' + formatRelativeTime(session.updatedAt) + '</span>' +
      '<div class="session-launcher-actions">' +
        '<button class="session-launcher-btn">继续</button>' +
        '<button class="session-launcher-btn danger">删除</button>' +
      '</div>';

    var continueBtn = rightWrap.querySelector('.session-launcher-btn');
    var deleteBtn = rightWrap.querySelector('.session-launcher-btn.danger');

    function continueSession() {
      pendingDeleteSessionId = '';
      captureActiveInternalTabViewState();
      pendingInternalTabId = activeInternalTabId;
      shouldRestoreInternalTabViewState = true;
      vscode.postMessage({ type: 'switchSession', sessionId: session.id });
    }

    sessionItem.addEventListener('click', function () {
      continueSession();
    });

    continueBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      continueSession();
    });

    deleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      pendingDeleteSessionId = session.id;
      renderSessionTabs();
    });

    sessionItem.appendChild(infoWrap);
    sessionItem.appendChild(rightWrap);
    listEl.appendChild(sessionItem);
  }

  function renderSessionTabs() {
    sessionTabsEl.innerHTML = '';

    if (!sessionLauncherVisible) {
      return;
    }

    messagesContainer.innerHTML = '';

    var launcherPanel = document.createElement('div');
    launcherPanel.className = 'session-launcher-panel';

    var headerEl = document.createElement('div');
    headerEl.className = 'session-launcher-header';
    headerEl.innerHTML =
      '<div class="session-launcher-heading">继续之前的对话</div>' +
      '<div class="session-launcher-subtitle">选择一个历史会话继续，或直接在下方输入开始新的对话</div>';

    var listEl = document.createElement('div');
    listEl.className = 'session-launcher-list';

    if (sessionList.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'session-launcher-empty';
      emptyEl.textContent = '暂无历史会话，直接在下方输入开始新对话';
      listEl.appendChild(emptyEl);
      launcherPanel.appendChild(headerEl);
      launcherPanel.appendChild(listEl);
      messagesContainer.appendChild(launcherPanel);
      return;
    }

    launcherPanel.appendChild(headerEl);

    // 只渲染前 sessionDisplayCount 条会话
    var visibleSessions = sessionList.slice(0, sessionDisplayCount);
    var hasMore = sessionList.length > sessionDisplayCount;

    visibleSessions.forEach(function (session) {
      buildSessionItem(session, listEl);
    });

    // 超出上限时显示"显示更多"按钮
    if (hasMore) {
      var remainingCount = sessionList.length - sessionDisplayCount;
      var showMoreBtn = document.createElement('button');
      showMoreBtn.className = 'session-launcher-show-more';
      showMoreBtn.textContent = '显示更多（剩余 ' + remainingCount + ' 条）';
      showMoreBtn.addEventListener('click', function () {
        sessionDisplayCount += SESSION_PAGE_SIZE;
        renderSessionTabs();
      });
      listEl.appendChild(showMoreBtn);
    }

    launcherPanel.appendChild(listEl);
    messagesContainer.appendChild(launcherPanel);
  }

  // ==================== 图片上传处理 ====================

  /**
   * 输入区图片拖拽进入：改用 input-area 级别的 dragover/drop 拦截图片文件
   * 注意：input-area 本身已有文件拖拽逻辑，此处在其前面优先处理图片
   */
  userInput.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types, function (t) { return t === 'Files'; })) {
      e.preventDefault();
      userInput.classList.add('drag-over');
    }
  });
  userInput.addEventListener('dragleave', function () {
    userInput.classList.remove('drag-over');
  });
  userInput.addEventListener('drop', function (e) {
    userInput.classList.remove('drag-over');
    if (!e.dataTransfer || !e.dataTransfer.files) { return; }
    var hasImage = false;
    Array.prototype.forEach.call(e.dataTransfer.files, function (file) {
      if (file.type.startsWith('image/')) {
        hasImage = true;
        processImageFile(file);
      }
    });
    // 只有拖入的是图片时才阻止默认行为
    if (hasImage) { e.preventDefault(); }
  });

  /** 粘贴：从剪贴板捕获图片 */
  document.addEventListener('paste', function (e) {
    if (!e.clipboardData || !e.clipboardData.items) { return; }
    Array.prototype.forEach.call(e.clipboardData.items, function (item) {
      if (item.type.startsWith('image/')) {
        var file = item.getAsFile();
        if (file) { processImageFile(file); }
      }
    });
  });

  /**
   * 处理单个图片文件：校验大小和数量，读取为 base64 DataURL
   * @param {File} file 图片文件对象
   */
  function processImageFile(file) {
    if (pendingImages.length >= MAX_IMAGE_COUNT) {
      showError('最多只能附加 ' + MAX_IMAGE_COUNT + ' 张图片');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      showError('图片超过 ' + MAX_IMAGE_SIZE_MB + 'MB 限制，请压缩后重试');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      var id = 'img-' + (++imageIdCounter);
      pendingImages.push({
        id: id,
        dataUrl: dataUrl,
        fileName: file.name || 'image.png',
        mimeType: file.type || 'image/png',
        sizeKB: Math.round(file.size / 1024),
      });
      renderImageAttachments();
    };
    reader.readAsDataURL(file);
  }

  /**
   * 重新渲染图片附件缩略图区域
   * 每个图片显示缩略图 + 文件名 + 大小 + 删除按钮
   */
  function renderImageAttachments() {
    imageAttachmentsContainer.innerHTML = '';
    pendingImages.forEach(function (img) {
      var tag = document.createElement('div');
      tag.className = 'image-attachment-tag';
      tag.setAttribute('data-img-id', img.id);
      tag.innerHTML =
        '<img class="img-thumb" src="' + img.dataUrl + '" alt="' + escapeAttr(img.fileName) + '" />' +
        '<button class="img-remove" title="移除图片">×</button>';
      // 点击缩略图弹出大图预览
      tag.querySelector('.img-thumb').addEventListener('click', function () {
        var overlay = document.createElement('div');
        overlay.className = 'image-preview-overlay';
        overlay.innerHTML = '<img src="' + img.dataUrl + '" alt="' + escapeAttr(img.fileName) + '" />';
        overlay.addEventListener('click', function () {
          overlay.remove();
        });
        document.body.appendChild(overlay);
      });
      tag.querySelector('.img-remove').addEventListener('click', function () {
        pendingImages = pendingImages.filter(function (i) { return i.id !== img.id; });
        renderImageAttachments();
      });
      imageAttachmentsContainer.appendChild(tag);
    });
  }

  /**
   * HTML 文本节点转义（防止 XSS），适合插入元素文本内容
   * @param {string} str 原始字符串
   */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  /**
   * HTML 属性值转义（防止 XSS），适合插入 src/alt/title 等属性
   * @param {string} str 原始字符串
   */
  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      // 添加状态指示条（如果还没有的话）
      showStreamStatus(messageEl, 'AI 正在思考...');
    }
    scrollToBottom();
  }

  /**
   * 在消息气泡底部显示状态指示条（spinner + 文字）
   * 放在 .message-content 内、.message-body 的兄弟节点，不受 Markdown 重渲影响
   */
  function showStreamStatus(messageEl, text) {
    var contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) { return; }
    // 避免重复创建：先移除已有的
    var existing = contentEl.querySelector('.stream-status');
    if (existing) { existing.remove(); }
    var statusEl = document.createElement('div');
    statusEl.className = 'stream-status';
    statusEl.innerHTML = '<div class="stream-status-spinner"></div><span>' + text + '</span>';
    contentEl.appendChild(statusEl);
  }

  /**
   * 移除消息气泡底部的状态指示条
   */
  function removeStreamStatus(messageEl) {
    if (!messageEl) { return; }
    var statusEl = messageEl.querySelector('.stream-status');
    if (statusEl) { statusEl.remove(); }
  }

  /** 流式渲染节流定时器 */
  var streamRenderTimers = {};
  var restoredRedoSyncTimer = 0;

  /**
   * 处理流式追加的文本片段
   * 节流渲染：每 50ms 最多渲染一次，减少 DOM 更新频率
   */
  function handleStreamChunk(messageId, chunk, createdAt) {
    // 用 hasOwnProperty 判断是否已初始化（避免空字符串 falsy 导致重复初始化）
    if (!streamBuffers.hasOwnProperty(messageId)) {
      streamBuffers[messageId] = '';

      // 创建消息容器（如果不存在）
      var messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (!messageEl) {
        addMessageToUI('assistant', '', messageId, createdAt);
        messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      }
      if (messageEl) {
        // 添加 streaming class，触发 CSS 闪烁光标
        var bodyEl = messageEl.querySelector('.message-body');
        if (bodyEl) { bodyEl.classList.add('streaming'); }
        // 添加状态指示条（spinner + “AI 正在生成...”）
        showStreamStatus(messageEl, 'AI 正在生成...');
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
    scrollToBottom();
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
    var finalContent = streamBuffers[messageId];
    if (finalContent !== undefined) {
      const messageEl = messagesContainer.querySelector('[data-message-id="' + messageId + '"]');
      if (messageEl) {
        const bodyEl = messageEl.querySelector('.message-body');
        if (bodyEl) {
          // 移除 streaming class，闪烁光标消失
          bodyEl.classList.remove('streaming');
          if (finalContent) {
            bodyEl.innerHTML = window.chatRender.renderMarkdown(finalContent);
            // 为代码块绑定按钮事件
            bindCodeBlockButtons(bodyEl);
          }
        }
        // 移除状态指示条
        removeStreamStatus(messageEl);
      }
    }

    scrollToBottom();

    // 清除缓冲
    delete streamBuffers[messageId];
    setLoading(false);
    scheduleQueuedMessageDispatch(activeInternalTabId);

    // 流式完成后：移除旧的重新生成按钮，在本条 AI 消息底部加新的
    syncRegenButtonForLatestTurn();

    if (window.chatSteps && window.chatSteps.markProcessComplete) {
      window.chatSteps.markProcessComplete(messageId);
    }
  }

  function scheduleRestoredHistoryRegenButtonSync() {
    if (restoredRedoSyncTimer) {
      clearTimeout(restoredRedoSyncTimer);
    }
    restoredRedoSyncTimer = window.setTimeout(function () {
      restoredRedoSyncTimer = 0;
      syncRegenButtonForLatestTurn();
    }, 0);
  }

  function getRelatedUserMessage(messageEl) {
    var currentEl = messageEl ? messageEl.previousElementSibling : null;
    while (currentEl) {
      if (
        currentEl.classList
        && currentEl.classList.contains('message')
        && currentEl.classList.contains('user')
      ) {
        return currentEl;
      }
      currentEl = currentEl.previousElementSibling;
    }
    return null;
  }

  function syncRegenButtonForLatestTurn() {
    removeAllRegenButtons();

    var messageItems = messagesContainer.querySelectorAll('.message');
    if (messageItems.length === 0) {
      return;
    }

    var lastAssistantMessage = null;
    for (var i = messageItems.length - 1; i >= 0; i -= 1) {
      var currentMessage = messageItems[i];
      if (!currentMessage || !currentMessage.classList.contains('assistant')) {
        continue;
      }

      var currentMessageId = currentMessage.getAttribute('data-message-id') || '';
      if (!currentMessageId) {
        continue;
      }

      lastAssistantMessage = currentMessage;
      break;
    }

    if (!lastAssistantMessage) {
      return;
    }

    addRegenButton(
      getRelatedUserMessage(lastAssistantMessage),
      lastAssistantMessage.getAttribute('data-message-id') || ''
    );
  }

  /**
   * 将重新生成按钮插入到 .msg-actions 区域（复制按钮后面）
   * 样式复用 btn-copy-msg，在 hover 时与复制按钮一起展示
   * @param {Element} messageEl 消息气泡 DOM 元素
   */
  function addRegenButton(messageEl, assistantMessageId) {
    if (!messageEl || !assistantMessageId) { return; }
    var actionsEl = messageEl.querySelector('.msg-actions');
    if (!actionsEl) { return; }

    var btn = document.createElement('button');
    btn.className = 'msg-action-btn btn-regen';
    btn.title = '重新生成';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';
    if (messageEl.getAttribute('data-read-only') === 'true') {
      btn.disabled = true;
      btn.title = '历史记录只读';
    } else {
      btn.addEventListener('click', function () {
        removeAllRegenButtons();
        vscode.postMessage({ type: 'regenerate', assistantMessageId: assistantMessageId });
      });
    }
    actionsEl.appendChild(btn);
  }

  /**
   * 移除所有消息上的重新生成按钮
   * 在发送新消息或清空对话时调用
   */
  function removeAllRegenButtons() {
    messagesContainer.querySelectorAll('.btn-regen').forEach(function (btn) {
      btn.remove();
    });
  }

  /** 显示错误消息（带重试按钮） */
  function showError(errorMessage, options) {
    if (sessionLauncherVisible) {
      setSessionLauncherVisible(false);
    }

    // 清理所有残留的流式指示器（出错时 streamDone 可能未被调用）
    messagesContainer.querySelectorAll('.message-body.streaming').forEach(function (el) {
      el.classList.remove('streaming');
    });
    messagesContainer.querySelectorAll('.stream-status').forEach(function (el) {
      el.remove();
    });
    pendingInternalTabId = '';
    sessionLauncherRequestInFlight = false;

    var safeOptions = options || {};
    var retryRequestId = safeOptions.retryRequestId || '';
    var shouldShowRetryButton = !!retryRequestId || !!safeOptions.retryable;
    var retryButtonHtml = shouldShowRetryButton
      ? ' <button class="btn-retry" title="' + (safeOptions.readOnly ? '历史记录只读' : '重新发送') + '"' + ((safeOptions.readOnly || !retryRequestId) ? ' disabled' : '') + '>重试</button>'
      : '';

    var timeStr = formatMessageTime(safeOptions.createdAt);
    var errorEl = document.createElement('div');
    errorEl.className = 'message assistant error-message';
    if (safeOptions.readOnly) {
      errorEl.setAttribute('data-read-only', 'true');
    }
    if (retryRequestId) {
      errorEl.setAttribute('data-retry-request-id', retryRequestId);
    }
    errorEl.innerHTML =
      '<div class="role-icon">⚠️</div>' +
      '<div class="message-content">' +
        '<div class="message-header">系统</div>' +
        '<div class="msg-actions"><span class="msg-time">' + timeStr + '</span></div>' +
        '<div class="message-body" style="color: var(--vscode-errorForeground, #f44);">' +
          escapeHtml(errorMessage) +
          retryButtonHtml +
        '</div>' +
      '</div>';

    messagesContainer.appendChild(errorEl);
    scrollToBottom();
    if (retryRequestId && !safeOptions.readOnly) {
      pauseQueuedMessages(activeInternalTabId);
    }
    setLoading(false);
    syncRegenButtonForLatestTurn();
  }

  function getCodeBlockText(wrapper) {
    if (!wrapper) {
      return '';
    }

    var codeEl = wrapper.querySelector('pre code');
    if (!codeEl) {
      return '';
    }

    return String(codeEl.textContent || '');
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
      cancelQueuedDispatch();
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
    renderMessageQueueBar();
    scrollToBottom();
  }

  /** 清空聊天界面，恢复欢迎页 */
  function clearChat() {
    var activeTab = getActiveInternalTab();
    if (scheduledScrollFrame) {
      cancelAnimationFrame(scheduledScrollFrame);
      scheduledScrollFrame = 0;
    }
    if (restoredRedoSyncTimer) {
      clearTimeout(restoredRedoSyncTimer);
      restoredRedoSyncTimer = 0;
    }
    Object.keys(streamRenderTimers).forEach(function (messageId) {
      clearTimeout(streamRenderTimers[messageId]);
      delete streamRenderTimers[messageId];
    });
    Object.keys(streamBuffers).forEach(function (messageId) {
      delete streamBuffers[messageId];
    });
    cancelQueuedDispatch();
    if (activeTab) {
      clearQueuedMessages(activeTab.id);
    }
    // 清除图片附件
    pendingImages = [];
    renderImageAttachments();
    // 清理 summary 文件数据缓存，防止内存泄漏
    if (window.chatSteps && window.chatSteps.clearStore) {
      window.chatSteps.clearStore();
    }
    setLoading(false);
    renderMessageQueueBar();
    renderMessagesBaseState();
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
  function scrollToBottom(force) {
    if (!force && !autoScrollEnabled) {
      return;
    }
    if (scheduledScrollFrame) {
      cancelAnimationFrame(scheduledScrollFrame);
    }
    scheduledScrollFrame = requestAnimationFrame(function () {
      scheduledScrollFrame = 0;
      if (!force && !autoScrollEnabled) {
        return;
      }
      messagesContainer.scrollTop = Math.max(0, messagesContainer.scrollHeight - messagesContainer.clientHeight);
    });
  }

  // ==================== Token 计数 ====================

  /**
   * 更新 Token 用量显示
   * @param {object|number} payload 估算的上下文占用数据
   */
  function updateTokenCount(payload) {
    var tokenCount = 0;
    var contextWindow = 0;
    var usagePercentage = 0;

    if (typeof payload === 'number') {
      tokenCount = payload;
    } else if (payload && typeof payload === 'object') {
      tokenCount = Number(payload.tokenCount) || 0;
      contextWindow = Number(payload.contextWindow) || 0;
      usagePercentage = Number(payload.usagePercentage) || 0;
    }

    tokenCountEl.classList.remove('token-count-warn', 'token-count-danger');

    if (contextWindow > 0) {
      tokenCountEl.textContent = '约 ' + formatCompactTokenCount(tokenCount) + ' / ' + formatCompactTokenCount(contextWindow) + ' · ' + usagePercentage + '%';
      tokenCountEl.title = '当前会话上下文占用为估算值，用于帮助你判断是否接近模型上下文上限。\n' +
        '估算已用：' + tokenCount + ' tokens\n' +
        '上下文上限：' + contextWindow + ' tokens\n' +
        '当前使用率：' + usagePercentage + '%';

      if (usagePercentage >= 80) {
        tokenCountEl.classList.add('token-count-danger');
      } else if (usagePercentage >= 60) {
        tokenCountEl.classList.add('token-count-warn');
      }
      return;
    }

    if (tokenCount > 0) {
      tokenCountEl.textContent = '~' + formatCompactTokenCount(tokenCount) + ' tokens';
      tokenCountEl.title = '当前对话估算 Token 数';
      return;
    }

    tokenCountEl.textContent = '';
    tokenCountEl.title = '当前对话估算 Token 数';
  }

  function formatCompactTokenCount(count) {
    if (count >= 1000000) {
      return trimTrailingZero((count / 1000000).toFixed(1)) + 'M';
    }

    if (count >= 1000) {
      return trimTrailingZero((count / 1000).toFixed(1)) + 'K';
    }

    return String(count);
  }

  function trimTrailingZero(text) {
    return String(text).replace(/\.0$/, '');
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
      if (target.disabled || target.closest('.message[data-read-only="true"]')) {
        return;
      }
      var wrapper = target.closest('.code-block-wrapper');
      var codeText = getCodeBlockText(wrapper);
      if (!codeText.trim()) {
        showError('代码块为空，无法复制');
        return;
      }

      vscode.postMessage({
        type: 'copyCode',
        code: codeText,
      });
      return;
    }

    // 重试按钮：重新发送最后一条消息
    if (target.classList.contains('btn-retry')) {
      if (target.disabled || target.closest('.error-message[data-read-only="true"]')) {
        return;
      }
      // 移除错误消息元素
      var errorMsg = target.closest('.error-message');
      if (errorMsg) { errorMsg.remove(); }
      var retryRequestId = errorMsg ? (errorMsg.getAttribute('data-retry-request-id') || '') : '';
      // 重新发送
      if (retryRequestId) {
        vscode.postMessage({ type: 'retryRequest', requestId: retryRequestId });
      }
      return;
    }

    // 复制整条 AI 回复按钮
    var copyBtn = typeof target.closest === 'function'
      ? target.closest('.btn-copy-msg')
      : (target.classList && target.classList.contains('btn-copy-msg') ? target : null);
    if (copyBtn) {
      if (copyBtn.disabled || copyBtn.closest('.message[data-read-only="true"]')) {
        return;
      }
      var msgContent = copyBtn.closest('.message-content');
      if (msgContent) {
        var bodyEl = msgContent.querySelector('.message-body');
        var bodyText = bodyEl ? String(bodyEl.textContent || '') : '';
        if (!bodyText.trim()) {
          showError('消息内容为空，无法复制');
          return;
        }

        vscode.postMessage({ type: 'copyCode', code: bodyText });
      }
      return;
    }

    // 插入代码按钮
    if (target.classList.contains('btn-insert-code')) {
      if (target.disabled || target.closest('.message[data-read-only="true"]')) {
        return;
      }
      var wrapper = target.closest('.code-block-wrapper');
      var insertCodeText = getCodeBlockText(wrapper);
      if (!insertCodeText.trim()) {
        showError('代码块为空，无法插入');
        return;
      }

      vscode.postMessage({
        type: 'insertCode',
        code: insertCodeText,
      });
      return;
    }
  });

  /**
   * 为指定元素内的代码块绑定按钮事件
   * 流式传输完成后调用，确保新渲染的代码块也有事件
   */
  function bindCodeBlockButtons(container) {
    if (!container) { return; }

    var messageEl = container.closest('.message[data-read-only="true"]');
    if (!messageEl) {
      return;
    }

    var insertButtons = container.querySelectorAll('.btn-insert-code');
    insertButtons.forEach(function (button) {
      button.disabled = true;
      button.title = '历史记录只读';
    });

    var copyButtons = container.querySelectorAll('.btn-copy-code');
    copyButtons.forEach(function (button) {
      button.disabled = true;
      button.title = '历史记录只读';
    });

    var links = container.querySelectorAll('a[href]');
    links.forEach(function (link) {
      link.setAttribute('tabindex', '-1');
      link.setAttribute('aria-disabled', 'true');
    });
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
    if (Array.isArray(previousState.internalTabs) && previousState.internalTabs.length > 0) {
      internalTabs = previousState.internalTabs
        .filter(function (tab) {
          return tab && typeof tab.id === 'string' && tab.id !== '';
        })
        .map(function (tab) {
          return normalizeInternalTabState(tab);
        });
    }
    if (typeof previousState.activeInternalTabId === 'string') {
      activeInternalTabId = previousState.activeInternalTabId;
    }
    if (typeof previousState.internalTabCounter === 'number') {
      internalTabCounter = previousState.internalTabCounter;
    }
    if (internalTabs.length > 0) {
      shouldRestoreInternalTabViewState = true;
    } else if (previousState.inputText || previousState.scrollTop !== undefined) {
      var restoredTab = normalizeInternalTabState({
        id: generateInternalTabId(),
        sessionId: '',
        title: '新对话',
        draftText: previousState.inputText || '',
        scrollTop: previousState.scrollTop || 0,
        awaitingSessionBind: !activeSessionId,
      });
      internalTabs = [restoredTab];
      activeInternalTabId = restoredTab.id;
      shouldRestoreInternalTabViewState = true;
    }
  }

  /** 保存状态（防抖，避免频繁调用） */
  var saveStateTimer = null;
  function saveWebviewState() {
    if (saveStateTimer) { clearTimeout(saveStateTimer); }
    saveStateTimer = setTimeout(function () {
      captureActiveInternalTabViewState();
      vscode.setState({
        inputText: userInput.value,
        scrollTop: messagesContainer.scrollTop,
        internalTabs: internalTabs.map(function (tab) {
          return normalizeInternalTabState(tab);
        }),
        activeInternalTabId: activeInternalTabId,
        internalTabCounter: internalTabCounter,
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

  // ==================== 初始化第一个内部标签 ====================
  // 面板启动时自动创建一个默认标签，关联当前活跃会话
  if (internalTabs.length === 0) {
    var firstTab = normalizeInternalTabState({
      id: generateInternalTabId(),
      sessionId: activeSessionId || '',
      title: '新对话',
      draftText: '',
      scrollTop: 0,
      awaitingSessionBind: !activeSessionId,
    });
    internalTabs.push(firstTab);
    activeInternalTabId = firstTab.id;
  }

  renderInternalTabBar();
  if (shouldRestoreInternalTabViewState) {
    restoreActiveInternalTabViewState();
    shouldRestoreInternalTabViewState = false;
  }

  // ==================== 初始化：自动请求模型列表 ====================
  /**
   * Webview 加载完成后，立即向后端请求模型列表
   * 确保首次打开面板时就能看到正确的模型名称，而不是占位符文本
   */
  vscode.postMessage({ type: 'requestModels' });

})();
