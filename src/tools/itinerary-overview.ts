import { planningLayerSummary } from "../core/planning-layers.ts";
import { requiredVisitGoals, requiredVisitGoalLabel } from "./required-visits.ts";
import type { Itinerary, ItineraryDay } from "./itinerary-schema.ts";
import type { ItineraryQualityReport } from "./itinerary-validator.ts";
import { expectedDaysFromTitle } from "./itinerary-validator.ts";
import { materializedDay } from "./itinerary-planning.ts";

const DAY_MS = 86_400_000;
function calendarDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;

/** 全局视图必须覆盖全部日期；预算不足就整体降级字段，不按日期先后丢记录。 */
export function renderItineraryOverview(plan: Itinerary, report?: ItineraryQualityReport, maxChars = 2400): string | undefined {
  const c = plan.constraints;
  const span = calendarDate(c?.start_date) && calendarDate(c?.end_date) ? Math.round((Date.parse(c.end_date) - Date.parse(c.start_date)) / DAY_MS) + 1 : 0;
  const expected = span > 0 && span <= 90 ? span : c?.expected_days ?? expectedDaysFromTitle(plan.title) ?? (plan.outline?.length || plan.days.length);
  const calendarCount = span > 0 && span <= 90 ? span : !c?.end_date && calendarDate(c?.start_date) && expected > 0 && expected <= 90 ? expected : 0;
  const requested = calendarCount ? Array.from({ length: calendarCount }, (_, i) => new Date(Date.parse(c!.start_date!) + i * DAY_MS).toISOString().slice(0, 10))
    : (plan.outline ?? []).map((day) => day.date);
  const dates = [...new Set([...requested, ...plan.days.flatMap((day) => day.date ? [day.date] : [])])].sort();
  const entries: { date?: string; actual?: ItineraryDay; index: number }[] = dates.map((date) => ({ date, actual: plan.days.find((day) => day.date === date), index: plan.days.findIndex((day) => day.date === date) }));
  plan.days.forEach((day, index) => { if (!day.date) entries.push({ actual: day, index }); });
  while (entries.length < expected && entries.length < 90) entries.push({ index: -1 });
  const completed = entries.filter((entry) => entry.actual && materializedDay(entry.actual) && (!calendarCount || (entry.date !== undefined && requested.includes(entry.date)))).length;
  const layerSummary = plan.planning_layers ? planningLayerSummary(plan.planning_layers) : "";
  const header = `【行程全局概览】${clip(plan.title, 60)}\n有效安排${completed}/${expected}天；已保存${plan.days.length}天${completed !== expected ? "，尚未完成" : ""}。${report ? `整体P0=${report.issue_count.P0}/P1=${report.issue_count.P1}` : "未在此预览重新验收"}`;
  const goals = plan.required_visit_goals ?? requiredVisitGoals(plan);
  const goalSummary = goals.length ? "必去目标：" + goals.map(requiredVisitGoalLabel).join("；") : "";
  const footer = "概览不含完整条目；未展示细节不等于没有安排。局部字段用load_itinerary(day/date,item_ids)，条目目录用day/date+summary=true。";
  const rows = entries.map(({ date, actual, index }, n) => {
    const reserved = plan.outline?.find((day) => day.date === date);
    const status = actual ? materializedDay(actual) ? "已安排" : "已保存骨架" : reserved ? "仅粗排" : "未保存";
    const briefStatus = actual ? materializedDay(actual) ? "排" : "骨" : reserved ? "预" : "缺";
    const items = actual?.items ?? [];
    const names = actual ? items.filter((item) => item.type === "visit").map((item) => item.name) : reserved?.visits.map((item) => item.name) ?? [];
    const count = names.length;
    const dayReport = report?.daily?.find((day) => day.day === index + 1);
    const p0 = dayReport?.issues.filter((issue) => issue.level === "P0").length;
    const p1 = dayReport?.issues.filter((issue) => issue.level === "P1").length;
    const quality = p0 === undefined ? "" : ` P0=${p0}/P1=${p1}`;
    const label = `Day ${n + 1} · ${date ?? "日期待定"}`;
    return [
      `${label} ${status} 景点${count}/餐候${items.filter((item) => item.type === "meal").length}/共${items.length}项${quality}${names.length ? " | " + names.slice(0, 3).map((name) => clip(name, 20)).join("、") : ""}`,
      `${label} ${status} 景点${count}${quality}${names.length ? " | " + clip(names[0]!, 18) : ""}`,
      `${label} ${status}${quality}`,
      `D${n + 1} ${date ?? "日期待定"} ${briefStatus}`,
    ];
  });
  for (let level = 0; level < 4; level++) {
    const result = [header, ...(layerSummary ? [layerSummary] : []), ...(goalSummary ? [goalSummary] : []), ...(level === 3 ? ["排=已安排；骨=骨架；预=仅粗排；缺=未保存"] : []), ...rows.map((row) => row[level]), footer].join("\n");
    if (result.length <= maxChars) return result;
  }
  return undefined;
}
