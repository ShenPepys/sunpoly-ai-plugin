/**
 * Windsurf 风格步骤渲染模块
 * 
 * 负责渲染工具执行过程中的各种步骤 UI：
 * - 进度步骤块（running / done / error）
 * - 可折叠 Thinking 面板
 * - 代码 Diff 展示（新增/删除行高亮）
 * - Accept / Reject 按钮
 * - 文件变更汇总
 * 
 * 通过 window.chatSteps 暴露给 chat.js 调用
 */
(function () {
  'use strict';

  // 注意：VS Code API 由 chat.js 初始化后暴露到 window.vscodeApi
  // 本模块在函数调用时惰性读取（加载时 chat.js 尚未执行）

  /**
   * summaryId → files 数组（含绝对路径）
   * showChangeSummary 时写入，View all changes 点击时读取，
   * 用于通知 Extension 在 IDE 中打开对应文件
   */
  var summaryFilesStore = {};
  var summaryUndoIntentStore = {};
  var processSummaryStore = {};
  var thinkingElapsedStore = {};
  var processCollapseTimers = {};

  // ==================== 步骤容器管理 ====================

  /**
   * 获取或创建消息气泡内的步骤容器
   * 步骤容器是 .message-content 内、.message-body 下方的兄弟节点
   * 
   * @param {string} messageId 消息 ID
   * @returns {HTMLElement|null} 步骤容器元素
   */
  function getOrCreateStepsContainer(messageId) {
    var msgEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!msgEl) { return null; }

    var contentEl = msgEl.querySelector('.message-content');
    if (!contentEl) { return null; }

    var container = contentEl.querySelector('.steps-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'steps-container';
      var resultPanelEl = contentEl.querySelector('.message-result-panel');
      var statusEl = contentEl.querySelector('.stream-status');
      if (resultPanelEl) {
        contentEl.insertBefore(container, resultPanelEl);
      } else if (statusEl) {
        contentEl.insertBefore(container, statusEl);
      } else {
        contentEl.appendChild(container);
      }
    }
    ensureStepSections(container);
    return container;
  }

  function ensureStepSections(container) {
    var headerEl = container.querySelector('.process-panel-toggle');
    var bodyEl = container.querySelector('.process-panel-body');
    var linesEl = bodyEl ? bodyEl.querySelector('.steps-lines') : container.querySelector('.steps-lines');
    var groupsEl = bodyEl ? bodyEl.querySelector('.step-process-groups') : container.querySelector('.step-process-groups');
    var detailsEl = bodyEl ? bodyEl.querySelector('.steps-details') : container.querySelector('.steps-details');

    if (headerEl && bodyEl && linesEl && groupsEl && detailsEl) {
      return {
        container: container,
        headerEl: headerEl,
        bodyEl: bodyEl,
        linesEl: linesEl,
        groupsEl: groupsEl,
        detailsEl: detailsEl,
      };
    }

    if (!headerEl) {
      headerEl = document.createElement('button');
      headerEl.type = 'button';
      headerEl.className = 'process-panel-toggle';
      headerEl.setAttribute('aria-expanded', 'true');
      headerEl.innerHTML =
        '<span class="process-panel-toggle-main">' +
          '<span class="process-panel-toggle-prefix">执行过程</span>' +
          '<span class="process-panel-toggle-summary">处理中</span>' +
        '</span>' +
        '<span class="process-panel-toggle-icon">▼</span>';
    }

    if (!bodyEl) {
      bodyEl = document.createElement('div');
      bodyEl.className = 'process-panel-body';
    }

    if (!linesEl) {
      linesEl = document.createElement('div');
      linesEl.className = 'steps-lines';
    }
    if (!groupsEl) {
      groupsEl = document.createElement('div');
      groupsEl.className = 'step-process-groups';
    }
    if (!detailsEl) {
      detailsEl = document.createElement('div');
      detailsEl.className = 'steps-details';
    }

    var existingChildren = Array.prototype.slice.call(container.children);
    Array.prototype.forEach.call(existingChildren, function (child) {
      if (child === headerEl || child === bodyEl || child === linesEl || child === groupsEl || child === detailsEl) { return; }
      if (child.classList.contains('step-item') || child.classList.contains('step-thinking')) {
        linesEl.appendChild(child);
      } else {
        detailsEl.appendChild(child);
      }
    });

    if (linesEl.parentNode !== bodyEl) {
      bodyEl.appendChild(linesEl);
    }
    if (groupsEl.parentNode !== bodyEl) {
      bodyEl.appendChild(groupsEl);
    }
    if (detailsEl.parentNode !== bodyEl) {
      bodyEl.appendChild(detailsEl);
    }
    if (headerEl.parentNode !== container) {
      container.appendChild(headerEl);
    }
    if (bodyEl.parentNode !== container) {
      container.appendChild(bodyEl);
    }

    if (!headerEl.getAttribute('data-bound')) {
      headerEl.setAttribute('data-bound', 'true');
      headerEl.addEventListener('click', function () {
        setProcessPanelCollapsed(container, !container.classList.contains('process-panel-collapsed'));
      });
    }

    return {
      container: container,
      headerEl: headerEl,
      bodyEl: bodyEl,
      linesEl: linesEl,
      groupsEl: groupsEl,
      detailsEl: detailsEl,
    };
  }

  function getStepSections(messageId) {
    var container = getOrCreateStepsContainer(messageId);
    if (!container) { return null; }
    return ensureStepSections(container);
  }

  function findStepSections(messageId) {
    var messageEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl) { return null; }

    var container = messageEl.querySelector('.steps-container');
    if (!container) { return null; }

    return ensureStepSections(container);
  }

  function getMessageIdByElement(el) {
    var messageEl = el && el.closest ? el.closest('[data-message-id]') : null;
    return messageEl ? (messageEl.getAttribute('data-message-id') || '') : '';
  }

  function applyExecutionHintState(hintEl, text, state) {
    if (!hintEl) { return; }

    hintEl.className = 'message-execution-hint';
    if (state) {
      hintEl.classList.add('is-' + state);
    }
    hintEl.textContent = text || '';
  }

  function setExecutionResultTitle(resultPanelEl, completed) {
    if (!resultPanelEl) { return; }

    var titleEl = resultPanelEl.querySelector('.message-result-title');
    if (!titleEl) {
      titleEl = document.createElement('div');
      titleEl.className = 'message-result-title';
      resultPanelEl.insertBefore(titleEl, resultPanelEl.firstChild || null);
    }

    titleEl.textContent = completed ? '最终结果' : '最终结果（整理中）';
  }

  function applyExecutionLayoutState(layout, completed) {
    if (!layout) { return; }

    setExecutionResultTitle(layout.resultPanelEl, completed);
    if (completed) {
      if (layout.hintEl) {
        layout.hintEl.style.display = 'none';
        layout.hintEl.textContent = '';
        layout.hintEl.className = 'message-execution-hint';
      }
      return;
    }

    if (layout.hintEl) {
      layout.hintEl.style.display = '';
    }
    applyExecutionHintState(
      layout.hintEl,
      'AI 正在执行任务，最终结果会显示在下方。',
      'running'
    );
  }

  function ensureExecutionLayout(messageId, options) {
    var normalizedOptions = options || {};
    var messageEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl || !messageEl.classList.contains('assistant')) {
      return null;
    }

    var contentEl = messageEl.querySelector('.message-content');
    var bodyEl = contentEl ? contentEl.querySelector('.message-body') : null;
    if (!contentEl || !bodyEl) {
      return null;
    }

    var hintEl = contentEl.querySelector('.message-execution-hint');
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'message-execution-hint';
    }

    var resultPanelEl = contentEl.querySelector('.message-result-panel');
    if (!resultPanelEl) {
      resultPanelEl = document.createElement('div');
      resultPanelEl.className = 'message-result-panel';
      resultPanelEl.innerHTML = '<div class="message-result-title"></div>';
    }

    if (resultPanelEl.parentNode !== contentEl) {
      var statusEl = contentEl.querySelector('.stream-status');
      if (statusEl) {
        contentEl.insertBefore(resultPanelEl, statusEl);
      } else {
        contentEl.appendChild(resultPanelEl);
      }
    }

    if (bodyEl.parentNode !== resultPanelEl) {
      resultPanelEl.appendChild(bodyEl);
    }

    if (hintEl.parentNode !== contentEl) {
      var stepsContainerEl = contentEl.querySelector('.steps-container');
      if (stepsContainerEl) {
        contentEl.insertBefore(hintEl, stepsContainerEl);
      } else {
        contentEl.insertBefore(hintEl, resultPanelEl);
      }
    }

    if (!normalizedOptions.preserveExistingContent && !String(bodyEl.textContent || '').trim()) {
      bodyEl.innerHTML = '<p>执行中，结果整理后会显示在这里。</p>';
    }

    messageEl.classList.add('assistant-execution-layout');
    applyExecutionLayoutState({
      messageEl: messageEl,
      contentEl: contentEl,
      hintEl: hintEl,
      resultPanelEl: resultPanelEl,
      bodyEl: bodyEl,
    }, normalizedOptions.completed === true);

    return {
      messageEl: messageEl,
      contentEl: contentEl,
      hintEl: hintEl,
      resultPanelEl: resultPanelEl,
      bodyEl: bodyEl,
    };
  }

  function setExecutionHint(messageId, text, state) {
    var messageEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl || !messageEl.classList.contains('assistant')) {
      return;
    }

    var hintEl = messageEl.querySelector('.message-execution-hint');
    if (!hintEl) {
      return;
    }

    applyExecutionHintState(hintEl, text, state);
  }

  function clearProcessCollapseTimer(messageId) {
    if (!processCollapseTimers[messageId]) {
      return;
    }

    clearTimeout(processCollapseTimers[messageId]);
    delete processCollapseTimers[messageId];
  }

  function setProcessPanelCollapsed(container, collapsed) {
    if (!container) { return; }

    var bodyEl = container.querySelector('.process-panel-body');
    var headerEl = container.querySelector('.process-panel-toggle');
    var iconEl = container.querySelector('.process-panel-toggle-icon');

    container.classList.toggle('process-panel-collapsed', collapsed);
    if (bodyEl) {
      bodyEl.classList.toggle('collapsed', collapsed);
    }
    if (headerEl) {
      headerEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (iconEl) {
      iconEl.textContent = collapsed ? '▶' : '▼';
    }
  }

  function activateProcessPanel(messageId, sections) {
    clearProcessCollapseTimer(messageId);
    if (!sections) { return; }

    ensureExecutionLayout(messageId, { preserveExistingContent: false, completed: false });

    sections.container.classList.remove('process-panel-complete');
    setProcessPanelCollapsed(sections.container, false);
  }

  function getProcessKindFromDescription(description) {
    if (!description) { return ''; }
    if (description.indexOf('Reading ') === 0) { return 'reading'; }
    if (description.indexOf('Editing ') === 0) { return 'modifying'; }
    if (description.indexOf('Creating ') === 0) { return 'creating'; }
    if (description.indexOf('Listing ') === 0) { return 'listing'; }
    if (description.indexOf('Running command:') === 0) { return 'command'; }
    return '';
  }

  function getProcessLabelFromDescription(processKind, description) {
    var text = String(description || '').trim();
    if (!text) { return ''; }
    switch (processKind) {
      case 'reading':
        return text.replace(/^Reading\s+/, '').trim();
      case 'modifying':
        return text.replace(/^Editing\s+/, '').trim();
      case 'creating':
        return text.replace(/^Creating\s+/, '').trim();
      case 'listing':
        return text.replace(/^Listing\s+/, '').trim();
      case 'command':
        return text.replace(/^Running command:\s*/, '').split(' · ')[0].trim();
      default:
        return text;
    }
  }

  function getMessageThinkingElapsedMs(messageId) {
    var elapsedMs = thinkingElapsedStore[messageId] || 0;
    var storedSummary = processSummaryStore[messageId];
    if (storedSummary && typeof storedSummary.thinkingElapsedMs === 'number') {
      elapsedMs = Math.max(elapsedMs, storedSummary.thinkingElapsedMs);
    }
    return elapsedMs;
  }

  function recordMessageThinkingElapsed(messageId, elapsedMs) {
    if (!messageId || typeof elapsedMs !== 'number' || elapsedMs <= 1000) {
      return;
    }

    thinkingElapsedStore[messageId] = (thinkingElapsedStore[messageId] || 0) + elapsedMs;
  }

  function removeThinkingStepLines(sections) {
    if (!sections || !sections.linesEl) { return; }

    var thinkingEls = sections.linesEl.querySelectorAll('.step-thinking');
    Array.prototype.forEach.call(thinkingEls, function (thinkingEl) {
      thinkingEl.remove();
    });
  }

  function createProcessGroupsState() {
    return {
      thinking: { key: 'thinking', title: '思考', icon: '🧠', items: [], itemMap: {} },
      listing: { key: 'listing', title: '列目录', icon: '📁', items: [], itemMap: {} },
      command: { key: 'command', title: '终端', icon: '💻', items: [], itemMap: {} },
      reading: { key: 'reading', title: '读取', icon: '📖', items: [], itemMap: {} },
      modifying: { key: 'modifying', title: '修改', icon: '✏️', items: [], itemMap: {} },
      creating: { key: 'creating', title: '创建', icon: '🆕', items: [], itemMap: {} },
      undoing: { key: 'undoing', title: '撤销', icon: '↩', items: [], itemMap: {} },
      failed: { key: 'failed', title: '失败', icon: '⚠', items: [], itemMap: {} },
    };
  }

  function getProcessItemStateWeight(state) {
    switch (state) {
      case 'error':
        return 3;
      case 'done':
        return 2;
      default:
        return 1;
    }
  }

  function addProcessGroupItem(group, label, state) {
    var text = String(label || '').trim();
    if (!text) { return; }

    var item = group.itemMap[text];
    if (!item) {
      item = { text: text, state: state || 'done' };
      group.itemMap[text] = item;
      group.items.push(item);
      return;
    }

    if (getProcessItemStateWeight(state) >= getProcessItemStateWeight(item.state)) {
      item.state = state || item.state;
    }
  }

  function getSummaryFileLabel(summaryId, filePath) {
    var files = summaryFilesStore[summaryId] || [];
    var matched = null;
    var i;
    for (i = 0; i < files.length; i += 1) {
      if (files[i].path === filePath) {
        matched = files[i];
        break;
      }
    }

    var label = matched ? (matched.displayPath || matched.path) : filePath;
    return label.split(/[/\\]/).pop() || label;
  }

  function isSummaryFileUndoable(file) {
    if (!file) { return false; }
    if (typeof file.undoable === 'boolean') {
      return !!file.undoable;
    }
    var isWriteFile = file.status === 'created' || file.status === 'modified';
    return isWriteFile && !file.issueText;
  }

  function rememberUndoIntent(summaryId, filePath) {
    if (!summaryUndoIntentStore[summaryId]) {
      summaryUndoIntentStore[summaryId] = {
        files: [],
        fileMap: {},
        paths: [],
        pathMap: {},
      };
    }

    var undoState = summaryUndoIntentStore[summaryId];
    var files = [];
    var paths = [];
    var i;

    if (filePath) {
      files.push(getSummaryFileLabel(summaryId, filePath));
      paths.push(filePath);
    } else {
      var summaryFiles = summaryFilesStore[summaryId] || [];
      for (i = 0; i < summaryFiles.length; i += 1) {
        if (!isSummaryFileUndoable(summaryFiles[i])) { continue; }
        files.push(summaryFiles[i].displayPath || summaryFiles[i].path);
        paths.push(summaryFiles[i].path);
      }
    }

    for (i = 0; i < files.length; i += 1) {
      var label = String(files[i] || '').split(/[/\\]/).pop() || String(files[i] || '');
      if (!label || undoState.fileMap[label]) { continue; }
      undoState.fileMap[label] = true;
      undoState.files.push(label);
    }

    for (i = 0; i < paths.length; i += 1) {
      var currentPath = paths[i];
      if (!currentPath || undoState.pathMap[currentPath]) { continue; }
      undoState.pathMap[currentPath] = true;
      undoState.paths.push(currentPath);
    }
  }

  function buildProcessGroupsForMessage(messageId, existingSections) {
    var sections = existingSections || getStepSections(messageId);
    if (!sections) { return null; }

    var groups = createProcessGroupsState();
    removeThinkingStepLines(sections);

    var thinkingMs = getMessageThinkingElapsedMs(messageId);
    if (thinkingMs > 1000) {
      addProcessGroupItem(groups.thinking, formatElapsed(thinkingMs), 'done');
    }

    var stepEls = sections.linesEl.querySelectorAll('.step-item');
    Array.prototype.forEach.call(stepEls, function (stepEl) {
      var descEl = stepEl.querySelector('.step-desc');
      var description = descEl ? String(descEl.textContent || '').trim() : '';
      var itemState = stepEl.classList.contains('step-error')
        ? 'error'
        : (stepEl.classList.contains('step-running') ? 'running' : 'done');

      if (itemState === 'error') {
        addProcessGroupItem(groups.failed, description, 'error');
        return;
      }

      var processKind = getProcessKindFromDescription(description);
      var processLabel = getProcessLabelFromDescription(processKind, description);
      if (!processKind || !groups[processKind]) { return; }
      addProcessGroupItem(groups[processKind], processLabel, itemState);
    });

    var summaryEls = sections.detailsEl.querySelectorAll('.change-summary');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      var summaryId = summaryEl.getAttribute('data-summary-id') || '';
      var statusEl = summaryEl.querySelector('.summary-status');
      var statusText = statusEl ? String(statusEl.textContent || '').trim() : '';
      if (!statusText) { return; }

      if (statusText.indexOf('↩') === 0) {
        var undoState = summaryUndoIntentStore[summaryId];
        if (undoState && undoState.files.length > 0) {
          Array.prototype.forEach.call(undoState.files, function (fileLabel) {
            addProcessGroupItem(groups.undoing, fileLabel, 'done');
          });
        } else {
          addProcessGroupItem(groups.undoing, statusText, 'done');
        }
        return;
      }

      if (
        statusEl.classList.contains('summary-failed') ||
        statusEl.classList.contains('summary-partial')
      ) {
        addProcessGroupItem(groups.failed, statusText, 'error');
      }
    });

    return {
      sections: sections,
      groups: groups,
    };
  }

  function renderProcessGroups(groups) {
    var groupOrder = ['thinking', 'listing', 'reading', 'command', 'modifying', 'creating', 'undoing', 'failed'];
    var html = '';

    Array.prototype.forEach.call(groupOrder, function (groupKey) {
      var group = groups[groupKey];
      if (!group || group.items.length === 0) { return; }

      var itemsHtml = group.items.map(function (item) {
        return '<span class="process-group-item" data-state="' + escapeHtml(item.state) + '">' + escapeHtml(item.text) + '</span>';
      }).join('');

      html +=
        '<div class="process-group-card" data-group="' + escapeHtml(group.key) + '">' +
          '<div class="process-group-header">' +
            '<span class="process-group-icon">' + group.icon + '</span>' +
            '<span class="process-group-title">' + escapeHtml(group.title) + '</span>' +
            '<span class="process-group-count">' + group.items.length + '</span>' +
          '</div>' +
          '<div class="process-group-items">' + itemsHtml + '</div>' +
        '</div>';
    });

    return html;
  }

  function buildHistoryProcessSummaryText(summary) {
    var parts = [];

    if (summary && typeof summary.thinkingElapsedMs === 'number' && summary.thinkingElapsedMs > 1000) {
      parts.push('思考 ' + formatElapsed(summary.thinkingElapsedMs));
    }
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

    if (summary && typeof summary.thinkingElapsedMs === 'number' && summary.thinkingElapsedMs > 1000) {
      items.push({ label: '思考', value: formatElapsed(summary.thinkingElapsedMs) });
    }
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

  function buildLiveProcessSummaryText(groups) {
    var parts = [];

    if (groups.thinking.items.length > 0) {
      if (groups.thinking.items.length === 1) {
        parts.push('思考 ' + groups.thinking.items[0].text);
      } else {
        parts.push('思考 ' + groups.thinking.items.length + ' 次');
      }
    }
    if (groups.listing.items.length > 0) {
      parts.push('列目录 ' + groups.listing.items.length);
    }
    if (groups.reading.items.length > 0) {
      parts.push('读取 ' + groups.reading.items.length);
    }
    if (groups.command.items.length > 0) {
      parts.push('终端 ' + groups.command.items.length);
    }
    if (groups.modifying.items.length > 0) {
      parts.push('修改 ' + groups.modifying.items.length);
    }
    if (groups.creating.items.length > 0) {
      parts.push('创建 ' + groups.creating.items.length);
    }
    if (groups.undoing.items.length > 0) {
      parts.push('撤销 ' + groups.undoing.items.length);
    }
    if (groups.failed.items.length > 0) {
      parts.push('失败 ' + groups.failed.items.length);
    }

    return parts.join(' · ') || '执行过程';
  }

  function decorateProcessPanelSummaryText(summaryText, isComplete) {
    var normalizedText = String(summaryText || '').trim();
    if (!normalizedText || normalizedText === '执行过程') {
      return isComplete ? '已完成' : '处理中';
    }

    return (isComplete ? '已完成 · ' : '处理中 · ') + normalizedText;
  }

  function refreshProcessPanel(messageId, processState) {
    var resolvedState = processState || buildProcessGroupsForMessage(messageId);
    var sections = resolvedState ? resolvedState.sections : getStepSections(messageId);
    if (!sections) { return; }

    var storedSummary = processSummaryStore[messageId];
    var prefixEl = sections.headerEl.querySelector('.process-panel-toggle-prefix');
    var summaryEl = sections.headerEl.querySelector('.process-panel-toggle-summary');
    var rawSummaryText = storedSummary
      ? buildHistoryProcessSummaryText(storedSummary)
      : (resolvedState ? buildLiveProcessSummaryText(resolvedState.groups) : '执行过程');
    var isComplete = !!storedSummary || sections.container.classList.contains('process-panel-complete');
    var summaryText = decorateProcessPanelSummaryText(rawSummaryText, isComplete);
    var hasContent = sections.linesEl.children.length > 0
      || sections.groupsEl.children.length > 0
      || sections.detailsEl.children.length > 0;

    if (prefixEl) {
      prefixEl.textContent = '执行过程';
    }
    if (summaryEl) {
      summaryEl.textContent = summaryText;
    }

    sections.container.style.display = hasContent ? '' : 'none';
    sections.container.classList.toggle('process-panel-history', !!storedSummary);
  }

  function refreshProcessGroups(messageId) {
    var processState = buildProcessGroupsForMessage(messageId);
    if (!processState) { return; }
    processState.sections.groupsEl.innerHTML = renderProcessGroups(processState.groups);
    refreshProcessPanel(messageId, processState);
  }

  function markProcessComplete(messageId) {
    if (!messageId) {
      return;
    }

    clearProcessCollapseTimer(messageId);
    processCollapseTimers[messageId] = setTimeout(function () {
      delete processCollapseTimers[messageId];
      var existingSections = findStepSections(messageId);
      if (!existingSections) { return; }

      var processState = buildProcessGroupsForMessage(messageId, existingSections);
      var sections = processState ? processState.sections : existingSections;
      if (!sections) { return; }

      ensureExecutionLayout(messageId, { preserveExistingContent: true, completed: true });
      sections.container.classList.add('process-panel-complete');
      refreshProcessPanel(messageId, processState);
      if (sections.container.style.display === 'none') {
        return;
      }

      setProcessPanelCollapsed(sections.container, false);
    }, 140);
  }

  function showHistoryProcessSummary(data) {
    if (!data || !data.summary) {
      return;
    }

    var sections = getStepSections(data.messageId);
    if (!sections) { return; }

    ensureExecutionLayout(data.messageId, { preserveExistingContent: true, completed: true });

    var existingSummaryEl = sections.detailsEl.querySelector('.history-process-card');
    if (existingSummaryEl) {
      existingSummaryEl.remove();
    }

    var metricItems = buildHistoryProcessMetricItems(data.summary);
    var metricHtml = metricItems.map(function (item) {
      return '<span class="history-process-chip' + (item.danger ? ' danger' : '') + '">' +
        '<span class="history-process-chip-label">' + escapeHtml(item.label) + '</span>' +
        '<span class="history-process-chip-value">' + escapeHtml(String(item.value)) + '</span>' +
      '</span>';
    }).join('');
    var filesHtml = '';

    if (data.summary.changedFiles && data.summary.changedFiles.length > 0) {
      filesHtml =
        '<div class="history-process-files">' +
          '<div class="history-process-section-title">改动文件</div>' +
          '<div class="history-process-file-list">' +
            data.summary.changedFiles.map(function (filePath) {
              return '<span class="history-process-file" title="' + escapeHtml(filePath) + '">' + escapeHtml(filePath) + '</span>';
            }).join('') +
          '</div>' +
        '</div>';
    }

    var summaryEl = document.createElement('div');
    summaryEl.className = 'history-process-card';
    summaryEl.innerHTML =
      '<div class="history-process-section">' +
        '<div class="history-process-section-title">过程摘要</div>' +
        '<div class="history-process-metrics">' + metricHtml + '</div>' +
      '</div>' +
      filesHtml;

    sections.detailsEl.appendChild(summaryEl);
    processSummaryStore[data.messageId] = data.summary;
    if (typeof data.summary.thinkingElapsedMs === 'number' && data.summary.thinkingElapsedMs > 1000) {
      thinkingElapsedStore[data.messageId] = data.summary.thinkingElapsedMs;
    }
    refreshProcessPanel(data.messageId);
    sections.container.classList.add('process-panel-complete');
    setProcessPanelCollapsed(sections.container, true);
    scrollToBottom();
  }

  function addStep(data) {
    var sections = getStepSections(data.messageId);
    if (!sections) { return; }
    activateProcessPanel(data.messageId, sections);

    var stepEl = document.createElement('div');
    stepEl.className = 'step-item step-' + data.status;
    stepEl.setAttribute('data-step-id', data.stepId);
    stepEl.setAttribute('data-icon', data.icon);

    // 步骤图标（running 时显示 spinner，done/error 显示对应图标）
    var iconHtml = getStepIconHtml(data.status, data.icon);

    stepEl.innerHTML =
      '<div class="step-icon">' + iconHtml + '</div>' +
      '<div class="step-desc">' + escapeHtml(data.description) + '</div>' +
      '<div class="step-elapsed"></div>';

    sections.linesEl.appendChild(stepEl);
    refreshProcessGroups(data.messageId);
    scrollToBottom();
  }

  /**
   * 更新步骤状态
   * 
   * @param {object} data { stepId, status, description?, elapsed? }
   */
  function updateStep(data) {
    var stepEl = document.querySelector('[data-step-id="' + data.stepId + '"]');
    if (!stepEl) { return; }

    // 更新 CSS 类
    stepEl.className = 'step-item step-' + data.status;

    // 更新图标
    var iconEl = stepEl.querySelector('.step-icon');
    if (iconEl) {
      // 从原始 icon 属性获取 emoji，或用默认
      var originalIcon = stepEl.getAttribute('data-icon') || '📄';
      iconEl.innerHTML = getStepIconHtml(data.status, originalIcon);
    }

    // 更新描述文字
    if (data.description !== undefined) {
      var descEl = stepEl.querySelector('.step-desc');
      if (descEl) {
        descEl.textContent = data.description;
      }
    }

    // 更新耗时
    if (data.elapsed !== undefined) {
      var elapsedEl = stepEl.querySelector('.step-elapsed');
      if (elapsedEl) {
        elapsedEl.textContent = formatElapsed(data.elapsed);
      }
    }

    var messageId = getMessageIdByElement(stepEl);
    if (messageId) {
      refreshProcessGroups(messageId);
    }
    scrollToBottom();
  }

  /**
   * 根据步骤状态返回对应的图标 HTML
   */
  function getStepIconHtml(status, emoji) {
    switch (status) {
      case 'running':
        return '<div class="step-spinner"></div>';
      case 'done':
        return '<span class="step-check">✓</span>';
      case 'error':
        return '<span class="step-error">✗</span>';
      default:
        return '<span>' + emoji + '</span>';
    }
  }

  // ==================== Thinking 耗时显示 ====================

  /**
   * 显示 Thinking 完成耗时（可折叠）
   * 替代之前的 Thinking 动画，流式结束后调用
   * 
   * @param {object} data { messageId, elapsed }
   */
  function showThinkingComplete(data) {
    if (!data || data.isExecutionMessage !== true) {
      return;
    }

    var sections = getStepSections(data.messageId);
    if (!sections) { return; }
    activateProcessPanel(data.messageId, sections);

    recordMessageThinkingElapsed(data.messageId, data.elapsed);
    removeThinkingStepLines(sections);
    refreshProcessGroups(data.messageId);
    scrollToBottom();
  }

  // ==================== Diff 展示 ====================

  /**
   * 显示代码 Diff
   * 
   * @param {object} data { messageId, stepId, filePath, language, additions, deletions, oldContent, newContent, needsConfirm }
   */
  function showDiff(data) {
    var stepEl = document.querySelector('[data-step-id="' + data.stepId + '"]');
    if (!stepEl) { return; }

    var messageId = getMessageIdByElement(stepEl);
    var sections = messageId ? getStepSections(messageId) : null;
    if (messageId && sections) {
      activateProcessPanel(messageId, sections);
    }

    var existingDiffEl = document.querySelector('.diff-block[data-step-id="' + data.stepId + '"]');
    if (existingDiffEl) {
      existingDiffEl.remove();
    }

    var diffModel = renderUnifiedDiff(data.oldContent, data.newContent, data.language);

    var diffEl = document.createElement('div');
    diffEl.className = 'diff-block';
    diffEl.setAttribute('data-step-id', data.stepId);
    if (data.readOnly) {
      diffEl.setAttribute('data-read-only', 'true');
    }
    if (data.summaryId) {
      diffEl.setAttribute('data-summary-id', data.summaryId);
    }

    var fileName = data.filePath.split(/[/\\]/).pop() || data.filePath;
    var statsHtml = buildDiffStatsHtml(diffModel.additions, diffModel.deletions);
    var diffContentHtml = diffModel.html;
    var noticeHtml = data.noticeText
      ? '<div class="diff-notice">' + escapeHtml(data.noticeText) + '</div>'
      : '';

    var actionsHtml = '';

    diffEl.innerHTML =
      '<div class="diff-header">' +
        '<span class="diff-lang">' + (data.language || 'text').toUpperCase() + '</span>' +
        '<span class="diff-filename">' + escapeHtml(fileName) + '</span>' +
        statsHtml +
        '<button class="diff-toggle" title="' + (data.readOnly ? '历史记录只读' : '展开/折叠') + '"' + (data.readOnly ? ' disabled' : '') + '>▼</button>' +
      '</div>' +
      noticeHtml +
      '<div class="diff-content">' + diffContentHtml + '</div>' +
      actionsHtml;

    if (sections) {
      sections.detailsEl.appendChild(diffEl);
    } else {
      stepEl.parentNode.insertBefore(diffEl, stepEl.nextSibling);
    }

    // 绑定折叠按钮事件
    var toggleBtn = diffEl.querySelector('.diff-toggle');
    if (toggleBtn && !data.readOnly) {
      toggleBtn.addEventListener('click', function () {
        setDiffCollapsed(diffEl, !isDiffCollapsed(diffEl));
        updateSummaryViewButtons(data.summaryId);
      });
    }

    setDiffCollapsed(diffEl, !!data.collapsed);

    // 绑定 Accept/Reject 事件
    if (!data.readOnly) {
      bindDiffActions(diffEl, data.stepId);
    }
    updateSummaryViewButtons(data.summaryId);

    scrollToBottom();
  }

  function buildDiffStatsHtml(additions, deletions) {
    var statsHtml = '';
    if (additions > 0) { statsHtml += '<span class="diff-add">+' + additions + '</span>'; }
    if (deletions > 0) { statsHtml += '<span class="diff-del">-' + deletions + '</span>'; }
    return statsHtml;
  }

  function renderUnifiedDiff(oldContent, newContent, language) {
    var oldLines = splitIntoLines(oldContent);
    var newLines = splitIntoLines(newContent);
    var operations = buildDiffOperations(oldLines, newLines);
    var additions = countOperationsByType(operations, 'add');
    var deletions = countOperationsByType(operations, 'del');

    if (additions === 0 && deletions === 0) {
      return {
        additions: 0,
        deletions: 0,
        html: '<div class="diff-line diff-line-info">无内容变更</div>'
      };
    }

    var visibleOperations = buildVisibleDiffOperations(operations, 3, 120);
    return {
      additions: additions,
      deletions: deletions,
      html: renderDiffOperationsHtml(visibleOperations)
    };
  }

  function splitIntoLines(content) {
    if (!content) {
      return [];
    }
    var normalized = String(content).replace(/\r\n/g, '\n');
    if (normalized.endsWith('\n')) {
      normalized = normalized.slice(0, -1);
    }
    if (!normalized) {
      return [];
    }
    return normalized.split('\n');
  }

  function buildDiffOperations(oldLines, newLines) {
    var prefixLength = 0;
    while (
      prefixLength < oldLines.length &&
      prefixLength < newLines.length &&
      oldLines[prefixLength] === newLines[prefixLength]
    ) {
      prefixLength += 1;
    }

    var oldSuffixIndex = oldLines.length - 1;
    var newSuffixIndex = newLines.length - 1;
    while (
      oldSuffixIndex >= prefixLength &&
      newSuffixIndex >= prefixLength &&
      oldLines[oldSuffixIndex] === newLines[newSuffixIndex]
    ) {
      oldSuffixIndex -= 1;
      newSuffixIndex -= 1;
    }

    var operations = [];
    var prefixIndex;
    for (prefixIndex = 0; prefixIndex < prefixLength; prefixIndex += 1) {
      operations.push({
        type: 'context',
        oldLineNumber: prefixIndex + 1,
        newLineNumber: prefixIndex + 1,
        text: oldLines[prefixIndex]
      });
    }

    var middleOldLines = oldLines.slice(prefixLength, oldSuffixIndex + 1);
    var middleNewLines = newLines.slice(prefixLength, newSuffixIndex + 1);
    var middleOperations = buildMiddleDiffOperations(middleOldLines, middleNewLines, prefixLength, prefixLength);
    Array.prototype.push.apply(operations, middleOperations);

    var suffixStartInOld = oldSuffixIndex + 1;
    var suffixStartInNew = newSuffixIndex + 1;
    var suffixLength = oldLines.length - suffixStartInOld;
    var suffixOffset;
    for (suffixOffset = 0; suffixOffset < suffixLength; suffixOffset += 1) {
      operations.push({
        type: 'context',
        oldLineNumber: suffixStartInOld + suffixOffset + 1,
        newLineNumber: suffixStartInNew + suffixOffset + 1,
        text: oldLines[suffixStartInOld + suffixOffset]
      });
    }

    return operations;
  }

  function buildMiddleDiffOperations(oldLines, newLines, oldOffset, newOffset) {
    if (oldLines.length === 0) {
      return newLines.map(function (line, index) {
        return { type: 'add', oldLineNumber: null, newLineNumber: newOffset + index + 1, text: line };
      });
    }

    if (newLines.length === 0) {
      return oldLines.map(function (line, index) {
        return { type: 'del', oldLineNumber: oldOffset + index + 1, newLineNumber: null, text: line };
      });
    }

    if (oldLines.length * newLines.length <= 120000) {
      return buildMiddleDiffOperationsByLcs(oldLines, newLines, oldOffset, newOffset);
    }

    return buildMiddleDiffOperationsByLookahead(oldLines, newLines, oldOffset, newOffset);
  }

  function buildMiddleDiffOperationsByLcs(oldLines, newLines, oldOffset, newOffset) {
    var rowCount = oldLines.length;
    var columnCount = newLines.length;
    var lcsTable = new Array(rowCount + 1);
    var row;
    for (row = 0; row <= rowCount; row += 1) {
      lcsTable[row] = new Uint32Array(columnCount + 1);
    }

    for (row = rowCount - 1; row >= 0; row -= 1) {
      var currentRow = lcsTable[row];
      var nextRow = lcsTable[row + 1];
      var column;
      for (column = columnCount - 1; column >= 0; column -= 1) {
        if (oldLines[row] === newLines[column]) {
          currentRow[column] = nextRow[column + 1] + 1;
        } else {
          currentRow[column] = nextRow[column] >= currentRow[column + 1]
            ? nextRow[column]
            : currentRow[column + 1];
        }
      }
    }

    var operations = [];
    var oldIndex = 0;
    var newIndex = 0;

    while (oldIndex < rowCount && newIndex < columnCount) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        operations.push({
          type: 'context',
          oldLineNumber: oldOffset + oldIndex + 1,
          newLineNumber: newOffset + newIndex + 1,
          text: oldLines[oldIndex]
        });
        oldIndex += 1;
        newIndex += 1;
      } else if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
        operations.push({
          type: 'del',
          oldLineNumber: oldOffset + oldIndex + 1,
          newLineNumber: null,
          text: oldLines[oldIndex]
        });
        oldIndex += 1;
      } else {
        operations.push({
          type: 'add',
          oldLineNumber: null,
          newLineNumber: newOffset + newIndex + 1,
          text: newLines[newIndex]
        });
        newIndex += 1;
      }
    }

    while (oldIndex < rowCount) {
      operations.push({
        type: 'del',
        oldLineNumber: oldOffset + oldIndex + 1,
        newLineNumber: null,
        text: oldLines[oldIndex]
      });
      oldIndex += 1;
    }

    while (newIndex < columnCount) {
      operations.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: newOffset + newIndex + 1,
        text: newLines[newIndex]
      });
      newIndex += 1;
    }

    return operations;
  }

  function buildMiddleDiffOperationsByLookahead(oldLines, newLines, oldOffset, newOffset) {
    var operations = [];
    var oldIndex = 0;
    var newIndex = 0;
    var lookaheadSize = 20;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        operations.push({
          type: 'context',
          oldLineNumber: oldOffset + oldIndex + 1,
          newLineNumber: newOffset + newIndex + 1,
          text: oldLines[oldIndex]
        });
        oldIndex += 1;
        newIndex += 1;
        continue;
      }

      var nextNewMatch = findNextMatchingLine(newLines, newIndex + 1, oldLines[oldIndex], lookaheadSize);
      var nextOldMatch = findNextMatchingLine(oldLines, oldIndex + 1, newLines[newIndex], lookaheadSize);

      if (nextNewMatch !== -1 && (nextOldMatch === -1 || nextNewMatch - newIndex <= nextOldMatch - oldIndex)) {
        while (newIndex < nextNewMatch) {
          operations.push({
            type: 'add',
            oldLineNumber: null,
            newLineNumber: newOffset + newIndex + 1,
            text: newLines[newIndex]
          });
          newIndex += 1;
        }
        continue;
      }

      if (nextOldMatch !== -1) {
        while (oldIndex < nextOldMatch) {
          operations.push({
            type: 'del',
            oldLineNumber: oldOffset + oldIndex + 1,
            newLineNumber: null,
            text: oldLines[oldIndex]
          });
          oldIndex += 1;
        }
        continue;
      }

      operations.push({
        type: 'del',
        oldLineNumber: oldOffset + oldIndex + 1,
        newLineNumber: null,
        text: oldLines[oldIndex]
      });
      operations.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: newOffset + newIndex + 1,
        text: newLines[newIndex]
      });
      oldIndex += 1;
      newIndex += 1;
    }

    while (oldIndex < oldLines.length) {
      operations.push({
        type: 'del',
        oldLineNumber: oldOffset + oldIndex + 1,
        newLineNumber: null,
        text: oldLines[oldIndex]
      });
      oldIndex += 1;
    }

    while (newIndex < newLines.length) {
      operations.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: newOffset + newIndex + 1,
        text: newLines[newIndex]
      });
      newIndex += 1;
    }

    return operations;
  }

  function findNextMatchingLine(lines, startIndex, targetLine, lookaheadSize) {
    var maxIndex = Math.min(lines.length, startIndex + lookaheadSize);
    var index;
    for (index = startIndex; index < maxIndex; index += 1) {
      if (lines[index] === targetLine) {
        return index;
      }
    }
    return -1;
  }

  function countOperationsByType(operations, type) {
    var count = 0;
    operations.forEach(function (operation) {
      if (operation.type === type) {
        count += 1;
      }
    });
    return count;
  }

  function buildVisibleDiffOperations(operations, contextLineCount, maxVisibleLines) {
    var changeIndexes = [];
    operations.forEach(function (operation, index) {
      if (operation.type !== 'context') {
        changeIndexes.push(index);
      }
    });

    if (changeIndexes.length === 0) {
      return [];
    }

    var ranges = [];
    changeIndexes.forEach(function (changeIndex) {
      var start = Math.max(0, changeIndex - contextLineCount);
      var end = Math.min(operations.length - 1, changeIndex + contextLineCount);
      var lastRange = ranges[ranges.length - 1];
      if (!lastRange || start > lastRange.end + 1) {
        ranges.push({ start: start, end: end });
      } else if (end > lastRange.end) {
        lastRange.end = end;
      }
    });

    var visibleOperations = [];
    var cursor = 0;
    ranges.forEach(function (range) {
      if (range.start > cursor) {
        visibleOperations.push({
          type: 'info',
          text: '... 省略 ' + (range.start - cursor) + ' 行未改动内容'
        });
      }

      var rangeIndex;
      for (rangeIndex = range.start; rangeIndex <= range.end; rangeIndex += 1) {
        visibleOperations.push(operations[rangeIndex]);
      }
      cursor = range.end + 1;
    });

    if (cursor < operations.length) {
      visibleOperations.push({
        type: 'info',
        text: '... 省略 ' + (operations.length - cursor) + ' 行未改动内容'
      });
    }

    return trimVisibleDiffOperations(visibleOperations, maxVisibleLines);
  }

  function trimVisibleDiffOperations(visibleOperations, maxVisibleLines) {
    var result = [];
    var visibleLineCount = 0;
    var index;
    for (index = 0; index < visibleOperations.length; index += 1) {
      var operation = visibleOperations[index];
      result.push(operation);
      if (operation.type !== 'info') {
        visibleLineCount += 1;
      }
      if (visibleLineCount >= maxVisibleLines) {
        if (index < visibleOperations.length - 1) {
          result.push({ type: 'info', text: '... 还有更多变更未展示' });
        }
        break;
      }
    }
    return result;
  }

  function renderDiffOperationsHtml(operations) {
    var preparedOperations = buildHighlightedDiffOperations(operations);
    var html = '';
    preparedOperations.forEach(function (operation) {
      if (operation.type === 'info') {
        html += '<div class="diff-line diff-line-info">' + escapeHtml(operation.text) + '</div>';
        return;
      }

      var lineClass = 'diff-line';
      var sign = ' ';
      if (operation.type === 'add') {
        lineClass += ' diff-line-add';
        sign = '+';
      } else if (operation.type === 'del') {
        lineClass += ' diff-line-del';
        sign = '-';
      } else {
        lineClass += ' diff-line-context';
      }

      html += '<div class="' + lineClass + '">' +
        '<span class="diff-line-num">' + formatDiffLineNumber(operation.oldLineNumber) + '</span>' +
        '<span class="diff-line-num">' + formatDiffLineNumber(operation.newLineNumber) + '</span>' +
        '<span class="diff-line-sign">' + sign + '</span>' +
        '<span class="diff-line-text">' + getDiffOperationTextHtml(operation) + '</span>' +
        '</div>';
    });
    return html;
  }

  function buildHighlightedDiffOperations(operations) {
    var preparedOperations = operations.map(function (operation) {
      return Object.assign({}, operation);
    });

    var index = 0;
    while (index < preparedOperations.length) {
      var operation = preparedOperations[index];
      if (operation.type !== 'add' && operation.type !== 'del') {
        index += 1;
        continue;
      }

      var blockStart = index;
      while (
        index < preparedOperations.length &&
        (preparedOperations[index].type === 'add' || preparedOperations[index].type === 'del')
      ) {
        index += 1;
      }

      decorateDiffChangeBlock(preparedOperations.slice(blockStart, index));
    }

    preparedOperations.forEach(function (operation) {
      if (operation.type !== 'info' && operation.renderedText === undefined) {
        operation.renderedText = escapeHtml(operation.text || '');
      }
    });

    return preparedOperations;
  }

  function decorateDiffChangeBlock(blockOperations) {
    var deletedOperations = [];
    var addedOperations = [];

    blockOperations.forEach(function (operation) {
      if (operation.type === 'del') {
        deletedOperations.push(operation);
      } else if (operation.type === 'add') {
        addedOperations.push(operation);
      }
    });

    deletedOperations.forEach(function (operation) {
      operation.renderedText = escapeHtml(operation.text || '');
    });
    addedOperations.forEach(function (operation) {
      operation.renderedText = escapeHtml(operation.text || '');
    });

    var pairCount = Math.min(deletedOperations.length, addedOperations.length);
    var pairIndex;
    for (pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      var deletedOperation = deletedOperations[pairIndex];
      var addedOperation = addedOperations[pairIndex];

      if (!shouldHighlightInlinePair(deletedOperation.text, addedOperation.text)) {
        continue;
      }

      var inlinePair = buildInlineHighlightPair(deletedOperation.text, addedOperation.text);
      deletedOperation.renderedText = inlinePair.deletedHtml;
      addedOperation.renderedText = inlinePair.addedHtml;
    }
  }

  function shouldHighlightInlinePair(oldText, newText) {
    if (!oldText && !newText) {
      return false;
    }

    if (oldText === newText) {
      return false;
    }

    return calculateLineSimilarity(oldText, newText) >= 0.18;
  }

  function calculateLineSimilarity(oldText, newText) {
    var oldValue = oldText || '';
    var newValue = newText || '';
    var maxLength = Math.max(oldValue.length, newValue.length, 1);
    var prefixLength = getCommonStringPrefixLength(oldValue, newValue);
    var suffixLength = getCommonStringSuffixLength(oldValue, newValue, prefixLength);
    return (prefixLength + suffixLength) / maxLength;
  }

  function buildInlineHighlightPair(oldText, newText) {
    var oldTokens = tokenizeDiffText(oldText || '');
    var newTokens = tokenizeDiffText(newText || '');

    if (oldTokens.length > 0 && newTokens.length > 0 && oldTokens.length * newTokens.length <= 4000) {
      var tokenOperations = buildTokenDiffOperations(oldTokens, newTokens);
      return {
        deletedHtml: renderInlineTokens(tokenOperations, 'del'),
        addedHtml: renderInlineTokens(tokenOperations, 'add')
      };
    }

    return buildInlineHighlightPairByPrefixSuffix(oldText || '', newText || '');
  }

  function tokenizeDiffText(text) {
    if (!text) {
      return [];
    }

    var characters = Array.from(text);
    var tokens = [];
    var currentValue = characters[0];
    var currentType = getDiffTokenType(characters[0]);
    var index;

    for (index = 1; index < characters.length; index += 1) {
      var character = characters[index];
      var tokenType = getDiffTokenType(character);
      if (tokenType === currentType && tokenType !== 'symbol') {
        currentValue += character;
      } else {
        tokens.push({ type: currentType, value: currentValue });
        currentType = tokenType;
        currentValue = character;
      }
    }

    tokens.push({ type: currentType, value: currentValue });
    return tokens;
  }

  function getDiffTokenType(character) {
    if (/\s/.test(character)) {
      return 'space';
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      return 'word';
    }
    return 'symbol';
  }

  function buildTokenDiffOperations(oldTokens, newTokens) {
    var rowCount = oldTokens.length;
    var columnCount = newTokens.length;
    var lcsTable = new Array(rowCount + 1);
    var row;

    for (row = 0; row <= rowCount; row += 1) {
      lcsTable[row] = new Array(columnCount + 1).fill(0);
    }

    for (row = rowCount - 1; row >= 0; row -= 1) {
      var column;
      for (column = columnCount - 1; column >= 0; column -= 1) {
        if (oldTokens[row].value === newTokens[column].value) {
          lcsTable[row][column] = lcsTable[row + 1][column + 1] + 1;
        } else {
          lcsTable[row][column] = Math.max(lcsTable[row + 1][column], lcsTable[row][column + 1]);
        }
      }
    }

    var operations = [];
    var oldIndex = 0;
    var newIndex = 0;

    while (oldIndex < rowCount && newIndex < columnCount) {
      if (oldTokens[oldIndex].value === newTokens[newIndex].value) {
        operations.push({ type: 'context', value: oldTokens[oldIndex].value });
        oldIndex += 1;
        newIndex += 1;
      } else if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
        operations.push({ type: 'del', value: oldTokens[oldIndex].value });
        oldIndex += 1;
      } else {
        operations.push({ type: 'add', value: newTokens[newIndex].value });
        newIndex += 1;
      }
    }

    while (oldIndex < rowCount) {
      operations.push({ type: 'del', value: oldTokens[oldIndex].value });
      oldIndex += 1;
    }

    while (newIndex < columnCount) {
      operations.push({ type: 'add', value: newTokens[newIndex].value });
      newIndex += 1;
    }

    return operations;
  }

  function renderInlineTokens(tokenOperations, targetType) {
    var html = '';
    tokenOperations.forEach(function (operation) {
      if (operation.type === 'context') {
        html += escapeHtml(operation.value);
      } else if (operation.type === targetType) {
        var className = targetType === 'add' ? 'diff-inline-add' : 'diff-inline-del';
        html += '<span class="' + className + '">' + escapeHtml(operation.value) + '</span>';
      }
    });
    return html;
  }

  function buildInlineHighlightPairByPrefixSuffix(oldText, newText) {
    var prefixLength = getCommonStringPrefixLength(oldText, newText);
    var suffixLength = getCommonStringSuffixLength(oldText, newText, prefixLength);

    var oldEndIndex = oldText.length - suffixLength;
    var newEndIndex = newText.length - suffixLength;

    var oldPrefix = oldText.slice(0, prefixLength);
    var newPrefix = newText.slice(0, prefixLength);
    var oldChanged = oldText.slice(prefixLength, oldEndIndex);
    var newChanged = newText.slice(prefixLength, newEndIndex);
    var oldSuffix = oldText.slice(oldEndIndex);
    var newSuffix = newText.slice(newEndIndex);

    return {
      deletedHtml: escapeHtml(oldPrefix) + wrapInlineFragment(oldChanged, 'diff-inline-del') + escapeHtml(oldSuffix),
      addedHtml: escapeHtml(newPrefix) + wrapInlineFragment(newChanged, 'diff-inline-add') + escapeHtml(newSuffix)
    };
  }

  function wrapInlineFragment(text, className) {
    if (!text) {
      return '';
    }
    return '<span class="' + className + '">' + escapeHtml(text) + '</span>';
  }

  function getCommonStringPrefixLength(leftText, rightText) {
    var maxLength = Math.min(leftText.length, rightText.length);
    var index = 0;
    while (index < maxLength && leftText[index] === rightText[index]) {
      index += 1;
    }
    return index;
  }

  function getCommonStringSuffixLength(leftText, rightText, prefixLength) {
    var leftIndex = leftText.length - 1;
    var rightIndex = rightText.length - 1;
    var suffixLength = 0;
    while (
      leftIndex >= prefixLength &&
      rightIndex >= prefixLength &&
      leftText[leftIndex] === rightText[rightIndex]
    ) {
      suffixLength += 1;
      leftIndex -= 1;
      rightIndex -= 1;
    }
    return suffixLength;
  }

  function getDiffOperationTextHtml(operation) {
    if (operation.renderedText !== undefined) {
      return operation.renderedText;
    }
    return escapeHtml(operation.text || '');
  }

  function formatDiffLineNumber(lineNumber) {
    if (lineNumber === null || lineNumber === undefined) {
      return '';
    }
    return String(lineNumber);
  }

  /**
   * 绑定 Diff 区域的 Accept/Reject 按钮事件
   */
  function bindDiffActions(diffEl, stepId) {
    if (!diffEl || !stepId) {
      return;
    }
  }

  function isDiffCollapsed(diffEl) {
    var contentEl = diffEl.querySelector('.diff-content');
    return !!(contentEl && contentEl.classList.contains('collapsed'));
  }

  function setDiffCollapsed(diffEl, collapsed) {
    var contentEl = diffEl.querySelector('.diff-content');
    var toggleBtn = diffEl.querySelector('.diff-toggle');

    if (contentEl) {
      contentEl.classList.toggle('collapsed', collapsed);
    }

    if (toggleBtn) {
      toggleBtn.textContent = collapsed ? '▶' : '▼';
    }
  }

  function getSummaryDiffBlocks(summaryId) {
    if (!summaryId) { return []; }
    return Array.prototype.slice.call(document.querySelectorAll('.diff-block[data-summary-id="' + summaryId + '"]'));
  }

  function updateSummaryViewButtons(summaryId) {
    if (!summaryId) { return; }

    var diffBlocks = getSummaryDiffBlocks(summaryId);
    var summaryEls = document.querySelectorAll('.change-summary[data-summary-id="' + summaryId + '"]');
    var hasDiffs = diffBlocks.length > 0;
    var hasCollapsedDiff = false;

    if (hasDiffs) {
      hasCollapsedDiff = diffBlocks.some(function (diffEl) {
        return isDiffCollapsed(diffEl);
      });
    }

    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      var viewBtn = summaryEl.querySelector('.summary-btn-view');
      if (!viewBtn) { return; }

      viewBtn.textContent = hasCollapsedDiff ? 'View all changes' : 'Hide all changes';
      if (summaryEl.getAttribute('data-read-only') === 'true') {
        viewBtn.disabled = true;
        viewBtn.title = '历史记录只读';
        return;
      }
      viewBtn.disabled = !hasDiffs;
    });
  }

  function toggleSummaryDiffs(summaryId) {
    var diffBlocks = getSummaryDiffBlocks(summaryId);
    if (diffBlocks.length === 0) { return; }

    var shouldExpandAll = diffBlocks.some(function (diffEl) {
      return isDiffCollapsed(diffEl);
    });

    diffBlocks.forEach(function (diffEl) {
      setDiffCollapsed(diffEl, !shouldExpandAll);
    });
  }

  function bindSummaryViewButton(summaryEl, summaryId) {
    var viewBtn = summaryEl.querySelector('.summary-btn-view');
    if (!viewBtn) { return; }

    if (summaryEl.getAttribute('data-read-only') === 'true') {
      viewBtn.disabled = true;
      viewBtn.title = '历史记录只读';
      return;
    }

    viewBtn.addEventListener('click', function () {
      // 待确认状态：用内联 diff 让用户审阅后再 Accept/Reject
      // 已应用状态：在 IDE 中直接打开文件，体验更好
      var isPending = summaryEl.classList.contains('change-summary-pending');

      if (isPending) {
        toggleSummaryDiffs(summaryId);
        updateSummaryViewButtons(summaryId);
        scrollToBottom();
      } else {
        var storedFiles = summaryFilesStore[summaryId] || [];
        // 只打开写入/创建类文件，忽略只读和目录列举操作
        var writeFiles = storedFiles.filter(function (f) {
          return f.status === 'created' || f.status === 'modified';
        });
        if (writeFiles.length > 0 && window.vscodeApi) {
          window.vscodeApi.postMessage({
            type: 'openFilesInIde',
            files: writeFiles.map(function (f) {
              return { path: f.path, status: f.status };
            })
          });
        }
      }
    });
  }

  function refreshSummaryUndoButtonState(summaryEl) {
    if (!summaryEl) { return; }
    var undoAllBtn = summaryEl.querySelector('.summary-btn-undo');
    if (!undoAllBtn) { return; }
    var hasVisibleFileUndo = false;
    var fileUndoBtns = summaryEl.querySelectorAll('.file-btn-undo');
    Array.prototype.forEach.call(fileUndoBtns, function (btn) {
      if (btn.style.display !== 'none') {
        hasVisibleFileUndo = true;
      }
    });
    undoAllBtn.style.display = hasVisibleFileUndo ? '' : 'none';
  }

  function hideUndoButtonsInSummary(summaryEl, filePaths) {
    if (!summaryEl) { return; }

    var hideAll = !Array.isArray(filePaths) || filePaths.length === 0;
    var allowedPathMap = {};
    if (!hideAll) {
      filePaths.forEach(function (filePath) {
        if (filePath) {
          allowedPathMap[filePath] = true;
        }
      });
    }

    var undoAllBtn = summaryEl.querySelector('.summary-btn-undo');
    if (undoAllBtn && hideAll) {
      undoAllBtn.style.display = 'none';
    }

    var fileUndoBtns = summaryEl.querySelectorAll('.file-btn-undo');
    Array.prototype.forEach.call(fileUndoBtns, function (btn) {
      if (hideAll) {
        btn.style.display = 'none';
        return;
      }

      var currentPath = btn.getAttribute('data-file-path') || '';
      if (allowedPathMap[currentPath]) {
        btn.style.display = 'none';
      }
    });

    refreshSummaryUndoButtonState(summaryEl);
  }

  function hideUndoButtonsForFilePaths(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) { return; }
    var summaryEls = document.querySelectorAll('.change-summary');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      hideUndoButtonsInSummary(summaryEl, filePaths);
    });
  }

  function hideUndoButtonsForMessage(messageId) {
    if (!messageId) { return; }
    var messageEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl) { return; }
    var summaryEls = messageEl.querySelectorAll('.change-summary');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      hideUndoButtonsInSummary(summaryEl);
    });
  }

  function setSummaryStatusState(summaryEl, summaryId, statusClass, statusText) {
    // 只更新专用的状态文字 span，不替换整个 .summary-actions
    // 这样 [↩ Undo all] 按钮不会被覆盖掉
    var statusEl = summaryEl.querySelector('.summary-status');
    if (statusEl) {
      statusEl.className = 'summary-status ' + statusClass;
      statusEl.textContent = statusText;
    }

    summaryEl.classList.remove('change-summary-pending');
    bindSummaryViewButton(summaryEl, summaryId);
    updateSummaryViewButtons(summaryId);

    // 撤销完成后隐藏所有 Undo 入口，防止重复撤销
    var messageId = getMessageIdByElement(summaryEl);
    if (statusClass === 'summary-cancelled') {
      hideUndoButtonsInSummary(summaryEl);
      return;
    }

    if (statusText.indexOf('\u21a9') === 0 && statusClass === 'summary-undone') {
      if (messageId) {
        hideUndoButtonsForMessage(messageId);
      } else {
        hideUndoButtonsInSummary(summaryEl);
      }
      return;
    }

    if (statusText.indexOf('\u21a9') === 0 && statusClass === 'summary-partial') {
      var undoState = summaryUndoIntentStore[summaryId];
      if (undoState && undoState.paths && undoState.paths.length > 0) {
        hideUndoButtonsForFilePaths(undoState.paths);
      } else {
        hideUndoButtonsInSummary(summaryEl);
      }
    }
  }

  function getSummaryStatusClass(status) {
    switch (status) {
      case 'accepted': return 'summary-accepted';
      case 'partial': return 'summary-partial';
      case 'failed': return 'summary-failed';
      case 'undone': return 'summary-undone';
      case 'partial-undone': return 'summary-partial';
      case 'cancelled': return 'summary-cancelled';
      default: return 'summary-cancelled';
    }
  }

  function updateChangeSummary(data) {
    var summaryEls = document.querySelectorAll('.change-summary[data-summary-id="' + data.summaryId + '"]');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      setSummaryStatusState(summaryEl, data.summaryId, getSummaryStatusClass(data.status), data.text);
      var messageId = getMessageIdByElement(summaryEl);
      if (messageId) {
        refreshProcessGroups(messageId);
      }
    });
  }

  function cancelPendingChangeSummaries() {
    // 新架构下不再有待确认的汇总面板，保留此函数是为了兼容 chat.js 调用
  }

  /**
   * 兜底机制：将所有仍在 running 状态的步骤标记为已取消
   * 在 generationStopped 时调用，防止步骤永远转圈
   */
  function cancelAllRunningSteps() {
    var runningSteps = document.querySelectorAll('.step-item.step-running');
    var completedMessageMap = {};
    Array.prototype.forEach.call(runningSteps, function (stepEl) {
      stepEl.className = 'step-item step-error';
      var iconEl = stepEl.querySelector('.step-icon');
      if (iconEl) {
        iconEl.innerHTML = '<span class="step-error">✗</span>';
      }
      var descEl = stepEl.querySelector('.step-desc');
      if (descEl) {
        var currentText = descEl.textContent || '';
        if (currentText.indexOf('(已取消)') === -1) {
          descEl.textContent = currentText + ' (已取消)';
        }
      }

      var messageId = getMessageIdByElement(stepEl);
      if (messageId) {
        refreshProcessGroups(messageId);
        completedMessageMap[messageId] = true;
      }
    });

    Object.keys(completedMessageMap).forEach(function (messageId) {
      markProcessComplete(messageId);
    });
  }

  /**
   * 绑定汇总面板的 Undo all 和单文件 ↩ 按钮
   * Undo all → 通知后端撤销本轮所有写文件操作
   * 单文件 ↩  → 通知后端撤销指定文件
   */
  function bindUndoButtons(summaryEl, summaryId) {
    var undoAllBtn = summaryEl.querySelector('.summary-btn-undo');
    var isReadOnly = summaryEl.getAttribute('data-read-only') === 'true';
    if (undoAllBtn) {
      if (isReadOnly) {
        undoAllBtn.disabled = true;
        undoAllBtn.title = '历史记录只读';
      }
      undoAllBtn.addEventListener('click', function () {
        if (isReadOnly) { return; }
        rememberUndoIntent(summaryId, '');
        if (window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'undoAllChanges', summaryId: summaryId });
        }
      });
    }

    var fileUndoBtns = summaryEl.querySelectorAll('.file-btn-undo');
    Array.prototype.forEach.call(fileUndoBtns, function (btn) {
      if (isReadOnly) {
        btn.disabled = true;
        btn.title = '历史记录只读';
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (isReadOnly) { return; }
        var filePath = btn.getAttribute('data-file-path');
        if (filePath) {
          rememberUndoIntent(summaryId, filePath);
        }
        if (filePath && window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'undoFileChange', filePath: filePath, summaryId: summaryId });
        }
        // 视觉反馈：按钮灰显，防止重复点击
        btn.disabled = true;
        btn.textContent = '↩…';
      });
    });
  }

  // ==================== 变更汇总 ====================

  /**
   * 显示文件变更汇总（只读面板 + Undo 入口）
   * 文件已立即写入磁盘，此面板仅用于展示和撤销，不再需要 Accept/Reject
   *
   * @param {object} data { messageId, summaryId, needsConfirm, files: [{ path, displayPath, additions, deletions, status }] }
   */
  function showChangeSummary(data) {
    var sections = getStepSections(data.messageId);
    if (!sections) { return; }
    var keepCompletedState = sections.container.classList.contains('process-panel-complete');
    if (keepCompletedState) {
      ensureExecutionLayout(data.messageId, { preserveExistingContent: true, completed: true });
    } else {
      activateProcessPanel(data.messageId, sections);
    }

    summaryFilesStore[data.summaryId] = data.files;

    var existingSummaryEl = document.querySelector('.change-summary[data-summary-id="' + data.summaryId + '"]');
    if (existingSummaryEl) {
      existingSummaryEl.remove();
    }

    var summaryEl = document.createElement('div');
    summaryEl.className = 'change-summary';
    summaryEl.setAttribute('data-summary-id', data.summaryId);
    if (data.readOnly) {
      summaryEl.setAttribute('data-read-only', 'true');
    }

    var totalAdd = 0;
    var totalDel = 0;
    data.files.forEach(function (file) {
      totalAdd += file.additions;
      totalDel += file.deletions;
    });
    var fileCountLabel = data.files.length + ' file' + (data.files.length > 1 ? 's' : '');

    // 构建文件行 HTML：写操作文件带单文件 ↩ 撤销按钮
    var fileRowsHtml = '';
    var hasUndoableFiles = false;
    data.files.forEach(function (file) {
      var fileName = file.displayPath || file.path;
      var statusIcon = getFileStatusIcon(file.status);
      var statsHtml = '';
      var issueHtml = file.issueText
        ? '<div class="summary-issue">' + escapeHtml(file.issueText) + '</div>'
        : '';
      if (file.additions > 0) { statsHtml += '<span class="diff-add">+' + file.additions + '</span> '; }
      if (file.deletions > 0) { statsHtml += '<span class="diff-del">-' + file.deletions + '</span>'; }

      var isWriteFile = file.status === 'created' || file.status === 'modified';
      var isUndoableFile = isWriteFile && isSummaryFileUndoable(file);
      if (isUndoableFile) {
        hasUndoableFiles = true;
      }
      var pathAttr = ' data-file-path="' + escapeHtml(file.path) + '"';
      var statusAttr = ' data-file-status="' + file.status + '"';

      // 写操作文件右侧显示单文件 ↩ 撤销按钮
      var fileActionsHtml = isUndoableFile
        ? '<span class="summary-file-actions"><button class="file-btn file-btn-undo" title="撤销此文件" data-file-path="' + escapeHtml(file.path) + '">↩</button></span>'
        : '';

      fileRowsHtml +=
        '<div class="summary-file' + (isWriteFile ? ' summary-file-write' : '') + '"' + pathAttr + statusAttr + '>' +
          '<div class="summary-file-row">' +
            '<span class="summary-icon">' + statusIcon + '</span>' +
            '<span class="summary-name' + (isWriteFile ? ' summary-name-clickable' : '') + '" title="' + escapeHtml(fileName) + '">' + escapeHtml(fileName) + '</span>' +
            '<span class="summary-stats">' + statsHtml + '</span>' +
            fileActionsHtml +
          '</div>' +
          issueHtml +
        '</div>';
    });

    var totalStats = '';
    if (totalAdd > 0) { totalStats += '<span class="diff-add">+' + totalAdd + '</span> '; }
    if (totalDel > 0) { totalStats += '<span class="diff-del">-' + totalDel + '</span>'; }

    summaryEl.innerHTML =
      '<div class="summary-bar">' +
        '<div class="summary-primary">' +
          '<span class="summary-count">' + fileCountLabel + '</span>' +
          '<span class="summary-total-stats">' + totalStats + '</span>' +
          '<span class="summary-status"></span>' +
        '</div>' +
        '<div class="summary-actions">' +
          '<button class="summary-btn summary-btn-view" title="' + (data.readOnly ? '历史记录只读' : '查看全部变更') + '"' + (data.readOnly ? ' disabled' : '') + '>View all changes</button>' +
          (hasUndoableFiles
            ? '<button class="summary-btn summary-btn-undo"' + (data.readOnly ? ' title="历史记录只读" disabled' : '') + '>↩ Undo all</button>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="summary-files">' + fileRowsHtml + '</div>';

    bindSummaryViewButton(summaryEl, data.summaryId);
    bindUndoButtons(summaryEl, data.summaryId);
    updateSummaryViewButtons(data.summaryId);
    bindFileNameClicks(summaryEl);

    sections.detailsEl.appendChild(summaryEl);
    if (keepCompletedState) {
      refreshProcessPanel(data.messageId);
      setProcessPanelCollapsed(sections.container, true);
    }
    scrollToBottom();
  }

  /**
   * 绑定文件名点击事件：在 IDE 中打开文件
   */
  function bindFileNameClicks(summaryEl) {
    if (summaryEl.getAttribute('data-read-only') === 'true') {
      return;
    }
    var nameEls = summaryEl.querySelectorAll('.summary-name-clickable');
    Array.prototype.forEach.call(nameEls, function (nameEl) {
      nameEl.addEventListener('click', function () {
        var fileEl = nameEl.closest('.summary-file');
        if (!fileEl) { return; }
        var filePath = fileEl.getAttribute('data-file-path');
        var status = fileEl.classList.contains('summary-file-write')
          ? (fileEl.getAttribute('data-file-status') || 'modified')
          : 'read';
        if (filePath && window.vscodeApi) {
          window.vscodeApi.postMessage({
            type: 'openFilesInIde',
            files: [{ path: filePath, status: status }],
          });
        }
      });
    });
  }

  /** 文件状态图标 */
  function getFileStatusIcon(status) {
    switch (status) {
      case 'created': return '🆕';
      case 'modified': return '✏️';
      case 'read': return '📖';
      case 'listed': return '📁';
      default: return '📄';
    }
  }

  // ==================== 工具函数 ====================

  /** HTML 转义 */
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text || ''));
    return div.innerHTML;
  }

  /** 格式化耗时（毫秒 → 人类可读） */
  function formatElapsed(ms) {
    if (ms < 1000) { return ms + 'ms'; }
    var seconds = (ms / 1000).toFixed(1);
    return seconds + 's';
  }

  /** 滚动到底部 */
  function scrollToBottom() {
    var messagesEl = document.getElementById('messages');
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ==================== 暴露给 chat.js 的接口 ====================

  /**
   * 清空 summaryFilesStore
   * 应在清空对话或切换 session 时调用，防止内存泄漏
   */
  function clearStore() {
    summaryFilesStore = {};
    summaryUndoIntentStore = {};
    processSummaryStore = {};
    thinkingElapsedStore = {};
    Object.keys(processCollapseTimers).forEach(function (messageId) {
      clearTimeout(processCollapseTimers[messageId]);
    });
    processCollapseTimers = {};
  }

  function resetMessageState(messageId) {
    if (!messageId) {
      return;
    }

    clearProcessCollapseTimer(messageId);
    delete processSummaryStore[messageId];

    var messageEl = document.querySelector('[data-message-id="' + messageId + '"]');
    if (!messageEl) {
      return;
    }

    var contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) {
      return;
    }

    var summaryEls = messageEl.querySelectorAll('.change-summary[data-summary-id]');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      var summaryId = summaryEl.getAttribute('data-summary-id') || '';
      if (!summaryId) { return; }
      delete summaryFilesStore[summaryId];
      delete summaryUndoIntentStore[summaryId];
    });

    var resultPanelEl = contentEl.querySelector('.message-result-panel');
    var bodyEl = contentEl.querySelector('.message-body');
    if (!bodyEl && resultPanelEl) {
      bodyEl = resultPanelEl.querySelector('.message-body');
    }

    if (bodyEl && bodyEl.parentNode !== contentEl) {
      var referenceEl = contentEl.querySelector('.message-execution-hint')
        || contentEl.querySelector('.history-process-summary')
        || contentEl.querySelector('.steps-container')
        || contentEl.querySelector('.stream-status')
        || resultPanelEl;
      if (referenceEl) {
        contentEl.insertBefore(bodyEl, referenceEl);
      } else {
        contentEl.appendChild(bodyEl);
      }
    }

    var removableSelectors = [
      '.message-execution-hint',
      '.message-result-panel',
      '.steps-container',
      '.history-process-summary'
    ];
    removableSelectors.forEach(function (selector) {
      var nodes = contentEl.querySelectorAll(selector);
      Array.prototype.forEach.call(nodes, function (node) {
        node.remove();
      });
    });

    messageEl.classList.remove('assistant-execution-layout');
  }

  window.chatSteps = {
    addStep: addStep,
    updateStep: updateStep,
    showThinkingComplete: showThinkingComplete,
    showDiff: showDiff,
    showChangeSummary: showChangeSummary,
    updateChangeSummary: updateChangeSummary,
    cancelPendingChangeSummaries: cancelPendingChangeSummaries,
    cancelAllRunningSteps: cancelAllRunningSteps,
    showHistoryProcessSummary: showHistoryProcessSummary,
    markProcessComplete: markProcessComplete,
    getOrCreateStepsContainer: getOrCreateStepsContainer,
    resetMessageState: resetMessageState,
    clearStore: clearStore,
  };

})();
