/**
 * AI API 客户端
 * 
 * 使用 OpenAI 兼容的 Chat Completion 接口，
 * 支持流式（SSE）和非流式两种调用方式。
 * 兼容 DeepSeek、OpenAI、豆包等所有 OpenAI 格式 API。
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { info, error as logError } from '../logger';
import { getProxy } from '../config';
import type {
  ChatMessageParam,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from './types';
import type { Socket } from 'net';

/** API 客户端配置 */
export interface ApiClientConfig {
  /** API 端点地址，如 https://api.deepseek.com */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型 ID，如 deepseek-chat */
  modelId: string;
  /** 自定义 API 路径，默认 /v1/chat/completions */
  apiPath: string;
  /** 最大回复 token 数 */
  maxTokens: number;
  /** 温度参数 */
  temperature: number;
}

/** 流式回调：每收到一个文本片段时触发 */
export type OnChunkCallback = (chunk: string) => void;

/** 流式完成回调：全部内容接收完毕时触发 */
export type OnDoneCallback = (fullContent: string) => void;

/** 错误回调 */
export type OnErrorCallback = (errorMessage: string) => void;

function buildRequestPath(url: URL): string {
  const requestPath = `${url.pathname}${url.search}`;
  return requestPath || '/';
}

/**
 * 发送非流式 Chat Completion 请求
 * 等待 AI 完整回复后一次性返回
 * 
 * @returns AI 回复的完整文本
 */
export async function sendChatRequest(
  config: ApiClientConfig,
  messages: ChatMessageParam[],
): Promise<string> {
  const requestBody: ChatCompletionRequest = {
    model: config.modelId,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  };

  const responseText = await doHttpRequest(config, requestBody);
  const response: ChatCompletionResponse = JSON.parse(responseText);

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('AI 返回了空内容');
  }

  return content;
}

/** 中断流式请求的函数 */
export type AbortStreamFn = () => void;

/**
 * 发送流式 Chat Completion 请求
 * AI 回复会逐字/逐片段通过回调函数返回
 * 
 * @returns 中断函数，调用后立即停止接收数据
 */
