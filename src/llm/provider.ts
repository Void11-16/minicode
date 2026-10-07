import type { PromptMessage } from "../core/message.ts";
import type { ToolCall } from "../core/message.ts";
import type { TokenUsage } from "../core/usage.ts";

/** 工具的 JSON Schema 参数定义（OpenAI Function Calling 格式）——LLM 协议类型 */
export type ToolParameters = Record<string, unknown>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
}

/** LLM 的一次响应：要么是文字，要么是工具调用请求 */
export type LLMResponse =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "tool_calls"; readonly toolCalls: readonly ToolCall[] };

/** 带用量信息的完整结果 */
export type LLMResult = LLMResponse & { readonly usage?: TokenUsage };

/** 所有 LLM 提供商的统一接口 */
export interface ChatProvider {
  readonly name: string;

  /**
   * 输入完整对话历史，返回一条 assistant 回复。
   * 实现方负责处理重试与错误抛出。
   */
  chat(history: readonly PromptMessage[]): Promise<string>;

  /**
   * 流式对话：每个增量片段通过 onDelta 回调，返回完整回复。
   * 可选实现 —— 不支持流式的 Provider 只实现 chat 即可，
   * 调用方（Agent）会自动降级。
   */
  chatStream?(
    history: readonly PromptMessage[],
    onDelta: (delta: string) => void,
  ): Promise<string>;

  /** 带工具的对话（Function Calling）。模型可返回工具调用请求。 */
  chatWithTools?(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResult>;

  /** 流式 + 工具：文本增量实时回调，同时支持流式 tool_calls（最终回答逐字输出） */
  chatStreamWithTools?(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResult>;
}
