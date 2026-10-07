import type { Session } from "../core/session.ts";
import type { ChatProvider } from "../llm/provider.ts";
import type { ToolCall } from "../core/message.ts";
import type { ToolRegistry } from "../tools/tool.ts";

export interface AgentEvent {
  readonly type: "tool_start" | "tool_end" | "tool_error" | "tool_denied";
  readonly name: string;
  readonly arguments?: string;
  readonly output?: string;
  readonly error?: string;
}

export interface RunOptions {
  /** 工具调用最大轮数，防止模型无限循环，默认 5 */
  readonly maxToolRounds?: number;
  readonly onEvent?: (event: AgentEvent) => void;
  /** 权限确认回调：返回 true 允许执行。未提供时默认放行（非交互场景） */
  readonly onPermission?: PermissionHandler;
  /** 流式输出：模型最终回答（以及工具轮之间的文字）逐字回调 */
  readonly onTextDelta?: (delta: string) => void;
  /**
   * steer 支持：每轮 LLM 调用前调用一次，取走运行期间注入的用户消息。
   * 返回的消息会作为 user 消息追加进历史，模型在下一轮就能看到。
   */
  readonly takeSteeredMessages?: () => string[];
}

export interface PermissionRequest {
  readonly tool: string;
  readonly arguments: string;
  /** 给用户看的人类可读描述 */
  readonly message: string;
}

export type PermissionHandler = (request: PermissionRequest) => Promise<boolean>;

/** 用户主动中断当前轮（/stop）时抛出 */
export class TurnAbortedError extends Error {
  constructor() {
    super("已中断当前轮");
    this.name = "TurnAbortedError";
  }
}

/**
 * Agent —— 对话循环的编排层。
 * 现在它只做「追加用户消息 → 调 LLM → 追加回复」。
 * 将来工具调用、权限确认都在这里扩展，core/llm 层不用动。
 */
export class ChatAgent {
  private readonly sessionValue: Session;
  private readonly provider: ChatProvider;
  private readonly tools: ToolRegistry | undefined;
  /** 当前执行轮的中断控制器（/stop 用） */
  private currentController: AbortController | undefined;

  constructor(session: Session, provider: ChatProvider, tools?: ToolRegistry) {
    this.sessionValue = session;
    this.provider = provider;
    this.tools = tools;
  }

  get history() {
    return this.sessionValue.history;
  }

  get session(): Session {
    return this.sessionValue;
  }

  /** 中断当前正在执行的轮次（若在执行）；下一轮开始前或正在进行的请求会被中止 */
  abort(): void {
    this.currentController?.abort();
  }

  async send(userInput: string): Promise<string> {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      throw new Error("输入不能为空");
    }

