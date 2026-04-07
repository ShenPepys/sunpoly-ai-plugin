/**
 * AI API 请求/响应类型定义
 * 遵循 OpenAI Chat Completion API 格式
 * DeepSeek、豆包、OpenAI 均兼容此格式
 */

/** 聊天消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 文本内容块 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** 图片内容块（OpenAI Vision API 格式，url 使用 base64 data URL） */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

/** 多模态内容块：文本或图片 */
export type ContentPart = TextContentPart | ImageContentPart;

/** 单条聊天消息（支持纯文本或多模态内容数组） */
export interface ChatMessageParam {
  role: ChatRole;
  /** 纯文本传 string；含图片时传 ContentPart 数组 */
  content: string | ContentPart[];
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
