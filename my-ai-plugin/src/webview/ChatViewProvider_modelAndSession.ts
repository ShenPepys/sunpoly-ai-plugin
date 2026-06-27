import type { ApiClientConfig } from '../api/client';
import { detectVisionSupport, getCustomSystemPrompt } from '../config';
import { info } from '../logger';
import type { ChatMessageParam } from '../api/types';
import { buildSystemPrompt } from '../prompts/system';
import type { ModelConfig } from '../prompts/types';
import { detectProjectType, getEnvContext, getGitStatus, getProjectContext } from '../utils/context';
import { estimateMessagesTokenCount, trimHistoryToFitContextWindow } from './ChatViewProvider_contextUsage';
import { summarizeDroppedMessages } from './ChatViewProvider_contextSummary';
import type {
  UpdateModelsResponse,
  VisionNotSupportedResponse,
  WorkMode,
} from './messageTypes';

const MODE_LABELS: Record<WorkMode, string> = {
  code: 'Code',
  ask: 'Ask',
  plan: 'Plan',
};

type ContextWindowFitResult = {
  messages: ChatMessageParam[];
  effectiveMaxTokens: number;
  droppedMessageCount: number;
  promptTokenEstimate: number;
};

const MIN_COMPLETION_TOKENS = 256;
const MIN_REQUEST_MAX_TOKENS = 64;

export function buildUpdateModelsResponse(options: {
  models: Array<{ name: string }>;
  activeIndex: number;
  supportsVision: boolean;
}): UpdateModelsResponse {
  const safeIndex = Math.min(options.activeIndex, Math.max(0, options.models.length - 1));
  return {
    type: 'updateModels',
    models: options.models.map((model, index) => ({ name: model.name, index })),
    activeIndex: safeIndex,
    supportsVision: options.supportsVision,
  };
}

export async function buildRequestSystemPrompt(options: {
  modelConfig: ModelConfig;
  requestMode: WorkMode;
  allowCustomPrompt?: boolean;
  includeProjectContext?: boolean;
}): Promise<string> {
  const shouldAllowCustomPrompt = options.allowCustomPrompt !== false;
  const customPrompt = shouldAllowCustomPrompt ? getCustomSystemPrompt() : '';
  const baseSystemPrompt = customPrompt
    ? customPrompt
    : buildSystemPrompt(
      getEnvContext(),
      options.modelConfig,
      options.requestMode,
      '中文',
      detectProjectType(),
      await getGitStatus(),
    );

  if (!options.includeProjectContext) {
    return baseSystemPrompt;
  }

  const projectContext = getProjectContext();
  if (!projectContext) {
    return baseSystemPrompt;
  }

  return `${baseSystemPrompt}\n\n${projectContext}`;
}

type AppendUserContentMode = 'always' | 'ifMissingLastUser' | 'never';

export async function buildChatRequestMessages(options: {
  modelConfig: ModelConfig;
  requestMode: WorkMode;
  remindedMessages: ChatMessageParam[];
  userContent?: ChatMessageParam['content'];
  appendUserContentMode?: AppendUserContentMode;
  allowCustomPrompt?: boolean;
  includeProjectContext?: boolean;
}): Promise<{ systemPrompt: string; messages: ChatMessageParam[] }> {
  const systemPrompt = await buildRequestSystemPrompt({
    modelConfig: options.modelConfig,
    requestMode: options.requestMode,
    allowCustomPrompt: options.allowCustomPrompt,
    includeProjectContext: options.includeProjectContext,
  });

  const messages: ChatMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...options.remindedMessages,
  ];
  const appendMode = options.appendUserContentMode ?? 'never';
  const userContent = options.userContent;

  if (appendMode === 'always' && userContent !== undefined) {
    messages.push({ role: 'user', content: userContent });
  } else if (appendMode === 'ifMissingLastUser' && userContent !== undefined) {
    const lastContextMessage = options.remindedMessages[options.remindedMessages.length - 1];
    if (!lastContextMessage || lastContextMessage.role !== 'user') {
      messages.push({ role: 'user', content: userContent });
    }
  }

  return {
    systemPrompt,
    messages,
  };
}

export function buildApiClientConfig(options: {
  modelConfig: ModelConfig;
  apiKey: string;
  maxTokens: number;
  temperature: number;
}): ApiClientConfig {
  return {
    baseUrl: options.modelConfig.baseUrl,
    apiKey: options.apiKey,
    modelId: options.modelConfig.modelId,
    apiPath: options.modelConfig.apiPath,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  };
}

