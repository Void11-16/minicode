import { activeDayTask } from "../core/day-tasks.ts";
import type { TravelState } from "../core/travel-state.ts";
import type { CumulativeToolBudget } from "../core/execution-budget.ts";
import type { ToolDefinition } from "../llm/provider.ts";
import { expectedDaysFromTitle } from "../tools/itinerary-validator.ts";

export function planningProgress(state: TravelState | undefined) {
  const plan = state?.itinerary, brief = state?.brief;
  const dated = brief?.startDate && brief.endDate ? Math.round((Date.parse(brief.endDate) - Date.parse(brief.startDate)) / 86400000) + 1 : undefined;
  const expected = dated ?? brief?.durationDays ?? plan?.expectedDays ?? expectedDaysFromTitle(brief?.title ?? plan?.title ?? "");
  const dates = dated && dated > 0 && dated <= 90 ? Array.from({ length: dated }, (_, i) => new Date(Date.parse(brief!.startDate!) + i * 86400000).toISOString().slice(0, 10)) : plan?.outline?.map((day) => day.date) ?? [];
  const actual = plan?.daySummaries?.filter((day) => day.materialized !== false && (!dates.length || (day.date !== undefined && dates.includes(day.date)))) ?? [];
  const count = plan?.materializedDays === undefined ? actual.length || plan?.dayCount || 0 : actual.length;
  const missing = dates.filter((date) => !actual.some((day) => day.date === date));
  const remaining = expected === undefined ? 0 : Math.max(0, expected - count);
  const outlineReady = expected === undefined || expected <= 1 || count >= expected || (plan?.outline?.length === expected && plan.outline.every((day) =>
    day.visits.length > 0 || actual.some((entry) => entry.date === day.date) || plan.planningLayers?.days.some((entry) => entry.date === day.date && entry.basic)));
  return { expected, count, dates, missing, remaining, outlineReady, phase: remaining > 0 ? "coverage" as const : "repair" as const };
}

export function planningGuidance(state: TravelState | undefined): string | undefined {
  if (!state?.brief) return undefined;
  const progress = planningProgress(state), plan = state.itinerary;
  if (basicLayerActive(state)) return `【第一层：基础安排】先保存覆盖全部${progress.expected}天的outline，必去全覆盖、跨日不重复。返程日可仅预留返程（visits=[]），其余日期分配具体景点。引用已知候选ID，开放、餐饮、住宿和时间路线留到后续层。${plan?.planningLayers?.missing_required.length ? `尚缺必去分配：${plan.planningLayers.missing_required.join("、")}` : ""}`;
  const task = activeDayTask(state);
  const activeDate = task?.date;
  if (task?.layer === "required") return `【必去独立任务】优先识别并在${task.date}预留「${task.goal_name}」。缺实体时定向search_attractions(location=${JSON.stringify(task.goal_name)})，引用真实ID保存本日outline；保留其他日期和已预留必去。子点不自动满足主点；只有已取证的主点可覆盖子目标。每目标有独立额度，无法识别时明确失败，其他日期继续；不得清空必去或伪造已满足。`;
  if (task?.layer === "feasibility") return `【第二层：可行性核验】只检查${task.date}已分配景点的真实身份与开放/闭馆资料；必要时用outline替换当前日期。未知保留待确认，不编造、不无限重搜；本轮不排具体时间路线。基础安排仍保留全部日期。`;
  if (task?.layer === "schedule") {
    const day = plan?.planningLayers?.days.find((day) => day.date === task.date);
    const conflicts = day?.visits.flatMap((visit) => visit.conflicts) ?? [];
    const action = conflicts.length ? `已知冲突：${conflicts.join("；")}。改用当前日期可用候选，通过schedule.visits直接提交替代日程。保留必去。`
      : day?.schedule === "missing" ? "本日尚无时间线。根据已知候选直接调用schedule，开放和路线待确认也可先保存。" : "已有时间线，按本日问题使用schedule、edits或repair_routes。";
    return `【逐日排程 ${task.date}】${action} 用save_itinerary({title,schedule:{date:"${task.date}",visits:[{name,duration_min}],mode}})。省略visits沿用本日粗排。程序计算交通和午餐，并按保存的顺序与方式补查缺段和重算时间。已有明确方式的路段无需再由模型重复查询。`;
  }
  const pendingGoals = plan?.requiredVisits?.filter((goal) => goal.status !== "scheduled" && (!activeDate || !goal.date || goal.date === activeDate)) ?? [];
  const goalGuide = pendingGoals.length ? `【必去目标兜底】尚未安排：${pendingGoals.map((goal) => `${goal.name}${goal.date ? `（已预留${goal.date}）` : "（待识别/分配日期）"}`).join("、")}。先落实这些目标，缺地点身份再定向查询；预留、推荐文字和排除理由都不算完成。已取证主景点可覆盖其子目标，同一区域的其他子点不能互相替代。` : "";
  if (!progress.outlineReady) return goalGuide + `【全局粗排优先】预计${progress.expected}天，先用save_itinerary(outline=[{date,visits:[{name,evidence_id}]}])分配全部日期主景点；粗排不计完成，不要只精修第一天。`;
  if (progress.phase === "coverage") {
    const date = activeDate ?? progress.missing[0], slot = plan?.outline?.find((day) => day.date === date);
    return goalGuide + `【补齐阶段】有效安排${progress.count}/${progress.expected}天。下一目标${date ?? "尚未保存的日期"}${slot ? `，预留：${slot.visits.map((v) => v.name).join("、")}` : ""}。只保存该日期，已保存日期固定；共享占用和相邻日期衔接由整体校验检查，其他旧日问题保留报告；P0阻止保存时只修相关条目。不要读取不存在的日期；缺字段才按date+item_ids读取。`;
  }
  return goalGuide + "【局部修订阶段】日期已补齐。按稳定ID用edits替换/删除/移动单条；路线问题优先save_itinerary({title,repair_routes:[受影响日期]})复用证据并修时间，一次一个日期。缺证据才查询，查询后必须成功保存新版本；保存失败先修具体时间冲突，不重查已有路线。必要时扩大到相邻条目，最终整体strict验收。";
}

