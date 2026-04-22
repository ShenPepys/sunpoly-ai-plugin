/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';

import { FileReadStateCache, validateFileReadState, buildReadFileStubIfUnchanged } from '../src/tools/fileReadStateCache';

// ==================== FileReadStateCache 基础操作 ====================

test('FileReadStateCache: set/get 基本读写', () => {
  const cache = new FileReadStateCache();
  const state = { content: 'hello', timestamp: Date.now() };
  cache.set('/a/b/c.ts', state);

  const result = cache.get('/a/b/c.ts');
  assert.ok(result);
  assert.equal(result.content, 'hello');
});

test('FileReadStateCache: has 检测存在与不存在', () => {
  const cache = new FileReadStateCache();
  cache.set('/a/b/c.ts', { content: 'x', timestamp: 1 });

  assert.equal(cache.has('/a/b/c.ts'), true);
  assert.equal(cache.has('/a/b/d.ts'), false);
});

test('FileReadStateCache: delete 删除条目', () => {
  const cache = new FileReadStateCache();
  cache.set('/a/b/c.ts', { content: 'x', timestamp: 1 });
  assert.equal(cache.size, 1);

  const deleted = cache.delete('/a/b/c.ts');
  assert.equal(deleted, true);
  assert.equal(cache.size, 0);
  assert.equal(cache.has('/a/b/c.ts'), false);
});

test('FileReadStateCache: delete 不存在的路径返回 false', () => {
  const cache = new FileReadStateCache();
  assert.equal(cache.delete('/nonexistent.ts'), false);
});

test('FileReadStateCache: clear 清空所有条目', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'a', timestamp: 1 });
  cache.set('/b.ts', { content: 'b', timestamp: 2 });
  assert.equal(cache.size, 2);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.totalSizeBytes, 0);
});

// ==================== 路径归一化 ====================

test('FileReadStateCache: Windows 反斜杠和正斜杠归一化到同一 key', () => {
  const cache = new FileReadStateCache();
  cache.set('D:\\Project\\file.ts', { content: 'content', timestamp: 1 });

  // 用正斜杠路径访问（Windows 下 path.normalize 会统一为反斜杠）
  // 注意：在非 Windows 平台上此行为取决于 path.normalize 实现
  if (process.platform === 'win32') {
    const result = cache.get('D:/Project/file.ts');
    assert.ok(result, '正斜杠路径应命中反斜杠缓存');
    assert.equal(result.content, 'content');
  }
});

test('FileReadStateCache: Windows 大小写不敏感', () => {
  if (process.platform !== 'win32') {
    return; // 跳过非 Windows 平台
  }

  const cache = new FileReadStateCache();
  cache.set('D:\\Project\\File.ts', { content: 'content', timestamp: 1 });

  const result = cache.get('d:\\project\\file.ts');
  assert.ok(result, '路径大小写应不敏感（Windows）');
  assert.equal(result.content, 'content');
});

test('FileReadStateCache: 冗余 .. 路径归一化', () => {
  const cache = new FileReadStateCache();
  cache.set('/a/b/../b/c.ts', { content: 'x', timestamp: 1 });

  const result = cache.get('/a/b/c.ts');
  assert.ok(result, '含 .. 的路径应归一化后命中');
});

// ==================== LRU 淘汰 ====================

test('FileReadStateCache: 超过 maxEntries 时淘汰最旧条目', () => {
  const cache = new FileReadStateCache(3); // 最多 3 条
  cache.set('/a.ts', { content: 'a', timestamp: 1 });
  cache.set('/b.ts', { content: 'b', timestamp: 2 });
  cache.set('/c.ts', { content: 'c', timestamp: 3 });
  assert.equal(cache.size, 3);

  // 第 4 条应淘汰最旧的 /a.ts
  cache.set('/d.ts', { content: 'd', timestamp: 4 });
  assert.equal(cache.size, 3);
  assert.equal(cache.has('/a.ts'), false, '/a.ts 应被淘汰');
  assert.ok(cache.get('/b.ts'), '/b.ts 应存在');
  assert.ok(cache.get('/c.ts'), '/c.ts 应存在');
  assert.ok(cache.get('/d.ts'), '/d.ts 应存在');
});

test('FileReadStateCache: get 操作会刷新访问顺序', () => {
  const cache = new FileReadStateCache(3);
  cache.set('/a.ts', { content: 'a', timestamp: 1 });
  cache.set('/b.ts', { content: 'b', timestamp: 2 });
  cache.set('/c.ts', { content: 'c', timestamp: 3 });

  // 访问 /a.ts 使其变为最近访问
  cache.get('/a.ts');

  // 新增 /d.ts 应淘汰 /b.ts（最久未访问的）
  cache.set('/d.ts', { content: 'd', timestamp: 4 });
  assert.equal(cache.has('/b.ts'), false, '/b.ts 应被淘汰');
  assert.ok(cache.get('/a.ts'), '/a.ts 因被访问过，不应被淘汰');
});

