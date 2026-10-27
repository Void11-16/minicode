import { setTimeout as sleep } from "node:timers/promises";
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

/** 建连超时与流式空闲超时：活跃的长回答不按总时长截断，静默卡死仍会退出 */
const LLM_TIMEOUT_MS = 120_000;
/** DeepSeek/代理偶发复用连接失败；有限重试可恢复，但不能无限重发产生费用 */
const LLM_MAX_ATTEMPTS = 3;
const LLM_MAX_STREAM_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 400;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class ReplaySafeStreamError extends Error {
  readonly replaySafe: boolean;

  constructor(message: string, replaySafe: boolean) {
    super(message);
    this.replaySafe = replaySafe;
  }
}

export interface OpenAICompatOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 任何 OpenAI 兼容服务的 base URL，例如 https://api.openai.com/v1 */
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  /** 注入自定义 fetch（测试用），默认全局 fetch */
  readonly fetchFn?: FetchLike;
  /** 网络重试退避基数（测试用；默认 400ms） */
  readonly retryDelayMs?: number;
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
  private readonly retryDelayMs: number;

  constructor(options: OpenAICompatOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.systemPrompt = options.systemPrompt;
    this.fetchFn = options.fetchFn ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? LLM_RETRY_BASE_DELAY_MS;
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

    if (options.stream === true) {
      try {
        return await this.consumeStreamWithRetry(body, options);
      } catch (error) {
        // 所有流式尝试都在尚未输出正文时失败，可安全改走非流式请求。
        if (
          !(error instanceof ReplaySafeStreamError) ||
          !error.replaySafe ||
          options.signal?.aborted === true
        ) {
          throw error;
        }
        const fallback = await this.requestCore(history, {
          ...(options.tools === undefined ? {} : { tools: options.tools }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (fallback.toolCalls.length === 0 && fallback.content !== "") {
          options.onTextDelta?.(fallback.content);
        }
        return fallback;
      }
    }

    const response = await this.requestWithRetry(body, options.signal);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`LLM 返回 ${response.status}: ${errorBody.slice(0, 500)}`);
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

  /**
   * 连接建立阶段失败或可恢复 HTTP 状态最多尝试 3 次。
   * 流开始后的中断不在这里重试，避免把已经展示给用户的半段文本再发一遍。
   */
  private async requestWithRetry(
    body: Record<string, unknown>,
    userSignal: AbortSignal | undefined,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt += 1) {
      try {
        // 不复用连接：Node 的 keep-alive 连接在与部分代理/API 网关组合时会偶发 ETIMEDOUT。
        const timeoutController = new AbortController();
        const timeout = globalThis.setTimeout(() => timeoutController.abort(), LLM_TIMEOUT_MS);
        timeout.unref();
        const signal = userSignal === undefined
          ? timeoutController.signal
          : AbortSignal.any([timeoutController.signal, userSignal]);
        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
              Connection: "close",
            },
            body: JSON.stringify(body),
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!RETRYABLE_STATUS.has(response.status) || attempt === LLM_MAX_ATTEMPTS) return response;
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        await sleep(retryDelayMs(response, attempt, this.retryDelayMs));
      } catch (error) {
        lastError = error;
        if (userSignal?.aborted === true || attempt === LLM_MAX_ATTEMPTS) break;
        await sleep(this.retryDelayMs * attempt);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`网络请求失败（已尝试 ${LLM_MAX_ATTEMPTS} 次）: ${reason}`);
  }

  /**
   * 流式请求建立后也可能被代理或网关中断。
   * 在还没有任何文本展示给用户时，可安全重发整个模型请求；一旦开始输出则不能重放，
   * 否则聊天中会出现重复的半段回答。
   */
  private async consumeStreamWithRetry(
    body: Record<string, unknown>,
    options: RequestOptions,
  ): Promise<RequestResult> {
    let lastError: unknown;
    let replaySafe = true;
    for (let attempt = 1; attempt <= LLM_MAX_STREAM_ATTEMPTS; attempt += 1) {
      const response = await this.requestWithRetry(body, options.signal);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`LLM 返回 ${response.status}: ${errorBody.slice(0, 500)}`);
      }
      let textEmitted = false;
      try {
        return await this.consumeStream(response, (delta) => {
          textEmitted = true;
          options.onTextDelta?.(delta);
        });
      } catch (error) {
        lastError = error;
        if (textEmitted) replaySafe = false;
        if (textEmitted || options.signal?.aborted === true || attempt === LLM_MAX_STREAM_ATTEMPTS) break;
        await sleep(this.retryDelayMs * attempt);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ReplaySafeStreamError(`网络请求失败（流式响应中断）: ${reason}`, replaySafe);
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

    const reader = response.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readStreamChunk(reader, LLM_TIMEOUT_MS);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
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
    // OpenAI 兼容协议要求 tool 消息必须逐一回应前面 assistant 的 tool_calls；
    // 历史压缩、会话中断都可能留下孤儿 tool 或未回应的 tool_calls，原样发送会被 API 以
    // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" 拒绝。
    // 统一修复：孤儿 tool 丢弃；未回应的 tool_calls 补占位结果，保证消息配对合法。
    const pending = new Set<string>();
    const flushPending = () => {
      for (const id of pending) {
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: "（该工具调用的结果缺失：会话中断或历史已压缩）",
        });
      }
      pending.clear();
    };
    for (const message of history) {
      if (message.role === "tool") {
        if (message.toolCallId !== undefined && pending.has(message.toolCallId)) {
          pending.delete(message.toolCallId);
          messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
        }
        continue;
      }
      flushPending();
      if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: message.content === "" ? null : message.content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of message.toolCalls) pending.add(call.id);
        continue;
      }
      messages.push({ role: message.role, content: message.content });
    }
    flushPending();
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

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5_000);
  return baseDelayMs * attempt;
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(
      () => reject(new Error(`流式响应超过 ${idleTimeoutMs / 1000} 秒无新数据`)),
      idleTimeoutMs,
    );
    timeout.unref();
  });
  return Promise.race([reader.read(), idle]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
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
