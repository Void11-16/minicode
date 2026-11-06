import { scenicVisitKey } from "./scenic-area.ts";
export const QUALITY_SCORING_VERSION = "opportunity-v9" as const;
import type { Itinerary, ItineraryItem } from "./itinerary-schema.ts";
import type { QualityIssue, ItineraryQualityStatus, QualityIssueLevel } from "./itinerary-validator.ts";

const PENDING_CODES = new Set(["unverified-place-evidence", "unverified-route", "unverified-closure", "closure-exception-check", "missing-location", "missing-coordinates", "unverified-coordinates", "missing-source", "missing-confidence", "missing-opening-hours", "reservation-required"]);
const LEG_CODES = new Set(["transfer-too-tight", "missing-route-leg", "route-duration-too-short", "unverified-route", "spatial-gap"]);
export function classifyIssue(value: QualityIssue): QualityIssue {
  return { ...value, kind: value.kind ?? (PENDING_CODES.has(value.code) ? "pending" : value.level === "P2" ? "advice" : "error") };
}
export function qualityStatus(issues: readonly QualityIssue[]): ItineraryQualityStatus {
  if (issues.some((i) => i.level === "P0")) return "invalid";
  if (issues.some((i) => i.level === "P1" && i.kind !== "pending")) return "needs_revision";
  return issues.length === 0 ? "ok" : "needs_confirmation";
}
export function issueCounts(issues: readonly QualityIssue[]) {
  return { P0: issues.filter((i) => i.level === "P0").length, P1: issues.filter((i) => i.level === "P1").length, P2: issues.filter((i) => i.level === "P2").length };
}