export function sendStreamRequest(
  config: ApiClientConfig,
  messages: ChatMessageParam[],
  onChunk: OnChunkCallback,
  onDone: OnDoneCallback,
  onError: OnErrorCallback,
): AbortStreamFn {
  const requestBody: ChatCompletionRequest = {
    model: config.modelId,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  };

  const bodyStr = JSON.stringify(requestBody);
  const apiPath = config.apiPath || '/v1/chat/completions';
  const url = new URL(apiPath, config.baseUrl);
  const proxyUrl = getProxy();

  // 根据协议选择 http 或 https
  const transport = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: buildRequestPath(url),
    method: 'POST',
    // 绕过 VS Code 对 http.globalAgent 的 patch，避免代理干扰
    agent: false as any,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };

  const proxyLabel = proxyUrl ? ` (代理: ${proxyUrl})` : '';
  info(`发起流式请求: ${config.modelId} → ${url.href}${proxyLabel}`);
  info(`请求详情: hostname=${options.hostname}, port=${options.port}, path=${options.path}, protocol=${url.protocol}`);

  let fullContent = '';
  let aborted = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 终态互斥标志：onDone 和 onError 只有第一个调用生效
   * 避免 req.destroy() 触发的 error 事件导致双重回调
   */
  let settled = false;

  /** 确保 onDone 只被调用一次，且不与 onError 并发 */
  function callOnDone(): void {
    if (settled) { return; }
    settled = true;
    onDone(fullContent);
  }

  /** 确保 onError 只被调用一次，且不与 onDone 并发 */
  function callOnError(message: string): void {
    if (settled) { return; }
    settled = true;
    onError(message);
  }

  /**
   * 实际发起请求的函数（支持通过代理隧道的 socket）
   * @param tunnelSocket 代理隧道 socket（无代理时为 undefined）
   */
  function doRequest(tunnelSocket?: Socket): void {
  const reqOptions = tunnelSocket
    ? { ...options, socket: tunnelSocket, agent: false as any }
    : options;

  const req = transport.request(reqOptions, (res) => {
    const statusCode = res.statusCode ?? 0;

    // 处理非 200 状态码
    if (statusCode !== 200) {
      let errorBody = '';
      res.on('data', (chunk) => { errorBody += chunk.toString(); });
      res.on('end', () => {
        // 429 自动重试（最多 3 次，指数退避）
        if (statusCode === 429 && retryCount < 3 && !aborted) {
          const retryAfter = res.headers['retry-after'];
          const baseWait = retryAfter ? parseInt(retryAfter, 10) : Math.min(30, 5 * Math.pow(2, retryCount));
          const waitSec = isNaN(baseWait) ? Math.min(30, 5 * Math.pow(2, retryCount)) : baseWait;
          retryCount++;
          info(`API 429 限流，${waitSec} 秒后自动重试（第 ${retryCount} 次）`);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (aborted) { return; }
            if (tunnelSocket && !tunnelSocket.destroyed) {
              doRequest(tunnelSocket);
            } else {
              doRequest();
            }
          }, waitSec * 1000);
          return;
        }

        let errMsg: string;
        if (statusCode === 429) {
          const retryAfter = res.headers['retry-after'];
          const waitSec = retryAfter ? parseInt(retryAfter, 10) : 30;
          errMsg = `API 请求频率过高，已自动重试 ${retryCount} 次仍然限流，请 ${waitSec} 秒后手动重试`;
        } else if (statusCode === 401 || statusCode === 403) {
          errMsg = 'API Key 无效或已过期，请在设置中检查 myAiPlugin.models 配置';
        } else {
          errMsg = parseApiError(errorBody, statusCode);
        }
        logError(`API 请求失败 (${statusCode}): ${errMsg}`);
        logError(`响应体: ${errorBody || '(空)'}`);
        logError(`请求目标: ${url.href}`);
        callOnError(errMsg);
      });
      return;
    }

    // 处理 SSE 流
    let buffer = '';

    // 流式空闲超时：60 秒内无新数据则判定超时
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(() => {
        if (!aborted) {
          logError('流式响应空闲超时（60 秒无数据）');
          req.destroy();
          if (fullContent) {
            callOnDone();
          } else {
            callOnError('AI 响应超时（60 秒无数据），请重试');
          }
        }
      }, 60000);
    };
    resetIdleTimer();

    res.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      buffer += chunk.toString();

      // SSE 格式：每条消息以 \n\n 分隔
      const lines = buffer.split('\n');
      // 保留最后一行（可能不完整）
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith(':')) {
          continue;
        }

        // 解析 data: 前缀
        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        const data = trimmed.slice(6);

        // 流结束标志
        if (data === '[DONE]') {
          if (idleTimer) { clearTimeout(idleTimer); }
          info(`流式响应完成，总内容长度: ${fullContent.length}`);
          callOnDone();
          return;
        }

        // 解析 JSON chunk
        try {
          const parsed: StreamChunk = JSON.parse(data);
          const deltaContent = parsed.choices?.[0]?.delta?.content;
          if (deltaContent) {
            fullContent += deltaContent;
            if (!aborted) { onChunk(deltaContent); }
          }
        } catch (e) {
          // 忽略解析失败的行（可能是不完整的 JSON）
        }
      }
    });

    res.on('end', () => {
      if (idleTimer) { clearTimeout(idleTimer); }
      if (aborted) { return; }
      // 如果 buffer 中还有未处理的数据，尝试处理
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
          try {
            const parsed: StreamChunk = JSON.parse(trimmed.slice(6));
            const deltaContent = parsed.choices?.[0]?.delta?.content;
            if (deltaContent) {
              fullContent += deltaContent;
              onChunk(deltaContent);
            }
          } catch (e) {
            // 忽略
          }
        }
      }

      // 确保 onDone 被调用（防止 [DONE] 标志丢失的情况）
      if (fullContent) {
        callOnDone();
      } else {
        callOnError('AI 响应异常：未收到有效内容，请重试');
      }
    });

    res.on('error', (err) => {
      logError('流式响应读取出错:', err.message);
      callOnError(`流式响应读取出错: ${err.message}`);
    });
  });

  req.on('error', (err) => {
    logError('API 请求出错:', err.message);
    callOnError(`连接 AI 服务失败: ${err.message}`);
  });

  // 设置超时（120 秒连接超时，大模型首 token 延迟可能较长）
  req.setTimeout(120000, () => {
    req.destroy();
    callOnError('连接 AI 服务超时（120 秒），请检查网络或 API 地址');
  });

  req.write(bodyStr);
  req.end();

  // 保存 req 引用到闭包外层，供 abort 使用
  currentReq = req;
  } // end doRequest

  let currentReq: http.ClientRequest | null = null;
  let retryCount = 0;

  // 如果配置了代理且目标是 HTTPS，先建立 CONNECT 隧道
  if (proxyUrl && url.protocol === 'https:') {
    connectThroughProxy(proxyUrl, url.hostname, Number(url.port) || 443, (err, socket) => {
      if (err) {
        onError(`代理连接失败: ${err.message}`);
        return;
      }
      doRequest(socket!);
    });
  } else if (proxyUrl && url.protocol === 'http:') {
    // HTTP 目标通过 HTTP 代理：直接将代理作为目标主机，请求路径用完整 URL
    const proxyParsed = new URL(proxyUrl);
    options.hostname = proxyParsed.hostname;
    options.port = Number(proxyParsed.port) || 80;
    options.path = url.href;
    doRequest();
  } else {
    doRequest();
  }

  // 返回中断函数
  return () => {
    if (!aborted) {
      aborted = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (currentReq) { currentReq.destroy(); }
      info('流式请求已主动中断');
      // 中断时把已收到的内容作为最终结果
      if (fullContent) {
        callOnDone();
      }
    }
  };
}

