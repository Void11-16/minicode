import type { Session } from "../core/session.ts";
import type { ChatProvider } from "../llm/provider.ts";
import { isCompactedToolArguments, type PromptMessage, type ToolCall } from "../core/message.ts";
import { renderMarkdown } from "../tools/itinerary.ts";
import { renderQualityReport } from "../tools/itinerary-validator.ts";
import { evidenceId } from "../tools/travel-evidence.ts";
import type { ItinerarySnapshot, ToolContext, ToolRegistry } from "../tools/tool.ts";
import { debugLog } from "../util/logger.ts";
import {
  activateToolForUse,
  activeToolNames,
  executeToolCatalog,
  isActivationTool,
  isAlwaysActiveTool,
  MAX_ACTIVE_TOOLS,
  toolLoadingGuide,
  TOOL_ACTIVATION_DEFINITIONS,
} from "../tools/activation.ts";
import {
  renderTravelState,
  type TravelState,
  updateTravelStateFromBrief,
  updateTravelStateFromItinerary,
  updateTravelStateFromItineraryJson,
  updateTravelStateFromQuality,
  updateTravelStateFromSnapshot,
} from "../core/travel-state.ts";
import { compactToolResults, type ToolResultForContext } from "./tool-output.ts";

export interface AgentEvent {
  readonly type: "tool_start" | "tool_end" | "tool_error" | "tool_denied";
  readonly name: string;
  readonly arguments?: string;
  readonly output?: string;
  readonly error?: string;
}

export interface CumulativeToolBudget {
  rounds: number;
  calls: number;
  tokens: number;
  stagnantRounds?: number;
  blockedReason?: string;
  readonly maxRounds: number;
  readonly maxCalls: number;
  readonly maxTokens?: number;
  /** Host may impose a monetary cap from actual usage and configured prices. */
  readonly costExceeded?: () => boolean;
}

export interface RunOptions {
  /** Reuse the same object across automatic recovery turns; counters never reset. */
  readonly cumulativeBudget?: CumulativeToolBudget;
  /**
   * 工具调用最大轮数，防止模型无限循环，默认 5。
   * 传函数时每轮重新取值：宿主可以按行程天数等动态调高预算。
   */
  readonly maxToolRounds?: number | (() => number | Promise<number>);
  /**
   * 轮次预算用尽时的续期钩子：返回 true/continue 表示宿主提高了 maxToolRounds，
   * 循环继续跑下去；返回 false（或不提供）则进入收尾。
   * guidance 会在续期后作为临时 system 消息注入，不会写入会话历史。
   * 宿主要负责封顶；Agent 另有 BUDGET_EXTENSION_LIMIT 次续期硬上限防死循环。
   */
  readonly onBudgetExhausted?: (limit: number) =>
    | boolean
    | BudgetExhaustedDecision
    | Promise<boolean | BudgetExhaustedDecision>;
  /** 每批工具结果回填后回调一次；用于区分"模型工具轮数"与单轮里的工具调用次数 */
  readonly onToolRound?: (info: {
    readonly round: number;
    readonly limit: number;
    readonly toolCalls: number;
  }) => void;
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

export interface BudgetExhaustedDecision {
  readonly continue: boolean;
  /** continue 时注入后续请求；停止时附加到收尾请求 */
  readonly guidance?: string;
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

/**
 * 单轮内最多接受几次预算续期：宿主钩子故障（一直返回 true）也不会空转。
 * 运行时按 150 轮硬上限、每次至少 +15 轮，最多只会走到 10 次；这里留出余量，
 * 保证最后一次追加后仍会把“已达硬上限”交给宿主解释。
 */
const BUDGET_EXTENSION_LIMIT = 20;

/** 相同工具错误连续出现后注入恢复提示，再连续出现则熔断当前工具循环 */
const REPEATED_FAILURE_GUIDANCE_AT = 2;
const REPEATED_FAILURE_CIRCUIT_AT = 5;

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
  /** 本次 run 是否已经保存过需求单；用于阻断同一请求内换标题重复落盘 */
  private briefSavedThisRun = false;
  private committedSnapshot?: ItinerarySnapshot;
  private savedThisRun = false;
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
    const reply = await this.provider.chat(this.sessionValue.toPrompt());
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
    const history = this.sessionValue.toPrompt();

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
    this.briefSavedThisRun = false;
    this.committedSnapshot = undefined;
    this.savedThisRun = false;
    const cumulative = options.cumulativeBudget ?? { rounds: 0, calls: 0, tokens: 0, maxRounds: 150, maxCalls: 300 };
    const exhausted = () => cumulative.rounds >= cumulative.maxRounds || cumulative.calls >= cumulative.maxCalls || (cumulative.maxTokens !== undefined && cumulative.tokens >= cumulative.maxTokens) || cumulative.costExceeded?.() === true;

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
    const roundLimit = async (): Promise<number> =>
      typeof options.maxToolRounds === "function" ? await options.maxToolRounds() : options.maxToolRounds ?? 5;
    const onEvent = options.onEvent;
    const streamWithTools = this.provider.chatStreamWithTools;