function fitMessagesToContextWindow(options: {
  messages: ChatMessageParam[];
  contextWindow: number;
  requestedMaxTokens: number;
}): ContextWindowFitResult {
  const normalizedContextWindow = Math.max(options.contextWindow, 1);
  const requestedMaxTokens = Math.max(options.requestedMaxTokens, MIN_REQUEST_MAX_TOKENS);
  // 安全缓冲：考虑 token 估算与真实分词的偏差，再加一层冗余。
  // 经验值：中英混合 + 代码估算偏差通常在 10% 以内，8% 的缓冲足以覆盖。
  // 下限 256 避免窗口过小时失效；上限 2048 避免大窗口模型（如 128K）浪费太多空间。
  const safetyBufferTokens = Math.min(2048, Math.max(256, Math.floor(normalizedContextWindow * 0.08)));
  const minimumCompletionTokens = Math.min(requestedMaxTokens, MIN_COMPLETION_TOKENS);
  const minimumPromptBudget = Math.max(1, normalizedContextWindow - minimumCompletionTokens - safetyBufferTokens);
  const nextMessages = [...options.messages];
  const minimumPreservedMessageCount = nextMessages.length > 1 ? 2 : 1;
  let promptTokenEstimate = estimateMessagesTokenCount(nextMessages);
  let droppedMessageCount = 0;

  while (nextMessages.length > minimumPreservedMessageCount && promptTokenEstimate > minimumPromptBudget) {
    nextMessages.splice(1, 1);
    droppedMessageCount += 1;
    promptTokenEstimate = estimateMessagesTokenCount(nextMessages);
  }

  const availableCompletionTokens = normalizedContextWindow - promptTokenEstimate - safetyBufferTokens;
  const effectiveMaxTokens = Math.max(
    1,
    Math.min(requestedMaxTokens, availableCompletionTokens),
  );

  return {
    messages: nextMessages,
    effectiveMaxTokens,
    droppedMessageCount,
    promptTokenEstimate,
  };
}

export async function prepareChatRequestExecution(options: {
  modelConfig: ModelConfig;
  requestMode: WorkMode;
  remindedMessages: ChatMessageParam[];
  apiKey: string;
  maxTokens: number;
  temperature: number;
  userContent?: ChatMessageParam['content'];
  appendUserContentMode?: AppendUserContentMode;
  allowCustomPrompt?: boolean;
  includeProjectContext?: boolean;
}): Promise<{
  systemPrompt: string;
  messages: ChatMessageParam[];
  apiConfig: ApiClientConfig;
}> {
  const requestMessages = await buildChatRequestMessages({
    modelConfig: options.modelConfig,
    requestMode: options.requestMode,
    remindedMessages: options.remindedMessages,
    userContent: options.userContent,
    appendUserContentMode: options.appendUserContentMode,
    allowCustomPrompt: options.allowCustomPrompt,
    includeProjectContext: options.includeProjectContext,
  });

  const fittedRequest = fitMessagesToContextWindow({
    messages: requestMessages.messages,
    contextWindow: options.modelConfig.contextWindow,
    requestedMaxTokens: options.maxTokens,
  });

  if (fittedRequest.droppedMessageCount > 0) {
    info('请求发送前二次压缩历史消息', {
      contextWindow: options.modelConfig.contextWindow,
      droppedMessageCount: fittedRequest.droppedMessageCount,
      promptTokenEstimate: fittedRequest.promptTokenEstimate,
    });
  }

  if (fittedRequest.effectiveMaxTokens < options.maxTokens) {
    info('请求发送前动态下调 maxTokens', {
      requestedMaxTokens: options.maxTokens,
      effectiveMaxTokens: fittedRequest.effectiveMaxTokens,
      promptTokenEstimate: fittedRequest.promptTokenEstimate,
      contextWindow: options.modelConfig.contextWindow,
    });
  }

  return {
    systemPrompt: requestMessages.systemPrompt,
    messages: fittedRequest.messages,
    apiConfig: buildApiClientConfig({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      maxTokens: fittedRequest.effectiveMaxTokens,
      temperature: options.temperature,
    }),
  };
}

export type BuildUserRequestContentResult = {
  content: ChatMessageParam['content'];
  visionWarning?: VisionNotSupportedResponse;
};

