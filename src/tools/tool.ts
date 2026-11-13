import { externalNow } from "../core/external-environment.ts";
import { normalizeToolArguments, parseToolInput, validateToolArguments } from "./tool-contract.ts";
import { attachExecutionState, executionStateOf, reportExecution, type ExecutionContext, type ToolExecutionState } from "../core/execution-state.ts";
import { recoverManagedOperations } from "../storage/managed-operation.ts";
import { annotateToolCall, toolErrorCategory } from "../core/tool-diagnostics.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolParameters } from "../llm/provider.ts";
import { isCompactedToolArguments } from "../core/message.ts";
import { TravelEvidenceStore, evidenceId } from "./travel-evidence.ts";
import type { Itinerary } from "./itinerary-schema.ts";
import type { ItineraryQualityReport } from "./itinerary-validator.ts";
import { attractionMinRating, TRAVEL_ATTRACTION_MIN_RATING, TRAVEL_QUERY_TOOLS, normalizeReviewArgs, normalizeVisitInfoArgs, queryFields, queryKeyArgs, querySummary, type QueryStatus } from "./travel-query.ts";
import type { ToolQueryStats } from "../core/usage.ts";
import { isHistoricalOpening } from "./opening-facts.ts";
import { discoveryCenterName, DiscoveryBudgetError, type DiscoveryTool } from "./discovery-pool.ts";
import { convertPoint } from "./coordinates.ts";
import type { GeoResult } from "./geocoding.ts";
import { briefBudgetPlan } from "./brief.ts";

export interface ItinerarySnapshot {
  readonly itinerary: Itinerary;
  readonly report: ItineraryQualityReport;
  readonly file: string;
}

export type { ToolParameters };
export type { ToolDefinition };
export { isCompactedToolArguments };