export function planningDefinitions(tools: readonly ToolDefinition[], state: TravelState | undefined): ToolDefinition[] {
  if (!state?.brief) return [...tools];
  const progress = planningProgress(state);
  const hasSavedDays = (state.itinerary?.dayCount ?? 0) > 0;
  return tools.map((tool) => {
    if (tool.name !== "save_itinerary") return tool;
    const properties = tool.parameters.properties as Record<string, unknown>;
    if (!properties?.outline) return tool;
    if (!progress.outlineReady && !hasSavedDays) {
      return {
        ...tool,
        description: "先按日期保存主景点粗排。粗排不计有效天数，后续用 days 保存实际安排。",
        parameters: { ...tool.parameters, properties: { title: properties.title, outline: properties.outline, expected_revision: properties.expected_revision }, required: ["title", "outline"] },
      };
    }
    if (!progress.outlineReady) {
      // 恢复旧行程时仍允许同时补粗排与修订已保存日。
      return { ...tool, parameters: { ...tool.parameters, required: ["title", "outline"] } };
    }
    if (!hasSavedDays && progress.phase === "coverage") {
      const { edits: _edits, repair_routes: _repairRoutes, ...draftProperties } = properties;
      return { ...tool, parameters: { ...tool.parameters, properties: draftProperties } };
    }
    return tool;
  });
}

/** 只对未完成日期的软停滞提供一次阶段切换；不恢复配额/密钥失败，不刷新硬预算。 */
export function recoverCoverage(state: TravelState | undefined, budget: CumulativeToolBudget): string | undefined {
  const p = planningProgress(state);
  if (!state?.brief || (!state.itinerary?.outline?.length && p.count === 0) || p.remaining === 0 || budget.blockedKind === "dependency" || (budget.blockedReason !== undefined && budget.blockedKind !== "no_progress") || budget.rounds >= budget.maxRounds || budget.calls >= budget.maxCalls || (budget.maxTokens !== undefined && budget.tokens >= budget.maxTokens) || budget.costExceeded?.()) return undefined;
  // 改写粗排日期或删掉已完成日不能刷新恢复额度；只有交付高水位提升才进入新阶段。
  const key = JSON.stringify([state.brief.title, Math.max(p.count, budget.deliveryProgress?.days ?? 0), p.expected, p.outlineReady]);
  budget.coverageRecoveries ??= new Set();
  if (budget.coverageRecoveries.has(key)) return undefined;
  budget.coverageRecoveries.add(key);
  budget.stagnantRounds = 0; budget.deliveryStagnantRounds = 0; budget.redundantRounds = 0; budget.redundantCalls = 0;
  budget.blockedReason = undefined; budget.blockedKind = undefined;
  return `【定向恢复】先前是局部停滞而非预算耗尽；本阶段仅恢复一次，累计调用/token/费用及已读记录不重置。${planningGuidance(state)}`;
}

export const DEFER_OPTIONAL_EVIDENCE_AFTER = 8;
export const MAX_DELIVERY_STAGNATION = 20;
export const MAX_REDUNDANT_CALLS_BEFORE_REPAIR = 6;
export const MAX_REDUNDANT_ROUNDS = 3;
export const REPAIR_TOOL_NAMES: ReadonlySet<string> = new Set(["save_itinerary", "load_itinerary", "validate_itinerary", "plan_day_routes", "read_file"]);
/** 收敛阶段保留参观硬约束资料；显式体验需求和严格餐饮仍可查询口碑。 */
export function isDeferredEvidenceCall(name: string, _argumentsJson: string, strictMeals: boolean, allowReviews = false): boolean {
  if (name === "search_restaurants") return !strictMeals;
  return name === "get_place_reviews" && !strictMeals && !allowReviews;
}

export function focusedEvidenceDefinitions(tools: readonly ToolDefinition[], strictMeals: boolean, allowReviews = false): ToolDefinition[] {
  return tools.filter((tool) => !isDeferredEvidenceCall(tool.name, "{}", strictMeals, allowReviews));
}

