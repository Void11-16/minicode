import { OpenAICompatProvider } from "./openai.ts";
import type { ChatProvider, LLMResult, ToolDefinition } from "./provider.ts";
import type { PromptMessage } from "../core/message.ts";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const DEEPSEEK_MODELS = {
  chat: "deepseek-chat",
  reasoner: "deepseek-reasoner",
} as const;

export interface DeepSeekOptions {
  readonly apiKey: string;
  /** 默认 deepseek-chat，可选 deepseek-reasoner（推理模型） */
  readonly model?: string;
  readonly systemPrompt?: string;
  /** 注入自定义 fetch（测试用） */
  readonly fetchFn?: typeof fetch;
}

/**
 * DeepSeek Provider —— 基于 OpenAI 兼容接口的薄封装。
 * 固定 base URL 与默认模型，避免调用方关心服务细节。
 */
export class DeepSeekProvider implements ChatProvider {
  private readonly inner: OpenAICompatProvider;
  readonly name: string;

  constructor(options: DeepSeekOptions) {
    const model = options.model ?? DEEPSEEK_MODELS.chat;
    this.inner = new OpenAICompatProvider({
      apiKey: options.apiKey,
      baseUrl: DEEPSEEK_BASE_URL,
      model,
      systemPrompt: options.systemPrompt,
      fetchFn: options.fetchFn,
    });
    this.name = `deepseek:${model}`;
  }

  chat(history: Parameters<ChatProvider["chat"]>[0]): Promise<string> {
    return this.inner.chat(history);
  }

  chatStream(
    history: readonly PromptMessage[],
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const stream = this.inner.chatStream;
    if (stream === undefined) {
      return this.chat(history);
    }
    return stream.call(this.inner, history, onDelta);
  }

  async chatWithTools(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    const withTools = this.inner.chatWithTools;
    if (withTools === undefined) {
      throw new Error("内部 Provider 不支持工具调用");
    }
    return await withTools.call(this.inner, history, tools, signal);
  }

  chatStreamWithTools(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    const stream = this.inner.chatStreamWithTools;
    if (stream === undefined) {
      return this.chatWithTools(history, tools, signal);
    }
    return stream.call(this.inner, history, tools, onTextDelta, signal);
  }
}
