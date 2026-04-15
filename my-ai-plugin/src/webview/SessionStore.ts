/**
 * 会话数据共享存储
 *
 * 所有 ChatEngine 实例共享同一个 sessions 池，
 * 避免多 Tab 各自持有独立副本导致保存时互相覆盖。
 * 由 ChatTabManager 创建并注入到每个 ChatTabPanel / ChatEngine。
 */
import * as vscode from 'vscode';
import { error, info } from '../logger';
import type { ChatSession, ChatSessionHistoryMessage, ChatSessionDisplayMessage } from './messageTypes';
import {
  loadSessionsState,
  sortSessionsByUpdatedAt,
  buildUpdateSessionsResponse,
} from './ChatViewProvider_f_sessions';

/** 首次加载所需的回调（用于旧数据迁移和 displayHistory 初始化） */
export type SessionStoreLoadCallbacks = {
  normalizeHistoryMessages: (history: ChatSessionHistoryMessage[]) => ChatSessionHistoryMessage[];
  sanitizeDisplayHistory: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
};

export type SessionRunLock = {
  ownerId: string;
  sessionId: string;
  runId: string;
  startedAt: number;
};

export class SessionStore {

  /** 共享的会话列表（所有 ChatEngine 通过 getter/setter 读写此数组） */
  private _sessions: ChatSession[] = [];

  /** globalState 持久化存储引用 */
  private readonly globalState: vscode.Memento;

  /** 是否已完成首次加载 */
  private _loaded = false;

  private _runLocks: Map<string, SessionRunLock> = new Map();

  /** 持久化串行队列，避免多次 update 并发写入互相覆盖 */
  private _persistQueue: Promise<void> = Promise.resolve();

  constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  /** 获取共享会话列表 */
  get sessions(): ChatSession[] {
    return this._sessions;
  }

  /** 替换共享会话列表（plan helpers 常返回新数组） */
  set sessions(value: ChatSession[]) {
    this._sessions = value;
  }

  /** 是否已完成首次加载 */
  get isLoaded(): boolean {
    return this._loaded;
  }

  /** 获取任意一个运行锁快照，兼容旧调用方 */
  get runLock(): SessionRunLock | null {
    const firstLock = this._runLocks.values().next().value;
    if (!firstLock) {
      return null;
    }

    return {
      ...firstLock,
    };
  }

  get runLocks(): SessionRunLock[] {
    return [...this._runLocks.values()].map(lock => ({ ...lock }));
  }

  /** 是否存在任意会话正在生成 */
  public hasAnyRunningSession(): boolean {
    return this._runLocks.size > 0;
  }

  /** 指定会话是否处于全局运行中 */
  public isSessionRunning(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    return this._runLocks.has(sessionId);
  }

  public getRunLock(sessionId: string): SessionRunLock | null {
    if (!sessionId) {
      return null;
    }

    const lock = this._runLocks.get(sessionId);
    if (!lock) {
      return null;
    }

    return {
      ...lock,
    };
  }

  /**
   * 尝试获取指定会话的运行锁。
   * 允许不同会话并发运行；仅阻止同一 sessionId 被不同 owner 并发占用。
   */
  public tryAcquireRunLock(options: {
    ownerId: string;
    sessionId: string;
    runId: string;
  }): { acquired: true; lock: SessionRunLock } | { acquired: false; lock: SessionRunLock | null } {
    if (!options.sessionId) {
      return {
        acquired: false,
        lock: null,
      };
    }

    const currentLock = this._runLocks.get(options.sessionId);
    if (currentLock && currentLock.runId !== options.runId) {
      return {
        acquired: false,
        lock: { ...currentLock },
      };
    }

    const nextLock: SessionRunLock = {
      ownerId: options.ownerId,
      sessionId: options.sessionId,
      runId: options.runId,
      startedAt: Date.now(),
    };
    this._runLocks.set(options.sessionId, nextLock);

    return {
      acquired: true,
      lock: { ...nextLock },
    };
  }

  /** 释放当前引擎持有的运行锁；若 runId 不匹配则忽略，避免旧回调误清新锁。 */
  public releaseRunLock(options: {
    ownerId: string;
    sessionId?: string;
    runId?: string;
  }): void {
    if (this._runLocks.size === 0) {
      return;
    }

    if (options.sessionId) {
      const lock = this._runLocks.get(options.sessionId);
      if (!lock) {
        return;
      }

      if (lock.ownerId !== options.ownerId) {
        return;
      }

      if (options.runId && lock.runId !== options.runId) {
        return;
      }

      this._runLocks.delete(options.sessionId);
      return;
    }

    for (const [sessionId, lock] of this._runLocks.entries()) {
      if (lock.ownerId !== options.ownerId) {
        continue;
      }

      if (options.runId && lock.runId !== options.runId) {
        continue;
      }

      this._runLocks.delete(sessionId);
    }
  }

  /**
   * 从 globalState 加载会话数据（仅首次调用实际加载，后续直接返回缓存）
   * @returns activeSessionId 和是否需要立即重新保存
   */
  public load(callbacks: SessionStoreLoadCallbacks): { activeSessionId: string; shouldResave: boolean } {
    if (this._loaded) {
      // 已加载过，后续引擎直接复用共享 sessions，activeSessionId 从 globalState 读取作为默认值
      const savedActiveId = this.globalState.get<string>('activeSessionId') || '';
      return { activeSessionId: savedActiveId, shouldResave: false };
    }

    const state = loadSessionsState({
      savedSessions: this.globalState.get<ChatSession[]>('chatSessions'),
      savedActiveId: this.globalState.get<string>('activeSessionId'),
      oldHistory: this.globalState.get<Array<{ role: string; content: unknown }>>('chatHistory'),
      normalizeHistoryMessages: callbacks.normalizeHistoryMessages,
      sanitizeDisplayHistory: callbacks.sanitizeDisplayHistory,
      buildDisplayHistoryFromRawHistory: callbacks.buildDisplayHistoryFromRawHistory,
    });

    this._sessions = state.sessions;
    this._loaded = true;

    info(`SessionStore: 加载 ${this._sessions.length} 个会话，活跃: ${state.activeSessionId}`);

    return {
      activeSessionId: state.activeSessionId,
      shouldResave: state.shouldResave,
    };
  }

  /** 等待当前已排队的持久化全部完成，供停用阶段或调试使用。 */
  public async flushPendingPersists(): Promise<void> {
    await this._persistQueue;
  }

  private cloneSessionsSnapshot(sessions: ChatSession[]): ChatSession[] {
    return JSON.parse(JSON.stringify(sessions)) as ChatSession[];
  }

  /**
   * 持久化会话数据到 globalState 并返回前端更新响应
   * @param activeSessionId 调用方引擎的当前活跃会话 ID
   */
  public persist(activeSessionId: string): ReturnType<typeof buildUpdateSessionsResponse> {
    const sortedSessions = sortSessionsByUpdatedAt(this._sessions);
    const sessionsSnapshot = this.cloneSessionsSnapshot(sortedSessions);
    const activeSessionSnapshot = activeSessionId;

    this._sessions = sortedSessions;

    this._persistQueue = this._persistQueue
      .catch(persistError => {
        error('SessionStore 持久化链路出现前序错误，继续后续写入', persistError);
      })
      .then(async () => {
        await this.globalState.update('chatSessions', sessionsSnapshot);
        await this.globalState.update('activeSessionId', activeSessionSnapshot);
      })
      .catch(persistError => {
        error('SessionStore 持久化失败:', persistError);
      });

    return buildUpdateSessionsResponse(sortedSessions, activeSessionId);
  }
}