/** 按交付结果而非版本号/任意新增候选判进展；相同质量的重保存不能刷新额度。 */
export function recordDeliveryProgress(state: TravelState | undefined, budget: CumulativeToolBudget): boolean {
  const plan = state?.itinerary, brief = state?.brief;
  if (!brief) return false;
  const requested = planningProgress(state).expected;
  const days = plan?.daySummaries?.filter((day) => day.materialized !== false && (!brief.startDate || !brief.endDate || (day.date !== undefined && day.date >= brief.startDate && day.date <= brief.endDate)));
  const coverage = days?.length ?? plan?.dayCount ?? 0;
  const layers = plan?.planningLayers;
  const current = { basicComplete: layers?.basic_complete ? 1 : 0, requiredCovered: (brief.mustVisit?.length ?? 0) - (layers?.missing_required.length ?? 0), basic: layers?.basic_days ?? 0, checked: layers?.checked_days ?? 0, ready: layers?.ready_days ?? 0, days: Math.min(coverage, requested ?? coverage), P0: plan?.issueCount?.P0 ?? Infinity, P1: plan?.issueCount?.P1 ?? Infinity,
    passed: days?.filter((day) => day.strictPass).length ?? 0 };
  const before = budget.deliveryProgress;
  const improved = before === undefined || current.basicComplete > (before.basicComplete ?? 0) || current.requiredCovered > (before.requiredCovered ?? 0) || current.basic > (before.basic ?? 0) || current.checked > (before.checked ?? 0) || current.ready > (before.ready ?? 0) || current.days > before.days || (current.days === before.days &&
    (current.P0 < before.P0 || (current.P0 === before.P0 && current.P1 < before.P1) ||
      (current.P0 <= before.P0 && current.P1 <= before.P1 && current.passed > before.passed)));
  if (improved) { budget.deliveryProgress = current; budget.deliveryStagnantRounds = 0; }
  else budget.deliveryStagnantRounds = (budget.deliveryStagnantRounds ?? 0) + 1;
  return improved;
}

export function deliveryGuidance(budget: CumulativeToolBudget): string | undefined {
  return (budget.deliveryStagnantRounds ?? 0) < DEFER_OPTIONAL_EVIDENCE_AFTER ? undefined
    : "连续多轮没有增加有效行程日期或降低 P0/P1：暂缓一般口碑和建议型餐饮取证，先保存缺失日期或修复明确问题。必要闭馆/开放/时长查询及严格餐饮仍可用；未知保持待确认，不可伪造；不要反复读同一版本。";
}


/** 默认规划只补尚未查询的关键开放事实，显式口碑需求和严格餐饮保留完整查询能力。 */
export function essentialVisitInfoDefinitions(tools: readonly ToolDefinition[], pending: readonly string[] | undefined, allowReviews = pending === undefined): ToolDefinition[] {
  if (pending === undefined) return tools.filter((tool) => allowReviews || tool.name !== "get_place_reviews");
  return tools.flatMap((tool) => {
    if (tool.name === "get_place_reviews") return allowReviews ? [tool] : [];
    if (tool.name !== "get_place_visit_info") return [tool];
    if (pending.length === 0) return [];
    return [{ ...tool, description: "仅补已选地点尚缺的参观资料；已查无依据的事项保持待确认。", parameters: { ...tool.parameters,
      properties: { ...(tool.parameters.properties as Record<string, unknown>), place: { type: "string", enum: pending } }, required: ["place"],
    } }];
  });
}


/** 混合“旧查询+少量新搜索”不能无限绕过连续空转检查；实质交付改进后恢复取证。 */
export function repairOnlyDefinitions(tools: readonly ToolDefinition[], enabled: boolean): ToolDefinition[] {
  return enabled ? tools.filter((tool) => REPAIR_TOOL_NAMES.has(tool.name)) : [...tools];
}

/** 第一层只做全日期景点分配；少量候选后收窄到保存，防止粗排前查开放/餐饮耗尽预算。 */
export function basicLayerActive(state: TravelState | undefined): boolean {
  if (!state?.brief) return false;
  const progress = planningProgress(state);
  return (progress.expected ?? 0) > 1 && !progress.outlineReady && (state.itinerary?.dayCount ?? 0) === 0;
}
export function basicLayerCallIssue(name: string, discoveryCalls: number): string | undefined {
  if (["save_itinerary", "load_itinerary", "save_travel_brief", "activate_tools", "deactivate_tools", "find_tools", "list_tools"].includes(name)) return undefined;
  if (name === "search_attractions" && discoveryCalls < 3) return undefined;
  return "当前先交付覆盖全部日期、必去点和跨日去重的outline基础安排。已知候选已提供；开放资料、住宿餐饮、时间和路线分层后处理，不再读取大归档或重搜。";
}
export function basicLayerDefinitions(definitions: readonly ToolDefinition[], discoveryCalls: number): ToolDefinition[] {
  return definitions.filter((tool) => !basicLayerCallIssue(tool.name, discoveryCalls));
}
