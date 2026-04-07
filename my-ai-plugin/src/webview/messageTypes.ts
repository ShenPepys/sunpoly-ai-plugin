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

// ==================== 会话数据结构 ====================

/** 单个聊天会话的完整数据，存储到 globalState中 */
export interface ChatSession {
  /** 会话唯一 ID */
  id: string;
  /** 用户可修改的显示名称 */
  name: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 对话历史（OpenAI 消息格式） */
  history: Array<{ role: string; content: unknown }>;
}

// ==================== Webview → Extension ====================

/** 用户发送聊天消息 */
export interface SendMessageRequest {
  type: 'sendMessage';
  text: string;
  /** 可选：随消息一起发送的图片附件（base64 DataURL 格式） */
  images?: Array<{ id: string; dataUrl: string; fileName: string; mimeType: string; sizeKB: number }>;
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

/** 用户点击上下文面板选项（Mentions / Workflow / Upload） */
export interface ContextActionRequest {
  type: 'contextAction';
  action: 'mentions' | 'workflow' | 'upload';
}

/** 用户在 Webview 中移除已添加的上下文文件 */
export interface RemoveContextFileRequest {
  type: 'removeContextFile';
  filePath: string;
}

/** 用户在输入框输入 @ 时请求工作区文件列表 */
export interface SearchWorkspaceFilesRequest {
  type: 'searchWorkspaceFiles';
  keyword: string;
}

/** 通过 @ mention 选中文件后直接添加到上下文列表 */
export interface AddContextFileRequest {
  type: 'addContextFile';
  filePath: string;
}

/** 导出对话为 Markdown 文件 */
export interface ExportChatRequest {
  type: 'exportChat';
}

/** 停止当前 AI 生成 */
export interface StopGenerationRequest {
  type: 'stopGeneration';
}

/** 从 Webview 触发 VS Code 命令（slash 命令） */
export interface ExecuteCommandRequest {
  type: 'executeCommand';
  command: string;
}

/** 用户点击「分析终端错误」按钮，后端从剪贴板读取错误并发给 AI */
export interface AnalyzeTerminalErrorRequest {
  type: 'analyzeTerminalError';
}

/** 用户点击「重新生成」按钮，后端删除最后一条 AI 回复并重新发送 */
export interface RegenerateRequest {
  type: 'regenerate';
}

/**
 * 用户点击 "View all changes" 按钮，请求 Extension 在 IDE 中打开对应文件
 * 新建文件 → showTextDocument，编辑文件 → vscode.diff 对比编辑器
 */
export interface OpenFilesInIdeRequest {
  type: 'openFilesInIde';
  /** 要打开的文件列表（绝对路径 + 状态） */
  files: Array<{ path: string; status: 'created' | 'modified' | 'read' | 'listed' }>;
}

/** 新建会话 */
export interface CreateSessionRequest {
  type: 'createSession';
}

/** 切换会话 */
export interface SwitchSessionRequest {
  type: 'switchSession';
  sessionId: string;
}

/** 删除会话 */
export interface DeleteSessionRequest {
  type: 'deleteSession';
  sessionId: string;
}

/** 重命名会话 */
export interface RenameSessionRequest {
  type: 'renameSession';
  sessionId: string;
  name: string;
}

/** Webview 发送给 Extension 的所有消息类型 */
export type WebviewMessage =
  | SendMessageRequest
  | CopyCodeRequest
  | InsertCodeRequest
  | ClearChatRequest
  | SwitchModelRequest
  | RequestModelsRequest
  | SwitchModeRequest
  | ContextActionRequest
  | RemoveContextFileRequest
  | SearchWorkspaceFilesRequest
  | AddContextFileRequest
  | ExportChatRequest
  | StopGenerationRequest
  | ExecuteCommandRequest
  | AcceptChangeRequest
  | RejectChangeRequest
  | AcceptAllChangesRequest
  | RejectAllChangesRequest
  | CreateSessionRequest
  | SwitchSessionRequest
  | DeleteSessionRequest
  | RenameSessionRequest
  | AnalyzeTerminalErrorRequest
  | RegenerateRequest
  | OpenFilesInIdeRequest;

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
  /** 当前活跃模型是否支持图片输入 */
  supportsVision?: boolean;
}

/** 更新已有消息的内容（用于剥离 tool_call 标签后刷新显示） */
export interface UpdateMessageResponse {
  type: 'updateMessage';
  messageId: string;
  content: string;
}

export interface RemoveLastAssistantMessageResponse {
  type: 'removeLastAssistantMessage';
}

/** 在指定气泡中显示 Thinking 动画 */
export interface ShowThinkingResponse {
  type: 'showThinking';
  messageId: string;
}

/** 添加上下文文件到 Webview 输入区显示 */
export interface AddContextFileResponse {
  type: 'addContextFile';
  /** 文件绝对路径 */
  filePath: string;
  /** 显示用的短文件名 */
  fileName: string;
}

/** 清空 Webview 中的上下文文件标签（发送消息后文件已注入） */
export interface ClearContextFilesResponse {
  type: 'clearContextFiles';
}

/** 返回工作区文件搜索结果 */
export interface WorkspaceFilesResponse {
  type: 'workspaceFiles';
  files: { filePath: string; fileName: string }[];
}

