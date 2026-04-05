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
      // 插入到 message-body 之后、stream-status 之前
      var statusEl = contentEl.querySelector('.stream-status');
      if (statusEl) {
        contentEl.insertBefore(container, statusEl);
      } else {
        contentEl.appendChild(container);
      }
    }
    return container;
  }

  // ==================== 步骤块渲染 ====================

  /**
   * 添加一个进度步骤
   * 
   * @param {object} data { messageId, stepId, icon, description, status }
   */
  function addStep(data) {
    var container = getOrCreateStepsContainer(data.messageId);
    if (!container) { return; }

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

    container.appendChild(stepEl);
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
    var container = getOrCreateStepsContainer(data.messageId);
    if (!container) { return; }

    // 在步骤容器最前面插入 Thinking 行
    var thinkingEl = document.createElement('div');
    thinkingEl.className = 'step-thinking';

    var elapsedText = formatElapsed(data.elapsed);
    thinkingEl.innerHTML =
      '<div class="step-icon"><span class="step-check">✓</span></div>' +
      '<div class="step-desc">Thought for ' + elapsedText + '</div>' +
      '<button class="step-toggle" title="展开/折叠">›</button>';

    // 插入到步骤容器的最前面
    container.insertBefore(thinkingEl, container.firstChild);
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

    var existingDiffEl = document.querySelector('.diff-block[data-step-id="' + data.stepId + '"]');
    if (existingDiffEl) {
      existingDiffEl.remove();
    }

    var diffModel = renderUnifiedDiff(data.oldContent, data.newContent, data.language);

    var diffEl = document.createElement('div');
    diffEl.className = 'diff-block';
    diffEl.setAttribute('data-step-id', data.stepId);

    var fileName = data.filePath.split(/[/\\]/).pop() || data.filePath;
    var statsHtml = buildDiffStatsHtml(diffModel.additions, diffModel.deletions);
    var diffContentHtml = diffModel.html;

    var actionsHtml = '';
    if (data.needsConfirm) {
      actionsHtml =
        '<div class="diff-actions">' +
          '<span class="diff-summary">1 file ' + statsHtml + '</span>' +
          '<button class="diff-btn diff-btn-reject" data-step-id="' + data.stepId + '">Reject</button>' +
          '<button class="diff-btn diff-btn-accept" data-step-id="' + data.stepId + '">Accept</button>' +
        '</div>';
    } else {
      actionsHtml =
        '<div class="diff-actions">' +
          '<span class="diff-summary">1 file ' + statsHtml + '</span>' +
        '</div>';
    }

    diffEl.innerHTML =
      '<div class="diff-header">' +
        '<span class="diff-lang">' + (data.language || 'text').toUpperCase() + '</span>' +
        '<span class="diff-filename">' + escapeHtml(fileName) + '</span>' +
        statsHtml +
        '<button class="diff-toggle" title="展开/折叠">▼</button>' +
      '</div>' +
      '<div class="diff-content">' + diffContentHtml + '</div>' +
      actionsHtml;

    // 插入到步骤元素后面
    stepEl.parentNode.insertBefore(diffEl, stepEl.nextSibling);

    // 绑定折叠按钮事件
    var toggleBtn = diffEl.querySelector('.diff-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var contentEl = diffEl.querySelector('.diff-content');
        if (contentEl) {
          var isCollapsed = contentEl.classList.toggle('collapsed');
          toggleBtn.textContent = isCollapsed ? '▶' : '▼';
        }
      });
    }

    // 绑定 Accept/Reject 事件
    bindDiffActions(diffEl, data.stepId);

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
    var html = '';
    operations.forEach(function (operation) {
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
        '<span class="diff-line-text">' + escapeHtml(operation.text) + '</span>' +
        '</div>';
    });
    return html;
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
    var acceptBtn = diffEl.querySelector('.diff-btn-accept');
    var rejectBtn = diffEl.querySelector('.diff-btn-reject');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        if (window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'acceptChange', stepId: stepId });
        }
        // 更新 UI 状态
        var actionsEl = diffEl.querySelector('.diff-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '<span class="diff-accepted">✓ 已接受</span>';
        }
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener('click', function () {
        if (window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'rejectChange', stepId: stepId });
        }
        // 更新 UI 状态
        var actionsEl = diffEl.querySelector('.diff-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '<span class="diff-rejected">✗ 已拒绝</span>';
        }
      });
    }
  }

  // ==================== 变更汇总 ====================

  /**
   * 显示文件变更汇总
   * 
   * @param {object} data { messageId, files: [{ path, additions, deletions, status }] }
   */
  function showChangeSummary(data) {
    var container = getOrCreateStepsContainer(data.messageId);
    if (!container) { return; }

    var summaryEl = document.createElement('div');
    summaryEl.className = 'change-summary';

    var totalAdd = 0;
    var totalDel = 0;
    var fileRows = '';

    data.files.forEach(function (file) {
      totalAdd += file.additions;
      totalDel += file.deletions;
      var fileName = file.path.split(/[/\\]/).pop() || file.path;
      var statusIcon = getFileStatusIcon(file.status);
      var statsHtml = '';
      if (file.additions > 0) { statsHtml += '<span class="diff-add">+' + file.additions + '</span> '; }
      if (file.deletions > 0) { statsHtml += '<span class="diff-del">-' + file.deletions + '</span>'; }

      fileRows +=
        '<div class="summary-file">' +
          '<span class="summary-icon">' + statusIcon + '</span>' +
          '<span class="summary-name">' + escapeHtml(fileName) + '</span>' +
          '<span class="summary-stats">' + statsHtml + '</span>' +
        '</div>';
    });

    var totalStats = '';
    if (totalAdd > 0) { totalStats += '<span class="diff-add">+' + totalAdd + '</span> '; }
    if (totalDel > 0) { totalStats += '<span class="diff-del">-' + totalDel + '</span>'; }

    summaryEl.innerHTML =
      '<div class="summary-header">' +
        '<span>' + data.files.length + ' file' + (data.files.length > 1 ? 's' : '') + '</span> ' +
        totalStats +
      '</div>' +
      '<div class="summary-files">' + fileRows + '</div>';

    container.appendChild(summaryEl);
    scrollToBottom();
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

  window.chatSteps = {
    addStep: addStep,
    updateStep: updateStep,
    showThinkingComplete: showThinkingComplete,
    showDiff: showDiff,
    showChangeSummary: showChangeSummary,
    getOrCreateStepsContainer: getOrCreateStepsContainer,
  };

})();