    this.sessionValue.add("user", trimmed);
    const reply = await this.provider.chat(this.sessionValue.history);
    this.sessionValue.add("assistant", reply);
    return reply;
  }

  /**
   * 流式发送：支持流式的 Provider 逐块回调 onDelta，
   * 不支持的自动降级为一次性返回（onDelta 收到完整回复）。
   */
  async sendStream(
    userInput: string,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      throw new Error("输入不能为空");
    }

    this.sessionValue.add("user", trimmed);
    const history = this.sessionValue.history;

    let reply: string;
    if (this.provider.chatStream !== undefined) {
      reply = await this.provider.chatStream(history, onDelta);
    } else {
      reply = await this.provider.chat(history);
      onDelta(reply);
    }

    this.sessionValue.add("assistant", reply);
    return reply;
  }

  /** 是否具备工具调用能力（工具注册表 + Provider 支持缺一不可） */
  get supportsTools(): boolean {
    return this.tools !== undefined && this.tools.size > 0 && this.provider.chatWithTools !== undefined;
  }

  /**
   * 带工具的完整运行循环：
   *   user → LLM → [tool_calls → 执行 → 结果回传 → LLM ...] → 最终文字
   * Provider 不支持工具时自动降级为纯对话。
   */
  async run(userInput: string, options: RunOptions = {}): Promise<string> {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      throw new Error("输入不能为空");
    }

    // 能力一次性解析并自然收窄类型（循环内不再判空/断言）
    const tools = this.tools;
    const chatWithTools = this.provider.chatWithTools;
    if (tools === undefined || tools.size === 0 || chatWithTools === undefined) {
      return this.send(userInput); // 不支持工具 → 降级纯对话
    }

    const maxToolRounds = options.maxToolRounds ?? 5;
    const onEvent = options.onEvent;
    const definitions = tools.definitions();
    const streamWithTools = this.provider.chatStreamWithTools;

    const controller = new AbortController();
    this.currentController = controller;

    try {
      this.sessionValue.add("user", trimmed);

      for (let round = 0; round < maxToolRounds; round++) {
        if (controller.signal.aborted) throw new TurnAbortedError();

        // 排干 steer 注入的消息（在每次 LLM 调用前生效，模型可据此转向）
        const steered = options.takeSteeredMessages?.() ?? [];
        for (const message of steered) {
          this.sessionValue.add("user", message);
        }

        // 记录请求字符量，响应后用真实 prompt_tokens 校准估算系数
        const requestChars = this.sessionValue.history.reduce(
          (sum, message) => sum + message.content.length + 8,
          0,
        );

        // 优先流式（最终回答逐字输出），Provider 不支持时降级
        let result;
        try {
          if (streamWithTools !== undefined) {
            result = await streamWithTools.call(
              this.provider,
              this.sessionValue.history,
              definitions,
              options.onTextDelta ?? (() => {}),
              controller.signal,
            );
          } else {
            result = await chatWithTools.call(this.provider, this.sessionValue.history, definitions, controller.signal);
          }
        } catch (error) {
          // 中断信号导致的任何失败统一转为 TurnAbortedError
          if (controller.signal.aborted) throw new TurnAbortedError();
          throw error;
        }

        if (result.usage !== undefined) {
          this.sessionValue.addUsage(result.usage);
          // 只在历史足够长时校准：短会话中系统提示+工具定义的固定 token
          // 占主导，会把观测系数拉到严重失真（实测会冲到 clamp 上限）
          if (requestChars >= 3000) {
            this.sessionValue.calibrateTokens(result.usage.promptTokens, requestChars);
          }
        }

        if (result.type === "text") {
          this.sessionValue.add("assistant", result.content);
          return result.content;
        }

        // 模型请求调用工具：先记录请求，再逐个执行并回传结果
        this.sessionValue.add("assistant", "", { toolCalls: result.toolCalls });

        for (const call of result.toolCalls) {
          if (controller.signal.aborted) throw new TurnAbortedError();
          const allowed = await this.checkPermission(call, tools, options);
          if (!allowed) {
            this.sessionValue.add("tool", "用户拒绝授权执行此工具。请调整方案或改用其他方式。", {
              toolCallId: call.id,
              toolName: call.name,
            });
            options.onEvent?.({ type: "tool_denied", name: call.name });
            continue;
          }

          const output = await this.executeTool(call, tools, onEvent);
          this.sessionValue.add("tool", output, { toolCallId: call.id, toolName: call.name });
        }
      }
      throw new Error(`工具调用超过 ${maxToolRounds} 轮上限，模型未能给出最终回答`);
    } finally {
      this.currentController = undefined;
    }
  }

  private async checkPermission(
    call: ToolCall,
    tools: ToolRegistry,
    options: RunOptions,
  ): Promise<boolean> {
    const tool = tools.get(call.name);
    if (tool?.requiresConfirmation !== true) {
      return true;
    }
    if (options.onPermission === undefined) {
      // 非交互场景（脚本/测试）默认放行，由调用方决定是否传入回调
      return true;
    }

    let message = `执行工具 ${call.name}`;
    try {
      const args = JSON.parse(call.arguments === "" ? "{}" : call.arguments) as Record<string, unknown>;
      message = tool.confirmationMessage?.(args) ?? message;
    } catch {
      // 参数解析失败就用默认描述，具体错误由 execute 阶段处理
    }

    return options.onPermission({
      tool: call.name,
      arguments: call.arguments,
      message,
    });
  }

  private async executeTool(
    call: ToolCall,
    tools: ToolRegistry,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<string> {
    onEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });

    let output: string;
    try {
      output = await tools.execute(call.name, call.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: "tool_error", name: call.name, error: message });
      // 错误也回传给模型，让它有机会自行调整参数重试
      output = `工具执行失败: ${message}`;
      return output;
    }

    onEvent?.({ type: "tool_end", name: call.name, output });
    return output;
  }
}