/** 推送 Token 用量估算到 Webview */
export interface UpdateTokenCountResponse {
  type: 'updateTokenCount';
  tokenCount: number;
}

/** 推送当前工作模式到 Webview */
export interface UpdateModeResponse {
  type: 'updateMode';
  mode: WorkMode;
}

/** 通知 Webview 用户主动停止了生成（保留已接收的部分内容） */
export interface GenerationStoppedResponse {
  type: 'generationStopped';
}

// ==================== Windsurf 风格步骤展示 ====================

/** 工具步骤状态 */
export type StepStatus = 'running' | 'done' | 'error';

/** 添加一个进度步骤到消息气泡（工具调用开始时发送） */
export interface AddStepResponse {
  type: 'addStep';
  /** 所属 AI 消息 ID */
  messageId: string;
  /** 步骤唯一 ID */
  stepId: string;
  /** 图标（emoji 或 codicon 名） */
  icon: string;
  /** 步骤描述（如 "Reading login.html #L1-50"） */
  description: string;
  /** 步骤状态 */
  status: StepStatus;
}

/** 更新步骤状态（工具执行完成或出错时发送） */
export interface UpdateStepResponse {
  type: 'updateStep';
  stepId: string;
  status: StepStatus;
  /** 可选：更新描述文字 */
  description?: string;
  /** 可选：耗时（毫秒） */
  elapsed?: number;
}

/** 在步骤中展示代码 diff（文件写入/编辑操作完成后发送） */
export interface ShowDiffResponse {
  type: 'showDiff';
  messageId: string;
  stepId: string;
  summaryId?: string;
  filePath: string;
  language: string;
  additions: number;
  deletions: number;
  oldContent: string;
  newContent: string;
  noticeText?: string;
  /** 是否需要用户确认（Accept/Reject），false 表示已自动执行 */
  needsConfirm: boolean;
  collapsed?: boolean;
}

/** 显示文件变更汇总（所有工具执行完成后发送） */
export interface ShowChangeSummaryResponse {
  type: 'showChangeSummary';
  messageId: string;
  summaryId: string;
  needsConfirm: boolean;
  files: Array<{
    path: string;
    displayPath: string;
    additions: number;
    deletions: number;
    status: 'created' | 'modified' | 'read' | 'listed';
    issueText?: string;
  }>;
}

/** 更新批量变更汇总的状态 */
export interface UpdateChangeSummaryResponse {
  type: 'updateChangeSummary';
  summaryId: string;
  status: 'applying' | 'accepted' | 'partial' | 'failed' | 'rejected' | 'cancelled';
  text: string;
}

/** 流式阶段完成后显示 Thinking 耗时（替代之前的 Thinking 动画） */
export interface ThinkingCompleteResponse {
  type: 'thinkingComplete';
  messageId: string;
  /** 思考耗时（毫秒） */
  elapsed: number;
}

// ==================== 图片附件（Image Attachment） ====================

/** 前端准备发送的图片附件数据 */
export interface ImageAttachment {
  /** 唯一标识，由前端生成 */
  id: string;
  /** base64 data URL，格式为 data:image/jpeg;base64,... */
  dataUrl: string;
  /** 原始文件名 */
  fileName: string;
  /** MIME 类型，如 image/jpeg */
  mimeType: string;
  /** 文件大小（KB） */
  sizeKB: number;
}

/** 后端通知前端当前模型不支持视觉输入（发送图片时才触发） */
export interface VisionNotSupportedResponse {
  type: 'visionNotSupported';
  /** 当前模型名称，用于在提示中展示 */
  modelName: string;
}

/** 后端通知前端清空图片附件缩略图（消息发送后图片已处理，可以清除展示） */
export interface ClearImageAttachmentsResponse {
  type: 'clearImageAttachments';
}

/** 推送会话列表到 Webview（新建/切换/删除/重命名后触发） */
export interface UpdateSessionsResponse {
  type: 'updateSessions';
  /** 所有会话的摘要信息（不含完整历史，减少传输量） */
  sessions: Array<{
    id: string;
    name: string;
    createdAt: number;
    /** 对话轮数（用于在 Tab 上展示徽章） */
    messageCount: number;
  }>;
  /** 当前活跃会话 ID */
  activeSessionId: string;
}

// ==================== Webview → Extension（Accept/Reject） ====================

/** 用户接受文件变更 */
export interface AcceptChangeRequest {
  type: 'acceptChange';
  stepId: string;
}

/** 用户拒绝文件变更 */
export interface RejectChangeRequest {
  type: 'rejectChange';
  stepId: string;
}

export interface AcceptAllChangesRequest {
  type: 'acceptAllChanges';
  summaryId: string;
}

export interface RejectAllChangesRequest {
  type: 'rejectAllChanges';
  summaryId: string;
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
  | RemoveLastAssistantMessageResponse
  | ShowThinkingResponse
  | AddContextFileResponse
  | ClearContextFilesResponse
  | WorkspaceFilesResponse
  | UpdateTokenCountResponse
  | UpdateModeResponse
  | GenerationStoppedResponse
  | AddStepResponse
  | UpdateStepResponse
  | ShowDiffResponse
  | ShowChangeSummaryResponse
  | UpdateChangeSummaryResponse
  | ThinkingCompleteResponse
  | VisionNotSupportedResponse
  | ClearImageAttachmentsResponse
  | UpdateSessionsResponse;
