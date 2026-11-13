import { loadBriefForTitle } from "../tools/brief.ts";
import { activeDayTask, taskDates, setDayTaskDraft, selectDayTask, extendDayTaskAttempts, blockDayTask, recordDayTaskRound, dayTaskScope, dayTaskHistory, dayTaskDefinitions, dayTaskCallIssue, isExplicitPlanEdit, dayTaskRounds, dayTaskCalls } from "../core/day-tasks.ts";
import { evidenceId } from "../tools/travel-evidence.ts";
import { executionStateOf, type ToolExecutionState } from "../core/execution-state.ts";
import { recoverInterruptedToolCalls } from "./tool-recovery.ts";
import { repeatVisitAllowed } from "../tools/repeat-visit-policy.ts";
import { normalizeVisitInfoArgs, normalizeReviewArgs, queryKeyArgs } from "../tools/travel-query.ts";
import { ToolDiagnostics, toolErrorCategory, type ToolErrorCategory } from "../core/tool-diagnostics.ts";
import { ToolValidationError, toolErrorOutput, toolErrorPayload, type ToolValidationIssue } from "../core/tool-error.ts";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderReadProgress, artifactReadStatus, undoReadDelivery } from "../tools/read-progress.ts";
import { atomicWrite, planFileFor } from "../tools/plan-files.ts";
import { createExecutionBudget, type CumulativeToolBudget } from "../core/execution-budget.ts";
export type { CumulativeToolBudget } from "../core/execution-budget.ts";
import { summarizeContext } from "../context/summarize.ts";
import { ContextEpochManager } from "../context/epoch.ts";
import { measureRequestContext, ContextInputLimitError, DEFAULT_MAX_INPUT_TOKENS, type RequestContextMetrics } from "../context/request.ts";
import { travelFocusDay, renderFocusedTravelState } from "../core/travel-context.ts";
import type { Session } from "../core/session.ts";
import type { ChatProvider, LLMResult } from "../llm/provider.ts";
import { isCompactedToolArguments, type PromptMessage, type ToolCall } from "../core/message.ts";
import { parseItinerary } from "../tools/itinerary-schema.ts";
import { applyBriefRequirements, inspectItinerary, renderMarkdown } from "../tools/itinerary.ts";
import { renderQualityReport } from "../tools/itinerary-validator.ts";
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
  type TravelState,
  updateTravelStateFromBrief,
  updateTravelStateFromItinerary,
  updateTravelStateFromItineraryJson,
  updateTravelStateFromQuality,
  updateTravelStateFromSnapshot,
} from "../core/travel-state.ts";
import { compactToolResults, type ToolResultForContext } from "./tool-output.ts";
import { nextRouteFollowUp, pendingRouteRepairs } from "./travel-finalization.ts";
import { recordDeliveryProgress, deliveryGuidance, DEFER_OPTIONAL_EVIDENCE_AFTER, MAX_DELIVERY_STAGNATION, isDeferredEvidenceCall, focusedEvidenceDefinitions, essentialVisitInfoDefinitions, repairOnlyDefinitions, MAX_REDUNDANT_CALLS_BEFORE_REPAIR, MAX_REDUNDANT_ROUNDS, REPAIR_TOOL_NAMES, planningGuidance, planningProgress, planningDefinitions, recoverCoverage, basicLayerActive, basicLayerCallIssue, basicLayerDefinitions } from "./travel-progress.ts";

function safeEmit(callback:()=>void):void{
  try{
    callback();
  }catch{
    //事件回调失败不中断agent
  }
}

export interface AgentEvent {
  readonly type: "tool_start" | "tool_end" | "tool_error" | "tool_denied";
  readonly name: string;
  readonly arguments?: string;
  readonly output?: string;
  readonly error?: string;
  readonly error_type?: "validation" | "execution";
  readonly execution_state?: ToolExecutionState;
  readonly code?: string;
  readonly issues?: readonly ToolValidationIssue[];
}