    const controller = new AbortController();
    this.currentController = controller;

    try {
      this.sessionValue.add("user", trimmed);
      await this.checkpoint(options);

      // executed = 已执行的轮数（续期的检查本身不占轮次，否则续期一次只能多跑一轮）
      let executed = 0;
      let extensions = 0;
      let budgetGuidance: string | undefined;
      let failureGuidance: string | undefined;
      let failureKey = "";
      let failureCount = 0;
      let circuitOpen = false;
      let stagnantRounds = cumulative.stagnantRounds ?? 0;
      await tools.evidence.load();
      const progress = () => evidenceId([tools.evidence.fingerprint, this.sessionValue.travelState?.brief,
        this.committedSnapshot?.itinerary.days]);
      let lastProgress = progress();
      for (;;) {
        if (cumulative.blockedReason !== undefined) { failureGuidance = cumulative.blockedReason; circuitOpen = true; break; }
        if (exhausted() || (cumulative.stagnantRounds ?? 0) >= 12) { budgetGuidance = "已达到本次任务累计轮次、调用、token 或费用上限；自动续跑不会重置预算。"; break; }
        const limit = await roundLimit();
        if (executed >= limit) {
          // 预算用尽：先问宿主能否续期（例如按行程天数放宽），不能续期才收尾
          if (extensions >= BUDGET_EXTENSION_LIMIT) break;
          const decision = await budgetExtension(options, limit);
          if (!decision.continue) {
            budgetGuidance = decision.guidance;
            break;
          }
          extensions += 1;
          budgetGuidance = decision.guidance;
          continue;
        }
        if (controller.signal.aborted) throw new TurnAbortedError();

        // 排干 steer 注入的消息（在每次 LLM 调用前生效，模型可据此转向）
        const steered = options.takeSteeredMessages?.() ?? [];
        for (const message of steered) {
          this.sessionValue.add("user", message);
        }

        // 剩余轮数不足时注入收尾提醒（仅本次请求可见，不进入会话历史，避免污染后续轮次）
        const remaining = limit - executed - 1;
        const loadingGuide = toolLoadingGuide(tools, this.sessionValue);
        const artifactGuide = renderArtifactGuide(this.sessionValue);
        const travelState = renderTravelState(this.sessionValue.travelState);
        const draftGate = shouldForceDraft(this.sessionValue.travelState, executed);
        const travelProgress = travelProgressGuidance(draftGate);
        const evidence = this.sessionValue.travelState?.brief === undefined ? "" : tools.evidence.summary(this.sessionValue.travelState.brief.destination, this.sessionValue.travelState.places.map((place) => place.name));
        const transientMessages = [
          ...(evidence === "" ? [] : [{ role: "system" as const, content: evidence }]),
          ...(loadingGuide === undefined
            ? []
            : [{ role: "system" as const, content: loadingGuide } satisfies PromptMessage]),
          ...(artifactGuide === undefined
            ? []
            : [{ role: "system" as const, content: artifactGuide } satisfies PromptMessage]),
          ...(travelState === undefined
            ? []
            : [{ role: "system" as const, content: travelState } satisfies PromptMessage]),
          ...(travelProgress === undefined
            ? []
            : [{ role: "system" as const, content: travelProgress } satisfies PromptMessage]),
          ...(failureGuidance === undefined
            ? []
            : [{ role: "system" as const, content: failureGuidance } satisfies PromptMessage]),
          ...(budgetGuidance === undefined
            ? []
            : [{ role: "system" as const, content: budgetGuidance } satisfies PromptMessage]),
          ...(remaining < WRAP_UP_HINT_ROUNDS ? [wrapUpHint(remaining)] : []),
        ];
        const history = this.sessionValue.toPrompt();
        const requestHistory = transientMessages.length === 0
          ? history
          : [...history, ...transientMessages];
        // 记录真实请求字符量（含 tool_calls 参数与临时提示），响应后校准估算系数
        const requestChars = this.sessionValue.promptCharCount(requestHistory);
        const requestTools = this.requestToolDefinitions(tools, draftGate);

        // 优先流式（最终回答逐字输出），Provider 不支持时降级
        let result;
        try {
          if (streamWithTools !== undefined) {
            result = await streamWithTools.call(
              this.provider,
              requestHistory,
              requestTools,
              this.sessionValue.travelState?.brief === undefined && !this.savedThisRun ? options.onTextDelta ?? (() => {}) : () => {},
              controller.signal,
            );
          } else {
            result = await chatWithTools.call(this.provider, requestHistory, requestTools, controller.signal);
          }
        } catch (error) {
          // 中断信号导致的任何失败统一转为 TurnAbortedError
          if (controller.signal.aborted) throw new TurnAbortedError();
          throw error;
        }

        if (result.usage !== undefined) {
          this.sessionValue.addUsage(result.usage);
          cumulative.tokens += result.usage.totalTokens;
          // 只在历史足够长时校准：短会话中系统提示+工具定义的固定 token
          // 占主导，会把观测系数拉到严重失真（实测会冲到 clamp 上限）
          if (requestChars >= 3000) {
            this.sessionValue.calibrateTokens(result.usage.promptTokens, requestChars);
          }
        }

        if (result.type === "text") {
          const reply = this.canonicalReply() ?? result.content;
          if (this.sessionValue.travelState?.brief !== undefined || this.canonicalReply() !== undefined) options.onTextDelta?.(reply);
          this.sessionValue.add("assistant", reply);
          await this.checkpoint(options);
          return reply;
        }

        // 模型请求调用工具：先记录请求，再逐个执行并回传结果
        this.sessionValue.add("assistant", "", { toolCalls: result.toolCalls });

        const pendingResults: ToolResultForContext[] = [];
        for (const call of result.toolCalls) {
          if (controller.signal.aborted) throw new TurnAbortedError();
          if (call.name === "save_travel_brief" && this.briefSavedThisRun) {
            const title = this.sessionValue.travelState?.brief?.title ?? "当前";
            const output =
              `需求单「${title}」已在本次用户请求中保存，本次重复保存已忽略。` +
              "请沿用该标题直接检索候选并保存第 1 天行程；用户提交新的修改要求时才更新需求单。";
            pendingResults.push({
              callId: call.id,
              toolName: call.name,
              output,
              outputKind: tools.get(call.name)?.outputKind,
            });
            options.onEvent?.({ type: "tool_end", name: call.name, output });
            failureKey = "";
            failureCount = 0;
            if (!circuitOpen) failureGuidance = undefined;
            continue;
          }
          if (cumulative.calls >= cumulative.maxCalls || cumulative.costExceeded?.() === true || (cumulative.maxTokens !== undefined && cumulative.tokens >= cumulative.maxTokens)) {
            pendingResults.push({ callId: call.id, toolName: call.name, output: "已达到累计工具或费用上限，本次调用未执行。" });
            continue;
          }
          const allowed = await this.checkPermission(call, tools, options);
          if (!allowed) {
            pendingResults.push({
              callId: call.id,
              toolName: call.name,
              output: "用户拒绝授权执行此工具。请调整方案或改用其他方式。",
            });
            options.onEvent?.({ type: "tool_denied", name: call.name });
            continue;
          }

          let snapshotReceived = false;
          cumulative.calls += 1;
          const execution = await this.executeTool(
            call,
            tools,
            { workspace: this.workspace, signal: controller.signal,
              destination: this.sessionValue.travelState?.brief?.destination,
              brief: this.sessionValue.travelState?.brief,
              onItinerary: (snapshot) => {
                snapshotReceived = true;
                this.committedSnapshot = snapshot;
                if (call.name === "save_itinerary") this.savedThisRun = true;
                this.sessionValue.setTravelState(updateTravelStateFromSnapshot(this.sessionValue.travelState, snapshot));
              },
            },
            onEvent,
          );
          let output = execution.output;
          if (execution.error === undefined) {
            failureKey = "";
            failureCount = 0;
            failureGuidance = undefined;
          } else {
            const key = toolFailureKey(call.name, execution.error);
            failureCount = key === failureKey ? failureCount + 1 : 1;
            failureKey = key;
            if (failureCount >= REPEATED_FAILURE_GUIDANCE_AT) {
              output += repeatedFailureHint(failureCount);
              failureGuidance = repeatedFailureGuidance(call.name, execution.error, failureCount);
            }
            circuitOpen = circuitOpen || failureCount >= REPEATED_FAILURE_CIRCUIT_AT;
            if (this.sessionValue.travelState?.brief !== undefined && /日调用量超限|日配额已用完|DAILY_QUERY_OVER_LIMIT|INVALID_USER_KEY|\[(?:10001|10003|10019|10044)\]/.test(execution.error)) {
              circuitOpen = true;
              failureGuidance = "地图数据服务的日配额或密钥阻止了取证，已停止重复请求。当前版本未完成，需服务恢复后复验；不能用估算冒充已核实数据。";
              cumulative.blockedReason = failureGuidance;
            }
          }
          if (!snapshotReceived) recordTravelToolResult(this.sessionValue, call, output, execution.error);
          pendingResults.push({
            callId: call.id,
            toolName: call.name,
            output,
            ...(execution.error === undefined ? {} : { error: execution.error }),
            ...(tools.get(call.name)?.outputKind === undefined
              ? {}
              : { outputKind: tools.get(call.name)?.outputKind }),
          });
        }
        const compactedResults = await compactToolResults(pendingResults, {
          workspace: this.workspace,
          sessionId: this.sessionValue.id,
        });
        for (const item of compactedResults) {
          this.sessionValue.add("tool", item.text, {
            toolCallId: item.callId,
            toolName: pendingResults.find((result) => result.callId === item.callId)?.toolName,
          });
        }
        // 工具结果已回填，调用参数不再需要完整重复发送。长行程会在同一用户轮次里
        // 跑很多次模型请求，必须在这里瘦身，而不能等到下一次用户发言才做 Epoch 压缩。
        this.sessionValue.compactCompletedToolCalls(undefined, this.sessionValue.travelState?.brief === undefined ? 1 : 3);
        // 一批工具结果全部回填完毕 = 历史一致的安全边界，落盘
        await this.checkpoint(options);
        executed += 1;
        cumulative.rounds += 1;
        if (this.sessionValue.travelState?.brief !== undefined) {
          const signature = progress();
          stagnantRounds = signature === lastProgress ? stagnantRounds + 1 : 0;
          lastProgress = signature;
          cumulative.stagnantRounds = stagnantRounds;
          if (stagnantRounds >= 6) failureGuidance = "连续多轮未增加地点/路线证据或保存内容。请复用已核验候选，保存缺失日期或按质量报告修订；不要重复读取需求单或改词重搜相同候选。";
          if (stagnantRounds >= 12) { circuitOpen = true; failureGuidance = "连续 12 轮无实际进展，已停止调用；已保存版本仍有缺口时必须明确列出。"; }
        }
        options.onToolRound?.({ round: executed, limit, toolCalls: result.toolCalls.length });
        if (circuitOpen) break;
      }
      // 轮次用尽：再做一次"禁用工具"的收尾请求，保证用户拿到最终产出而不是硬报错
      const canonical = this.canonicalReply(false);
      if (canonical !== undefined || exhausted() || stagnantRounds >= 12 || (circuitOpen && this.sessionValue.travelState?.brief !== undefined)) {
        const reply = [failureGuidance, canonical ?? (circuitOpen ? "本次规划未完成，尚未保存可交付的行程。" : "本次规划尚未保存可交付的行程，累计预算已用尽。")].filter(Boolean).join("\n\n");
        options.onTextDelta?.(reply);
        this.sessionValue.add("assistant", reply);
        await this.checkpoint(options);
        return reply;
      }
      const wrapUp = await this.forceFinalAnswer(
        options.onTextDelta,
        [budgetGuidance, failureGuidance].filter((value) => value !== undefined).join("\n\n"),
        circuitOpen
          ? "检测到同一工具错误连续重复，已熔断工具调用"
          : "工具调用轮次已全部用尽",
      );
      if (wrapUp !== undefined && wrapUp.trim() !== "") {
        if (controller.signal.aborted) throw new TurnAbortedError();
        this.sessionValue.add("assistant", wrapUp);
        await this.checkpoint(options);
        return wrapUp;
      }
      throw new Error(`工具调用超过 ${await roundLimit()} 轮上限，模型未能给出最终回答`);
    } finally {
      this.currentController = undefined;
    }
  }