export function buildUserRequestContent(options: {
  userContent: string;
  images: Array<{ dataUrl: string }>;
  modelConfig: ModelConfig;
  allModels: Array<{ name: string; modelId: string; supportsVision?: boolean }>;
}): BuildUserRequestContentResult {
  if (options.images.length === 0) {
    return {
      content: options.userContent,
    };
  }

  if (options.modelConfig.supportsVision) {
    return {
      content: [
        { type: 'text', text: options.userContent },
        ...options.images.map(image => ({
          type: 'image_url' as const,
          image_url: { url: image.dataUrl },
        })),
      ],
    };
  }

  const visionModels = options.allModels
    .filter(model => {
      if (model.supportsVision === true) {
        return true;
      }

      if (model.supportsVision === false) {
        return false;
      }

      return detectVisionSupport(model.modelId);
    })
    .map(model => model.name);

  return {
    content: options.userContent,
    visionWarning: {
      type: 'visionNotSupported',
      modelName: options.modelConfig.modelName,
      visionModels,
    },
  };
}

export type InjectModeReminderResult = {
  history: ChatMessageParam[];
  mismatchDetected: boolean;
  insertPosition: number;
};

export function injectModeReminder(
  history: ChatMessageParam[],
  requestMode: WorkMode,
): InjectModeReminderResult {
  const currentLabel = MODE_LABELS[requestMode] || requestMode;
  const otherLabels = Object.entries(MODE_LABELS)
    .filter(([mode]) => mode !== requestMode)
    .map(([, label]) => label);

  const hasMismatch = history.some(message => {
    if (message.role !== 'assistant') {
      return false;
    }

    const text = typeof message.content === 'string' ? message.content : '';
    return otherLabels.some(label => text.includes(`${label} 模式`));
  });

  if (!hasMismatch) {
    return {
      history,
      mismatchDetected: false,
      insertPosition: -1,
    };
  }

  const nextHistory = [...history];
  let lastUserIndex = -1;
  for (let i = nextHistory.length - 1; i >= 0; i--) {
    if (nextHistory[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const reminder: ChatMessageParam = {
    role: 'system',
    content: `[重要模式变更提醒] 用户已切换到 ${currentLabel} 模式。请忽略之前对话中关于其他模式的描述，严格按照当前 ${currentLabel} 模式的能力和规则来回应。`,
  };

  if (lastUserIndex >= 0) {
    nextHistory.splice(lastUserIndex, 0, reminder);
  } else {
    nextHistory.push(reminder);
  }

  return {
    history: nextHistory,
    mismatchDetected: true,
    insertPosition: lastUserIndex >= 0 ? lastUserIndex : nextHistory.length - 1,
  };
}

export async function prepareRemindedMessages(options: {
  history: ChatMessageParam[];
  requestMode: WorkMode;
  contextWindow: number;
  maxTokens: number;
  excludeLastMessage?: boolean;
  /** 用于上下文摘要的 API 参数（可选，未提供则跳过摘要） */
  modelConfig?: ModelConfig;
  apiKey?: string;
  temperature?: number;
}): Promise<ChatMessageParam[]> {
  const historyWindow = trimHistoryToFitContextWindow(options.history, {
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
  });

  let retainedHistory = historyWindow.retainedHistory;

  if (historyWindow.skippedCount > 0) {
    info(`上下文窗口截断：总窗口 ${historyWindow.contextWindow}，历史预算 ${historyWindow.historyTokenBudget}，跳过前 ${historyWindow.skippedCount} 条消息，保留 ${historyWindow.retainedCount} 条`);

    // 对被裁剪的早期消息生成 AI 摘要
    if (options.modelConfig && options.apiKey) {
      const summaryApiConfig = buildApiClientConfig({
        modelConfig: options.modelConfig,
        apiKey: options.apiKey,
        maxTokens: 500,
        temperature: options.temperature ?? 0.3,
      });
      const droppedMessages = options.history.slice(0, historyWindow.skippedCount);
      const summary = await summarizeDroppedMessages(droppedMessages, summaryApiConfig);
      if (summary) {
        retainedHistory = [
          { role: 'system', content: `[以下是之前对话的压缩摘要，共 ${historyWindow.skippedCount} 条消息]\n${summary}` },
          ...retainedHistory,
        ];
      }
    }
  }

  const historyForReminder = options.excludeLastMessage
    ? retainedHistory.slice(0, -1)
    : retainedHistory;
  const reminderResult = injectModeReminder(historyForReminder, options.requestMode);

  if (reminderResult.mismatchDetected) {
    info('注入模式变更提醒', {
      requestMode: options.requestMode,
      mismatchDetected: true,
      insertPosition: reminderResult.insertPosition,
    });
  }

  return reminderResult.history;
}
