import type { Session } from "../core/session.ts";
import type { ChatProvider } from "../llm/provider.ts";
import type { PromptMessage, ToolCall } from "../core/message.ts";
import type { ToolContext, ToolRegistry } from "../tools/tool.ts";
import { debugLog } from "../util/logger.ts";

export interface AgentEvent {
  readonly type: "tool_start" | "tool_end" | "tool_error" | "tool_denied";
  readonly name: string;
  readonly arguments?: string;
  readonly output?: string;
  readonly error?: string;
}

export interface RunOptions {
  /**
   * 工具调用最大轮数，防止模型无限循环，默认 5。
   * 传函数时每轮重新取值：宿主可以按行程天数等动态调高预算。
   */
  readonly maxToolRounds?: number | (() => number);
  /**
   * 轮次预算用尽时的续期钩子：返回 true 表示宿主提高了 maxToolRounds，
   * 循环继续跑下去；返回 false（或不提供）则进入收尾。
   * 宿主要负责封顶；Agent 另有 BUDGET_EXTENSION_LIMIT 次续期硬上限防死循环。
   */
  readonly onBudgetExhausted?: (limit: number) => boolean | Promise<boolean>;
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

  /**
   * 持久化检查点：在安全边界调用（用户消息入库后、每批工具结果写完后、最终回答写入后）。
   * 崩溃时最多丢失进行中的半步，而不是整轮。回调失败不打断对话（只记调试日志）。
   */
  readonly onCheckpoint?: () => void | Promise<void>;
}

export interface PermissionRequest {
  readonly tool: string;
  readonly arguments: string;
  /** 给用户看的人类可读描述 */
  readonly message: string;
}

export type PermissionHandler = (request: PermissionRequest) => Promise<boolean>;

/** 剩余轮数少于该值时，每次请求注入收尾提醒（不写入会话历史） */
const WRAP_UP_HINT_ROUNDS = 3;

