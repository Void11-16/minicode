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
  const outlineReady = expected === undefined || expected <= 1 || count >= expected || (plan?.outline?.length === expected && plan.outline.every((day) => day.visits.length > 0 || actual.some((entry) => entry.date === day.date)));
  return { expected, count, dates, missing, remaining, outlineReady, phase: remaining > 0 ? "coverage" as const : "repair" as const };
}

export function planningGuidance(state: TravelState | undefined): string | undefined {
  if (!state?.brief) return undefined;
  const progress = planningProgress(state), plan = state.itinerary;
  if (!progress.outlineReady) return `【全局粗排优先】预计${progress.expected}天，先用save_itinerary(outline=[{date,visits:[{name,evidence_id}]}])分配全部日期主景点；粗排不计完成，不要只精修第一天。`;
  if (progress.phase === "coverage") {
    const date = progress.missing[0], slot = plan?.outline?.find((day) => day.date === date);
    return `【补齐阶段】有效安排${progress.count}/${progress.expected}天。下一目标${date ?? "尚未保存的日期"}${slot ? `，预留：${slot.visits.map((v) => v.name).join("、")}` : ""}。优先保存该日实际安排；已保存日的P1先保留，P0阻止保存时只修相关条目。不要读取不存在的日期；缺字段才按date+item_ids读取。`;
  }
  return "【局部修订阶段】日期已补齐。按稳定ID用edits替换/删除/移动单条；路线问题优先save_itinerary({title,repair_routes:[受影响日期]})复用证据并修时间，一次一个日期。缺证据才查询，查询后必须成功保存新版本；保存失败先修具体时间冲突，不重查已有路线。必要时扩大到相邻条目，最终整体strict验收。";
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
const REQUIRED_REVIEW_TOPICS = ["开放时间", "闭馆时间", "游玩时长"];

/** 收敛阶段保留尚需取得的硬约束资料，暂停一般口碑和默认建议型餐饮。 */
export function isDeferredEvidenceCall(name: string, argumentsJson: string, strictMeals: boolean): boolean {
  if (name === "search_restaurants") return !strictMeals;
  if (name !== "get_place_reviews") return false;
  try { return !REQUIRED_REVIEW_TOPICS.includes(JSON.parse(argumentsJson).aspect); } catch { return false; }
}

export function focusedEvidenceDefinitions(tools: readonly ToolDefinition[], strictMeals: boolean): ToolDefinition[] {
  return tools.filter((tool) => strictMeals || tool.name !== "search_restaurants").map((tool) => {
    if (tool.name !== "get_place_reviews") return tool;
    const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;
    const topics = properties?.aspect?.enum?.filter((topic) => REQUIRED_REVIEW_TOPICS.includes(topic)) ?? REQUIRED_REVIEW_TOPICS;
    return { ...tool, description: tool.description + " 当前收敛阶段仅开放必要的开放/闭馆/时长查询，已有结论继续受查询次数限制。",
      parameters: { ...tool.parameters, properties: { ...properties, aspect: { type: "string", enum: topics } }, required: [...new Set([...(tool.parameters.required as string[] ?? []), "aspect"])] },
    };
  });
}

/** 按交付结果而非版本号/任意新增候选判进展；相同质量的重保存不能刷新额度。 */
export function recordDeliveryProgress(state: TravelState | undefined, budget: CumulativeToolBudget): boolean {
  const plan = state?.itinerary, brief = state?.brief;
  if (!brief) return false;
  const requested = planningProgress(state).expected;
  const days = plan?.daySummaries?.filter((day) => day.materialized !== false && (!brief.startDate || !brief.endDate || (day.date !== undefined && day.date >= brief.startDate && day.date <= brief.endDate)));
  const coverage = days?.length ?? plan?.dayCount ?? 0;
  const current = { days: Math.min(coverage, requested ?? coverage), P0: plan?.issueCount?.P0 ?? Infinity, P1: plan?.issueCount?.P1 ?? Infinity,
    passed: days?.filter((day) => day.strictPass).length ?? 0 };
  const before = budget.deliveryProgress;
  const improved = before === undefined || current.days > before.days || (current.days === before.days &&
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
export function essentialReviewDefinitions(tools: readonly ToolDefinition[], pending: readonly string[] | undefined): ToolDefinition[] {
  if (pending === undefined) return [...tools];
  return tools.flatMap((tool) => {
    if (tool.name !== "get_place_reviews") return [tool];
    if (pending.length === 0) return [];
    return [{ ...tool, description: "仅补本轮尚缺的关键开放/闭馆事实；已查无依据的事项保持待确认。", parameters: { ...tool.parameters,
      properties: { ...(tool.parameters.properties as Record<string, unknown>), place: { type: "string", enum: pending }, aspect: { type: "string", enum: ["开放时间"] } }, required: ["place", "aspect"],
    } }];
  });
}


/** 混合“旧查询+少量新搜索”不能无限绕过连续空转检查；实质交付改进后恢复取证。 */
export function repairOnlyDefinitions(tools: readonly ToolDefinition[], enabled: boolean): ToolDefinition[] {
  return enabled ? tools.filter((tool) => REPAIR_TOOL_NAMES.has(tool.name)) : [...tools];
}
