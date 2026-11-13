import { violatesForbiddenVisit } from "../tools/travel-requirements.ts";
import { createHash } from "node:crypto";
import type { Itinerary, ItineraryOutlineDay, PlannedVisit } from "../tools/itinerary-schema.ts";
import type { ItineraryQualityReport } from "../tools/itinerary-validator.ts";
import { requiredVisitCoverage } from "../tools/required-visits.ts";
import { sameVisit, materializedDay } from "../tools/itinerary-planning.ts";
import { repeatVisitAllowed } from "../tools/repeat-visit-policy.ts";
import { itineraryDayRole } from "../tools/day-role.ts";

export type PlanningLayer = "required" | "feasibility" | "schedule" | "budget";
export interface VisitFeasibility {
  readonly name: string;
  readonly identity_verified: boolean;
  readonly checked: boolean;
  readonly pending: readonly string[];
  readonly conflicts: readonly string[];
  readonly evidence_ids: readonly string[];
}
export interface PlanningLayerDay {
  readonly date: string;
  readonly signature: string;
  readonly basic: boolean;
  readonly feasibility: "pending" | "checked" | "conflict";
  readonly visits: readonly VisitFeasibility[];
  readonly schedule: "missing" | "draft" | "ready";
  readonly budget_gaps?: readonly string[];
}
export interface PlanningLayers {
  readonly version: "layers-v1";
  readonly expected_days: number;
  readonly basic_days: number;
  readonly basic_complete: boolean;
  readonly missing_required: readonly string[];
  readonly checked_days: number;
  readonly scheduled_days: number;
  readonly ready_days: number;
  readonly days: readonly PlanningLayerDay[];
}
export function planningDates(plan: Itinerary): string[] {
  const c = plan.constraints;
  const span = c?.start_date && c.end_date ? Math.round((Date.parse(c.end_date) - Date.parse(c.start_date)) / 86400000) + 1 : c?.expected_days;
  if (c?.start_date && span && span > 0 && span <= 90 && Number.isFinite(Date.parse(c.start_date))) return Array.from({ length: span }, (_, i) => new Date(Date.parse(c.start_date!) + i * 86400000).toISOString().slice(0, 10));
  return [...new Set([...(plan.outline ?? []).map((day) => day.date), ...plan.days.flatMap((day) => day.date ? [day.date] : [])])].sort();
}
export function planningOutline(plan: Itinerary): readonly ItineraryOutlineDay[] {
  return plan.outline ?? plan.days.flatMap((day) => day.date ? [{ date: day.date, visits: day.items.filter((item) => item.type === "visit") }] : []);
}
export function allocationSignature(visits: readonly PlannedVisit[]): string {
  return createHash("sha256").update(JSON.stringify(visits.map((visit) => [visit.name, visit.evidence_id ?? "", visit.parent_visit?.evidence_id ?? ""]))).digest("hex").slice(0, 20);
}
/** 层级进度从内容、事实证据与正式报告重算；模型自填状态不能通过验收。 */
export function derivePlanningLayers(plan: Itinerary, report: ItineraryQualityReport, inspect?: (visit: PlannedVisit, date: string) => VisitFeasibility): PlanningLayers {
  const outline = planningOutline(plan), dates = planningDates(plan);
  const expected = plan.constraints?.expected_days ?? (dates.length || plan.days.length);
  const allocated = outline.flatMap((day) => day.visits.map((visit) => ({ ...visit, date: day.date })));
  const missing = [...new Set(plan.constraints?.must_visit ?? [])].filter((name) => !allocated.some((visit) => requiredVisitCoverage(name, visit, plan.constraints?.destination)));
  const days = dates.map((date): PlanningLayerDay => {
    const visits = outline.find((day) => day.date === date)?.visits ?? [];
    const duplicate = visits.some((visit) => allocated.some((other) => other.date !== date && sameVisit(visit, other, plan.constraints?.destination) && !repeatVisitAllowed(plan, visit)));
    const signature = allocationSignature(visits), previous = plan.planning_layers?.days.find((day) => day.date === date && day.signature === signature);
    const checks = visits.map((visit) => inspect?.(visit, date) ?? previous?.visits.find((item) => item.name === visit.name) ?? { name: visit.name, identity_verified: false, checked: false, pending: ["地点与开放资料尚待核验"], conflicts: [], evidence_ids: [] });
    const actual = plan.days.find((day) => day.date === date), index = actual ? plan.days.indexOf(actual) + 1 : 0;
    const departure = itineraryDayRole(plan, actual ?? { date }, dates.indexOf(date)) === "departure";
    const hard = report.issues.some((issue) => issue.level !== "P2" && (issue.day === index || issue.related_days?.includes(index)));
    const requirements = plan.constraints?.requirements;
    const invalidAllocation = (requirements?.max_visits_per_day !== undefined && visits.length > requirements.max_visits_per_day)
      || (requirements?.forbidden_visits ?? []).some((name) => violatesForbiddenVisit(visits, name, plan.constraints?.destination));
    const scheduledVisits = actual?.items.filter((item) => item.type === "visit") ?? [];
    const allocationMatches = visits.length === scheduledVisits.length && visits.every((visit) => scheduledVisits.some((item) => sameVisit(item, visit, plan.constraints?.destination)));
    const budgetGaps = actual && materializedDay(actual) ? report.budget?.days.find((day) => day.day === index)?.gaps : undefined;
    return { date, signature, basic: (visits.length > 0 || departure && outline.some((day) => day.date === date)) && visits.every((visit) => !/^(?:待(?:定|安排|补充|选择|核验)(?:景点|地点)?|景点[一二三四五六七八九十\d]*|某(?:个)?(?:景点|公园|博物馆)|候选景点|自由活动|休息|酒店)$/.test(visit.name)) && !duplicate && !invalidAllocation,
      feasibility: checks.some((check) => check.conflicts.length) ? "conflict" : (checks.length > 0 || departure) && checks.every((check) => check.checked) ? "checked" : "pending", visits: checks,
      schedule: actual && materializedDay(actual) ? !hard && allocationMatches ? "ready" : "draft" : "missing",
      ...(budgetGaps?.length ? { budget_gaps: budgetGaps } : {}) };
  });
  const basic = days.filter((day) => day.basic).length;
  return { version: "layers-v1", expected_days: expected, basic_days: basic, basic_complete: basic === expected && missing.length === 0,
    missing_required: missing, checked_days: days.filter((day) => day.feasibility === "checked").length,
    scheduled_days: days.filter((day) => day.schedule !== "missing").length, ready_days: days.filter((day) => day.schedule === "ready").length, days };
}
export function parsePlanningLayers(value: unknown): PlanningLayers {
  const row = value as PlanningLayers;
  if (!row || row.version !== "layers-v1" || !Array.isArray(row.days) || row.days.length > 90 || !Array.isArray(row.missing_required)) throw new Error("planning_layers结构不合法");
  for (const key of ["expected_days", "basic_days", "checked_days", "scheduled_days", "ready_days"] as const) if (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > 90) throw new Error("planning_layers计数不合法");
  if (typeof row.basic_complete !== "boolean") throw new Error("planning_layers基础状态不合法");
  for (const day of row.days) {
    if (!day || typeof day.date !== "string" || typeof day.signature !== "string" || typeof day.basic !== "boolean" || !["pending", "checked", "conflict"].includes(day.feasibility) || !["missing", "draft", "ready"].includes(day.schedule) || !Array.isArray(day.visits)) throw new Error("planning_layers日期状态不合法");
    if (day.budget_gaps !== undefined && (!Array.isArray(day.budget_gaps) || day.budget_gaps.some((gap: unknown) => typeof gap !== "string"))) throw new Error("planning_layers预算缺口不合法");
    for (const visit of day.visits) if (!visit || typeof visit.name !== "string" || typeof visit.identity_verified !== "boolean" || typeof visit.checked !== "boolean" || ![visit.pending, visit.conflicts, visit.evidence_ids].every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"))) throw new Error("planning_layers核验状态不合法");
  }
  return row;
}
export function planningLayerSummary(layers: PlanningLayers): string {
  return `分层进度：基础安排 ${layers.basic_days}/${layers.expected_days}天${layers.basic_complete ? "（已覆盖日期、必去和跨日去重）" : "（仍待补齐）"}；可行性已查 ${layers.checked_days}/${layers.expected_days}天；详细时间已排 ${layers.scheduled_days}/${layers.expected_days}天，日内P0/P1清零 ${layers.ready_days}/${layers.expected_days}天。资料待确认与最终strict另计。`;
}