export interface RunOptions {
  readonly maxPromptTokens?: number;
  /** 在每次完整请求构造后检查，工具结果已配对，允许安全压缩。 */
  readonly compactContext?: (estimatedRequestTokens: number) => Promise<unknown>;
  readonly onRequestContext?: (metrics: RequestContextMetrics) => void;
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
const EMPTY_MODEL_REPLY = "模型返回了空回复。可以重新发送本次请求。";

/** 用户主动中断当前轮（/stop）时抛出 */
export class TurnAbortedError extends Error {
  constructor() {
    super("已中断当前轮");
    this.name = "TurnAbortedError";
  }
}

export function describeTurnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/^(?:LLM 返回|HTTP)\s+(\d{3})\b/)?.[1];
  if (status === "401" || status === "403") return "模型服务拒绝了访问，请检查当前模型配置和密钥。";
  if (status === "429") return "模型服务限制了请求频率或额度（HTTP 429），可以稍后再试。";
  if (status) return `模型服务返回 HTTP ${status}。`;
  const category = toolErrorCategory(error);
  if (category === "timeout") return "服务请求超时，可以稍后重试。";
  if (category === "network") return "服务连接中断，可以在网络恢复后重试。";
  return message.trim().split("\n", 1)[0]?.slice(0, 240) || "本轮执行异常，服务未返回具体原因。";
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
  private get itinerarySnapshot(): ItinerarySnapshot | undefined { return this.committedSnapshot; }
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

  async send(userInput: string, options: RunOptions = {}): Promise<string> {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      throw new Error("输入不能为空");
    }

    this.sessionValue.add("user", trimmed);
    const history = await this.preparePlainHistory([], options);
    const measured = this.provider.chatWithUsage === undefined ? undefined : await this.provider.chatWithUsage(history, this.currentController?.signal);
    if (measured?.usage !== undefined) { this.sessionValue.addUsage(measured.usage); this.sessionValue.completeRequestContext(measured.usage); }
    const content = measured?.type === "text" ? measured.content : await this.provider.chat(history);
    const reply = content.trim() ? content : EMPTY_MODEL_REPLY;
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
    await recoverInterruptedToolCalls(this.sessionValue, this.tools, this.workspace);
    const cumulative = options.cumulativeBudget ?? createExecutionBudget(this.sessionValue);
    cumulative.diagnostics ??= new ToolDiagnostics();
    cumulative.allowAdvisoryReviews ||= /口碑|评价|点评|排队|招牌|人均价格/.test(trimmed);
    cumulative.allowVisitInfoQueries ||= /游[玩览]时长|开放时间|闭馆|停止入园|最后入场|场次|公告|重新核实|重查|刷新|重新查询/.test(trimmed);
    let accountedTokens = this.sessionValue.usage.totalTokens;
    const syncUsage = () => { cumulative.tokens += Math.max(0, this.sessionValue.usage.totalTokens - accountedTokens); accountedTokens = this.sessionValue.usage.totalTokens; };
    const exhausted = () => cumulative.rounds >= cumulative.maxRounds || cumulative.calls >= cumulative.maxCalls || (cumulative.maxTokens !== undefined && cumulative.tokens >= cumulative.maxTokens) || cumulative.costExceeded?.() === true;

    if (exhausted()) {
      const reply = "已达到累计轮次、调用、token 或费用预算，本次未发送新的模型请求。";
      this.sessionValue.add("user", trimmed); this.sessionValue.add("assistant", reply);
      await this.checkpoint(options);
      return reply;
    }
    // 能力一次性解析并自然收窄类型（循环内不再判空/断言）
    const tools = this.tools;
    const chatWithTools = this.provider.chatWithTools;
    if (tools === undefined || tools.size === 0 || chatWithTools === undefined) {
      // 不支持工具 → 降级纯对话
      const reply = await this.send(userInput, options);
      syncUsage();
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
    const failures = new Map<string, { tool: string; reason: string; count: number }>();
    let hadSuccessfulToolCall = false;
    let committedPlanThisRun = false;
    let failedSaveThisRun = false;
    let streamedResponse = "";
    const recordFailure = (tool: string, error: string) => {
      const reason = error.trim().split("\n").slice(0, 2).join(" ").slice(0, 320) || "工具未返回具体原因";
      const key = toolFailureKey(tool, reason);
      const count = (failures.get(key)?.count ?? 0) + 1;
      failures.delete(key);
      failures.set(key, { tool, reason, count });
      if (failures.size > 20) failures.delete(failures.keys().next().value!);
      if (tool === "save_itinerary") failedSaveThisRun = true;
    };
    const failureDetails = () => {
      if (failures.size === 0) return undefined;
      const latest = [...failures.values()].reverse();
      const lastSaveFailure = latest.find((failure) => failure.tool === "save_itinerary");
      const shown = lastSaveFailure ? [lastSaveFailure, ...latest.filter((failure) => failure !== lastSaveFailure).slice(0, 3)] : latest.slice(0, 4);
      return [
        hadSuccessfulToolCall ? "本轮遇到的工具问题" : "本轮工具未取得可用结果，原因如下",
        "",
        ...shown.map(({ tool, reason, count }) => `- \`${tool}\` ${reason}${count > 1 ? `（重复 ${count} 次）` : ""}`),
      ].join("\n");
    };
    const nextStep = () => {
      const plan = this.sessionValue.travelState?.itinerary;
      if (!failedSaveThisRun || cumulative.operationRecovery || cumulative.blockedKind === "dependency"
        || (committedPlanThisRun && plan?.strictPass && plan.complete !== false)) return undefined;
      if ([...failures.values()].some(({ reason }) => reason.includes("[DAY_SCHEDULE_CONFLICT]"))) {
        return "如果结束时间或固定预约不能调整，请告诉我新增景点的优先顺序，我可以据此重新安排。";
      }
      return "可以回复「继续修复」，我会根据上面的原因重新尝试保存。";
    };
    const planStatus = () => {
      if (cumulative.operationRecovery) return cumulative.blockedReason ?? "有操作待核对，请先查看当前版本。";
      const saved = this.sessionValue.travelState?.itinerary;
      if (!saved) return "本轮尚未保存行程。";
      const version = saved.revision === undefined ? "" : ` v${saved.revision}`;
      return committedPlanThisRun
        ? `本轮已保存「${saved.title}」${version}，共 ${saved.dayCount} 天。未完成的修改可以从该版本继续。`
        : `本轮未保存新的行程版本。最近已保存「${saved.title}」${version}，共 ${saved.dayCount} 天。`;
    };
    const finish = async (reply: string) => {
      if (controller.signal.aborted) throw new TurnAbortedError();
      const delta = streamedResponse && reply.startsWith(streamedResponse) ? reply.slice(streamedResponse.length)
        : streamedResponse ? `\n\n${reply}` : reply;
      if (delta) safeEmit(() => options.onTextDelta?.(delta));
      this.sessionValue.add("assistant", reply);
      await this.checkpoint(options);
      return reply;
    };

    try {
      this.sessionValue.add("user", trimmed);
      await this.checkpoint(options);

      // executed = 已执行的轮数（续期的检查本身不占轮次，否则续期一次只能多跑一轮）
      let executed = 0;
      let extensions = 0;
      let budgetGuidance: string | undefined;
      let budgetExtensionStart: { round: number; limit: number } | undefined;
      const extensionSummary = () => this.committedSnapshot && budgetExtensionStart && budgetExtensionStart.limit > budgetExtensionStart.round
        ? `最近一次追加了 ${budgetExtensionStart.limit - budgetExtensionStart.round} 轮，实际使用 ${executed - budgetExtensionStart.round} 轮。` : undefined;
      let failureGuidance: string | undefined;
      let modelFailure: string | undefined;
      let failureKey = "";
      let failureCount = 0;
      let circuitOpen = false;
      let earlyFinalizations = 0;
      let routesQueried = false;
      const attemptedRouteCommits = new Set<string>();
      const routineVisitQueries = new Set<string>();
      const queriedRouteLegs = new Set<string>();
      const savedRouteDates = new Set<string>();
      const supportsRouteQueries = tools.get("plan_day_routes")?.supportsRoutineRouteQuery === true;
      let dayPlanning = false;
      let dayHistoryBoundary = "";
      let dayScopeKey = "";
      let basicScopeKey = "";
      cumulative.basicDiscoveryCalls ??= new Map();
      const basicQueries = () => cumulative.basicDiscoveryCalls!.get(this.sessionValue.travelState?.brief?.title ?? "") ?? 0;
      const researchOnly = /(?:核实|查询|重查|刷新|查一下|看看).*(?:开放|闭馆|天气|资料|时长)|(?:检查|查看|读取|加载|展示).*(?:当前|已有|已保存)?行程/.test(trimmed) && !/规划|补齐|生成|(?<!已)保存|重排|调整行程/.test(trimmed);
      const explicitEdit = isExplicitPlanEdit(trimmed);
      let dailyEnabled = !explicitEdit && !researchOnly;
      const planningRequested = /规划|行程|补齐|续跑|接着|继续|旅游|旅行|保存|(?:玩|去).{0,20}[一二三四五六七八九十\d]+(?:天|日)/.test(trimmed);
      const explicitlyNew = /(?:新建|另建|另起|另做|另存|再(?:做|排|规划|生成)一份).{0,16}(?:行程|旅行|旅程|日游|天)|(?:新建|另建|另起|另做|再(?:做|排|规划|生成))一份|(?:新的一趟|新的行程|新的旅行)/.test(trimmed);
      const resumingDates = !explicitlyNew && /继续|补齐|续跑|接着|还缺|缺失|未完成|剩余|后[面续].*(?:天|行程)/.test(trimmed);
      const currentTravel = this.sessionValue.travelState;
      const newTravelPlan = explicitlyNew || (planningRequested && !currentTravel?.brief && !currentTravel?.itinerary && !resumingDates && dailyEnabled);
      if (!dailyEnabled) {
        const active = activeDayTask(this.sessionValue.travelState);
        if (active) this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, active.date, "用户指定修订，暂停该日期补天任务"));
      }
      const resetDayLoop = () => {
        cumulative.stagnantRounds = 0; cumulative.deliveryStagnantRounds = 0; cumulative.redundantCalls = 0; cumulative.redundantRounds = 0;
        if (cumulative.blockedKind !== "dependency") { cumulative.blockedReason = undefined; cumulative.blockedKind = undefined; }
        stagnantRounds = 0; failureKey = ""; failureCount = 0; earlyFinalizations = 0; circuitOpen = false; failureGuidance = undefined;
      };
      const nextDateTask = () => {
        const state = this.sessionValue.travelState;
        if (!state?.brief || !state.itinerary || !dailyEnabled) return;
        if (!dayPlanning && (!this.savedThisRun && !resumingDates || state.brief.title !== state.itinerary.title)) return;
        const p = planningProgress(state);
        const layers = state.itinerary.planningLayers;
        if (layers?.basic_complete && layers.checked_days === layers.expected_days && layers.ready_days === layers.expected_days && !cumulative.allowVisitInfoQueries) dayPlanning = true;
        if (!p.outlineReady && state.itinerary.dayCount === 0) {
          const active = activeDayTask(state); if (active) this.sessionValue.setTravelState(blockDayTask(state, active.date, "基础安排变更，先恢复基础层"));
          dayPlanning = false; return;
        }
        const budgetPending = layers?.days.some((day) => day.budget_gaps?.length) === true;
        if (!dayPlanning && !budgetPending && !((layers ? layers.missing_required.length > 0 || layers.days.some((day) => day.feasibility !== "checked" || day.schedule !== "ready") : p.remaining > 0) && (p.outlineReady || state.itinerary.dayCount > 0 && taskDates(state).length === p.expected) && (p.expected ?? 0) > 1)) return;
        dayPlanning = true;
        const selected = selectDayTask(state, cumulative);
        this.sessionValue.setTravelState(selected.state);
        if (selected.task) {
          const key = `${state.itinerary.itineraryId ?? state.itinerary.title}:${selected.task.date}:${selected.task.layer ?? "legacy"}:${selected.task.goal_id ?? ""}:${selected.task.requirement_version ?? ""}:${selected.task.attempts}`;
          if (key !== dayScopeKey) {
            dayScopeKey = key; resetDayLoop();
            dayHistoryBoundary = `【日期任务上下文边界】${key}:${this.sessionValue.history.length}`;
            this.sessionValue.add("system", dayHistoryBoundary);
          }
        }
        return selected.task;
      };
      let stagnantRounds = cumulative.stagnantRounds ?? 0;
      await tools.evidence.load();
      const previousPlan = this.sessionValue.travelState?.itinerary;
      const briefRoot = tools.get("save_travel_brief")?.operationRoot ?? tools.get("save_itinerary")?.operationRoot ?? this.workspace;
      const briefTitle = this.sessionValue.travelState?.brief?.title ?? (resumingDates ? previousPlan?.title : undefined);
      if (briefTitle) {
        const brief = await loadBriefForTitle(briefRoot, briefTitle);
        if (brief) this.sessionValue.setTravelState(updateTravelStateFromBrief(this.sessionValue.travelState, { ...brief }));
      }
      if (resumingDates && previousPlan) {
        const planRoot = tools.get("save_itinerary")?.operationRoot ?? this.workspace;
        const file = planFileFor(planRoot, "plans", previousPlan.title, "json");
        try {
          const saved = parseItinerary(JSON.parse(await readFile(file, "utf8")));
          this.committedSnapshot = { file, ...inspectItinerary(applyBriefRequirements(saved, this.sessionValue.travelState?.brief), tools.evidence) };
          this.sessionValue.setTravelState(updateTravelStateFromSnapshot(this.sessionValue.travelState, this.committedSnapshot));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const targets = () => [...(this.sessionValue.travelState?.brief?.mustVisit ?? []), ...(this.sessionValue.travelState?.itinerary?.assignments?.map((v) => v.name) ?? []), ...(this.sessionValue.travelState?.places.filter((p) => p.kind === "visit" || p.kind === "accommodation").map((p) => p.name) ?? [])];
      const facts = () => tools.evidence.usableEvidenceKeys(targets(), this.sessionValue.travelState?.brief?.destination);
      cumulative.observedEvidence ??= new Set(facts());
      cumulative.queryAttempts ??= new Map();
      cumulative.readVersions ??= new Map();
      cumulative.queryStats ??= { executed: 0, cacheHits: 0, blocked: 0 };
      const strictMeals = () => this.committedSnapshot?.itinerary.constraints?.recommendation_mode === "strict" || this.sessionValue.travelState?.itinerary?.recommendationMode === "strict";
      const repairOnly = () => !dayPlanning && this.sessionValue.travelState?.brief !== undefined && (cumulative.redundantCalls ?? 0) >= MAX_REDUNDANT_CALLS_BEFORE_REPAIR;
      const allowReviews = () => !this.sessionValue.travelState?.brief || cumulative.allowAdvisoryReviews === true || strictMeals();
      const pendingVisitInfo = () => {
        const state = this.sessionValue.travelState;
        if (!state?.brief || cumulative.allowAdvisoryReviews || cumulative.allowVisitInfoQueries || strictMeals()) return undefined;
        const active = activeDayTask(state);
        const focus = travelFocusDay(state, trimmed);
        const slot = active ? state.itinerary?.outline?.find((day) => day.date === active.date) : state.itinerary?.outline?.[focus - 1];
        const names = [...slot?.visits.map((v) => v.name) ?? [], ...state.places.filter((p) => p.kind === "visit" && (slot?.date ? p.date === slot.date : p.day === focus)).map((p) => p.name), ...state.brief.mustVisit];
        return tools.evidence.pendingVisitInfoPlaces(names, state.brief.destination, cumulative.queryAttempts).slice(0, 12);
      };
      if (cumulative.deliveryProgress === undefined) recordDeliveryProgress(this.sessionValue.travelState, cumulative);
      for (;;) {
        if (exhausted()) { budgetGuidance = "已达到本次任务累计轮次、调用、token 或费用上限；自动续跑不会重置预算。"; break; }
        const snapshotBeforeRound = this.itinerarySnapshot;
        if (snapshotBeforeRound) {
          const itinerary = applyBriefRequirements(snapshotBeforeRound.itinerary, this.sessionValue.travelState?.brief);
          this.committedSnapshot = { ...snapshotBeforeRound, ...inspectItinerary(itinerary, tools.evidence) };
          this.sessionValue.setTravelState(updateTravelStateFromSnapshot(this.sessionValue.travelState, this.committedSnapshot));
        }
        const flowEnabled = dailyEnabled && (planningRequested || this.briefSavedThisRun || this.savedThisRun || resumingDates);
        const basicStage = flowEnabled && basicLayerActive(this.sessionValue.travelState);
        if (basicStage && basicScopeKey !== this.sessionValue.travelState?.brief?.title) {
          basicScopeKey = this.sessionValue.travelState!.brief!.title; resetDayLoop();
          dayHistoryBoundary = `【日期任务上下文边界】基础安排:${basicScopeKey}:${this.sessionValue.history.length}`;
          this.sessionValue.add("system", dayHistoryBoundary);
        }
        let dateTask = nextDateTask();
        if (dateTask && (dateTask.attempt_rounds >= dayTaskRounds(dateTask) || dateTask.attempt_calls >= dayTaskCalls(dateTask))) {
          this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, dateTask.date, dateTask.last_error ?? "该日期达到单次软额度，先处理其他日期，再按独立额度重试"));
          dateTask = nextDateTask();
          await this.checkpoint(options);
          if (!dateTask) continue;
        }
        if (cumulative.blockedKind === "dependency") { circuitOpen = true; failureGuidance = cumulative.blockedReason; break; }
        if (dateTask && (cumulative.blockedReason !== undefined || (cumulative.deliveryStagnantRounds ?? 0) >= MAX_DELIVERY_STAGNATION || (cumulative.stagnantRounds ?? 0) >= 12)) {
          this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, dateTask.date, cumulative.blockedReason ?? "该日期局部停滞，转向其他日期"));
          await this.checkpoint(options); nextDateTask(); continue;
        }
        const saved = this.itinerarySnapshot;
        const routeCallSlots = Math.min(cumulative.maxCalls - cumulative.calls, dateTask ? dayTaskCalls(dateTask) - dateTask.attempt_calls : Infinity);
        // 日期软额度用尽后，已保存版本的路线仍可在累计预算内补查与提交。
        const routeDates = dateTask ? new Set([dateTask.date]) : dailyEnabled ? undefined : savedRouteDates;
        let routeFollowUp = saved && !basicStage && tools.get("save_itinerary") && (!dateTask || dateTask.layer === "schedule")
          && (dayPlanning || supportsRouteQueries && (this.savedThisRun || dailyEnabled && resumingDates))
          ? nextRouteFollowUp(saved, tools.evidence, {
            dates: routeDates, maxQueries: supportsRouteQueries ? Math.min(4, routeCallSlots - 1) : 0,
            queriedLegs: queriedRouteLegs, attemptedRepairs: attemptedRouteCommits,
          }) : undefined;
        const limit = await roundLimit();
        const finishedDates = dayPlanning && !dateTask && !routeFollowUp;
        const retryableDates = finishedDates && this.sessionValue.travelState?.itinerary?.dayTasks?.some((task) => task.status !== "saved");
        if (finishedDates && (!retryableDates || executed < limit || extensions >= BUDGET_EXTENSION_LIMIT)) {
          circuitOpen = true;
          const tasks = this.sessionValue.travelState?.itinerary?.dayTasks ?? [];
          failureGuidance = tasks.some((task) => task.status !== "saved") ? "各日期已按独立额度尝试；以下日期仍待处理：" + tasks.filter((task) => task.status !== "saved").map((task) => `${task.date}/${task.layer ?? "时间路线"}（${task.attempts}次：${task.last_error ?? "缺少有效安排"}）`).join("；") : "各层已完成可完成的核验与细排；基础安排保留全部日期，整体质量与待确认事项如下。";
          break;
        }
        if (!dayPlanning && !routeFollowUp && (cumulative.blockedReason !== undefined || (cumulative.deliveryStagnantRounds ?? 0) >= MAX_DELIVERY_STAGNATION || (cumulative.stagnantRounds ?? 0) >= 12)) {
          const recovery = recoverCoverage(this.sessionValue.travelState, cumulative);
          if (recovery) { failureGuidance = recovery; stagnantRounds = 0; circuitOpen = false; }
          else { circuitOpen = true; failureGuidance = cumulative.blockedReason ?? ((cumulative.deliveryStagnantRounds ?? 0) >= MAX_DELIVERY_STAGNATION ? "连续 20 轮未推进交付，本阶段已停滞；不是预算耗尽。保留已保存版本及待修问题。" : "连续 12 轮无实际进展，本阶段已停滞；不是预算耗尽。保留已保存版本及待修问题。"); break; }
        }
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
          budgetExtensionStart = { round: executed, limit: await roundLimit() };
          if (dayPlanning && this.sessionValue.travelState) extendDayTaskAttempts(this.sessionValue.travelState, cumulative);
          continue;
        }
        if (controller.signal.aborted) throw new TurnAbortedError();

        // 排干 steer 注入的消息（在每次 LLM 调用前生效，模型可据此转向）
        const steered = options.takeSteeredMessages?.() ?? [];
        for (const message of steered) {
          this.sessionValue.add("user", message);
          cumulative.allowAdvisoryReviews ||= /口碑|评价|点评|排队|招牌|人均价格/.test(message);
          cumulative.allowVisitInfoQueries ||= /游[玩览]时长|开放时间|闭馆|停止入园|最后入场|场次|公告|重新核实|重查|刷新|重新查询/.test(message);
          cumulative.redundantCalls = 0; cumulative.redundantRounds = 0;
          if (isExplicitPlanEdit(message)) {
            const active = activeDayTask(this.sessionValue.travelState);
            if (active) this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, active.date, "用户指定修订，暂停补天"));
            dailyEnabled = false; dayPlanning = false; dateTask = undefined;
            routeFollowUp = undefined;
          }
        }

        // 剩余轮数不足时注入收尾提醒（仅本次请求可见，不进入会话历史，避免污染后续轮次）
        const remaining = limit - executed - 1;
        const roundTaskDate = dateTask?.date;
        const roundTaskLayer = dateTask?.layer ?? "legacy";
        const roundTaskGoal = dateTask?.goal_id;
        const buildRequest = (dynamicChars: number) => {
          const loadingGuide = toolLoadingGuide(tools, this.sessionValue);
          const artifactGuide = renderArtifactGuide(this.sessionValue, this.workspace, this.sessionValue.travelMode ? cumulative.readVersions : undefined);
          const readGuide = this.sessionValue.travelMode ? renderReadProgress(cumulative.readVersions) : undefined;
          const phaseGuide = flowEnabled ? planningGuidance(this.sessionValue.travelState) : "【用户指定任务】按本次用户需求处理；暂停自动推进完整行程，完成后如实报告结果。";
          const focusInput = [...this.sessionValue.history].reverse().find((message) => message.role === "user")?.content ?? trimmed;
          const focusDay = roundTaskDate ? Math.max(1, taskDates(this.sessionValue.travelState!).indexOf(roundTaskDate) + 1) : travelFocusDay(this.sessionValue.travelState, focusInput);
          const travelState = renderFocusedTravelState(this.sessionValue.travelState, focusDay, Math.floor(dynamicChars * 0.5));
          const draftGate = shouldForceDraft(this.sessionValue.travelState, executed);
          const travelProgress = flowEnabled ? travelProgressGuidance(draftGate) : undefined;
          const focusDate = roundTaskDate ?? this.sessionValue.travelState?.itinerary?.outline?.[focusDay - 1]?.date ?? this.sessionValue.travelState?.itinerary?.daySummaries?.find((day) => day.day === focusDay)?.date;
          const focusNames = [...(this.sessionValue.travelState?.places.filter((place) => focusDate ? place.date === focusDate : place.day === focusDay).map((place) => place.name) ?? []), ...(this.sessionValue.travelState?.itinerary?.outline?.find((slot) => slot.date === focusDate)?.visits.map((v) => v.name) ?? []), ...recentEvidenceNames(this.sessionValue)];
          const repeatPolicy = { constraints: { destination: this.sessionValue.travelState?.brief?.destination, repeat_visit_permissions: this.sessionValue.travelState?.itinerary?.repeatVisitPermissions } };
          const unavailableVisits = [...(this.sessionValue.travelState?.itinerary?.assignments?.filter((v) => v.date !== focusDate && !repeatVisitAllowed(repeatPolicy, v)).flatMap((v) => [v.name, ...(v.parent_visit ? [v.parent_visit.name] : [])]) ?? []), ...(this.sessionValue.travelState?.itinerary?.excludedVisits?.map((v) => v.name) ?? [])];
          const evidence = this.sessionValue.travelState?.brief === undefined ? "" : basicStage ? tools.evidence.basicCandidates(this.sessionValue.travelState.brief.destination) : tools.evidence.summary(this.sessionValue.travelState.brief.destination, [...focusNames, ...this.sessionValue.travelState.brief.mustVisit], Math.floor(dynamicChars * 0.3), unavailableVisits);
          const queryIndex = tools.evidence.queryContext([...focusNames, ...(this.sessionValue.travelState?.brief?.mustVisit ?? [])], Math.min(1600, Math.floor(dynamicChars * 0.2)));
          const deliveryHint = deliveryGuidance(cumulative);
          const transientMessages = [
            ...(queryIndex === "" ? [] : [{ role: "system" as const, content: queryIndex }]),
            ...(deliveryHint === undefined ? [] : [{ role: "system" as const, content: deliveryHint }]),
            ...(repairOnly() ? [{ role: "system" as const, content: "本阶段重复调用已达6次，暂缓新增候选与口碑搜索；请直接保存缺失日期或按已有问题做增量修订。资料未知如实保留。新增有效日期或降低P0/P1后自动恢复查询。" }] : []),
            ...(evidence === "" ? [] : [{ role: "system" as const, content: evidence }]),
            ...(loadingGuide === undefined
              ? []
              : [{ role: "system" as const, content: loadingGuide } satisfies PromptMessage]),
            ...(artifactGuide === undefined
              ? []
              : [{ role: "system" as const, content: artifactGuide } satisfies PromptMessage]),
            ...(readGuide === undefined ? [] : [{ role: "system" as const, content: readGuide }]),
            ...(phaseGuide === undefined ? [] : [{ role: "system" as const, content: phaseGuide }]),
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
          const allHistory = this.sessionValue.toPrompt();
          const rawRequests = allHistory.filter((message) => message.role === "user");
          const history = dayPlanning || basicStage ? dayTaskHistory(allHistory, dayHistoryBoundary, rawRequests) : allHistory;
          const requestHistory = transientMessages.length === 0
            ? history
            : [...history, ...transientMessages];
          // 记录真实请求字符量（含 tool_calls 参数与临时提示），响应后校准估算系数
          const available = this.requestToolDefinitions(tools).filter((tool) => tool.name !== "load_travel_brief" || !this.sessionValue.travelState?.brief?.requirementVersion);
          const definitions = repairOnlyDefinitions(essentialVisitInfoDefinitions(available, pendingVisitInfo(), allowReviews()), repairOnly());
          const requestTools = basicStage ? basicLayerDefinitions(definitions, basicQueries()) : dayPlanning && roundTaskDate ? dayTaskDefinitions(definitions, dayTaskScope(this.sessionValue.travelState, roundTaskDate)!) : (cumulative.deliveryStagnantRounds ?? 0) < DEFER_OPTIONAL_EVIDENCE_AFTER ? definitions : focusedEvidenceDefinitions(definitions, strictMeals(), cumulative.allowAdvisoryReviews);
          const metrics = measureRequestContext(this.sessionValue, this.provider.systemPrompt, history, transientMessages, requestTools, options.maxPromptTokens);
          return { requestHistory, requestTools, metrics };
        };
        const state = this.sessionValue.travelState;
        const city = state?.brief?.destination;
        const routineCalls = dateTask?.layer === "feasibility" && city && tools.get("get_place_visit_info")?.supportsRoutineVisitInfo
          ? (state?.itinerary?.planningLayers?.days.find((day) => day.date === roundTaskDate)?.visits ?? [])
            .filter((visit) => visit.identity_verified)
            .flatMap((visit): ToolCall[] => {
              const place = tools.evidence.canonicalPlaceName(visit.name, city);
              if (!tools.evidence.pendingVisitInfoPlaces([place], city, cumulative.queryAttempts, roundTaskDate).length) return [];
              const fields = tools.evidence.missingOpeningFields(city, place, undefined, roundTaskDate);
              const key = evidenceId([city, place, fields, roundTaskDate]);
              return routineVisitQueries.has(key) ? [] : [{ id: `opening-${key}`, name: "get_place_visit_info", arguments: JSON.stringify({ place, city, fields, visit_date: roundTaskDate }) }];
            }).filter((call, index, calls) => calls.findIndex((entry) => entry.id === call.id) === index)
            .slice(0, Math.min(4, dayTaskCalls(dateTask) - dateTask.attempt_calls, cumulative.maxCalls - cumulative.calls))
          : [];
        let requestChars = 0;
        let result: LLMResult;
        if (routeFollowUp && "repair" in routeFollowUp && saved) {
          const { repair } = routeFollowUp;
          attemptedRouteCommits.add(repair.key);
          result = { type: "tool_calls", toolCalls: [{ id: `schedule-route-${repair.key}`, name: "save_itinerary",
            arguments: JSON.stringify({ title: saved.itinerary.title, expected_revision: saved.itinerary.revision, repair_routes: [repair.date] }) }] };
        } else if (routeFollowUp && "requests" in routeFollowUp) {
          result = { type: "tool_calls", toolCalls: routeFollowUp.requests.map(({ key, args, legKeys }) => {
            for (const leg of legKeys) queriedRouteLegs.add(leg);
            return { id: `route-${key}`, name: "plan_day_routes", arguments: JSON.stringify(args) };
          }) };
        } else if (routineCalls.length) {
          for (const call of routineCalls) routineVisitQueries.add(call.id.slice("opening-".length));
          result = { type: "tool_calls", toolCalls: routineCalls };
        } else {
          let request = buildRequest(10_000);
          if (request.metrics.estimatedInputTokens > request.metrics.inputLimit) {
            await this.compactContext(request.metrics.estimatedInputTokens, options);
            request = buildRequest(10_000);
          }
          if (request.metrics.estimatedInputTokens > request.metrics.inputLimit) {
            this.sessionValue.compactCompletedToolCalls(undefined, 1);
            request = buildRequest(2_000);
          }
          syncUsage();
          if (exhausted()) { budgetGuidance = "上下文整理后，累计预算已用尽，本轮没有发送后续模型请求。"; break; }
          this.sessionValue.recordRequestContext(request.metrics);
          options.onRequestContext?.(request.metrics);
          debugLog("context", JSON.stringify(request.metrics));
          const { requestHistory, requestTools } = request;
          requestChars = request.metrics.totalChars;

          // 优先流式（最终回答逐字输出），Provider 不支持时降级
          try {
            if (request.metrics.estimatedInputTokens > request.metrics.inputLimit) throw new ContextInputLimitError(request.metrics);
            if (streamWithTools !== undefined) {
              const streamReply = this.sessionValue.travelState?.brief === undefined && !this.savedThisRun && failures.size === 0;
              result = await streamWithTools.call(
                this.provider,
                requestHistory,
                requestTools,
                (delta) => {
                  if (!streamReply) return;
                  streamedResponse += delta;
                  safeEmit(() => options.onTextDelta?.(delta));
                },
                controller.signal,
              );
            } else {
              result = await chatWithTools.call(this.provider, requestHistory, requestTools, controller.signal);
            }
          } catch (error) {
            // 中断信号导致的任何失败统一转为 TurnAbortedError
            if (controller.signal.aborted) throw new TurnAbortedError();
            if (executed === 0) throw error;
            modelFailure = describeTurnError(error);
            break;
          }
        }

        if (result.usage !== undefined) {
          this.sessionValue.addUsage(result.usage);
          this.sessionValue.completeRequestContext(result.usage);
          syncUsage();
          // 用完整请求校准；短输入的协议固定开销占比高，仍需最低样本长度。
          if (requestChars >= 3000) {
            this.sessionValue.calibrateTokens(result.usage.promptTokens, requestChars);
          }
        }

        if (result.type === "text" && dayPlanning && roundTaskDate) {
          this.sessionValue.setTravelState(recordDayTaskRound(this.sessionValue.travelState!, roundTaskDate, 0, "模型仅文字收尾，尚未完成当前层", roundTaskLayer));
          this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, roundTaskDate, "模型仅文字收尾，转向其他日期后再重试"));
          executed += 1; cumulative.rounds += 1;
          await this.checkpoint(options); nextDateTask(); continue;
        }
        if (result.type === "text") {
          const progress = planningProgress(this.sessionValue.travelState);
          const snapshot = this.itinerarySnapshot;
          const activePlanning = this.savedThisRun || (routesQueried && /规划|安排行程|继续|修[复订改]|调整|重排|补齐/.test(trimmed));
          if (activePlanning && snapshot && (this.sessionValue.travelState?.brief || snapshot.itinerary.constraints?.require_routes)) {
            if (exhausted()) { budgetGuidance = "累计预算已用尽，保留已保存版本及尚未修复的问题。"; break; }
            const pending = tools.get("save_itinerary") ? pendingRouteRepairs(snapshot, tools.evidence).find((entry) =>
              (dailyEnabled || savedRouteDates.has(entry.date)) && !attemptedRouteCommits.has(entry.key)) : undefined;
            if (pending) {
              attemptedRouteCommits.add(pending.key);
              // 进入与模型工具调用相同的权限、预算、诊断及检查点路径，成功后再读新快照。
              result = { type: "tool_calls", toolCalls: [{ id: `finalize-route-${pending.key}`, name: "save_itinerary",
                arguments: JSON.stringify({ title: snapshot.itinerary.title, expected_revision: snapshot.itinerary.revision, repair_routes: [pending.date] }) }] };
            } else if (progress.remaining > 0 || this.sessionValue.travelState?.itinerary?.complete === false || snapshot.report.issue_count.P0 > 0 || snapshot.report.issue_count.P1 > 0) {
              if (earlyFinalizations >= 2) { failureGuidance = "连续多次尝试文字收尾仍未推进修复，已停止空转；以下为已保存待修订版本。"; break; }
              earlyFinalizations += 1;
              executed += 1; cumulative.rounds += 1;
              failureGuidance = `【交付检查未通过】有效${progress.count}/${progress.expected ?? "待确认"}天，P0=${snapshot.report.issue_count.P0}、P1=${snapshot.report.issue_count.P1}。请继续工具修订并保存，不能只给文字总结。${planningGuidance(this.sessionValue.travelState) ?? ""}\n` +
                snapshot.report.issues.filter((issue) => issue.level !== "P2").slice(0, 6).map((issue) => `[${issue.code}] ${issue.message}`).join("\n");
              await this.checkpoint(options);
              continue;
            }
          }
        }
        if (result.type === "text") {
          const progress = planningProgress(this.sessionValue.travelState);
          const incomplete = this.sessionValue.travelState?.itinerary !== undefined && (progress.remaining > 0 || this.sessionValue.travelState.itinerary.complete === false);
          const savedReply = incomplete ? this.canonicalReply(false) ?? `当前有效安排${progress.count}/${progress.expected ?? "待确认"}天，行程尚未完成。${progress.missing.length ? `缺失日期为 ${progress.missing.join("、")}。` : ""}` : this.canonicalReply();
          const failedChange = failedSaveThisRun && !committedPlanThisRun;
          const missingReply = !result.content.trim() && !savedReply;
          return finish([
            extensionSummary(),
            failedChange || (missingReply && this.sessionValue.travelState) ? planStatus() : undefined,
            savedReply ?? (missingReply ? EMPTY_MODEL_REPLY : failedChange ? undefined : result.content),
            failedChange || missingReply || !hadSuccessfulToolCall ? failureDetails() : undefined,
            failedChange ? nextStep() : undefined,
          ].filter(Boolean).join("\n\n"));
        }

        streamedResponse = "";
        // 模型和宿主工具调用共用同一执行、权限和诊断路径。
        const callBatch = this.sessionValue.add("assistant", "", { toolCalls: result.toolCalls });
        // 先持久化调用意图。崩溃后根据批次 ID 核对账本，不自动重放副作用。
        await this.checkpoint(options);

        const diagnosticStart = cumulative.diagnostics.records.length;
        const pendingResults: ToolResultForContext[] = [];
        let uncertainEffect = false;
        let dayCallsThisRound = 0;
        for (const call of result.toolCalls) {
          if (controller.signal.aborted) throw new TurnAbortedError();
          if (uncertainEffect) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
            pendingResults.push({ callId: call.id, toolName: call.name, output: "前序工具提交结果或导出需要核对，本批后续调用未执行；请先检查实际状态。" });
            continue;
          }
          const effectiveBasicStage = dailyEnabled && (planningRequested || this.briefSavedThisRun || this.savedThisRun || resumingDates) && basicLayerActive(this.sessionValue.travelState);
          if (effectiveBasicStage) {
            const issue = basicLayerCallIssue(call.name, basicQueries());
            if (issue) { cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked"); pendingResults.push({ callId: call.id, toolName: call.name, output: issue }); continue; }
          }
          const scope = dayPlanning ? dayTaskScope(this.sessionValue.travelState, roundTaskDate) : undefined;
          if (scope) {
            let issue: string | undefined;
            try { issue = dayTaskCallIssue(call.name, JSON.parse(call.arguments), scope); } catch { /* 参数错误交由正常执行处理。 */ }
            if (activeDayTask(this.sessionValue.travelState)?.date !== roundTaskDate) issue = "本批任务状态已变化；程序将在下一轮重新评估日期与层级，本调用未执行。";
            if (issue) {
              cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
              pendingResults.push({ callId: call.id, toolName: call.name, output: issue }); continue;
            }
          }
          if (repairOnly() && !REPAIR_TOOL_NAMES.has(call.name)) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked"); cumulative.queryStats.blocked++;
            pendingResults.push({ callId: call.id, toolName: call.name, output: "当前已有多次重复请求，仅开放保存、读取受影响条目和路线修订。直接补齐日期或修改具体问题；未知规则保留待确认。实质交付改进后自动恢复取证。" });
            continue;
          }
          const pendingVisitNames = pendingVisitInfo();
          if (["get_place_visit_info", "get_place_reviews"].includes(call.name) && (pendingVisitNames !== undefined || call.name === "get_place_reviews" && !allowReviews())) {
            let redundant = false;
            let blockedKey: string | undefined;
            try {
              const raw = JSON.parse(call.arguments);
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("参数必须是对象");
              const args = call.name === "get_place_visit_info" ? normalizeVisitInfoArgs(raw) : normalizeReviewArgs(raw);
              if (typeof args.place !== "string" || args.place.trim() === "") throw new Error("缺少place");
              const name = tools.evidence.canonicalPlaceName(String(args.place ?? ""), this.sessionValue.travelState!.brief!.destination);
              blockedKey = evidenceId([call.name, queryKeyArgs(call.name, { ...args, place: name, city: this.sessionValue.travelState!.brief!.destination })]);
              redundant = call.name === "get_place_reviews" || !pendingVisitNames?.includes(name);
            } catch { /* 参数错误仍由正常执行路径返回。 */ }
            if (redundant) {
              const observation = cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked"); observation.query_key = blockedKey;
              cumulative.queryStats.blocked++;
              pendingResults.push({ callId: call.id, toolName: call.name, output: call.name === "get_place_reviews" ? "默认规划暂不追加一般口碑查询，本次未联网。复用候选评分；参观资料缺口使用get_place_visit_info。用户明确需要体验信息或严格餐饮时才查询口碑。" : "该事项已有结论或不是本次尚缺的参观资料，本次未联网。复用状态卡与证据索引；未知保持待确认，不要换词、字段或工具重搜。请直接保存缺失日期或修订明确问题。" });
              continue;
            }
          }
          if ((cumulative.deliveryStagnantRounds ?? 0) >= DEFER_OPTIONAL_EVIDENCE_AFTER
            && !(roundTaskLayer === "budget" && call.name === "search_restaurants")
            && isDeferredEvidenceCall(call.name, call.arguments, strictMeals(), cumulative.allowAdvisoryReviews)) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
            cumulative.queryStats.blocked++;
            pendingResults.push({ callId: call.id, toolName: call.name, output: deliveryGuidance(cumulative)! });
            continue;
          }
          if (call.name === "save_travel_brief" && this.briefSavedThisRun) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
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
          if (scope && (activeDayTask(this.sessionValue.travelState)?.attempt_calls ?? 0) + dayCallsThisRound >= dayTaskCalls(activeDayTask(this.sessionValue.travelState)!)) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
            pendingResults.push({ callId: call.id, toolName: call.name, output: "该日期本次工具额度已用完，本调用未执行；程序将切换到其他日期。" }); continue;
          }
          if (cumulative.calls >= cumulative.maxCalls || cumulative.costExceeded?.() === true || (cumulative.maxTokens !== undefined && cumulative.tokens >= cumulative.maxTokens)) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "blocked");
            pendingResults.push({ callId: call.id, toolName: call.name, output: "已达到累计工具或费用上限，本次调用未执行。" });
            continue;
          }
          const allowed = await this.checkPermission(call, tools, options);
          if (!allowed) {
            cumulative.diagnostics.skip(call, cumulative.rounds + 1, "denied");
            pendingResults.push({
              callId: call.id,
              toolName: call.name,
              output: "用户拒绝授权执行此工具。请调整方案或改用其他方式。",
            });
            options.onEvent?.({ type: "tool_denied", name: call.name });
            continue;
          }

          let snapshotReceived = false;
          let preparedArgs: Record<string, unknown> | undefined;
          let argumentCorrections: readonly string[] = [];
          cumulative.calls += 1;
          if (scope) dayCallsThisRound += 1;
          if (effectiveBasicStage && call.name === "search_attractions") cumulative.basicDiscoveryCalls!.set(this.sessionValue.travelState!.brief!.title, basicQueries() + 1);
          const awaitingPlan = !this.briefSavedThisRun && !this.savedThisRun;
          const allocatingPlan = newTravelPlan && awaitingPlan;
          const creatingBrief = call.name === "save_travel_brief" && awaitingPlan && dailyEnabled && !resumingDates && !currentTravel?.brief && !currentTravel?.itinerary;
          const execution = await cumulative.diagnostics.run(call, cumulative.rounds + 1, () => this.executeTool(
            call,
            tools,
            { workspace: this.workspace, operationId: `${this.sessionValue.id}:${callBatch.id}:${call.id}`, signal: controller.signal, readVersions: this.sessionValue.travelMode ? cumulative.readVersions : undefined, readCallId: call.id, queryAttempts: cumulative.queryAttempts, queryStats: cumulative.queryStats,
              basicPlanning: effectiveBasicStage,
              newTravelPlan: allocatingPlan || creatingBrief,
              isolateDisjointTripDates: dailyEnabled,
              dayPlanningScope: scope,
              destination: this.sessionValue.travelState?.brief?.destination,
              travelMode: this.sessionValue.travelMode,
              onArgumentsPrepared: (args, corrections) => { preparedArgs = args; argumentCorrections = corrections; },
              brief: allocatingPlan ? undefined : this.sessionValue.travelState?.brief,
              // 当前请求产生新授权；之前已确认的授权随对应行程持久化，不挪用其他任务的旧消息。
              userRequests: this.sessionValue.history.filter((message) => message.role === "user").slice(-1).map(({ id, content }) => ({ id, content })),
              onBrief: (brief) => {
                snapshotReceived = true;
                if ((allocatingPlan || this.briefSavedThisRun) && call.name === "load_travel_brief" && this.sessionValue.travelState?.brief?.title !== brief.title) return;
                if (this.committedSnapshot?.itinerary.title !== brief.title) this.committedSnapshot = undefined;
                this.sessionValue.setTravelState(updateTravelStateFromBrief(this.sessionValue.travelState, { ...brief }));
              },
              onItinerary: (snapshot) => {
                snapshotReceived = true;
                const brief = this.sessionValue.travelState?.brief;
                if (call.name !== "save_itinerary" && (allocatingPlan || this.briefSavedThisRun && brief?.title !== snapshot.itinerary.title)) return;
                this.committedSnapshot = snapshot;
                if (call.name === "save_itinerary") {
                  this.savedThisRun = true;
                  for (const dayNumber of snapshot.report.changed_days ?? []) {
                    const date = snapshot.itinerary.days[dayNumber - 1]?.date;
                    if (date) savedRouteDates.add(date);
                  }
                }
                this.sessionValue.setTravelState(updateTravelStateFromSnapshot(this.sessionValue.travelState, snapshot));
              },
            },
            onEvent,
          ));
          let output = (argumentCorrections.length ? `参数按兼容规则规范化：${argumentCorrections.join("；")}。\n` : "") + execution.output;
          if (dayPlanning && roundTaskDate && call.name === "save_itinerary" && execution.error && execution.executionState?.effect_status !== "committed" && execution.executionState?.effect_status !== "unknown") {
            const args = safeArguments(call.arguments);
            if (args && Array.isArray(args.days) && args.days.every((day) => day && typeof day === "object" && day.date === roundTaskDate)) {
              const path = join(this.workspace, ".minicode", "day-tasks", evidenceId([scope?.title, roundTaskDate, scope?.layer]), "rejected-draft.json");
              await mkdir(resolve(path, ".."), { recursive: true });
              await atomicWrite(path, JSON.stringify({ task_date: roundTaskDate, status: "rejected", args, error: execution.error }, null, 2));
              this.sessionValue.setTravelState(setDayTaskDraft(this.sessionValue.travelState!, roundTaskDate, path));
            }
          }
          if (execution.executionState?.code === "RESOURCE_RECOVERY_REQUIRED" || execution.executionState?.exports_pending || (execution.executionState?.execution_status !== "succeeded" && ["committed", "unknown", "partial"].includes(execution.executionState?.effect_status ?? ""))) {
            uncertainEffect = true; circuitOpen = true;
            cumulative.operationRecovery = execution.executionState;
            cumulative.blockedKind = "dependency";
            cumulative.blockedReason = execution.executionState?.code === "RESOURCE_RECOVERY_REQUIRED" ? `前次操作 ${execution.executionState.blocked_by_operation_id} 尚待核对或恢复，本次修改未执行；请先处理该操作。`
              : execution.executionState?.exports_pending ? "主文件已提交，部分导出尚未完成；已停止本批后续调用，请先重建导出，不要重复保存。"
              : execution.executionState?.effect_status === "committed" ? "主文件已提交，但工具后续处理失败；已停止本批后续调用，请先读取当前版本，不要原样重放。"
              : "工具副作用结果未知或部分提交；已停止本批后续调用，不自动重放。请先核对实际状态。";
            failureGuidance = cumulative.blockedReason;
          }
          if (execution.error === undefined) {
            if (!isActivationTool(call.name)) hadSuccessfulToolCall = true;
            if (call.name === "save_itinerary" && execution.executionState?.effect_status === "committed" && !execution.executionState.replayed) committedPlanThisRun = true;
            if (call.name === "plan_day_routes") routesQueried = true;
            failureKey = "";
            failureCount = 0;
            failureGuidance = cumulative.operationRecovery ? cumulative.blockedReason : undefined;
          } else {
            recordFailure(call.name, execution.error);
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
              cumulative.blockedKind = "dependency";
            }
          }
          if (!snapshotReceived) recordTravelToolResult(this.sessionValue, preparedArgs ? { ...call, arguments: JSON.stringify(preparedArgs) } : call, output, execution.error);
          pendingResults.push({
            callId: call.id,
            toolName: call.name,
            output,
            ...(execution.executionState ? { executionState: execution.executionState } : {}),
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
          if (item.truncated) undoReadDelivery(cumulative.readVersions, item.callId);
          this.sessionValue.add("tool", item.text, {
            toolCallId: item.callId,
            toolName: pendingResults.find((result) => result.callId === item.callId)?.toolName,
            toolExecution: pendingResults.find((result) => result.callId === item.callId)?.executionState,
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
          const improved = recordDeliveryProgress(this.sessionValue.travelState, cumulative);
          if (improved) earlyFinalizations = 0;
          if (improved) cumulative.redundantCalls = 0;
          const currentFacts = facts();
          const newFact = currentFacts.some((key) => !cumulative.observedEvidence!.has(key));
          currentFacts.forEach((key) => cumulative.observedEvidence!.add(key));
          stagnantRounds = improved || newFact ? 0 : stagnantRounds + 1;
          cumulative.stagnantRounds = stagnantRounds;
          if (stagnantRounds >= 6) failureGuidance = "连续多轮未增加地点/路线证据或保存内容。请复用已核验候选，保存缺失日期或按质量报告修订；不要重复读取需求单或改词重搜相同候选。";
          if (stagnantRounds >= 12) { circuitOpen = true; failureGuidance = "连续 12 轮无实际进展，已停止调用；已保存版本仍有缺口时必须明确列出。"; }
        }
        const observations = cumulative.diagnostics.records.slice(diagnosticStart);
        for (const observation of observations) {
          if (observation.execution !== "blocked" && observation.execution !== "denied") continue;
          const result = pendingResults.find((item) => item.callId === observation.call_id);
          if (result) recordFailure(result.toolName, result.output);
        }
        if (this.sessionValue.travelState?.brief !== undefined) {
          const progressThisRound = cumulative.deliveryStagnantRounds === 0;
          if (!progressThisRound) cumulative.redundantCalls = (cumulative.redundantCalls ?? 0) + observations.filter((r) => r.execution === "blocked" || r.execution === "cache_hit").length;
        }
        const onlyReuse = observations.length === result.toolCalls.length && observations.length > 0 && observations.every((r) => r.execution === "cache_hit" || r.execution === "blocked");
        cumulative.redundantRounds = onlyReuse ? (cumulative.redundantRounds ?? 0) + 1 : 0;
        if (cumulative.redundantRounds > 0) failureGuidance = "本轮只有缓存复用或重复拦截，没有新增资料；不要再读同一版本或换词重搜。直接保存缺失日期、修订已知错误，或汇报确实缺少的依据。";
        if (cumulative.redundantRounds >= MAX_REDUNDANT_ROUNDS) { circuitOpen = true; failureGuidance = "连续3轮只有重复调用、无新资料或修改，已停止重复循环；未通过的条件仍须如实列出。"; cumulative.blockedReason = failureGuidance; cumulative.blockedKind = "no_progress"; }
        if (dayPlanning && roundTaskDate) {
          const calls = observations.filter((r) => r.execution !== "blocked" && r.execution !== "denied").length;
          const lastError = [...pendingResults].reverse().find((item) => item.error)?.error;
          this.sessionValue.setTravelState(recordDayTaskRound(this.sessionValue.travelState!, roundTaskDate, calls, lastError, roundTaskLayer, roundTaskGoal));
          const beforeLayerDay = snapshotBeforeRound?.itinerary.planning_layers?.days.find((day) => day.date === roundTaskDate);
          const currentLayers = this.sessionValue.travelState?.itinerary?.planningLayers;
          const currentLayerDay = currentLayers?.days.find((day) => day.date === roundTaskDate);
          if (roundTaskLayer === "schedule" && beforeLayerDay?.schedule === "missing" && currentLayerDay?.schedule === "draft" && currentLayers?.days.some((day) => day.date !== roundTaskDate && day.schedule === "missing")) {
            this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, roundTaskDate, "已保存时间草稿；先补齐其他日期，再完善本日质量问题"));
            nextDateTask();
          }
          if (circuitOpen && cumulative.blockedKind !== "dependency") {
            this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, roundTaskDate, failureGuidance ?? lastError ?? "该日期重复调用停滞"));
            circuitOpen = false; nextDateTask();
          }
          await this.checkpoint(options);
        }
        if (routeFollowUp && cumulative.blockedKind !== "dependency") circuitOpen = false;
        if (!dayPlanning && circuitOpen && cumulative.blockedKind !== "dependency") {
          const recovery = recoverCoverage(this.sessionValue.travelState, cumulative);
          if (recovery) { circuitOpen = false; failureGuidance = recovery; stagnantRounds = 0; }
          else { cumulative.blockedKind = "no_progress"; cumulative.blockedReason = failureGuidance ?? "局部修订停滞，保留未完成版本"; }
        }
        options.onToolRound?.({ round: executed, limit, toolCalls: result.toolCalls.length });
        if (circuitOpen) break;
      }
      if (dayPlanning) {
        const unfinished = activeDayTask(this.sessionValue.travelState);
        if (unfinished) this.sessionValue.setTravelState(blockDayTask(this.sessionValue.travelState!, unfinished.date,
          modelFailure ? `模型请求未完成：${modelFailure}` : failureGuidance ?? budgetGuidance ?? "任务预算达到上限，保留该日期进度待续接"));
      }
      // 优先用已保存状态交付。没有可用快照时，模型收尾失败也交付本地记录。
      const canonical = this.canonicalReply(false);
      const details = failureDetails();
      const stopReason = circuitOpen ? "工具调用因重复失败或未取得进展而停止。" : `已用完本轮 ${executed} 轮工具额度。`;
      if (modelFailure || canonical !== undefined || exhausted() || stagnantRounds >= 12 || cumulative.operationRecovery !== undefined || (circuitOpen && this.sessionValue.travelState?.brief !== undefined)) {
        const recoveryNote = cumulative.operationRecovery ? `操作 ${cumulative.operationRecovery.operation_id ?? "当前调用"}：${cumulative.operationRecovery.effect_status}。请先核对状态，未自动重放。` : undefined;
        const budgetResult = canonical !== undefined ? extensionSummary() ?? budgetGuidance : budgetGuidance;
        const status = this.sessionValue.travelState || failedSaveThisRun ? planStatus() : undefined;
        return finish([
          modelFailure ? `工具执行后的模型请求未完成。原因是 ${modelFailure}` : budgetResult,
          modelFailure ? undefined : failureGuidance,
          canonical === undefined || !committedPlanThisRun ? status : undefined,
          recoveryNote,
          details,
          nextStep(),
          canonical,
        ].filter(Boolean).join("\n\n") || "本轮已停止。累计预算已用尽。");
      }
      if (failedSaveThisRun && !committedPlanThisRun) {
        return finish([planStatus(), stopReason, details, nextStep()].filter(Boolean).join("\n\n"));
      }
      const wrapUp = await this.forceFinalAnswer(
        [budgetGuidance, failureGuidance].filter((value) => value !== undefined).join("\n\n"),
        circuitOpen
          ? "检测到同一工具错误连续重复，已熔断工具调用"
          : "工具调用轮次已全部用尽",
      );
      syncUsage();
      return finish([
        failedSaveThisRun || (!wrapUp.reply && this.sessionValue.travelState) ? planStatus() : undefined,
        wrapUp.reply ?? `${stopReason}模型未能生成收尾回复。原因是 ${wrapUp.reason}`,
        details,
        nextStep(),
      ].filter(Boolean).join("\n\n"));
    } finally {
      this.currentController = undefined;
    }
  }

  private async compactContext(tokens: number, options: RunOptions): Promise<void> {
    if (options.compactContext !== undefined) { await options.compactContext(tokens); return; }
    await new ContextEpochManager({ maxPromptTokens: options.maxPromptTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      archive: async (session, epoch) => {
        const directory = join(this.workspace, ".minicode", "epochs");
        await mkdir(directory, { recursive: true });
        await atomicWrite(join(directory, `${encodeURIComponent(session.id)}-${epoch}.json`), JSON.stringify(session.toData()));
      },
      summarize: (session, messages) => summarizeContext(this.provider, session, messages, this.currentController?.signal, options.maxPromptTokens),
    }).maybeCompact(this.sessionValue, tokens);
  }

  private async preparePlainHistory(transient: readonly PromptMessage[], options: RunOptions = {}): Promise<PromptMessage[]> {
    const measure = () => measureRequestContext(this.sessionValue, this.provider.systemPrompt, this.sessionValue.toPrompt(), transient, [], options.maxPromptTokens);
    let metrics = measure();
    if (metrics.estimatedInputTokens > metrics.inputLimit) {
      await this.compactContext(metrics.estimatedInputTokens, options);
      metrics = measure();
    }
    this.sessionValue.recordRequestContext(metrics);
    options.onRequestContext?.(metrics);
    if (metrics.estimatedInputTokens > metrics.inputLimit) throw new ContextInputLimitError(metrics);
    return [...this.sessionValue.toPrompt(), ...transient];
  }

  private canonicalReply(requireSave = true): string | undefined {
    if ((requireSave && !this.savedThisRun) || this.committedSnapshot === undefined) return undefined;
    const { itinerary, report, file } = this.committedSnapshot;
    const brief = this.sessionValue.travelState?.brief;
    if (brief && itinerary.title !== brief.title && (this.briefSavedThisRun || brief.requestedTitle)) return undefined;
    const progress = planningProgress(this.sessionValue.travelState);
    if (!this.savedThisRun && progress.dates.length && itinerary.days.length && itinerary.days.every((day) => day.date && !progress.dates.includes(day.date))
      && !itinerary.outline?.some((day) => progress.dates.includes(day.date))) return undefined;
    const passed = report.issue_count.P0 === 0 && report.issue_count.P1 === 0 && progress.remaining === 0 && this.sessionValue.travelState?.itinerary?.complete !== false;
    return [
      `已保存「${itinerary.title}」v${itinerary.revision ?? 1}，${itinerary.days.length} 天 / ${itinerary.days.reduce((sum, day) => sum + day.items.length, 0)} 项。strict ${passed ? "通过" : "未通过，当前版本尚未通过 strict 校验，以下为待修订版本"}。`,
      ...(progress.expected === undefined ? [] : [`完整性: 有效${progress.count}/${progress.expected}天${progress.remaining > 0 ? `，尚未完成${progress.missing.length ? `；缺失日期：${progress.missing.join("、")}` : ""}` : ""}`]),
      `[行程文件](${file}) · [质量报告](${file.slice(0, -5)}.quality.md)`,
      renderMarkdown(itinerary, report.budget),
      ...(passed && report.issues.length === 0 ? [] : [renderQualityReport(report)]),
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
   * 失败时返回原因，调用方用本地记录生成最终回复。
   */
  private async forceFinalAnswer(
    guidance?: string,
    reason: string = "工具调用轮次已全部用尽",
  ): Promise<{ reply: string; reason?: never } | { reply?: never; reason: string }> {
    const instruction: PromptMessage = {
      role: "system",
      content:
        `${reason}，工具已被禁用。请基于以上已获得的信息直接给出最终回答：` +
        "保留关键结论与数据；未查到的部分明确说明，不要再请求调用工具。" +
        "如果本轮还有没做完的收尾动作（如某天还没保存、质量校验还没通过），必须如实说明做到哪一步，" +
        "并给用户一句可操作的下一步（例如回复「继续」接着修），不要声称已完成或已通过校验。" +
        (guidance === undefined ? "" : `\n\n${guidance}`),
    };
    try {
      const history = await this.preparePlainHistory([instruction]);
      let reply: string;
      if (this.provider.chatWithUsage !== undefined) {
        const result = await this.provider.chatWithUsage(history, this.currentController?.signal);
        if (result.usage !== undefined) { this.sessionValue.addUsage(result.usage); this.sessionValue.completeRequestContext(result.usage); }
        reply = result.type === "text" ? result.content : "";
      } else if (this.provider.chatStream !== undefined) {
        reply = await this.provider.chatStream(history, () => {});
      } else {
        reply = await this.provider.chat(history);
      }
      return reply.trim() ? { reply } : { reason: EMPTY_MODEL_REPLY };
    } catch (error) {
      return { reason: describeTurnError(error) };
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
  ): Promise<{ readonly output: string; readonly error?: string; readonly errorCode?: string; readonly errorCategory?: ToolErrorCategory; readonly executionState?: ToolExecutionState }> {
    safeEmit(()=>{
    onEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });
    });
    try {
      const execution = isActivationTool(call.name)
        ? { output: executeToolCatalog(
            call.name,
            parseToolArguments(call.arguments),
            tools,
            this.sessionValue,
          ) }
        : await this.executeRegisteredTool(call, tools, ctx);
      const { output, error, executionState } = execution;
      if (error) {
        safeEmit(() => onEvent?.({ type: "tool_error", name: call.name, error, code: executionState?.code, error_type: "execution", execution_state: executionState }));
        return { ...execution, output: JSON.stringify({ error, execution_state: executionState, output }), errorCode: executionState?.code };
      }
      safeEmit(()=>{
      onEvent?.({ type: "tool_end", name: call.name, output });
      });
      return execution;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeEmit(() => onEvent?.({ type: "tool_error", name: call.name, ...toolErrorPayload(error) }));
      // 错误也回传给模型，让它有机会自行调整参数重试
      return { output: toolErrorOutput(error), error: message, executionState: executionStateOf(error), ...(error instanceof ToolValidationError ? { errorCode: error.code, errorCategory: "validation" as const } : {}) };
    }
  }

  private requestToolDefinitions(tools: ToolRegistry) {
    const active = activeToolNames(tools, this.sessionValue);
    const hasOptionalTools = tools.list().some((tool) => !isAlwaysActiveTool(tool, this.sessionValue));
    const optionalDefinitions = tools
      .definitions(active)
      .filter((definition) => !isActivationTool(definition.name));
    return planningDefinitions(hasOptionalTools
      ? [...TOOL_ACTIVATION_DEFINITIONS, ...optionalDefinitions]
      : optionalDefinitions, this.sessionValue.travelState);
  }

  private async executeRegisteredTool(
    call: ToolCall,
    tools: ToolRegistry,
    ctx: ToolContext,
  ): Promise<{ output: string; error?: string; executionState?: ToolExecutionState }> {
    const tool = tools.get(call.name);
    if (
      tool !== undefined &&
      !isAlwaysActiveTool(tool, this.sessionValue) &&
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
    const output = await tools.executeDetailed(call.name, call.arguments, ctx);
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
  return executedRounds >= 8 && state?.brief !== undefined && (state.itinerary?.materializedDays ?? state.itinerary?.dayCount ?? 0) === 0;
}

function travelProgressGuidance(draftGate: boolean): string | undefined {
  if (!draftGate) return undefined;
  return (
    "【行程落盘提醒】需求单已经保存，但当前还没有可评估的行程。请减少扩展搜索，" +
    "先补全局outline分配；已有粗排时，立即save_itinerary保存下一缺失日期的实际安排，不能把骨架算作完成。缺少少量资料可标待确认后补齐，" +
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
    "停止原样重试。被压缩的 `_truncated` 参数不是可执行参数；缺字段时用load_itinerary(day,item_ids)精准获取，归档按已读游标续读，不要重新加载整份行程。",
    "如果当前信息不足以继续，请如实说明未完成、已经保存到哪一步和具体阻塞原因，不要继续空转。",
  ].join("\n");
}

/** 未保存当前日时，也保留最近正在核实的地点与路线端点，不依赖完整工具原文。 */
function recentEvidenceNames(session: Session): string[] {
  const names = new Set<string>();
  for (const message of session.history.slice(-20).reverse()) {
    for (const call of message.archivedToolCalls ?? message.toolCalls ?? []) {
      const args = safeArguments(call.arguments);
      if (args === null) continue;
      if (typeof args.place === "string") names.add(args.place);
      if (Array.isArray(args.stops)) for (const name of args.stops) if (typeof name === "string") names.add(name);
    }
    if (names.size >= 20) break;
  }
  return [...names].slice(0, 20);
}

/** 只保留少量归档索引；完整结果需要时用 read_file 按需读取。 */
function renderArtifactGuide(session: Session, workspace: string, reads?: Map<string, string>): string | undefined {
  const artifacts = new Map<string, { toolName: string; order: number }>();
  for (const [index, message] of session.history.entries()) {
    if (message.role !== "tool") continue;
    if (message.toolName === "read_file") continue;
    const path = /\bartifact=([^\s\n]+)/.exec(message.content)?.[1];
    if (path === undefined || path === "unavailable") continue;
    artifacts.set(path, { toolName: message.toolName ?? "tool", order: index });
  }
  const recent = [...artifacts.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .slice(0, 8);
  if (recent.length === 0) return undefined;
  return [
    "【工具原文归档索引】按已读进度续读，不重复从0开始；行程局部字段优先load_itinerary(day,item_ids)：",
    ...recent.map(([path, item]) => {
      const progress = artifactReadStatus(reads, resolve(workspace, path));
      return `- ${item.toolName}: ${path}${progress?.complete ? "（已完整读取，勿重读）" : `；byte_offset=${progress?.next ?? 0}`}`;
    }),
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
