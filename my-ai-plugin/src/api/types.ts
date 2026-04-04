/**
 * AI API 请求/响应类型定义
 * 遵循 OpenAI Chat Completion API 格式
 * DeepSeek、豆包、OpenAI 均兼容此格式
 */

/** 聊天消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 单条聊天消息 */
export interface ChatMessageParam {
  role: ChatRole;
  content: string;
}

/** Chat Completion 请求体 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessageParam[];
  /** 最大回复 token 数 */
  max_tokens?: number;
  /** 随机性（0~1） */
  temperature?: number;
  /** 是否开启流式输出 */
  stream?: boolean;
}

/** 非流式响应中的单条 choice */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: ChatRole;
    content: string;
  };
  finish_reason: string | null;
}

/** 非流式 Chat Completion 响应 */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 流式响应中的单条 delta choice */
export interface StreamChoice {
  index: number;
  delta: {
    role?: ChatRole;
    content?: string;
  };
  finish_reason: string | null;
}

/** 流式 SSE 中每一个 chunk 的结构 */
export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: StreamChoice[];
}

/** API 错误响应 */
export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | number | null;
  };
}
