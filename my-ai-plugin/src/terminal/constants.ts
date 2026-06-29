/** Shell Integration 等待就绪超时（毫秒） */
export const SHELL_INTEGRATION_WAIT_TIMEOUT_MS = 4000;

/** Shell Integration 输出流读取超时（毫秒） */
export const SHELL_INTEGRATION_STREAM_TIMEOUT_MS = 10_000;

/** 无 Shell Integration 时 sendText 后等待输出的时间（毫秒） */
export const NO_SHELL_INTEGRATION_WAIT_MS = 3000;

/** 进程输出缓冲上限（字符） */
export const MAX_FULL_OUTPUT_SIZE = 256 * 1024;

/** 默认命令超时（毫秒），P1-2 起可由配置覆盖 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** 返回给模型的命令输出最大字符数，P1-2 起可由配置覆盖 */
export const MAX_COMMAND_OUTPUT_CHARS = 8192;
