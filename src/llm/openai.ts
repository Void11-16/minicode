import type { ChatProvider, LLMResult, ToolDefinition } from "./provider.ts";
import type { PromptMessage } from "../core/message.ts";
import type { ToolCall } from "../core/message.ts";
import type { TokenUsage } from "../core/usage.ts";

type FetchLike = typeof fetch;

interface ApiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: ApiUsage;
}

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** SSE 流式响应的单个 chunk */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ApiUsage;
}

/** LLM 请求超时：含工具的大对话可能较慢，但绝不能无限等待 */
const LLM_TIMEOUT_MS = 120_000;

export interface OpenAICompatOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 任何 OpenAI 兼容服务的 base URL，例如 https://api.openai.com/v1 */
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  /** 注入自定义 fetch（测试用），默认全局 fetch */
  readonly fetchFn?: FetchLike;
}

interface RequestOptions {
  readonly tools?: readonly ToolDefinition[];
  readonly stream?: boolean;
  readonly onTextDelta?: (delta: string) => void;
  /** 用户中断信号（/stop）；与超时信号合并 */
  readonly signal?: AbortSignal;
}

/** 请求统一结果：content 与 toolCalls 互斥（有工具调用时 content 可能为空） */
interface RequestResult {
  readonly content: string;
  readonly toolCalls: ToolCall[];
  readonly usage?: TokenUsage;
}

/**
 * OpenAI 兼容 Provider —— 适用于 OpenAI / DeepSeek / 本地 vLLM / Ollama 等
 * 所有暴露 /chat/completions 接口的服务。
 *
 * 四个公开方法（chat / chatWithTools / chatStream / chatStreamWithTools）
 * 全部委托给同一个 requestCore，请求构造/超时/错误处理只维护一份。
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly name: string;

  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly systemPrompt: string | undefined;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAICompatOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.systemPrompt = options.systemPrompt;
    this.fetchFn = options.fetchFn ?? fetch;
    this.name = `openai:${this.model}`;
  }

  async chat(history: readonly PromptMessage[]): Promise<string> {
    const result = await this.requestCore(history, {});
    if (result.content === "") {
      throw new Error("LLM 返回内容为空");
    }
    return result.content;
  }

  async chatWithTools(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    return this.toLLMResult(await this.requestCore(history, { tools, signal }));
  }

  async chatStream(
    history: readonly PromptMessage[],
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const result = await this.requestCore(history, { stream: true, onTextDelta: onDelta });
    if (result.content === "") {
      throw new Error("LLM 返回内容为空");
    }
    return result.content;
  }

  async chatStreamWithTools(
    history: readonly PromptMessage[],
    tools: readonly ToolDefinition[],
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    return this.toLLMResult(
      await this.requestCore(history, { tools, stream: true, onTextDelta: onTextDelta, signal }),
    );
  }

  private toLLMResult(result: RequestResult): LLMResult {
    if (result.toolCalls.length > 0) {
      return { type: "tool_calls", toolCalls: result.toolCalls, usage: result.usage };
    }
    if (result.content === "") {
      throw new Error("LLM 返回内容为空（既无文字也无工具调用）");
    }
    return { type: "text", content: result.content, usage: result.usage };
  }

  /** 唯一的请求入口：流式/非流式、带工具/不带工具全部在这处理 */
  private async requestCore(
    history: readonly PromptMessage[],
    options: RequestOptions,
  ): Promise<RequestResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(history),
    };
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    if (options.stream === true) {
      body.stream = true;
      // 让最后一个 chunk 携带 usage（OpenAI/DeepSeek 均支持）
      body.stream_options = { include_usage: true };
    }

    let response: Response;
    try {
      // 超时信号与用户中断信号合并：任一触发即中止
      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const signal = options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, options.signal]);
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`网络请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`LLM 返回 ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (options.stream === true) {
      return this.consumeStream(response, options.onTextDelta);
    }

    const data = (await response.json()) as ApiResponse;
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage: toTokenUsage(data.usage),
    };
  }

  /** 消费 SSE 流：同时累积文本增量与工具调用增量（按 index 分片拼接） */
  private async consumeStream(
    response: Response,
    onTextDelta: ((delta: string) => void) | undefined,
  ): Promise<RequestResult> {
    if (response.body === null) {
      throw new Error("LLM 未返回响应体");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: TokenUsage | undefined;
    // 工具调用按 index 累积：id/name 只出现一次，arguments 分片追加
    const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();

    const handleChunk = (chunk: StreamChunk) => {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
        content += delta.content;
        onTextDelta?.(delta.content);
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = toolCallAcc.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id !== undefined) entry.id = call.id;
        if (call.function?.name !== undefined && call.function.name !== "") {
          entry.name += call.function.name;
        }
        if (call.function?.arguments !== undefined) {
          entry.arguments += call.function.arguments;
        }
        toolCallAcc.set(index, entry);
      }
      // 注意：流式中间 chunk 的 usage 可能是 null（最后一个 chunk 才带真实值）
      if (chunk.usage != null) {
        usage = toTokenUsage(chunk.usage);
      }
    };

    for await (const raw of response.body) {
      buffer += decoder.decode(raw as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = this.parseSSELine(line);
        if (parsed !== undefined) handleChunk(parsed);
      }
    }
    // 结尾残留
    const tail = this.parseSSELine(buffer);
    if (tail !== undefined) handleChunk(tail);

    return {
      content,
      toolCalls: [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, entry]) => entry),
      usage,
    };
  }

  private buildMessages(
    history: readonly PromptMessage[],
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (this.systemPrompt !== undefined) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const message of history) {
      if (message.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId ?? "",
          content: message.content,
        });
      } else if (message.role === "assistant" && message.toolCalls !== undefined) {
        messages.push({
          role: "assistant",
          content: message.content === "" ? null : message.content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return messages;
  }

  /** 解析一行 SSE；返回 chunk；[DONE] 和无关行返回 undefined */
  private parseSSELine(line: string): StreamChunk | undefined {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("data:")) return undefined;

    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return undefined;

    try {
      return JSON.parse(payload) as StreamChunk;
    } catch {
      return undefined;
    }
  }
}

function toTokenUsage(raw: ApiUsage | undefined): TokenUsage | undefined {
  if (raw == null || raw.prompt_tokens === undefined || raw.completion_tokens === undefined) {
    return undefined;
  }
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens ?? raw.prompt_tokens + raw.completion_tokens,
    promptCacheHitTokens:
      raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens,
    promptCacheMissTokens: raw.prompt_cache_miss_tokens,
  };
}
