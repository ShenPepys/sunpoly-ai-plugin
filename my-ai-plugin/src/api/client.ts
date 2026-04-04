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
import type {
  ChatMessageParam,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from './types';

/** API 客户端配置 */
export interface ApiClientConfig {
  /** API 端点地址，如 https://api.deepseek.com */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型 ID，如 deepseek-chat */
  modelId: string;
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

/**
 * 发送流式 Chat Completion 请求
 * AI 回复会逐字/逐片段通过回调函数返回
 * 
 * @param config API 配置
 * @param messages 消息列表
 * @param onChunk 每收到一个片段时的回调
 * @param onDone 全部完成时的回调
 * @param onError 出错时的回调
 */
export function sendStreamRequest(
  config: ApiClientConfig,
  messages: ChatMessageParam[],
  onChunk: OnChunkCallback,
  onDone: OnDoneCallback,
  onError: OnErrorCallback,
): void {
  const requestBody: ChatCompletionRequest = {
    model: config.modelId,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  };

  const bodyStr = JSON.stringify(requestBody);
  const url = new URL('/v1/chat/completions', config.baseUrl);

  // 根据协议选择 http 或 https
  const transport = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };

  info(`发起流式请求: ${config.modelId} → ${url.href}`);

  let fullContent = '';

  const req = transport.request(options, (res) => {
    const statusCode = res.statusCode ?? 0;

    // 处理非 200 状态码
    if (statusCode !== 200) {
      let errorBody = '';
      res.on('data', (chunk) => { errorBody += chunk.toString(); });
      res.on('end', () => {
        const errMsg = parseApiError(errorBody, statusCode);
        logError(`API 请求失败 (${statusCode}): ${errMsg}`);
        onError(errMsg);
      });
      return;
    }

    // 处理 SSE 流
    let buffer = '';

    res.on('data', (chunk: Buffer) => {
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
          info(`流式响应完成，总内容长度: ${fullContent.length}`);
          onDone(fullContent);
          return;
        }

        // 解析 JSON chunk
        try {
          const parsed: StreamChunk = JSON.parse(data);
          const deltaContent = parsed.choices?.[0]?.delta?.content;
          if (deltaContent) {
            fullContent += deltaContent;
            onChunk(deltaContent);
          }
        } catch (e) {
          // 忽略解析失败的行（可能是不完整的 JSON）
        }
      }
    });

    res.on('end', () => {
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
        onDone(fullContent);
      }
    });

    res.on('error', (err) => {
      logError('流式响应读取出错:', err.message);
      onError(`流式响应读取出错: ${err.message}`);
    });
  });

  req.on('error', (err) => {
    logError('API 请求出错:', err.message);
    onError(`连接 AI 服务失败: ${err.message}`);
  });

  // 设置超时（30 秒连接超时）
  req.setTimeout(30000, () => {
    req.destroy();
    onError('连接 AI 服务超时（30 秒），请检查网络或 API 地址');
  });

  req.write(bodyStr);
  req.end();
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
    const url = new URL('/v1/chat/completions', config.baseUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          const errMsg = parseApiError(data, statusCode);
          reject(new Error(errMsg));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', (err) => reject(new Error(`连接失败: ${err.message}`)));
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('请求超时（60 秒）'));
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * 解析 API 错误响应，提取可读的错误信息
 */
function parseApiError(body: string, statusCode: number): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed.error?.message) {
      return `API 错误 (${statusCode}): ${parsed.error.message}`;
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
