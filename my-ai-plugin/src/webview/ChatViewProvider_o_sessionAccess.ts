import {
  buildDisplayHistoryFromRawHistory,
  sanitizeDisplayHistory,
} from './ChatViewProvider_c_displayHistory';
import type {
  ChatSessionDisplayMessage,
  ChatSessionHistoryMessage,
} from './messageTypes';

export {
  getActiveSession,
  getSessionDisplayHistoryForExport,
  resolveSessionDisplayHistory,
  setSessionDisplayHistory,
} from './ChatViewProvider_f_sessions';

type SessionMessageIdFactory = (role: 'user' | 'assistant', timestamp?: number) => string;

export type SessionDisplayHistoryAccessors = {
  sanitizeDisplayHistory: (displayHistory: ChatSessionDisplayMessage[]) => ChatSessionDisplayMessage[];
  buildDisplayHistoryFromRawHistory: (history: ChatSessionHistoryMessage[]) => ChatSessionDisplayMessage[];
};

export function createSessionDisplayHistoryAccessors(options: {
  createDisplayMessageId: SessionMessageIdFactory;
  toChangedFileDisplayPath: (filePath: string) => string;
}): SessionDisplayHistoryAccessors {
  return {
    sanitizeDisplayHistory: displayHistory => sanitizeDisplayHistory(displayHistory, options.createDisplayMessageId),
    buildDisplayHistoryFromRawHistory: history => buildDisplayHistoryFromRawHistory(history, {
      createDisplayMessageId: options.createDisplayMessageId,
      toChangedFileDisplayPath: options.toChangedFileDisplayPath,
    }),
  };
}