  private canonicalReply(requireSave = true): string | undefined {
    if ((requireSave && !this.savedThisRun) || this.committedSnapshot === undefined) return undefined;
    const { itinerary, report, file } = this.committedSnapshot;
    const passed = report.issue_count.P0 === 0 && report.issue_count.P1 === 0;
    return [
      `已保存「${itinerary.title}」v${itinerary.revision ?? 1}，${itinerary.days.length} 天 / ${itinerary.days.reduce((sum, day) => sum + day.items.length, 0)} 项。strict ${passed ? "通过" : "未通过，当前版本尚未通过 strict 校验，以下为待修订版本"}。`,
      `[行程文件](${file}) · [质量报告](${file.slice(0, -5)}.quality.md)`,
      renderMarkdown(itinerary),
      ...(passed ? [] : [renderQualityReport(report)]),
    ].join("\n\n");
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
  private async forceFinalAnswer(
    onTextDelta?: (delta: string) => void,
    guidance?: string,
    reason: string = "工具调用轮次已全部用尽",
  ): Promise<string | undefined> {
    const instruction: PromptMessage = {
      role: "system",
      content:
        `${reason}，工具已被禁用。请基于以上已获得的信息直接给出最终回答：` +
        "保留关键结论与数据；未查到的部分明确说明，不要再请求调用工具。" +
        "如果本轮还有没做完的收尾动作（如某天还没保存、质量校验还没通过），必须如实说明做到哪一步，" +
        "并给用户一句可操作的下一步（例如回复「继续」接着修），不要声称已完成或已通过校验。" +
        (guidance === undefined ? "" : `\n\n${guidance}`),
    };
    const history = [...this.sessionValue.toPrompt(), instruction];
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
    // 压缩占位符会在执行层明确拒绝；不要为它弹出一次无意义的权限确认
    if (isCompactedToolArguments(call.arguments)) return true;
    if (isActivationTool(call.name)) return true;
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
  ): Promise<{ readonly output: string; readonly error?: string }> {
    onEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });

