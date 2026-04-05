/**
 * AI 聊天面板 - 渲染模块
 *
 * 从 chat.js 拆分出的纯渲染函数，负责：
 * 1. Markdown → HTML 转换
 * 2. 代码块渲染（语法高亮、行号）
 * 3. 表格渲染
 *
 * 所有函数通过 window 对象暴露，供 chat.js 主逻辑调用。
 * 必须在 chat.js 之前加载。
 */

// @ts-nocheck
(function () {
  'use strict';

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
   * 简易语法高亮
   * 用正则将关键词、字符串、注释、数字包裹成 <span class="hl-*"> 标签
   */
  function highlightSyntax(lang, code) {
    var escaped = escapeHtml(code);
    var normalizedLang = (lang || '').toLowerCase();

    // 不支持的语言直接返回转义文本
    var supportedLangs = ['js', 'javascript', 'ts', 'typescript', 'python', 'py', 'css', 'html', 'json', 'java', 'c', 'cpp', 'csharp', 'cs', 'go', 'rust', 'bash', 'sh', 'shell', 'sql'];
    if (supportedLangs.indexOf(normalizedLang) === -1 && normalizedLang !== '') {
      return escaped;
    }

    // 用占位符保护已高亮的部分，避免嵌套替换
    var tokens = [];
    function pushToken(cls, text) {
      var idx = tokens.length;
      tokens.push('<span class="hl-' + cls + '">' + text + '</span>');
      return '\x00T' + idx + '\x00';
    }

    // 1. 注释（单行 // 和 # ，多行暂不支持）
    escaped = escaped.replace(/(\/\/.*?$|#.*?$)/gm, function (m) {
      return pushToken('comment', m);
    });

    // 2. 字符串（双引号和单引号，简单匹配）
    escaped = escaped.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#039;(?:[^&]|&(?!#039;))*?&#039;)/g, function (m) {
      return pushToken('string', m);
    });

    // 3. 模板字符串标记（反引号）
    escaped = escaped.replace(/(`[^`]*`)/g, function (m) {
      return pushToken('string', m);
    });

    // 4. 数字
    escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, function (m) {
      return pushToken('number', m);
    });

    // 5. 关键词（根据语言选择关键词集）
    var keywords = [];
    if (['js', 'javascript', 'ts', 'typescript'].indexOf(normalizedLang) >= 0) {
      keywords = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'default', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof', 'void', 'null', 'undefined', 'true', 'false', 'interface', 'type', 'enum', 'implements', 'private', 'public', 'protected', 'readonly', 'static', 'abstract'];
    } else if (['python', 'py'].indexOf(normalizedLang) >= 0) {
      keywords = ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'raise', 'with', 'yield', 'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self', 'async', 'await'];
    } else if (['java', 'c', 'cpp', 'csharp', 'cs', 'go', 'rust'].indexOf(normalizedLang) >= 0) {
      keywords = ['int', 'float', 'double', 'char', 'bool', 'void', 'string', 'class', 'struct', 'enum', 'interface', 'public', 'private', 'protected', 'static', 'final', 'const', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'this', 'null', 'true', 'false', 'import', 'package', 'func', 'fn', 'let', 'mut', 'pub', 'use', 'mod'];
    } else if (['bash', 'sh', 'shell'].indexOf(normalizedLang) >= 0) {
      keywords = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'local'];
    } else if (normalizedLang === 'sql') {
      keywords = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'INTO', 'VALUES', 'SET'];
    }

    if (keywords.length > 0) {
      var kwPattern = new RegExp('\\b(' + keywords.join('|') + ')\\b', 'g');
      escaped = escaped.replace(kwPattern, function (m) {
        return pushToken('keyword', m);
      });
    }

    // 还原占位符
    escaped = escaped.replace(/\x00T(\d+)\x00/g, function (_, idx) {
      return tokens[parseInt(idx, 10)];
    });

    return escaped;
  }

  /**
   * 渲染代码块
   * 带有语言标签、复制/插入按钮、简易语法高亮、行号（超过 5 行时显示）
   */
  function renderCodeBlock(lang, code) {
    var langLabel = lang || '代码';
    var trimmedCode = code.replace(/\n$/, '');
    var highlightedCode = highlightSyntax(lang, trimmedCode);
    var lines = trimmedCode.split('\n');
    var showLineNumbers = lines.length > 5;

    var codeContent;
    if (showLineNumbers) {
      // 生成行号列
      var lineNums = '';
      for (var i = 1; i <= lines.length; i++) {
        lineNums += i + '\n';
      }
      codeContent =
        '<pre class="code-with-lines">' +
          '<span class="line-numbers">' + lineNums.trimEnd() + '</span>' +
          '<code>' + highlightedCode + '</code>' +
        '</pre>';
    } else {
      codeContent = '<pre><code>' + highlightedCode + '</code></pre>';
    }

    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' +
        '<span>' + langLabel + '</span>' +
        '<div class="code-block-actions">' +
          '<button class="btn-copy-code" title="复制代码">复制</button>' +
          '<button class="btn-insert-code" title="插入到编辑器">插入</button>' +
        '</div>' +
      '</div>' +
      codeContent +
    '</div>';
  }

  /**
   * 渲染 Markdown 表格
   * @param {string[]} rows 表格行数组（第 0 行为表头，第 1 行为分隔符，后续为数据行）
   */
  function renderTable(rows) {
    if (rows.length < 2) { return ''; }

    // 解析对齐方式（从分隔行读取 :--- / :---: / ---:）
    var separators = rows[1].split('|').filter(function (c) { return c.trim(); });
    var aligns = separators.map(function (sep) {
      var s = sep.trim();
      if (s.startsWith(':') && s.endsWith(':')) { return 'center'; }
      if (s.endsWith(':')) { return 'right'; }
      return 'left';
    });

    // 解析单元格内容
    function parseCells(row) {
      return row.split('|').slice(1, -1).map(function (cell) { return cell.trim(); });
    }

    var headerCells = parseCells(rows[0]);
    var tableHtml = '<table class="md-table"><thead><tr>';
    for (var h = 0; h < headerCells.length; h++) {
      var align = aligns[h] ? ' style="text-align:' + aligns[h] + '"' : '';
      tableHtml += '<th' + align + '>' + renderInline(headerCells[h]) + '</th>';
    }
    tableHtml += '</tr></thead><tbody>';

    // 数据行（跳过第 0 行表头和第 1 行分隔符）
    for (var r = 2; r < rows.length; r++) {
      var cells = parseCells(rows[r]);
      tableHtml += '<tr>';
      for (var c = 0; c < cells.length; c++) {
        var align = aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '';
        tableHtml += '<td' + align + '>' + renderInline(cells[c] || '') + '</td>';
      }
      tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table>';
    return tableHtml;
  }

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

    // 第二步：提取表格，用占位符替代
    var tables = [];
    processed = processed.replace(/((?:\|.+\|[ \t]*\n){2,})/g, function (tableBlock) {
      var rows = tableBlock.trim().split('\n');
      // 至少需要 header + separator + 1 data row，且第二行是分隔行
      if (rows.length < 2 || !/^\|[\s:|-]+\|$/.test(rows[1].trim())) {
        return tableBlock;
      }
      var idx = tables.length;
      tables.push(rows);
      return '___TABLE_BLOCK_' + idx + '___';
    });

    // 第三步：按行处理
    var lines = processed.split('\n');
    var html = '';
    var inList = false;
    var listType = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 表格占位符
      var tableMatch = line.match(/^___TABLE_BLOCK_(\d+)___$/);
      if (tableMatch) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += renderTable(tables[parseInt(tableMatch[1], 10)]);
        continue;
      }

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

  // ==================== 暴露到全局 ====================
  // 供 chat.js 主逻辑调用
  window.chatRender = {
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
  };

})();
