import type { Itinerary } from "./itinerary-schema.ts";
import { requiredVisitMatches, sameVisitName } from "./required-visits.ts";
import { mainDestinationKey } from "./scenic-area.ts";
import { itemEndMinutes } from "./itinerary-timeline.ts";
import { timeToMinutes } from "./itinerary-schema.ts";

export interface TravelTimeWindow {
  readonly start: string;
  readonly end: string;
}

/** 只声明用户已明确提出、可以从最终产物验证的事实；软偏好另走人工复核。 */
export interface TravelRequirements {
  readonly dates?: readonly string[];
  readonly forbidden_visits?: readonly string[];
  readonly max_visits_per_day?: number;
  readonly daily_window?: TravelTimeWindow;
  /** day 使用从 1 开始的实际行程顺序。 */
  readonly day_windows?: readonly (TravelTimeWindow & { readonly day: number })[];
  readonly travelers?: number;
  readonly room_count?: number;
  readonly fixed_stay?: boolean;
}

export interface TravelRequirementCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly message: string;
  readonly day?: number;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const FIELDS = new Set(["dates", "forbidden_visits", "max_visits_per_day", "daily_window", "day_windows", "travelers", "room_count", "fixed_stay"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validTravelDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

export function parseRequirements(raw: unknown, days: number | undefined, label: string): TravelRequirements {
  const fail = (message: string): never => { throw new Error(`${label}: requirements ${message}`); };
  if (!object(raw)) fail("需要对象");
  const record = raw as Record<string, unknown>;
  for (const field of Object.keys(record)) if (!FIELDS.has(field)) fail(`未知字段 ${field}`);
  for (const field of ["travelers", "room_count", "max_visits_per_day"]) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) fail(`${field} 需要正整数`);
  }
  if (record.fixed_stay !== undefined && typeof record.fixed_stay !== "boolean") fail("fixed_stay 需要布尔值");
  if (record.forbidden_visits !== undefined && (!Array.isArray(record.forbidden_visits) || record.forbidden_visits.length === 0 || record.forbidden_visits.some((name) => typeof name !== "string" || !name.trim()))) fail("forbidden_visits 需要非空名称数组");
  if (record.dates !== undefined) {
    if (!Array.isArray(record.dates) || record.dates.length < 1 || record.dates.length > 90 || (days !== undefined && record.dates.length !== days) || record.dates.some((date) => !validTravelDate(date))) fail("dates 需要与 days 一致的有效日期数组");
    const dates = record.dates as string[];
    if (dates.some((date, i) => i > 0 && Date.parse(date) - Date.parse(dates[i - 1]!) !== 86_400_000)) fail("dates 必须连续且按时间递增");
  }
  const window = (value: unknown, field: string, hasDay = false): void => {
    if (!object(value) || typeof value.start !== "string" || typeof value.end !== "string" || !TIME.test(value.start) || !TIME.test(value.end) || value.start >= value.end) fail(`${field} 需要 HH:mm 且 start < end`);
    for (const key of Object.keys(value as object)) if (!["start", "end", ...(hasDay ? ["day"] : [])].includes(key)) fail(`${field} 未知字段 ${key}`);
  };
  if (record.daily_window !== undefined) window(record.daily_window, "daily_window");
  if (record.day_windows !== undefined) {
    if (!Array.isArray(record.day_windows) || record.day_windows.length === 0) fail("day_windows 需要非空数组");
    const windows = record.day_windows as unknown[];
    const seen = new Set<number>();
    for (const value of windows) {
      window(value, "day_windows", true);
      const day = (value as Record<string, unknown>).day;
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > (days ?? (record.dates as string[] | undefined)?.length ?? 90) || seen.has(day)) fail("day_windows.day 需要不重复的有效日序");
      seen.add(day as number);
    }
  }
  // 完整验证后保留 JSON 值；调用方不能通过拼写错误悄悄丢失一条闸门。
  return structuredClone(record) as TravelRequirements;
}