/**
 * 发送普通 HTTP 请求（非流式）
 * 返回完整的响应体文本
 */
function doHttpRequest(
  config: ApiClientConfig,
  body: ChatCompletionRequest,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const apiPath = config.apiPath || '/v1/chat/completions';
    const url = new URL(apiPath, config.baseUrl);
    const proxyUrl = getProxy();
    const transport = url.protocol === 'https:' ? https : http;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: buildRequestPath(url),
      method: 'POST',
      agent: false as any,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    let retryCount = 0;

    function makeRequest(tunnelSocket?: Socket): void {
      const reqOptions = tunnelSocket
        ? { ...options, socket: tunnelSocket }
        : options;

      const req = transport.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;

          // 429 自动重试（最多 3 次，指数退避）
          if (statusCode === 429 && retryCount < 3) {
            const retryAfter = res.headers['retry-after'];
            const baseWait = retryAfter ? parseInt(retryAfter as string, 10) : Math.min(30, 5 * Math.pow(2, retryCount));
            const waitSec = isNaN(baseWait) ? Math.min(30, 5 * Math.pow(2, retryCount)) : baseWait;
            retryCount++;
            info(`非流式 API 429 限流，${waitSec} 秒后自动重试（第 ${retryCount} 次）`);
            setTimeout(() => {
              if (tunnelSocket && !tunnelSocket.destroyed) {
                makeRequest(tunnelSocket);
              } else {
                makeRequest();
              }
            }, waitSec * 1000);
            return;
          }

          if (statusCode !== 200) {
            const errMsg = parseApiError(data, statusCode);
            reject(new Error(errMsg));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', (err) => reject(new Error(`连接失败: ${err.message}`)));
      req.setTimeout(180000, () => {
        req.destroy();
        reject(new Error('请求超时（180 秒）'));
      });

      req.write(bodyStr);
      req.end();
    }

    // 代理处理逻辑
    if (proxyUrl && url.protocol === 'https:') {
      connectThroughProxy(proxyUrl, url.hostname, Number(url.port) || 443, (err, socket) => {
        if (err) { reject(new Error(`代理连接失败: ${err.message}`)); return; }
        makeRequest(socket!);
      });
    } else if (proxyUrl && url.protocol === 'http:') {
      const proxyParsed = new URL(proxyUrl);
      options.hostname = proxyParsed.hostname;
      options.port = Number(proxyParsed.port) || 80;
      options.path = url.href;
      makeRequest();
    } else {
      makeRequest();
    }
  });
}

/**
 * 通过 HTTP 代理建立 CONNECT 隧道（用于 HTTPS 请求走代理）
 * 使用 Node.js 内置模块，无需外部依赖
 */
function connectThroughProxy(
  proxyUrl: string,
  targetHost: string,
  targetPort: number,
  callback: (err: Error | null, socket?: Socket) => void,
): void {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port) || 80;

  const connectReq = http.request({
    hostname: proxy.hostname,
    port: proxyPort,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
  });

  connectReq.on('connect', (_res, socket) => {
    info(`代理隧道已建立: ${proxy.hostname}:${proxyPort} → ${targetHost}:${targetPort}`);
    callback(null, socket);
  });

  connectReq.on('error', (err) => {
    logError(`代理连接失败: ${err.message}`);
    callback(err);
  });

  connectReq.setTimeout(15000, () => {
    connectReq.destroy();
    callback(new Error('代理连接超时（15 秒）'));
  });

  connectReq.end();
}

/**
 * 解析 API 错误响应，提取可读的错误信息
 */
function parseApiError(body: string, statusCode: number): string {
  try {
    const parsed = JSON.parse(body);
    // 兼容 OpenAI 格式 {error: {message}} 和 FastAPI 格式 {detail}
    const msg = parsed.error?.message || parsed.detail || parsed.message;
    if (msg) {
      return `API 错误 (${statusCode}): ${msg}`;
    }
  } catch {
    // JSON 解析失败，使用原始文本
  }

  // 常见状态码的中文说明
  const statusMessages: Record<number, string> = {
    401: '认证失败，请检查 API Key 是否正确',
    403: '权限不足，API Key 可能没有该模型的访问权限',
    404: '接口地址不存在，请检查 baseUrl 配置',
    429: '请求频率超限，请稍后再试',
    500: 'AI 服务内部错误，请稍后重试',
    502: 'AI 服务网关错误，请稍后重试',
    503: 'AI 服务暂时不可用，请稍后重试',
  };

  return statusMessages[statusCode] ?? `请求失败 (HTTP ${statusCode})`;
}