/** 单轮内最多接受几次预算续期：宿主钩子故障（一直返回 true）也不会空转 */
const BUDGET_EXTENSION_LIMIT = 10;

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
  /** 装配默认工作区（会话未单独指定时用）；文件类工具与 bash 以此为根 */
  private readonly defaultWorkspace: string;
  /** 当前执行轮的中断控制器（/stop 用） */
  private currentController: AbortController | undefined;

  constructor(session: Session, provider: ChatProvider, tools?: ToolRegistry, defaultWorkspace: string = process.cwd()) {
    this.sessionValue = session;
    this.provider = provider;
    this.tools = tools;
    this.defaultWorkspace = defaultWorkspace;
  }

  /** 本 agent 当前生效的工作区：会话指定 > 装配默认 */
  get workspace(): string {
    return this.sessionValue.workspace ?? this.defaultWorkspace;
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
      // 不支持工具 → 降级纯对话
      const reply = await this.send(userInput);
      await this.checkpoint(options);
      return reply;
    }

    // 预算可以按轮动态读取（宿主按行程天数调整），也可以中途续期
    const roundLimit = (): number =>
      typeof options.maxToolRounds === "function" ? options.maxToolRounds() : options.maxToolRounds ?? 5;
    const onEvent = options.onEvent;
    const definitions = tools.definitions();
    const streamWithTools = this.provider.chatStreamWithTools;

    const controller = new AbortController();
    this.currentController = controller;

    try {
      this.sessionValue.add("user", trimmed);
      await this.checkpoint(options);

      // executed = 已执行的轮数（续期的检查本身不占轮次，否则续期一次只能多跑一轮）
      let executed = 0;
      let extensions = 0;
      for (;;) {
        const limit = roundLimit();
        if (executed >= limit) {
          // 预算用尽：先问宿主能否续期（例如按行程天数放宽），不能续期才收尾
          if (extensions >= BUDGET_EXTENSION_LIMIT) break;
          const extended = await budgetExtension(options, limit);
          if (!extended) break;
          extensions += 1;
          continue;
        }
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

        // 剩余轮数不足时注入收尾提醒（仅本次请求可见，不进入会话历史，避免污染后续轮次）
        const remaining = limit - executed - 1;
        const requestHistory = remaining < WRAP_UP_HINT_ROUNDS
          ? [...this.sessionValue.history, wrapUpHint(remaining)]
          : this.sessionValue.history;

        // 优先流式（最终回答逐字输出），Provider 不支持时降级
        let result;
        try {
          if (streamWithTools !== undefined) {
            result = await streamWithTools.call(
              this.provider,
              requestHistory,
              definitions,
              options.onTextDelta ?? (() => {}),
              controller.signal,
            );
          } else {
            result = await chatWithTools.call(this.provider, requestHistory, definitions, controller.signal);
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
          await this.checkpoint(options);
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

          const output = await this.executeTool(call, tools, { workspace: this.workspace, signal: controller.signal }, onEvent);
          this.sessionValue.add("tool", output, { toolCallId: call.id, toolName: call.name });
        }
        // 一批工具结果全部回填完毕 = 历史一致的安全边界，落盘
        await this.checkpoint(options);
        executed += 1;
      }
      // 轮次用尽：再做一次"禁用工具"的收尾请求，保证用户拿到最终产出而不是硬报错
      const wrapUp = await this.forceFinalAnswer(options.onTextDelta);
      if (wrapUp !== undefined && wrapUp.trim() !== "") {
        if (controller.signal.aborted) throw new TurnAbortedError();
        this.sessionValue.add("assistant", wrapUp);
        await this.checkpoint(options);
        return wrapUp;
      }
      throw new Error(`工具调用超过 ${roundLimit()} 轮上限，模型未能给出最终回答`);
    } finally {
      this.currentController = undefined;
    }
  }

  /** 安全边界快照：落盘失败只是丢快照，不该打断对话 */
  private async checkpoint(options: RunOptions): Promise<void> {
    if (options.onCheckpoint === undefined) return;
    try {
      await options.onCheckpoint();
    } catch (error) {
      debugLog("agent", `checkpoint 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 收尾兜底：工具已被禁用，要求模型基于已有信息直接给出最终回答。
   * 失败（网络/脚本耗尽）返回 undefined，由调用方回落到原始报错。
   */
  private async forceFinalAnswer(onTextDelta?: (delta: string) => void): Promise<string | undefined> {
    const instruction: PromptMessage = {
      role: "system",
      content:
        "工具调用轮次已全部用尽，工具已被禁用。请基于以上已获得的信息直接给出最终回答：" +
        "保留关键结论与数据；未查到的部分明确说明，不要再请求调用工具。" +
        "如果本轮还有没做完的收尾动作（如某天还没保存、质量校验还没通过），必须如实说明做到哪一步，" +
        "并给用户一句可操作的下一步（例如回复「继续」接着修），不要声称已完成或已通过校验。",
    };
    const history = [...this.sessionValue.history, instruction];
    try {
      if (this.provider.chatStream !== undefined) {
        return await this.provider.chatStream.call(this.provider, history, onTextDelta ?? (() => {}));
      }
      return await this.provider.chat(history);
    } catch {
      return undefined;
    }
  }

  private async checkPermission(
    call: ToolCall,
    tools: ToolRegistry,
    options: RunOptions,
  ): Promise<boolean> {
    const tool = tools.get(call.name);
    if (tool === undefined) return true;

    // 参数先解析（动态确认与确认文案共用；解析失败交给 execute 阶段报错）
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments === "" ? "{}" : call.arguments) as Record<string, unknown>;
    } catch {
      // ignore —— 参数非法时按静态标记处理
    }

    const needsConfirm = tool.needsConfirmation !== undefined
      ? tool.needsConfirmation(args)
      : tool.requiresConfirmation === true;
    if (!needsConfirm) return true;
    if (options.onPermission === undefined) {
      // 非交互场景（脚本/测试）默认放行，由调用方决定是否传入回调
      return true;
    }

    const message = tool.confirmationMessage?.(args) ?? `执行工具 ${call.name}`;
    return options.onPermission({
      tool: call.name,
      arguments: call.arguments,
      message,
    });
  }

  private async executeTool(
    call: ToolCall,
    tools: ToolRegistry,
    ctx: ToolContext,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<string> {
    onEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });

    let output: string;
    try {
      output = await tools.execute(call.name, call.arguments, ctx);
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

/** 剩余轮数不足时的收尾提醒（作为请求尾部的临时 system 消息，不写入会话历史） */
function wrapUpHint(remaining: number): PromptMessage {
  const budget = remaining === 0
    ? "这是本轮最后一次工具调用机会"
    : `本轮之后还剩 ${remaining} 轮工具调用预算`;
  return {
    role: "system",
    content:
      `【轮次提醒】${budget}。请避免重复查询，优先补齐关键信息并尽快收敛；` +
      "如果现有数据已足够，请立即用文字给出最终回答。",
  };
}

/** 询问宿主能否续期预算：宿主回调出错按"不许续期"处理，不能因此让整轮失败 */
async function budgetExtension(options: RunOptions, limit: number): Promise<boolean> {
  try {
    return (await options.onBudgetExhausted?.(limit)) === true;
  } catch (error) {
    debugLog("agent", `预算续期回调失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
