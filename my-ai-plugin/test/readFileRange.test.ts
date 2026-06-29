/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseToolCalls } from '../src/tools/toolParser';
import {
  DEFAULT_READ_FILE_MAX_LINES,
  addLineNumbersFromStart,
  readFile,
  sliceFileContentByLineRange,
} from '../src/tools/fileOps';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

test('parseToolCalls 识别 read_file 的 start_line/end_line', () => {
  const calls = parseToolCalls('<read_file path="src/app.ts" start_line="10" end_line="25" />');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'read_file');
  assert.equal(calls[0].path, 'src/app.ts');
  assert.equal(calls[0].readStartLine, 10);
  assert.equal(calls[0].readEndLine, 25);
});

test('sliceFileContentByLineRange 默认返回前 DEFAULT_READ_FILE_MAX_LINES 行', () => {
  const content = Array.from({ length: 300 }, (_, i) => `line-${i + 1}`).join('\n');
  const result = sliceFileContentByLineRange(content);

  assert.equal(result.start, 1);
  assert.equal(result.end, DEFAULT_READ_FILE_MAX_LINES);
  assert.equal(result.totalLines, 300);
  assert.match(result.content, /^line-1\nline-2/);
  assert.match(result.content, /Use start_line=201 to continue reading/);
});

test('sliceFileContentByLineRange 尊重显式 start_line/end_line', () => {
  const content = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
  const result = sliceFileContentByLineRange(content, 2, 4);

  assert.equal(result.content, 'beta\ngamma\ndelta');
  assert.equal(result.start, 2);
  assert.equal(result.end, 4);
  assert.doesNotMatch(result.content, /continue reading/);
});

test('addLineNumbersFromStart 保留续读提示', () => {
  const body = 'beta\ngamma';
  const content = `${body}\n\n(Showing lines 2-3 of 10 total. Use start_line=4 to continue reading.)`;
  const numbered = addLineNumbersFromStart(content, 2);

  assert.match(numbered, /^2\tbeta/);
  assert.match(numbered, /Use start_line=4 to continue reading/);
});

test('readFile 大文件只返回请求行范围与续读提示', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-range-'));
  const filePath = path.join(tmpDir, 'large.txt');
  const lines = Array.from({ length: 250 }, (_, i) => `row-${i + 1}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];

  try {
    const result = await readFile('large.txt');
    assert.equal(result.success, true);
    assert.match(result.content ?? '', /row-1/);
    assert.match(result.content ?? '', /row-200/);
    assert.doesNotMatch(result.content ?? '', /row-201/);
    assert.match(result.content ?? '', /start_line=201/);
    assert.ok(result.fullContentForCache);
    assert.equal(result.readRangeStart, 1);

    const ranged = await readFile('large.txt', { startLine: 201, endLine: 220 });
    assert.equal(ranged.success, true);
    assert.match(ranged.content ?? '', /row-201/);
    assert.match(ranged.content ?? '', /row-220/);
    assert.doesNotMatch(ranged.content ?? '', /row-221/);
    assert.match(ranged.content ?? '', /start_line=221/);
    assert.equal(ranged.readRangeStart, 201);
  } finally {
    vscode.workspace.workspaceFolders = originalFolders;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