test('FileReadStateCache: 超过 maxSizeBytes 时淘汰', () => {
  // 最大 10 字节，每条约 5 字节 → 最多 2 条
  const cache = new FileReadStateCache(100, 10);
  cache.set('/a.ts', { content: '12345', timestamp: 1 }); // ~5 bytes
  cache.set('/b.ts', { content: '12345', timestamp: 2 }); // ~5 bytes
  assert.equal(cache.size, 2);

  cache.set('/c.ts', { content: '12345', timestamp: 3 }); // ~5 bytes, 总共 15 > 10
  // 应淘汰到满足限制
  assert.ok(cache.size <= 2, '应淘汰条目使总大小不超过限制');
  assert.ok(cache.get('/c.ts'), '最新条目应保留');
});

// ==================== set 覆盖已有条目 ====================

test('FileReadStateCache: set 已有路径会更新内容和大小', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'short', timestamp: 1 });
  const sizeBefore = cache.totalSizeBytes;

  cache.set('/a.ts', { content: 'a much longer content here', timestamp: 2 });
  assert.ok(cache.totalSizeBytes > sizeBefore, '更新后总大小应增大');
  assert.equal(cache.get('/a.ts')!.content, 'a much longer content here');
  assert.equal(cache.size, 1, '条目数不应增加');
});

// ==================== validateFileReadState ====================

test('validateFileReadState: 文件从未被读取过 → 拒绝', () => {
  const cache = new FileReadStateCache();
  const result = validateFileReadState('/a.ts', cache, Date.now());

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('尚未被读取过'));
});

test('validateFileReadState: 仅通过 @ 注入的 partial 视图 → 拒绝', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'partial', timestamp: Date.now(), isPartialView: true });

  const result = validateFileReadState('/a.ts', cache, Date.now());
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('@ 引用'));
});

test('validateFileReadState: 文件被外部修改（时间戳晚于缓存） → 拒绝', () => {
  const cache = new FileReadStateCache();
  const readTime = Date.now() - 5000; // 5 秒前读取
  cache.set('/a.ts', { content: 'old content', timestamp: readTime });

  // 文件修改时间比读取时间晚 3 秒
  const currentMtimeMs = readTime + 3000;
  const result = validateFileReadState('/a.ts', cache, currentMtimeMs, 'new content');

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('已被外部修改'));
});

test('validateFileReadState: 时间戳变化但内容未变（Windows 兼容） → 放行', () => {
  const cache = new FileReadStateCache();
  const readTime = Date.now() - 5000;
  cache.set('/a.ts', { content: 'same content', timestamp: readTime });

  // 时间戳变了但内容一样
  const currentMtimeMs = readTime + 3000;
  const result = validateFileReadState('/a.ts', cache, currentMtimeMs, 'same content');

  assert.equal(result.valid, true);
});

test('validateFileReadState: 正常读取且文件未变 → 通过', () => {
  const cache = new FileReadStateCache();
  const now = Date.now();
  cache.set('/a.ts', { content: 'content', timestamp: now });

  // 文件修改时间 ≤ 缓存时间（在容差范围内）
  const result = validateFileReadState('/a.ts', cache, now - 500);
  assert.equal(result.valid, true);
});

test('validateFileReadState: 时间戳刚好在容差范围内 → 通过', () => {
  const cache = new FileReadStateCache();
  const readTime = Date.now();
  cache.set('/a.ts', { content: 'content', timestamp: readTime });

  // 文件修改时间比读取时间晚 500ms（在 1s 容差内）
  const result = validateFileReadState('/a.ts', cache, readTime + 500);
  assert.equal(result.valid, true);
});

test('validateFileReadState: 不提供 currentContent 且时间戳过期 → 拒绝', () => {
  const cache = new FileReadStateCache();
  const readTime = Date.now() - 5000;
  cache.set('/a.ts', { content: 'old', timestamp: readTime });

  // 不提供 currentContent，无法做内容兜底比对
  const result = validateFileReadState('/a.ts', cache, readTime + 3000);
  assert.equal(result.valid, false);
});

// ==================== buildReadFileStubIfUnchanged ====================

test('buildReadFileStubIfUnchanged: 缓存中无记录 → 不使用 stub', () => {
  const cache = new FileReadStateCache();
  const result = buildReadFileStubIfUnchanged('/a.ts', 'content', cache);
  assert.equal(result.useStub, false);
});

test('buildReadFileStubIfUnchanged: 内容未变 → 返回 stub', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'same content', timestamp: Date.now() });

  const result = buildReadFileStubIfUnchanged('/a.ts', 'same content', cache);
  assert.equal(result.useStub, true);
  assert.ok(result.stubContent);
  assert.ok(result.stubContent.includes('文件未变'));
  assert.ok(result.stubContent.includes('a.ts'));
});

test('buildReadFileStubIfUnchanged: 内容变化 → 不使用 stub', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'old content', timestamp: Date.now() });

  const result = buildReadFileStubIfUnchanged('/a.ts', 'new content', cache);
  assert.equal(result.useStub, false);
});

test('buildReadFileStubIfUnchanged: partial 视图不做 stub 比较', () => {
  const cache = new FileReadStateCache();
  cache.set('/a.ts', { content: 'partial', timestamp: Date.now(), isPartialView: true });

  const result = buildReadFileStubIfUnchanged('/a.ts', 'partial', cache);
  assert.equal(result.useStub, false, 'partial 视图即使内容相同也不应返回 stub');
});
