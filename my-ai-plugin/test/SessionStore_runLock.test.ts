/// <reference types="node" />

/**
 * SessionStore 运行锁并发阻断自动化测试
 *
 * 验证同一 sessionId 在多个 owner（模拟多个 ChatEngine 实例）之间
 * 的运行锁获取、阻断与释放行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore } from '../src/webview/SessionStore';
import type { SessionRunLock } from '../src/webview/SessionStore';

/** 最简 Memento mock，仅满足 SessionStore 构造签名，锁测试不触发持久化 */
function createMockMemento(): any {
  const store = new Map<string, any>();
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined => store.get(key) ?? defaultValue,
    update: async (key: string, value: any): Promise<void> => { store.set(key, value); },
  };
}

/** 创建一个共享 SessionStore 实例（模拟 ChatTabManager 注入的同一个 store） */
function createSharedStore(): SessionStore {
  return new SessionStore(createMockMemento());
}

// ==================== 测试用例 ====================

test('不同 sessionId 的锁互不冲突', () => {
  const store = createSharedStore();

  // 引擎 A 锁住 session-1
  const resultA = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-1',
  });
  assert.equal(resultA.acquired, true);

  // 引擎 B 锁住 session-2，应成功
  const resultB = store.tryAcquireRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-2',
    runId: 'run-2',
  });
  assert.equal(resultB.acquired, true);

  // 两个锁同时存在
  assert.equal(store.isSessionRunning('session-1'), true);
  assert.equal(store.isSessionRunning('session-2'), true);
  assert.equal(store.hasAnyRunningSession(), true);
});

test('同一 sessionId 不同 owner 第二次获取应被阻断', () => {
  const store = createSharedStore();

  // 引擎 A 先获取 session-1 的锁
  const resultA = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });
  assert.equal(resultA.acquired, true);
  if (resultA.acquired) {
    assert.equal(resultA.lock.ownerId, 'engine-A');
  }

  // 引擎 B 尝试获取同一 session-1 的锁，应被拒
  const resultB = store.tryAcquireRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-B1',
  });
  assert.equal(resultB.acquired, false);
  if (!resultB.acquired) {
    // 返回的锁信息应指向引擎 A 持有的锁
    assert.ok(resultB.lock);
    assert.equal(resultB.lock!.ownerId, 'engine-A');
    assert.equal(resultB.lock!.runId, 'run-A1');
  }
});

test('同一 owner 同一 sessionId 同一 runId 可重复获取（幂等）', () => {
  const store = createSharedStore();

  const result1 = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-1',
  });
  assert.equal(result1.acquired, true);

  // 同一 owner + 同一 runId 再次获取，应成功（幂等）
  const result2 = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-1',
  });
  assert.equal(result2.acquired, true);
});

test('同一 owner 同一 sessionId 不同 runId 第二次获取也被阻断', () => {
  const store = createSharedStore();

  const result1 = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-1',
  });
  assert.equal(result1.acquired, true);

  // 同一 owner 但不同 runId，也应被拒
  const result2 = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-2',
  });
  assert.equal(result2.acquired, false);
});

test('锁释放后其他 owner 可获取', () => {
  const store = createSharedStore();

  // 引擎 A 获取锁
  store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });

  // 引擎 A 释放锁
  store.releaseRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });

  // 引擎 B 现在应能获取
  const resultB = store.tryAcquireRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-B1',
  });
  assert.equal(resultB.acquired, true);
});

test('其他 owner 不能释放不属于自己的锁', () => {
  const store = createSharedStore();

  store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });

  // 引擎 B 尝试释放引擎 A 的锁，应无效
  store.releaseRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-A1',
  });

  // 锁仍存在，仍由引擎 A 持有
  assert.equal(store.isSessionRunning('session-1'), true);
  const lock = store.getRunLock('session-1');
  assert.ok(lock);
  assert.equal(lock!.ownerId, 'engine-A');
});

test('runId 不匹配时释放无效', () => {
  const store = createSharedStore();

  store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });

  // 用错误的 runId 释放，应无效
  store.releaseRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-wrong',
  });

  assert.equal(store.isSessionRunning('session-1'), true);
});

test('空 sessionId 不获取锁', () => {
  const store = createSharedStore();

  const result = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: '',
    runId: 'run-1',
  });
  assert.equal(result.acquired, false);
  assert.equal(result.lock, null);
});

test('getRunLock 对空 sessionId 返回 null', () => {
  const store = createSharedStore();
  assert.equal(store.getRunLock(''), null);
});

test('isSessionRunning 对空 sessionId 返回 false', () => {
  const store = createSharedStore();
  assert.equal(store.isSessionRunning(''), false);
});

test('完整并发场景：A 运行中 B 被拒 → A 完成 → B 可获取 → B 完成 → 锁清空', () => {
  const store = createSharedStore();

  // 阶段1：引擎 A 获取 session-1 的锁
  const phase1 = store.tryAcquireRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });
  assert.equal(phase1.acquired, true, '阶段1: 引擎 A 应成功获取锁');

  // 阶段2：引擎 B 尝试获取同一 session-1 的锁，应被拒
  const phase2 = store.tryAcquireRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-B1',
  });
  assert.equal(phase2.acquired, false, '阶段2: 引擎 B 应被阻断');
  if (!phase2.acquired) {
    assert.equal(phase2.lock!.ownerId, 'engine-A', '阶段2: 冲突锁应指向引擎 A');
  }

  // 阶段3：引擎 A 释放锁
  store.releaseRunLock({
    ownerId: 'engine-A',
    sessionId: 'session-1',
    runId: 'run-A1',
  });
  assert.equal(store.isSessionRunning('session-1'), false, '阶段3: 引擎 A 释放后锁应消失');

  // 阶段4：引擎 B 再次尝试获取，应成功
  const phase4 = store.tryAcquireRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-B1',
  });
  assert.equal(phase4.acquired, true, '阶段4: 引擎 B 应成功获取锁');

  // 阶段5：引擎 B 释放锁
  store.releaseRunLock({
    ownerId: 'engine-B',
    sessionId: 'session-1',
    runId: 'run-B1',
  });
  assert.equal(store.hasAnyRunningSession(), false, '阶段5: 所有锁应已清空');
});

test('跨 sessionId 释放：owner 可一次性释放所有自己持有的锁', () => {
  const store = createSharedStore();

  // 引擎 A 锁住 session-1 和 session-2
  store.tryAcquireRunLock({ ownerId: 'engine-A', sessionId: 'session-1', runId: 'run-A1' });
  store.tryAcquireRunLock({ ownerId: 'engine-A', sessionId: 'session-2', runId: 'run-A2' });

  // 引擎 B 锁住 session-3
  store.tryAcquireRunLock({ ownerId: 'engine-B', sessionId: 'session-3', runId: 'run-B1' });

  // 引擎 A 不指定 sessionId 释放所有锁
  store.releaseRunLock({ ownerId: 'engine-A' });

  // session-1 和 session-2 应已释放
  assert.equal(store.isSessionRunning('session-1'), false);
  assert.equal(store.isSessionRunning('session-2'), false);
  // session-3 仍由引擎 B 持有
  assert.equal(store.isSessionRunning('session-3'), true);
});
