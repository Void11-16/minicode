import { activeDayTask, requestedTravelDays } from "./day-tasks.ts";
import { renderTravelState, type TravelState } from "./travel-state.ts";

/** 明确指定日期优先；否则先补缺失日期，完整后再处理具体日期的问题。 */
export function travelFocusDay(state: TravelState | undefined, input: string): number {
  const [explicit] = requestedTravelDays(input);
  if (explicit !== undefined) return explicit;
  const active = activeDayTask(state);
  if (active) { const index = state?.itinerary?.outline?.findIndex((slot) => slot.date === active.date); if (index !== undefined && index >= 0) return index + 1; }
  const brief = state?.brief;
  const outline = state?.itinerary?.outline;
  if (outline?.length) {
    const missing = outline.findIndex((slot) => !state?.itinerary?.daySummaries?.some((entry) => entry.date === slot.date && entry.materialized !== false));
    if (missing >= 0) return missing + 1;
  }
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
export function renderFocusedTravelState(state: TravelState | undefined, day: number, maxChars = 6000, editDate?: string): string | undefined {
  if (state === undefined) return undefined;
  const task = editDate ? undefined : activeDayTask(state);
  const global = renderTravelState({ ...state,
    places: state.places.filter((place) => place.kind === "visit"),
    ...(state.itinerary === undefined ? {} : { itinerary: { ...state.itinerary, timeline: undefined, issues: [], ...(task ? { score: undefined, issueCount: undefined, strictPass: undefined, repairDays: undefined } : {}) } }),
  }, Infinity);
  if (global === undefined) return undefined;
  const date = editDate ?? task?.date ?? state.itinerary?.outline?.[day - 1]?.date;
  const actualDay = date === undefined ? day : state.itinerary?.daySummaries?.find((entry) => entry.date === date)?.day;
  const sections = [global, `当前工作日期：${date ?? `Day ${day}`}。${date ? "按date保存/读取；预留但未保存的日期直接补齐，不要读取不存在的单日。" : "其他日期按需读取，不要重读整份行程。"}`];
  if (state.itinerary?.daySummaries?.length) sections.push("已保存日期：" + state.itinerary.daySummaries.map((d) => `D${d.day} ${d.date ?? "日期未定"} ${d.itemCount}项${task || d.strictPass === undefined ? "" : d.strictPass ? " 日内通过" : " 日内待修"}`).join("；"));
  if (!editDate && !task && state.itinerary?.repairDays?.length) sections.push(`建议局部修复日期：${state.itinerary.repairDays.join("、")}；其余已通过日期保持。`);
  const timeline = state.itinerary?.timeline?.split("\n").filter((line) => actualDay !== undefined && line.startsWith(`D${actualDay} `)).join("\n");
  const details: string[] = [];
  if (timeline) details.push(`当前日条目索引：\n${timeline}`);
  if (task) {
    sections.push(`【独立日期任务】${task.date}，${task.layer === "required" ? `必去识别与预留:${task.goal_name}` : task.layer === "feasibility" ? "可行性核验" : task.layer === "budget" ? "补预算缺项" : "时间路线细排"}，第${task.attempts}次尝试，本次已用${task.attempt_rounds}轮/${task.attempt_calls}次工具。本次只处理当前层；草稿允许继续修订，其他日期已有成果保留。`);
    if (task.layer === "budget") {
      const gaps = state.itinerary?.planningLayers?.days.find((day) => day.date === task.date)?.budget_gaps;
      sections.push(`本日预算缺项：${gaps?.join("、") ?? "已补齐"}。优先复用已查候选，缺候选才补查对应板块，选好后用days增量保存。已有价格的采用来源金额，缺价保留预算估算。`);
    }
    if (task.layer === "required") sections.push(`必须在本日outline预留「${task.goal_name}」。缺实体时只定向查该目标；同名、子点和同区域地点只作候选，不能冒充覆盖。两次独立尝试失败后仍保留缺口，其他日期继续。`);
    if (task.last_error) sections.push(`该日期上次失败：${task.last_error}`);
    if (task.layer === "feasibility") sections.push("只核验已分配地点与开放/闭馆，不安排具体时刻。未知保留，已知冲突需更换本日基础安排。计算时间层前所有日期先经过这一轮核验。");
    if (task.draft_path) sections.push(`该日期失败草稿（未保存、未通过）：${task.draft_path}；重试时按需读取并修正，不把它当成已完成日程。`);
    const boundaries = state.itinerary?.boundaries ?? [];
    const previous = boundaries.filter((entry) => entry.date < task.date).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const next = boundaries.filter((entry) => entry.date > task.date).sort((a, b) => a.date.localeCompare(b.date))[0];
    for (const boundary of [previous, next].filter((entry) => entry !== undefined)) sections.push(`相邻日期衔接：${boundary.date} ${JSON.stringify(boundary === previous ? boundary.last : boundary.first)}`);
    sections.push("已保存景点仅用于占用去重；新日期必须能衔接相邻日期停留点和固定酒店。跨日冲突优先调整当前日期，不能改旧日规避。");
  }
  const issues = [...(state.itinerary?.issues ?? [])].filter((issue) => (!task && !editDate) || issue.date === date || (actualDay !== undefined && issue.day === actualDay)).sort((a, b) =>
    a.level.localeCompare(b.level) || Number(b.day === day) - Number(a.day === day));
  details.push(...issues.slice(0, 6).map((issue) => `[${issue.level}]${issue.date ? ` ${issue.date}` : issue.day === undefined ? "" : ` Day ${issue.day}`} ${issue.code ?? ""}: ${issue.message}`));
  // 约束不按字符截断；超大约束交由完整请求预算明确拒绝，避免静默遗失忌口等信息。
  let remaining = Math.max(0, maxChars - sections.join("\n").length - 1);
  for (const detail of details) {
    if (detail.length <= remaining) { sections.push(detail); remaining -= detail.length + 1; }
    else if (remaining > 100) { sections.push(detail.slice(0, remaining - 30) + "\n…（详情按日期读取）"); remaining = 0; }
  }
  return sections.join("\n");
}