/** 一次修复能同时解决的同一段交通问题合并；保留全部检查码，不合并独立错误。 */
export function aggregateIssues(issues: readonly QualityIssue[], itinerary: Itinerary): QualityIssue[] {
  const result: QualityIssue[] = [];
  const groups = new Map<string, QualityIssue[]>();
  for (const raw of issues) {
    const value = classifyIssue(raw);
    if (!LEG_CODES.has(value.code) || value.day === undefined || value.item_id === undefined) { result.push(value); continue; }
    const items = itinerary.days[value.day - 1]?.items ?? [];
    const itemIndex = items.findIndex((item) => item.id === value.item_id);
    const item = items[itemIndex];
    const target = item?.type === "transport" ? items.slice(itemIndex + 1).find((stop) => ["visit", "accommodation", "rest"].includes(stop.type) && stop.name === item.to) : item;
    const key = `leg:${value.day}:${target?.id ?? value.item_id}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...value, root_key: key }]);
  }
  const priority = ["route-duration-too-short", "transfer-too-tight", "unverified-route", "missing-route-leg", "spatial-gap"];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.level.localeCompare(b.level) || Number(a.kind === "pending") - Number(b.kind === "pending") || priority.indexOf(a.code) - priority.indexOf(b.code));
    const primary = group[0]!;
    result.push({ ...primary, root_key: key, related_codes: [...new Set(group.flatMap((i) => [i.code, ...(i.related_codes ?? [])]))],
      related_item_ids: [...new Set(group.flatMap((i) => i.item_id === undefined ? [] : [i.item_id]))],
      message: [...new Set(group.map((i) => i.message))].join("；") });
  }
  return result;
}

export interface ScoreDimension { readonly weight: number; readonly checked: number; readonly failed: number; readonly score: number }
export interface OpportunityScore { readonly score: number; readonly completeness: number; readonly dimensions: Readonly<Record<"schedule" | "routing" | "evidence" | "consistency", ScoreDimension>> }
const COMPLETENESS_CODES = new Set(["title-day-mismatch", "missing-requested-date", "unmaterialized-outline-day", "outline-day-count-mismatch"]);
function dimensionFor(issue: QualityIssue): keyof OpportunityScore["dimensions"] {
  if (PENDING_CODES.has(issue.code) && !LEG_CODES.has(issue.code)) return "evidence";
  if (LEG_CODES.has(issue.code) || /route|transport|transfer|spatial|remote-day/.test(issue.code)) return "routing";
  if (/duplicate|budget|required-visit|unexpected.*date|day-role|allocation|outline|unfulfilled-reservation|excluded-visit/.test(issue.code)) return "consistency";
  return "schedule";
}
function itemKey(day: number, item: ItineraryItem): string {
  return item.type === "visit" ? `${day}:visit:${scenicVisitKey(item.name, item.parent_visit?.name)}` : item.type === "accommodation" ? `${day}:stay:${item.name}` : `${day}:${item.id}`;
}

/** 分母只由实际检查对象决定，不随问题条数增加；同一对象按最严重问题计一次损失。 */
export function opportunityScore(itinerary: Itinerary, issues: readonly QualityIssue[], expectedDays?: number, scopeDay?: number): OpportunityScore {
  const opportunities: Record<keyof OpportunityScore["dimensions"], Set<string>> = { schedule: new Set(), routing: new Set(), evidence: new Set(), consistency: new Set(["global"]) };
  itinerary.days.forEach((day, index) => {
    const number = index + 1;
    if (scopeDay !== undefined && number !== scopeDay) return;
    for (const set of Object.values(opportunities)) set.add(`day:${number}`);
    // 主目的地和住处才是地点/时段检查机会；拆交通、堆休息或自由活动不增加分母。
    const relevant = day.items.filter((item) => item.type === "visit" || item.type === "accommodation");
    for (const item of relevant) {
      opportunities.schedule.add(itemKey(number, item));
      opportunities.evidence.add(itemKey(number, item));
      if (item.type === "visit") opportunities.consistency.add(itemKey(number, item));
    }
    const stops = relevant.filter((item) => item.time !== undefined).slice().sort((a, b) => a.time!.localeCompare(b.time!));
    for (let i = 1; i < stops.length; i++) {
      if (itemKey(number, stops[i]!) !== itemKey(number, stops[i - 1]!)) opportunities.routing.add(`leg:${itemKey(number, stops[i]!)}`);
    }
  });
  const penalties = { schedule: new Map<string, number>(), routing: new Map<string, number>(), evidence: new Map<string, number>(), consistency: new Map<string, number>() };
  const severity: Record<QualityIssueLevel, number> = { P0: 1, P1: 0.5, P2: 0.1 };
  for (const issue of issues) {
    if (issue.level === "P2" && ["incomplete-day-start", "incomplete-day-end", "day-too-long"].includes(issue.code)) continue; // 节奏参考不当作确定缺陷扣分。
    if (["unverified-closure", "closure-exception-check"].includes(issue.code)) continue; // 资料确认项单列，不从规划分扣减。
    if (COMPLETENESS_CODES.has(issue.code)) continue; // 完整度只乘一次，不再逐个缺失日期重复扣分。
    const dimension = dimensionFor(issue);
    const item = issue.day === undefined ? undefined : itinerary.days[issue.day - 1]?.items.find((entry) => entry.id === issue.item_id);
    let key = issue.day === undefined ? "global" : item === undefined ? `day:${issue.day}` : itemKey(issue.day, item);
    if (dimension === "routing" && issue.root_key !== undefined && issue.day !== undefined) {
      const target = itinerary.days[issue.day - 1]?.items.find((entry) => issue.root_key === `leg:${issue.day}:${entry.id}`);
      if (target !== undefined) key = `leg:${itemKey(issue.day, target)}`;
    }
    if (!opportunities[dimension].has(key)) key = issue.day === undefined ? [...opportunities[dimension]][0] ?? "global" : `day:${issue.day}`;
    if (!opportunities[dimension].has(key)) continue;
    penalties[dimension].set(key, Math.max(penalties[dimension].get(key) ?? 0, severity[issue.level]));
  }
  const weights = { schedule: 0.35, routing: 0.25, evidence: 0.25, consistency: 0.15 };
  const dimensions = Object.fromEntries(Object.entries(opportunities).map(([name, checked]) => {
    const key = name as keyof typeof opportunities;
    const loss = [...penalties[key].values()].reduce((a, b) => a + b, 0);
    return [name, { weight: weights[key], checked: checked.size, failed: penalties[key].size, score: Math.round(1000 * (1 - loss / Math.max(1, checked.size))) / 10 }];
  })) as unknown as OpportunityScore["dimensions"];
  let completeness = expectedDays === undefined ? 1 : Math.min(1, itinerary.days.length / expectedDays);
  const c = itinerary.constraints;
  if (scopeDay === undefined && c?.start_date && c.end_date) {
    const dates = new Set(itinerary.days.map((day) => day.date));
    let expected = 0, found = 0;
    for (let date = Date.parse(c.start_date); date <= Date.parse(c.end_date); date += 86400000) { expected++; if (dates.has(new Date(date).toISOString().slice(0, 10))) found++; }
    if (expected > 0) completeness = found / expected;
  }
  if (scopeDay !== undefined) completeness = 1;
  return { score: Math.floor(Object.values(dimensions).reduce((sum, d) => sum + d.weight * d.score, 0) * completeness + 1e-9), completeness, dimensions };
}
