import { renderTravelState, type TravelState } from "./travel-state.ts";

/** 明确指定日期优先；否则先补缺失日期，完整后再处理具体日期的问题。 */
export function travelFocusDay(state: TravelState | undefined, input: string): number {
  const requested = /(?:第\s*([一二三四五六七八九十两\d]{1,3})\s*天|\bday\s*(\d+))/i.exec(input);
  const label = requested?.[1] ?? requested?.[2] ?? "";
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const explicit = label.includes("十") ? (digits[label.split("十")[0]!] ?? 1) * 10 + (digits[label.split("十")[1]!] ?? 0) : digits[label] ?? Number(label);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 60) return explicit;
  const brief = state?.brief;
  const expected = brief?.startDate && brief.endDate
    ? Math.round((Date.parse(brief.endDate) - Date.parse(brief.startDate)) / 86400000) + 1
    : undefined;
  if (expected !== undefined && Number.isFinite(expected) && expected >= 1 && expected <= 60) {
    const saved = new Set((state?.itinerary?.daySummaries ?? []).map((day) => day.date));
    for (let day = 1; day <= expected; day++) {
      const date = new Date(Date.parse(brief!.startDate!) + (day - 1) * 86400000).toISOString().slice(0, 10);
      if (!saved.has(date)) return day;
    }
  }
  return state?.itinerary?.issues.find((issue) => issue.level !== "P2" && issue.day !== undefined)?.day ?? 1;
}

/** 全局约束、版本和跨天景点去重始终保留；只有当前日展开完整条目与待修问题。 */
export function renderFocusedTravelState(state: TravelState | undefined, day: number, maxChars = 6000): string | undefined {
  if (state === undefined) return undefined;
  const global = renderTravelState({ ...state,
    places: state.places.filter((place) => place.kind === "visit"),
    ...(state.itinerary === undefined ? {} : { itinerary: { ...state.itinerary, timeline: undefined, issues: [] } }),
  }, Infinity);
  if (global === undefined) return undefined;
  const sections = [global, `当前工作日期：Day ${day}。其他日期按需 load_itinerary(day=N)，不要重读整份行程。`];
  if (state.itinerary?.daySummaries?.length) sections.push("已保存日期：" + state.itinerary.daySummaries.map((d) => `D${d.day} ${d.date ?? "日期未定"} ${d.itemCount}项${d.strictPass === undefined ? "" : d.strictPass ? " 日内通过" : " 日内待修"}`).join("；"));
  if (state.itinerary?.repairDays?.length) sections.push(`建议局部修复日期：${state.itinerary.repairDays.join("、")}；其余已通过日期保持。`);
  const timeline = state.itinerary?.timeline?.split("\n").filter((line) => line.startsWith(`D${day} `)).join("\n");
  const details: string[] = [];
  if (timeline) details.push(`当前日条目索引：\n${timeline}`);
  const issues = [...(state.itinerary?.issues ?? [])].sort((a, b) =>
    a.level.localeCompare(b.level) || Number(b.day === day) - Number(a.day === day));
  details.push(...issues.slice(0, 6).map((issue) => `[${issue.level}]${issue.day === undefined ? "" : ` Day ${issue.day}`} ${issue.code ?? ""}: ${issue.message}`));
  // 约束不按字符截断；超大约束交由完整请求预算明确拒绝，避免静默遗失忌口等信息。
  let remaining = Math.max(0, maxChars - sections.join("\n").length - 1);
  for (const detail of details) {
    if (detail.length <= remaining) { sections.push(detail); remaining -= detail.length + 1; }
    else if (remaining > 100) { sections.push(detail.slice(0, remaining - 30) + "\n…（详情按日期读取）"); remaining = 0; }
  }
  return sections.join("\n");
}