/** 不相信模型保存的限制字段：直接对日期、条目、人数与房数逐项核对。 */
export function checkRequirements(itinerary: Itinerary, requirements: TravelRequirements, options: {
  /** 生产草稿可能从中间日期开始；正式评测仍按完整产物日序。 */
  readonly plannedDay?: (date: string | undefined, index: number) => number;
  readonly partial?: boolean;
} = {}): TravelRequirementCheck[] {
  const checks: TravelRequirementCheck[] = [];
  const add = (code: string, passed: boolean, message: string, day?: number): void => { checks.push({ code, passed, message, ...(day === undefined ? {} : { day }) }); };
  if (requirements.dates) {
    add("requested-dates", itinerary.days.length === requirements.dates.length && requirements.dates.every((date, i) => itinerary.days[i]?.date === date), `日期应依次为 ${requirements.dates.join("、")}；实际 ${itinerary.days.map((day) => day.date ?? "未填").join("、")}`);
  }
  const city = itinerary.constraints?.destination;
  for (const forbidden of requirements.forbidden_visits ?? []) {
    const hits = itinerary.days.flatMap((day, index) => violatesForbiddenVisit(day.items.filter((item) => item.type === "visit"), forbidden, city) ? [index + 1] : []);
    if (options.partial && hits.length) {
      for (const day of hits) add("forbidden-visit", false, `禁去景点「${forbidden}」仍出现在游览安排中`, day);
    } else add("forbidden-visit", hits.length === 0, `禁去景点「${forbidden}」${hits.length ? "仍出现在游览安排中" : "未被安排"}`);
  }
  for (const [index, day] of itinerary.days.entries()) {
    const dayNumber = options.plannedDay?.(day.date, index) ?? index + 1;
    if (requirements.max_visits_per_day !== undefined) {
      const count = mainVisitCount(day.items.filter((item) => item.type === "visit").map((item) => ({ ...item, area_group: item.evidence_verified ? item.area_group : undefined })));
      add("daily-visit-limit", count <= requirements.max_visits_per_day, `第 ${dayNumber} 天游览 ${count} 个主景点，上限 ${requirements.max_visits_per_day}`, index + 1);
    }
    const windows = [requirements.daily_window, requirements.day_windows?.find((value) => value.day === dayNumber)].filter((value): value is TravelTimeWindow => value !== undefined);
    for (const allowed of windows) {
      // meal 是并列餐厅候选，不是每家都要执行的活动；实际用餐由休整时间块表示。
      const scheduled = day.items.filter((item) => !["note", "accommodation", "meal"].includes(item.type));
      const invalid = scheduled.filter((item) => {
        if (!item.time || !TIME.test(item.time) || (item.end_time !== undefined && !TIME.test(item.end_time))) return true;
        const end = itemEndMinutes(item), start = timeToMinutes(item.time);
        return end === undefined || end <= start || start < timeToMinutes(allowed.start) || end > timeToMinutes(allowed.end);
      });
      add("activity-window", scheduled.length > 0 && invalid.length === 0, `第 ${dayNumber} 天活动限 ${allowed.start}—${allowed.end}${invalid.length ? `；越界或缺少有效起止时间：${invalid.map((item) => item.name).join("、")}` : scheduled.length ? "；符合" : "；没有可验证活动"}`, index + 1);
    }
  }
  if (!options.partial) for (const window of requirements.day_windows ?? []) {
    if (!itinerary.days[window.day - 1]) add("activity-window", false, `缺少第 ${window.day} 天，无法验证可用时段`);
  }
  if (requirements.travelers !== undefined) add("traveler-count", itinerary.travelers === requirements.travelers, `出行人数应为 ${requirements.travelers}；实际 ${itinerary.travelers ?? "未填"}`);
  const stays = itinerary.days.flatMap((day) => day.items.filter((item) => item.type === "accommodation"));
  if (requirements.room_count !== undefined) {
    const count = requirements.room_count;
    if (options.partial) {
      itinerary.days.forEach((day, index) => {
        if (day.items.some((item) => item.type === "accommodation" && (item.room_count ?? itinerary.room_count) !== count)) add("room-count", false, `住宿条目应为 ${count} 间房`, index + 1);
      });
      if (itinerary.room_count !== count || stays.length === 0) add("room-count", false, `每晚房数应为 ${count}；${stays.length === 0 ? "未安排住宿" : "全局房数不符"}`);
    } else add("room-count", stays.length > 0 && stays.every((item) => (item.room_count ?? itinerary.room_count) === count), `每晚房数应为 ${count}；${stays.length ? "逐个核对住宿条目与全局房数" : "未安排住宿"}`);
  }
  if (requirements.fixed_stay) {
    const base = stays[0];
    const sameStay = stays.every((item) => base !== undefined && (base.location?.poi_id && item.location?.poi_id ? base.location.poi_id === item.location.poi_id : sameVisitName(base.name, item.name, city)));
    const covered = itinerary.days.slice(0, -1).every((day) => day.items.some((item) => item.type === "accommodation"));
    add("fixed-stay", stays.length > 0 && sameStay && covered, "全程固定同一酒店，且每个过夜日都有住宿锚点");
  }
  return checks;
}

type VisitForRequirement = Pick<import("./itinerary-schema.ts").PlannedVisit, "name" | "parent_visit" | "area_group"> & {
  readonly recommended_spots?: readonly string[];
};

export function mainVisitCount(visits: readonly VisitForRequirement[]): number {
  return new Set(visits.map((visit) => mainDestinationKey(visit.name, visit.parent_visit?.name, visit.area_group?.name))).size;
}

export function violatesForbiddenVisit(visits: readonly VisitForRequirement[], forbidden: string, city?: string): boolean {
  return visits.some((visit) => [visit.name, visit.parent_visit?.name, ...(visit.recommended_spots ?? [])]
    .some((name) => name !== undefined && requiredVisitMatches(forbidden, name, city)));
}