/** 参数校验：要求非空字符串 */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少或非法参数 ${key}（需要非空字符串）`);
  }
  return value.trim();
}

/** 参数校验：要求有效数字 */
export function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`缺少或非法参数 ${key}（需要数字）`);
  }
  return value;
}

/** 校验 absolute 路径在 rootDir 内（relative 判断，防 /root 与 /root-evil 前缀绕过） */
export function assertInsideRoot(rootDir: string, absolute: string): void {
  const root = resolve(rootDir);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`安全限制: 只能访问 ${root} 目录内的路径`);
  }
}

/** 单次工具调用的运行上下文：工作区（文件/命令的根）与中断信号 */
export interface ToolContext extends ExecutionContext {
  readonly onArgumentsPrepared?: (args: Record<string, unknown>, corrections: readonly string[]) => void;
  readonly basicPlanning?: boolean;
  readonly dayPlanningScope?: import("../core/day-tasks.ts").DayPlanningScope;
  /** 本次调用所属会话的工作区；文件类工具与 bash 以此为根 */
  readonly workspace: string;
  /** 中断信号（/stop）：长任务（如 bash）应立即终止 */
  readonly signal?: AbortSignal;
  readonly destination?: string;
  readonly travelMode?: boolean;
  readonly brief?: import("../core/travel-state.ts").TravelBriefState;
  /** 宿主提供的原始用户消息；不接受工具参数中的自报授权。 */
  readonly userRequests?: readonly import("./repeat-visit-policy.ts").UserRequest[];
  readonly evidence?: TravelEvidenceStore;
  readonly onBrief?: (brief: import("./brief.ts").TravelBrief) => void;
  readonly onItinerary?: (snapshot: ItinerarySnapshot) => void;
  readonly readVersions?: Map<string, string>;
  /** 已读范围只在对应工具结果完整交付后生效。 */
  readonly readCallId?: string;
  readonly queryAttempts?: Map<string, number>;
  readonly queryStats?: ToolQueryStats;
  /** 原始候选池未覆盖本次需求时，在 POI 联网前扣除同中心预算。 */
  readonly beforeDiscoveryFetch?: (geo?: GeoResult) => void;
  /** 本地重筛不占联网次数，缓存时间沿用原始采集时间。 */
  readonly onDiscoveryReuse?: (observedAt: number) => void;
  /** 两种地点资料工具复用来源时，保留原采集时间和缓存统计。 */
  readonly onQueryReuse?: (observedAt: number) => void;
}

export interface Tool {
  /** 调度与恢复元数据；当前仍串行执行，不据此擅自推断数据依赖。 */
  readonly effect?: "query" | "managed_write" | "command";
  /** 业务产物根可能与会话命令工作区不同，恢复时必须同时核对。 */
  readonly operationRoot?: string;
  readonly recordsPlaceEvidence?: boolean;
  readonly supportsRoutineVisitInfo?: boolean;
  readonly supportsRoutineRouteQuery?: boolean;
  readonly usesDiscoveryPool?: boolean;
  readonly name: string;
  /** 给 LLM 看的描述：决定模型何时、如何使用这个工具 */
  readonly description: string;
  readonly parameters: ToolParameters;
  /** 工具目录分类；未分类的第三方工具会被视为常驻，兼容现有扩展 */
  readonly category?: ToolCategory;
  /** 目录检索词；不要用它们替代 description */
  readonly keywords?: readonly string[];
  /** 常驻工具：每个请求都发送完整定义，只用于极小且高频的核心能力 */
  readonly alwaysActive?: boolean | "travel";
  /** 返回结果类型，供裁剪结果和模型快速判断数据结构 */
  readonly outputKind?: ToolOutputKind;
  /** 执行工具，返回 LLM 可读的文本结果（出错时 throw，由 Agent 捕获回传） */
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string>;

  /** 执行前需要用户确认（写文件、读敏感文件等有副作用的操作） */
  readonly requiresConfirmation?: boolean;

  /**
   * 动态确认判断（按参数决定，如 bash 只读命令免确认）。
   * 存在时优先于 requiresConfirmation；返回 true 表示需要用户确认。
   */
  needsConfirmation?(args: Record<string, unknown>): boolean;

  /** 是否允许「本次会话总是允许」选项（bash 等高风险工具应设 false，保持逐条确认） */
  readonly sessionAlwaysAllowed?: boolean;

  /** 工作区内文件写入类工具：审批模式为「自动编辑」时免确认 */
  readonly workspaceEdit?: boolean;

  /** 确认时展示给用户看的人类可读描述 */
  confirmationMessage?(args: Record<string, unknown>): string;
}

export type ToolCategory =
  | "workspace"
  | "travel-basics"
  | "discovery"
  | "routing"
  | "itinerary"
  | "traveler";

export type ToolOutputKind =
  | "file"
  | "command"
  | "place-list"
  | "route"
  | "itinerary"
  | "validation"
  | "weather"
  | "profile"
  | "generic";

export class ToolRegistry {
  private readonly recovery = new Map<string, Promise<unknown>>();
  private readonly pendingQueries = new Map<string, { promise: Promise<string>; signal?: AbortSignal; evidence: TravelEvidenceStore }>();
  private readonly pendingDiscovery = new Map<string, { promise: Promise<string>; signal?: AbortSignal; evidence: TravelEvidenceStore }>();
  private readonly tools = new Map<string, Tool>();
  readonly evidence: TravelEvidenceStore;
  private readonly defaultWorkspace: string;
  private readonly persistenceRoot: string;
  constructor(root?: string, workspace?: string) { this.evidence = new TravelEvidenceStore(root); this.defaultWorkspace = workspace ?? root ?? process.cwd(); this.persistenceRoot = root ?? process.cwd(); }

  operationRoots(workspace = this.defaultWorkspace): string[] {
    return [...new Set([workspace, this.persistenceRoot, ...this.list().flatMap((tool) => tool.operationRoot ? [tool.operationRoot] : [])].map((root) => resolve(root)))];
  }

  /** 兼容原有字符串工具；Agent/MCP 使用此入口取得统一执行与副作用状态。 */
  async executeDetailed(name: string, argsJson: string, ctx?: Omit<ToolContext, "workspace"> & { workspace?: string }): Promise<{ output: string; error?: string; executionState?: ToolExecutionState }> {
    let state: ToolExecutionState | undefined;
    try {
      const output = await this.execute(name, argsJson, { workspace: ctx?.workspace ?? this.defaultWorkspace, ...ctx,
        onExecution: (value) => { state = value; reportExecution(ctx, value); },
      });
      state ??= { execution_status: "succeeded", effect_status: this.get(name)?.effect === "managed_write" || this.get(name)?.effect === "command" ? "unknown" : "none", recovery_action: "none" };
      return { output, ...(state ? { executionState: state } : {}), ...(state && state.execution_status !== "succeeded" ? { error: state.message ?? state.code ?? "工具执行失败" } : {}) };
    } catch (error) {
      state ??= executionStateOf(error);
      if (!state) {
        const category = toolErrorCategory(error), tool = this.get(name), invalid = ["invalid_arguments", "validation"].includes(category);
        state = { execution_status: category === "cancelled" ? "cancelled" : "failed",
          effect_status: invalid ? "not_committed" : tool?.effect === "managed_write" || tool?.effect === "command" ? "unknown" : "none",
          recovery_action: invalid ? /版本冲突/.test(String(error)) ? "reread" : "fix_arguments" : ["network", "timeout", "rate_limit"].includes(category) && tool?.effect !== "managed_write" && tool?.effect !== "command" ? "retry" : "manual_review" };
      }
      attachExecutionState(error, state); throw error;
    }
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  /** 导出为 LLM API 的 tools 参数；省略 names 时导出全部（MCP 等场景） */
  definitions(names?: ReadonlySet<string>): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => names === undefined || names.has(tool.name))
      .map(({ name, description, parameters }) => ({
        name,
        description: toolOutputDescription(description, this.tools.get(name)),
        parameters,
      }));
  }

  /**
   * 按名称执行工具。参数是 LLM 给的原始 JSON 字符串。
   * 工具不存在或参数非法都会抛错——Agent 会把错误文本回传给模型。
   */
  async execute(name: string, argsJson: string, ctx?: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`工具不存在: ${name}（可用: ${[...this.tools.keys()].join(", ")}）`);
    }
    const workspace = resolve(ctx?.workspace ?? this.defaultWorkspace);
    const prepared = normalizeToolArguments(name, parseToolInput(argsJson));
    let args = prepared.args;
    if (args._truncated === true) {
      throw new Error(
        "参数是会话历史压缩占位符（_truncated），工具未执行；" +
        "请重新读取当前数据并按工具 schema 构造完整参数，不要把占位符原样再次提交",
      );
    }
    if (name === "get_place_reviews") args = normalizeReviewArgs(args);
    if (name === "get_place_visit_info") args = normalizeVisitInfoArgs(args);

    ctx?.signal?.throwIfAborted();
    const context = { workspace: ctx?.workspace ?? this.defaultWorkspace, ...ctx, evidence: ctx?.evidence ?? this.evidence };
    const destination = context.destination;
    if (destination !== undefined) {
      if (name === "search_attractions" || name === "get_place_reviews" || name === "get_place_visit_info") args.city = destination;
      if (name === "search_stays" || name === "search_restaurants") args.region = destination;
      if (name === "geocode" || name === "plan_day_routes") args.city = destination;
    }
    if (name === "search_stays" || name === "search_restaurants" || name === "search_attractions") {
      const budget = context.brief ? briefBudgetPlan(context.brief) : undefined;
      if (name === "search_attractions" && context.travelMode && args.min_rating === undefined) args.min_rating = budget?.economy ? 0 : TRAVEL_ATTRACTION_MIN_RATING;
      if (name === "search_stays" && budget?.economy && args.economy === undefined) args.economy = true;
      const field = name === "search_stays" ? "max_room_price" : name === "search_attractions" ? "max_visit_cost" : "max_cost";
      const planned = name === "search_stays" ? budget?.roomPerNight : name === "search_attractions" ? budget?.visitsPerPersonDay : budget?.mealPerPerson;
      const explicit = args[field];
      if (explicit === undefined || typeof explicit === "number") {
        const userCap = name === "search_restaurants" ? context.brief?.budgetPerMealYuan : undefined;
        const flexible = context.dayPlanningScope?.layer === "budget" && explicit !== undefined;
        const cap = Math.min(explicit ?? Infinity, userCap ?? Infinity, flexible ? Infinity : planned ?? Infinity);
        if (Number.isFinite(cap)) args[field] = cap;
      }
    }
    validateToolArguments(tool.parameters, args);
    context.onArgumentsPrepared?.(args, prepared.corrections);
    for (const root of this.operationRoots(workspace)) {
      if (!this.recovery.has(root)) this.recovery.set(root, recoverManagedOperations(root));
      await this.recovery.get(root);
    }
    const cacheable = TRAVEL_QUERY_TOOLS.includes(name);
    await context.evidence.load();
    const pooledDiscovery = tool.usesDiscoveryPool === true && (name === "search_attractions" || name === "search_restaurants");
    const discoveryCity = String(name === "search_attractions" ? args.city ?? "" : args.region ?? destination ?? args.city ?? "");
    if (pooledDiscovery) {
      const field = name === "search_attractions" ? "location" : "city";
      if (typeof args[field] === "string") args[field] = context.evidence.canonicalPlaceName(discoveryCenterName(args[field], discoveryCity), discoveryCity);
    }
    if (["get_place_reviews", "get_place_visit_info"].includes(name) && typeof args.place === "string" && typeof args.city === "string") args.place = context.evidence.canonicalPlaceName(args.place, args.city);
    if (name === "get_place_visit_info" && args.refresh !== true) {
      const requested = args.fields as string[];
      const opening = requested.filter((field): field is import("./opening-facts.ts").OpeningField => field !== "visit_duration");
      const missing: string[] = context.evidence.missingOpeningFields(String(args.city ?? ""), String(args.place ?? ""), opening, typeof args.visit_date === "string" ? args.visit_date : undefined);
      if (requested.includes("visit_duration") && !context.evidence.visitInfoFacts(String(args.city ?? ""), String(args.place ?? ""), ["visit_duration"])) missing.push("visit_duration");
      if (args.visit_date && requested.includes("notices") && !missing.includes("notices")) missing.push("notices");
      if (missing.length && missing.length < requested.length) args.fields = missing;
    }
    if (name === "plan_day_routes" && Array.isArray(args.stops) && typeof args.city === "string") args.stops = args.stops.map((stop) => typeof stop === "string" ? context.evidence.canonicalPlaceName(stop.trim(), String(args.city)) : stop);
    const routePoints = name === "plan_day_routes" && Array.isArray(args.stops) ? args.stops.map((stop) => context.evidence.point(String(stop), String(args.city))) : undefined;
    const protectedVisits = name === "search_attractions" && attractionMinRating(args.min_rating) !== undefined
      ? [...new Set(context.brief?.mustVisit ?? [])].sort() : [];
    const key = evidenceId([name, queryKeyArgs(name, args), ...(routePoints === undefined ? [] : [routePoints]), ...(protectedVisits.length ? [protectedVisits] : [])]);
    annotateToolCall({ query_key: key });
    const beforeEvidence = new Set(context.evidence.diagnosticEvidenceKeys());
    const openingFields = name === "get_place_visit_info" ? (args.fields as string[]).filter((f): f is import("./opening-facts.ts").OpeningField => f !== "visit_duration") : undefined;
    const attemptKey = openingFields ? evidenceId(["opening-attempt", args.city, args.place]) : key;
    const count = cacheable && context.queryAttempts ? (context.queryAttempts.get(attemptKey) ?? 0) + 1 : 1;
    if (cacheable) { context.queryAttempts?.set(attemptKey, count); if (attemptKey !== key) context.queryAttempts?.set(key, count); }
    const previous = cacheable ? context.evidence.queryRecord(key) : undefined;
    if (cacheable && !pooledDiscovery && count > 2) {
      annotateToolCall({ execution: "blocked" });
      if (context.queryStats) context.queryStats.blocked++;
      return `同一任务该事项已查询/复用两次，本次未执行：${previous ? querySummary(previous) : name}。请保存缺失日期或修订具体问题，不要原样或换词重试。`;
    }
    const visitDate = typeof args.visit_date === "string" ? args.visit_date : undefined;
    const knownOpening = openingFields ? context.evidence.openingFactsFor(String(args.city ?? ""), String(args.place ?? ""), visitDate) : {};
    const verifiedFields = openingFields?.filter((field) => (knownOpening[field]?.status === "verified" && !isHistoricalOpening(knownOpening[field])) || (field === "closure" && context.evidence.hasVerifiedClosure(String(args.city ?? ""), String(args.place ?? ""), visitDate))) ?? [];
    const sharedFact = name === "get_place_visit_info" && args.refresh !== true && !(visitDate && (args.fields as string[]).includes("notices")) ? context.evidence.visitInfoFacts(String(args.city ?? ""), String(args.place ?? ""), args.fields as string[], visitDate) : undefined;
    if (sharedFact !== undefined) {
      const status = openingFields && openingFields.length > 0 && !(args.fields as string[]).includes("visit_duration") && verifiedFields.length === openingFields.length ? "verified" : "returned";
      annotateToolCall({ execution: "cache_hit", query_status: status, evidence_keys: context.evidence.diagnosticEvidenceKeys(sharedFact) });
      if (context.queryStats) context.queryStats.cacheHits++;
      return sharedFact;
    }
    const cached = cacheable ? context.evidence.cached(key) : undefined;
    if (args.refresh !== true) {
      if (cached !== undefined) {
        annotateToolCall({ execution: "cache_hit", evidence_keys: context.evidence.diagnosticEvidenceKeys(cached), ...(previous === undefined ? {} : { query_status: previous.status }) });
        if (context.queryStats) context.queryStats.cacheHits++;
        return count === 1 || previous === undefined ? cached : `本次复用缓存，未联网、无新增事实：${querySummary(previous)}`;
      }
      if (previous?.status === "unavailable") {
        annotateToolCall({ execution: "cache_hit", query_status: "unavailable" });
        if (context.queryStats) context.queryStats.cacheHits++;
        return `本次复用已查状态，未联网、无新增事实：${querySummary(previous)}`;
      }
    }
    const pending = cacheable && args.refresh !== true ? this.pendingQueries.get(key) : undefined;
    if (pending && pending.signal === context.signal && pending.evidence === context.evidence) {
      annotateToolCall({ execution: "cache_hit" });
      if (context.queryStats) context.queryStats.cacheHits++;
      const output = await pending.promise;
      annotateToolCall({ evidence_keys: context.evidence.diagnosticEvidenceKeys(output), query_status: context.evidence.queryRecord(key)?.status });
      return output;
    }
    const failedResolveKey = evidenceId(["discovery-resolve-failed", name, discoveryCity, args.location ?? args.city]);
    const poolAfterFailedResolve = pooledDiscovery && (context.queryAttempts?.get(failedResolveKey) ?? 0) >= 2
      ? context.evidence.discoveryPools.find(name as DiscoveryTool, discoveryCity, String(args.location ?? args.city), String(args.cuisine ?? "").trim(), Number(queryKeyArgs(name, args).radius_km)) : undefined;
    if (pooledDiscovery && !poolAfterFailedResolve && (context.queryAttempts?.get(failedResolveKey) ?? 0) >= 2) {
      annotateToolCall({ execution: "blocked" });
      if (context.queryStats) context.queryStats.blocked++;
      return `同一中心两次未能核验坐标，本次未执行：${name} · ${discoveryCity}/${String(args.location ?? args.city)}。不要通过改半径、数量或预算重试；保留待确认并推进其他地点。`;
    }
    const execute = async (): Promise<string> => {
      const startedAt = externalNow().getTime();
      let sourceAt: number | undefined;
      let sourceReused = false;
      let discoveryStarted = false;
      let discoveryReused = false;
      const beforeDiscoveryFetch = (geo?: GeoResult) => {
        if (discoveryStarted) return; // 高德失败后降级仍算一次发现请求。
        const point = geo ? convertPoint(geo, "gcj02") : undefined;
        const family = point ? evidenceId(["discovery-fetch", name, discoveryCity.replace(/市$/, ""), point.latitude.toFixed(5), point.longitude.toFixed(5)]) : failedResolveKey;
        const attempts = (context.queryAttempts?.get(family) ?? 0) + 1;
        context.queryAttempts?.set(family, attempts);
        if (attempts > 2) {
          annotateToolCall({ execution: "blocked" });
          if (context.queryStats) context.queryStats.blocked++;
          throw new DiscoveryBudgetError(`同一中心已联网搜索两次，本次未联网：${name} · ${discoveryCity}/${geo?.name ?? String(args.location ?? args.city)}。缩小半径、改limit/预算/评分请复用已查候选池；确有缺失实体时定向查询该实体，不要继续扩圈或换参数重试。`);
        }
        discoveryStarted = true;
        if (discoveryReused) {
          if (context.queryStats) context.queryStats.cacheHits--;
          discoveryReused = false;
          sourceAt = undefined;
        }
        annotateToolCall({ execution: "executed" });
        if (context.queryStats) context.queryStats.executed++;
      };
      const onDiscoveryReuse = (at: number) => {
        sourceAt = at;
        discoveryReused = true;
        annotateToolCall({ execution: "cache_hit" });
        if (context.queryStats) context.queryStats.cacheHits++;
      };
      if (cacheable && !pooledDiscovery && context.queryStats) context.queryStats.executed++;
      const onQueryReuse = (at: number) => {
        sourceAt = at;
        if (!sourceReused && context.queryStats) { context.queryStats.executed--; context.queryStats.cacheHits++; }
        sourceReused = true; annotateToolCall({ execution: "cache_hit" });
      };
      let output: string;
      try { output = await tool.execute(args, pooledDiscovery ? { ...context, beforeDiscoveryFetch, onDiscoveryReuse } : { ...context, onQueryReuse }); }
      catch (error) { if (error instanceof DiscoveryBudgetError) return error.message; throw error; }
      if (pooledDiscovery && !discoveryStarted && !discoveryReused && context.queryStats) context.queryStats.executed++;
      context.signal?.throwIfAborted();
      if (!tool.recordsPlaceEvidence && ["search_attractions", "search_stays", "search_restaurants"].includes(name)) {
        const city = String(args.region ?? (name === "search_attractions" ? args.city : destination) ?? args.city ?? args.location ?? "");
        output = await context.evidence.observePlaces(name, city, output);
      }
      if (cacheable && !/仅历史参考|开放信息查询受阻|评价信息查询受阻|未找到|失败|不可用|没有.*(?:餐厅|景点)/.test(output)) context.evidence.cache(key, output, sourceAt ?? startedAt);
      if (cacheable) {
        const fields = queryFields(name, args);
        const status: QueryStatus = openingFields ? (/搜索失败|仅历史参考|开放信息查询受阻/.test(output) ? "failed" : (() => {
          const known = context.evidence.openingFactsFor(fields.city, fields.entity, visitDate);
          const verified = openingFields.filter((f) => (known[f]?.status === "verified" && !isHistoricalOpening(known[f])) || (f === "closure" && context.evidence.hasVerifiedClosure(fields.city, fields.entity, visitDate))).length;
          const duration = (args.fields as string[]).includes("visit_duration");
          return verified === openingFields.length && !duration ? "verified" : verified || (duration && output.includes("⏱")) ? "returned" : "unavailable";
        })())
          : name === "get_place_reviews" && /评价信息查询受阻/.test(output) ? "failed"
          : name === "get_place_reviews" && /未找到明确的/.test(output) ? "unavailable"
          : /搜索失败|未找到|未能|不可用/.test(output) ? "failed"
          : /没有搜到|没有.*(?:餐厅|景点)/.test(output) ? "unavailable"
          : "returned";
        annotateToolCall({ query_status: status });
        await context.evidence.observeQuery({ ...fields, key, status, at: sourceAt ?? startedAt });
      }
      const evidenceKeys = context.evidence.diagnosticEvidenceKeys(output);
      annotateToolCall({ evidence_keys: evidenceKeys, new_evidence_keys: evidenceKeys.filter((key) => !beforeEvidence.has(key)) });
      return output;
    };
    if (!cacheable) return execute();
    // 同中心不同投影先等待正在采集的原始池；保持不同证据库/取消信号隔离。
    const family = pooledDiscovery ? evidenceId([name, discoveryCity, args.location ?? args.city]) : undefined;
    const prior = family ? this.pendingDiscovery.get(family) : undefined;
    const run = async () => {
      if (prior && prior.signal === context.signal && prior.evidence === context.evidence) {
        try { await prior.promise; } catch { context.signal?.throwIfAborted(); }
      }
      context.signal?.throwIfAborted();
      return execute();
    };
    const entry = { promise: run(), signal: context.signal, evidence: context.evidence };
    this.pendingQueries.set(key, entry);
    if (family) this.pendingDiscovery.set(family, entry);
    try { return await entry.promise; }
    finally {
      if (this.pendingQueries.get(key) === entry) this.pendingQueries.delete(key);
      if (family && this.pendingDiscovery.get(family) === entry) this.pendingDiscovery.delete(family);
    }
  }
}

function toolOutputDescription(description: string, tool: Tool | undefined): string {
  if (tool?.outputKind === undefined) return description;
  return `${description}\n返回结构类型：${tool.outputKind}`;
}
