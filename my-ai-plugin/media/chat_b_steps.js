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
    if (data.needsConfirm) {
      actionsHtml =
        '<div class="diff-actions">' +
          '<span class="diff-summary">1 file ' + statsHtml + '</span>' +
          '<button class="diff-btn diff-btn-reject" data-step-id="' + data.stepId + '">Reject</button>' +
          '<button class="diff-btn diff-btn-accept" data-step-id="' + data.stepId + '">Accept</button>' +
        '</div>';
    }

    diffEl.innerHTML =
      '<div class="diff-header">' +
        '<span class="diff-lang">' + (data.language || 'text').toUpperCase() + '</span>' +
        '<span class="diff-filename">' + escapeHtml(fileName) + '</span>' +
        statsHtml +
        '<button class="diff-toggle" title="展开/折叠">▼</button>' +
      '</div>' +
      noticeHtml +
      '<div class="diff-content">' + diffContentHtml + '</div>' +
      actionsHtml;

    // 插入到步骤元素后面
    stepEl.parentNode.insertBefore(diffEl, stepEl.nextSibling);

    // 绑定折叠按钮事件
    var toggleBtn = diffEl.querySelector('.diff-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        setDiffCollapsed(diffEl, !isDiffCollapsed(diffEl));
        updateSummaryViewButtons(data.summaryId);
      });
    }

    setDiffCollapsed(diffEl, !!data.collapsed);

    // 绑定 Accept/Reject 事件
    bindDiffActions(diffEl, data.stepId);
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

  function setSummaryStatusState(summaryEl, summaryId, statusClass, statusText) {
    var actionsEl = summaryEl.querySelector('.summary-actions');
    if (!actionsEl) { return; }

    actionsEl.innerHTML =
      '<button class="summary-btn summary-btn-view">View all changes</button>' +
      '<span class="' + statusClass + '">' + statusText + '</span>';

    summaryEl.classList.remove('change-summary-pending');
    bindSummaryViewButton(summaryEl, summaryId);
    updateSummaryViewButtons(summaryId);
  }

  function setSummaryDecisionState(summaryEl, summaryId, accepted) {
    var statusClass = accepted ? 'summary-applying' : 'summary-rejected';
    var statusText = accepted ? 'Applying changes...' : 'Rejecting changes...';
    setSummaryStatusState(summaryEl, summaryId, statusClass, statusText);
  }

  function getSummaryStatusClass(status) {
    switch (status) {
      case 'applying': return 'summary-applying';
      case 'accepted': return 'summary-accepted';
      case 'partial': return 'summary-partial';
      case 'failed': return 'summary-failed';
      case 'rejected': return 'summary-rejected';
      case 'cancelled': return 'summary-cancelled';
      default: return 'summary-cancelled';
    }
  }

  function updateChangeSummary(data) {
    var summaryEls = document.querySelectorAll('.change-summary[data-summary-id="' + data.summaryId + '"]');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      setSummaryStatusState(summaryEl, data.summaryId, getSummaryStatusClass(data.status), data.text);
    });
  }

  function cancelPendingChangeSummaries() {
    var summaryEls = document.querySelectorAll('.change-summary.change-summary-pending[data-summary-id]');
    Array.prototype.forEach.call(summaryEls, function (summaryEl) {
      var summaryId = summaryEl.getAttribute('data-summary-id') || '';
      setSummaryStatusState(summaryEl, summaryId, 'summary-cancelled', '✗ Cancelled');
    });
  }

  /**
   * 兜底机制：将所有仍在 running 状态的步骤标记为已取消
   * 在 generationStopped 时调用，防止步骤永远转圈
   */
  function cancelAllRunningSteps() {
    var runningSteps = document.querySelectorAll('.step-item.step-running');
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
    });
  }

  function bindBatchSummaryActions(summaryEl, data) {
    bindSummaryViewButton(summaryEl, data.summaryId);

    var acceptBtn = summaryEl.querySelector('.summary-btn-accept');
    var rejectBtn = summaryEl.querySelector('.summary-btn-reject');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        if (window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'acceptAllChanges', summaryId: data.summaryId });
        }
        setSummaryDecisionState(summaryEl, data.summaryId, true);
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener('click', function () {
        if (window.vscodeApi) {
          window.vscodeApi.postMessage({ type: 'rejectAllChanges', summaryId: data.summaryId });
        }
        setSummaryDecisionState(summaryEl, data.summaryId, false);
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

    // 缓存文件数据，供 View all changes 按钮使用（需要绝对路径）
    summaryFilesStore[data.summaryId] = data.files;

    var existingSummaryEl = document.querySelector('.change-summary[data-summary-id="' + data.summaryId + '"]');
    if (existingSummaryEl) {
      existingSummaryEl.remove();
    }

    var summaryEl = document.createElement('div');
    summaryEl.className = data.needsConfirm ? 'change-summary change-summary-pending' : 'change-summary';
    summaryEl.setAttribute('data-summary-id', data.summaryId);

    var totalAdd = 0;
    var totalDel = 0;
    var fileRows = '';
    var fileCountLabel = data.files.length + ' file' + (data.files.length > 1 ? 's' : '');

    data.files.forEach(function (file) {
      totalAdd += file.additions;
      totalDel += file.deletions;
      var fileName = file.displayPath || file.path;
      var statusIcon = getFileStatusIcon(file.status);
      var statsHtml = '';
      var issueHtml = file.issueText
        ? '<div class="summary-issue">' + escapeHtml(file.issueText) + '</div>'
        : '';
      if (file.additions > 0) { statsHtml += '<span class="diff-add">+' + file.additions + '</span> '; }
      if (file.deletions > 0) { statsHtml += '<span class="diff-del">-' + file.deletions + '</span>'; }

      fileRows +=
        '<div class="summary-file">' +
          '<div class="summary-file-row">' +
            '<span class="summary-icon">' + statusIcon + '</span>' +
            '<span class="summary-name" title="' + escapeHtml(fileName) + '">' + escapeHtml(fileName) + '</span>' +
            '<span class="summary-stats">' + statsHtml + '</span>' +
          '</div>' +
          issueHtml +
        '</div>';
    });

    var totalStats = '';
    if (totalAdd > 0) { totalStats += '<span class="diff-add">+' + totalAdd + '</span> '; }
    if (totalDel > 0) { totalStats += '<span class="diff-del">-' + totalDel + '</span>'; }

    if (data.needsConfirm) {
      summaryEl.innerHTML =
        '<div class="summary-bar">' +
          '<div class="summary-primary">' +
            '<span class="summary-count">' + fileCountLabel + '</span>' +
            '<span class="summary-total-stats">' + totalStats + '</span>' +
          '</div>' +
          '<div class="summary-actions">' +
            '<button class="summary-btn summary-btn-view">View all changes</button>' +
            '<button class="summary-btn summary-btn-reject">Reject all</button>' +
            '<button class="summary-btn summary-btn-accept">Accept all</button>' +
          '</div>' +
        '</div>' +
        '<div class="summary-files">' + fileRows + '</div>';

      bindBatchSummaryActions(summaryEl, data);
      updateSummaryViewButtons(data.summaryId);
    } else {
      summaryEl.innerHTML =
        '<div class="summary-header">' +
          '<span>' + fileCountLabel + '</span> ' +
          totalStats +
        '</div>' +
        '<div class="summary-files">' + fileRows + '</div>';
    }

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

  /**
   * 清空 summaryFilesStore
   * 应在清空对话或切换 session 时调用，防止内存泄漏
   */
  function clearStore() {
    summaryFilesStore = {};
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
    getOrCreateStepsContainer: getOrCreateStepsContainer,
    clearStore: clearStore,
  };

})();