    try {
      const output = isActivationTool(call.name)
        ? executeToolCatalog(
            call.name,
            parseToolArguments(call.arguments),
            tools,
            this.sessionValue,
          )
        : await this.executeRegisteredTool(call, tools, ctx);
      onEvent?.({ type: "tool_end", name: call.name, output });
      return { output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: "tool_error", name: call.name, error: message });
      // 错误也回传给模型，让它有机会自行调整参数重试
      return { output: `工具执行失败: ${message}`, error: message };
    }
  }

  private requestToolDefinitions(tools: ToolRegistry, _draftGate: boolean) {
    const active = activeToolNames(tools, this.sessionValue);
    const hasOptionalTools = tools.list().some((tool) => !isAlwaysActiveTool(tool));
    const optionalDefinitions = tools
      .definitions(active)
      .filter((definition) => !isActivationTool(definition.name));
    return hasOptionalTools
      ? [...TOOL_ACTIVATION_DEFINITIONS, ...optionalDefinitions]
      : optionalDefinitions;
  }

  private async executeRegisteredTool(
    call: ToolCall,
    tools: ToolRegistry,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = tools.get(call.name);
    if (
      tool !== undefined &&
      !isAlwaysActiveTool(tool) &&
      !this.sessionValue.activeTools.includes(tool.name)
    ) {
      const activation = activateToolForUse(tool, tools, this.sessionValue);
      if (!activation) {
        throw new Error(
          `可选工具已达 ${MAX_ACTIVE_TOOLS} 个上限，无法自动加载 ${tool.name}。` +
          "请先用 deactivate_tools 卸载不用的工具。",
        );
      }
    }
    const output = await tools.execute(call.name, call.arguments, ctx);
    if (call.name === "save_travel_brief") this.briefSavedThisRun = true;
    return output;
  }
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson === "" ? "{}" : argumentsJson) as unknown;
  } catch {
    throw new Error(`参数不是合法 JSON: ${argumentsJson.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("参数必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function recordTravelToolResult(
  session: Session,
  call: ToolCall,
  output: string,
  error?: string,
): void {
  const args = safeArguments(call.arguments);
  if (args === null) return;
  if (call.name === "save_travel_brief" && error === undefined) {
    session.setTravelState(updateTravelStateFromBrief(session.travelState, args));
    return;
  }
  if (call.name === "load_travel_brief" && error === undefined) {
    const brief = parseJsonObjectPrefix(output);
    if (brief !== null) {
      session.setTravelState(updateTravelStateFromBrief(session.travelState, brief));
    }
    return;
  }
  if (call.name === "save_itinerary" && error === undefined) {
    session.setTravelState(updateTravelStateFromItinerary(session.travelState, args));
    session.setTravelState(
      updateTravelStateFromQuality(session.travelState, output, stringValue(args.title)),
    );
    return;
  }
  if (call.name === "load_itinerary" && error === undefined) {
    const day = typeof args.day === "number" && Number.isInteger(args.day) && args.day > 0
      ? args.day
      : undefined;
    session.setTravelState(updateTravelStateFromItineraryJson(
      session.travelState,
      output,
      Date.now(),
      day === undefined ? undefined : { merge: true, dayStart: day },
    ));
    return;
  }
  if (call.name === "validate_itinerary") {
    session.setTravelState(
      updateTravelStateFromQuality(
        session.travelState,
        error === undefined ? output : `${output}\n${error}`,
        stringValue(args.title),
      ),
    );
  }
}

function safeArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    return parseToolArguments(argumentsJson);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 旅行规划的阶段闸门：轮次不能被无限用于查资料，必须在合理位置先形成可评估版本。 */
function shouldForceDraft(state: TravelState | undefined, executedRounds: number): boolean {
  return executedRounds >= 8 && state?.brief !== undefined && state.itinerary === undefined;
}

function travelProgressGuidance(draftGate: boolean): string | undefined {
  if (!draftGate) return undefined;
  return (
    "【行程落盘提醒】需求单已经保存，但当前还没有可评估的行程。请减少扩展搜索，" +
    "立即用已获得的候选 save_itinerary 保存第 1 天；缺少的少量坐标或详情可以标记置信度后补齐，" +
    "可以检索缺失证据，但应优先形成可评估版本。保存后再按天继续，不要换标题重复保存需求单。"
  );
}

/** load_travel_brief 会在 JSON 后追加同行人约束；只解析开头完整的 JSON 对象。 */
function parseJsonObjectPrefix(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const value = safeArguments(text.slice(start, index + 1));
    return value;
  }
  return null;
}

function toolFailureKey(name: string, error: string): string {
  return `${name}\n${error.trim() || "(empty error)"}`;
}

function repeatedFailureHint(count: number): string {
  return (
    `\n\n【防循环】同一工具和错误已连续出现 ${count} 次。` +
    "不要原样重发这组参数；先重新读取当前数据、缩小修改范围，或改用其他工具。"
  );
}

function repeatedFailureGuidance(name: string, error: string, count: number): string {
  return [
    `【工具失败熔断提示】${name} 的同一错误已连续出现 ${count} 次：${error}`,
    "停止原样重试。被压缩的 `_truncated` 参数不是可执行参数；需要用 load_itinerary 等读取工具重新取得当前数据后再构造参数。",
    "如果当前信息不足以继续，请如实说明未完成、已经保存到哪一步和具体阻塞原因，不要继续空转。",
  ].join("\n");
}

/** 只保留少量归档索引；完整结果需要时用 read_file 按需读取。 */
function renderArtifactGuide(session: Session): string | undefined {
  const artifacts = new Map<string, { toolName: string; order: number }>();
  for (const [index, message] of session.history.entries()) {
    if (message.role !== "tool") continue;
    const path = /\bartifact=([^\s\n]+)/.exec(message.content)?.[1];
    if (path === undefined || path === "unavailable") continue;
    artifacts.set(path, { toolName: message.toolName ?? "tool", order: index });
  }
  const recent = [...artifacts.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .slice(0, 8);
  if (recent.length === 0) return undefined;
  return [
    "【工具原文归档索引】以下大结果不在上下文内；需要核对或继续修改时用 read_file 分段读取：",
    ...recent.map(([path, item]) => `- ${item.toolName}: ${path}`),
  ].join("\n");
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
async function budgetExtension(options: RunOptions, limit: number): Promise<BudgetExhaustedDecision> {
  try {
    const decision = await options.onBudgetExhausted?.(limit);
    if (typeof decision === "boolean") return { continue: decision };
    return decision ?? { continue: false };
  } catch (error) {
    debugLog("agent", `预算续期回调失败: ${error instanceof Error ? error.message : String(error)}`);
    return { continue: false };
  }
}
