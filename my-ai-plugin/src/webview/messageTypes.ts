/**
 * Webview ↔ Extension Host 双向通信的消息类型定义
 * 
 * 通信方向：
 *   Webview  → Extension：用户操作（发消息、点按钮等）
 *   Extension → Webview ：AI 回复、状态更新等
 */

// ==================== 工作模式 ===================

/** 工作模式类型 */
export type WorkMode = 'code' | 'ask' | 'plan';

// ==================== Webview → Extension ====================

/** 用户发送聊天消息 */
export interface SendMessageRequest {
  type: 'sendMessage';
  text: string;
}

/** 用户点击"复制代码"按钮 */
export interface CopyCodeRequest {
  type: 'copyCode';
  code: string;
}

/** 用户点击"插入代码到编辑器"按钮 */
export interface InsertCodeRequest {
  type: 'insertCode';
  code: string;
}

/** 用户点击"清空对话"按钮 */
export interface ClearChatRequest {
  type: 'clearChat';
}

/** 用户切换模型 */
export interface SwitchModelRequest {
  type: 'switchModel';
  index: number;
}

/** 用户请求模型列表（点击下拉框时触发） */
export interface RequestModelsRequest {
  type: 'requestModels';
}

/** 用户切换工作模式 */
export interface SwitchModeRequest {
  type: 'switchMode';
  mode: WorkMode;
}

/** Webview 发送给 Extension 的所有消息类型 */
export type WebviewMessage =
  | SendMessageRequest
  | CopyCodeRequest
  | InsertCodeRequest
  | ClearChatRequest
  | SwitchModelRequest
  | RequestModelsRequest
  | SwitchModeRequest;

// ==================== Extension → Webview ====================

/** 添加一条完整消息到聊天界面 */
export interface AddMessageResponse {
  type: 'addMessage';
  role: 'user' | 'assistant';
  content: string;
  /** 消息唯一 ID，用于流式更新时定位 */
  messageId: string;
}

/** 流式追加内容到最后一条 AI 消息 */
export interface StreamChunkResponse {
  type: 'streamChunk';
  /** 本次追加的文本片段 */
  chunk: string;
  /** 对应的消息 ID */
  messageId: string;
}

/** 流式传输结束 */
export interface StreamDoneResponse {
  type: 'streamDone';
  messageId: string;
}

/** 显示错误信息 */
export interface ShowErrorResponse {
  type: 'showError';
  message: string;
}

/** 设置加载状态 */
export interface SetLoadingResponse {
  type: 'setLoading';
  loading: boolean;
}

/** 清空聊天界面 */
export interface ClearChatResponse {
  type: 'clearChat';
}

/** 推送模型列表到 Webview */
export interface UpdateModelsResponse {
  type: 'updateModels';
  /** 模型名称列表 */
  models: { name: string; index: number }[];
  /** 当前活跃模型的序号 */
  activeIndex: number;
}

/** 更新已有消息的内容（用于剥离 tool_call 标签后刷新显示） */
export interface UpdateMessageResponse {
  type: 'updateMessage';
  messageId: string;
  content: string;
}

/** 在指定气泡中显示 Thinking 动画 */
export interface ShowThinkingResponse {
  type: 'showThinking';
  messageId: string;
}

/** 推送当前工作模式到 Webview */
export interface UpdateModeResponse {
  type: 'updateMode';
  mode: WorkMode;
}

/** Extension 发送给 Webview 的所有消息类型 */
export type ExtensionMessage =
  | AddMessageResponse
  | StreamChunkResponse
  | StreamDoneResponse
  | ShowErrorResponse
  | SetLoadingResponse
  | ClearChatResponse
  | UpdateModelsResponse
  | UpdateMessageResponse
  | ShowThinkingResponse
  | UpdateModeResponse;
