import { createHash } from "node:crypto";
import { itemEndMinutes } from "./itinerary-timeline.ts";
import { timeToMinutes } from "./itinerary-schema.ts";
import type { Itinerary, PlannedVisit, RequiredVisitGoal } from "./itinerary-schema.ts";
import type { QualityIssue } from "./itinerary-validator.ts";

function key(name: string, city?: string): string {
  let value = name.replace(/\s+/g, "").toLowerCase();
  const cityPrefix = city ? new RegExp(`^${city.replace(/市$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:市)?`) : undefined;
  if (cityPrefix) value = value.replace(cityPrefix, "");
  // 地图常给独立场馆加上片区前缀；去掉前缀后仍须完整匹配场馆名，不把父景区等同子点。
  value = value.replace(/^.{2,30}?(?:文化旅游区|历史文化街区)(?=.{2})/, "");
  if (cityPrefix) value = value.replace(cityPrefix, "");
  return value.replace(/^中国/, "").replace(/^(.{2,3})省(?=博物(?:馆|院)$)/, "$1");
}

function shortName(name: string): string { return name.replace(/(?:博物院|博物馆|公园|风景名胜区|旅游景区|旅游区|景区)$/, ""); }

export function sameVisitName(left: string, right: string, city?: string): boolean {
  const target = key(left, city), name = key(right, city);
  return target !== "" && name !== "" && (target === name || target === shortName(name) || shortName(target) === name);
}

// 西安同一主景点的常用检索名和地图规范名，明确的坑、展厅和丽山园不在此集合。
const XIAN_TERRACOTTA_ALIASES = new Set(["兵马俑", "秦兵马俑", "秦始皇兵马俑", "兵马俑博物馆", "秦始皇兵马俑博物馆", "秦始皇帝陵博物院"]);

export function visitNameAliases(name: string, city?: string): readonly string[] {
  return city?.replace(/市$/, "") === "西安" && XIAN_TERRACOTTA_ALIASES.has(key(name, city)) ? [...XIAN_TERRACOTTA_ALIASES] : [];
}

/** 主景区泛称可由明确对应的主景区满足，内部子点、餐厅和仅外观不替代游览。 */
export function requiredVisitMatches(required: string, actual: string, city?: string): boolean {
  const target = key(required, city), name = key(actual, city);
  if (sameVisitName(required, actual, city)) return true;
  if (city?.replace(/市$/, "") === "西安" && XIAN_TERRACOTTA_ALIASES.has(target) && XIAN_TERRACOTTA_ALIASES.has(name)) return true;
  return ["长城", "草原", "海滩", "古城", "古镇"].includes(target) && shortName(name).endsWith(target) && !/[-—·（(]/.test(name);
}

/** 单向覆盖：主点覆盖已取证子点；子点不代表去过主点或其他同区域地点。 */
export function requiredVisitCoverage(required: string, visit: PlannedVisit & { readonly evidence_verified?: boolean; readonly type?: string }, city?: string): RequiredVisitGoal["relation"] | undefined {
  if (requiredVisitMatches(required, visit.name, city)) return "direct";
  if (!visit.evidence_id || (visit.type !== undefined ? visit.evidence_verified !== true : visit.evidence_verified === false)) return undefined;
  return visit.covered_visits?.find((child) => child.evidence_id && requiredVisitMatches(required, child.name, city))?.relation;
}

/** 以实际条目重算，绝不读取台账里模型可能填写的完成状态。 */
export function requiredVisitGoals(itinerary: Itinerary, identify?: (name: string) => { evidence_id?: string; evidence_verified?: boolean }): RequiredVisitGoal[] {
  const city = itinerary.constraints?.destination;
  return [...new Set(itinerary.constraints?.must_visit ?? [])].map((name): RequiredVisitGoal => {
    const id = `required-${createHash("sha256").update(JSON.stringify([city ?? "", key(name, city)])).digest("hex").slice(0, 16)}`;
    const base = { id, name };
    const candidates = itinerary.days.flatMap((day) => day.items.flatMap((item) => {
      if (item.type !== "visit" || item.time === undefined) return [];
      const end = itemEndMinutes(item), relation = requiredVisitCoverage(name, item, city);
      return relation && end !== undefined && end > timeToMinutes(item.time) ? [{ day, item, relation }] : [];
    })).sort((a, b) => Number(b.item.evidence_verified === true) - Number(a.item.evidence_verified === true) || Number(b.relation === "direct") - Number(a.relation === "direct"));
    const saved = candidates[0];
    if (saved) return { ...base, status: "scheduled", identity_verified: saved.item.evidence_verified === true,
      evidence_id: saved.item.evidence_id, date: saved.day.date, item_id: saved.item.id, covered_by: saved.item.name, relation: saved.relation };
    for (const day of itinerary.outline ?? []) for (const visit of day.visits) {
      const relation = requiredVisitCoverage(name, visit, city);
      if (relation) return { ...base, status: "reserved", identity_verified: !!visit.evidence_id, evidence_id: visit.evidence_id, date: day.date, covered_by: visit.name, relation };
    }
    const known = identify?.(name);
    return { ...base, status: known?.evidence_verified ? "identified" : "unresolved", identity_verified: known?.evidence_verified === true, evidence_id: known?.evidence_id };
  });
}

export function requiredVisitIssues(itinerary: Itinerary): QualityIssue[] {
  const visits = itinerary.days.flatMap((day) => day.items.filter((item) => item.type === "visit"));
  return requiredVisitGoals(itinerary).flatMap((goal): QualityIssue[] => {
    if (goal.status === "scheduled") return [];
    const similar = visits.some((item) => item.name.includes(goal.name) || goal.name.includes(item.name));
    const message = goal.status === "reserved" ? `必去「${goal.name}」仅在 ${goal.date} 预留，尚未保存有效游览时间；请落实对应条目`
      : similar ? `必去「${goal.name}」只有名称相近、子景点或缺少有效游览时间的安排，尚不能确认目标已满足`
      : `缺少必去景点「${goal.name}」，请补充游览安排`;
    return [{ level: "P1", code: similar ? "uncertain-required-visit" : "missing-required-visit", kind: similar ? "pending" : "error", message }];
  });
}

export function requiredVisitGoalLabel(goal: RequiredVisitGoal): string {
  const status = { unresolved: "待识别", identified: "已识别，待分配日期", reserved: "已预留，待保存游览", scheduled: "已安排" }[goal.status];
  return `${goal.name}：${status}${goal.date ? `@${goal.date}` : ""}${goal.relation && goal.relation !== "direct" ? `，由「${goal.covered_by}」覆盖（${goal.relation === "geographic_area" ? "区域包含" : "主子景点"}）` : ""}；${goal.identity_verified ? "地点身份/包含关系已核验" : "地点身份待核验"}`;
}
