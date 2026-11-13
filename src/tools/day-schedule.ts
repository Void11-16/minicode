import { createHash } from "node:crypto";
import type { Itinerary, ItineraryDay, ItineraryItem } from "./itinerary-schema.ts";
import type { TravelEvidenceStore } from "./travel-evidence.ts";
import { validateToolArguments } from "./tool-contract.ts";
import { ToolValidationError } from "../core/tool-error.ts";
import { haversineKm } from "./geo.ts";
import { convertPoint } from "./coordinates.ts";
import { isConcreteStayName } from "./stay-policy.ts";
import { itineraryDayRole } from "./day-role.ts";

type Mode = "walking" | "transit" | "driving";
export interface DayScheduleInput {
  readonly date: string;
  readonly visits?: readonly { readonly name: string; readonly duration_min?: number; readonly at?: string }[];
  readonly mode?: Mode;
  readonly leg_modes?: readonly Mode[];
  readonly start?: string;
  readonly end?: string;
  readonly available_end?: string;
  readonly start_place?: string;
  readonly end_place?: string;
  readonly return_station?: string;
  readonly meal_candidates?: readonly { readonly name: string; readonly subtype: "lunch" | "dinner" }[];
}
const timeSchema = { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" };
const modeSchema = { type: "string", enum: ["walking", "transit", "driving"] };
export const dayScheduleSchema = {
  type: "object", additionalProperties: false, required: ["date"],
  description: "程序生成单日时间线。visits提供景点顺序、可选时长和固定开始时刻，省略则采用本日outline。自动排交通、午餐和等待。普通游玩日未填酒店起终点时，沿用行程已选的唯一酒店。未知路线为估算，真实路线查询后用repair_routes重排。参考节奏时间可顺延，超出明确时间窗则拒绝并保留旧日程。",
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    visits: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 1 }, duration_min: { type: "integer", minimum: 1, maximum: 720 }, at: timeSchema,
    } } },
    mode: modeSchema, leg_modes: { type: "array", maxItems: 21, items: modeSchema },
    start: timeSchema, end: timeSchema, start_place: { type: "string", minLength: 1 }, end_place: { type: "string", minLength: 1 },
    available_end: { ...timeSchema, description: "用户明确要求或已确认的当日最晚结束时间，末日可填最晚到站时间；会保留为硬边界。估排结束用end。" },
    return_station: { type: "string", minLength: 1, description: "末日返程车站或机场。可用已确认或待核实的推荐站点，班次未知时保留待确认。末日visits可为空。" },
    meal_candidates: { type: "array", maxItems: 10, description: "已查的午餐和晚餐候选。同一餐段只计一次餐费。",
      items: { type: "object", additionalProperties: false, required: ["name", "subtype"], properties: {
        name: { type: "string", minLength: 1 }, subtype: { type: "string", enum: ["lunch", "dinner"] },
      } } },
  },
};
export function parseDaySchedule(raw: unknown): DayScheduleInput {
  validateToolArguments(dayScheduleSchema, raw as Record<string, unknown>);
  const value = raw as DayScheduleInput;
  if (!Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date) throw new Error("schedule.date不是有效日期");
  return structuredClone(value);
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (value: number) => `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;

/** 只继承同一行程中已选的酒店。已指定的端点及抵达、离开和转场日仍按原计划处理。 */
export function inheritedScheduleStay(plan: Itinerary, input: DayScheduleInput, dayType?: ItineraryDay["day_type"]): string | undefined {
  if (!plan.constraints?.require_accommodation || input.start_place || input.end_place || dayType && dayType !== "full") return undefined;
  const selected = new Set(plan.days.flatMap((day) => day.items.flatMap((item) =>
    item.type === "accommodation" && isConcreteStayName(item.name) ? [item.name] : [])));
  const fixed = plan.constraints.allow_hotel_changes === false ? plan.constraints.base_stay_name : undefined;
  if (fixed && selected.has(fixed)) return fixed;
  return selected.size === 1 ? selected.values().next().value : undefined;
}

/** 只负责给已选景点排时间；不删除目标、不缩短时长、不把估算标成核实。 */
export function buildDaySchedule(plan: Itinerary, input: DayScheduleInput, evidence: TravelEvidenceStore): ItineraryDay {
  const date = input.date, old = plan.days.find((day) => day.date === date), c = plan.constraints;
  const city = c?.destination ?? "";
  const fail = (message: string): never => { throw new ToolValidationError([{ code: "DAY_SCHEDULE_CONFLICT", path: "schedule", date,
    message: `${date}：${message}；未提交修改，已有日程保留。`, hint: "只调整本日景点顺序、时长或候选；已核实的路线直接复用。必去不可静默删除。" }]); };
  if (c?.start_date && date < c.start_date || c?.end_date && date > c.end_date) fail("日期超出需求单的行程范围");
  const index = c?.start_date ? Math.round((Date.parse(date) - Date.parse(c.start_date)) / 86400000) + 1 : (plan.outline?.findIndex((day) => day.date === date) ?? 0) + 1;
  const role = itineraryDayRole(plan, { date, day_type: old?.day_type }, index > 0 ? index - 1 : undefined);
  const departure = role === "departure";
  const station = input.return_station?.trim();
  if (input.return_station !== undefined && (!station || !departure)) fail("return_station须为末日的非空返程站点");
  if (station && /^(?:待确认|待定|返程站点|高铁站|火车站|机场|车站)$/.test(station)) fail("请填写实际站点名称，未知时保持待确认");
  const previousDay = plan.days.filter((day) => day.date && day.date < date).slice().sort((a, b) => a.date!.localeCompare(b.date!)).at(-1);
  const previousStay = departure ? previousDay?.items.filter((item) => item.type === "accommodation" && item.stay_nights !== 0 && isConcreteStayName(item.name)).at(-1)?.name : undefined;
  const windows = [c?.requirements?.daily_window, c?.requirements?.day_windows?.find((window) => window.day === index)].filter((value) => value !== undefined);
  const visits = input.visits ?? plan.outline?.find((day) => day.date === date)?.visits.map(({ name }): NonNullable<DayScheduleInput["visits"]>[number] => ({ name })) ?? [];
  const availableEnd = [input.available_end, old?.available_end].filter((time): time is string => !!time).sort()[0];
  const hardEnds = [availableEnd, ...windows.map((w) => w.end)].filter((time): time is string => !!time);
  const defaultStart = departure && visits.length === 0 && !hardEnds.some((time) => time <= "12:00") ? "12:00" : c?.day_start ?? "10:00";
  const start = Math.max(...[old?.available_start, ...windows.map((w) => w.start)].filter((t): t is string => !!t).map(minutes), minutes(input.start ?? defaultStart));
  // day_end 只用于节奏评分。路线耗时增加时可以自然顺延返店，硬边界仍由已知窗口控制。
  const end = Math.min(...hardEnds.map(minutes), minutes(input.end ?? "23:59"));
  if (start >= end) fail("没有可用时间窗");
  if (!visits.length && (!departure || !station || !(input.start_place ?? previousStay))) return fail("缺少本日景点；仅返程日可以用实际出发地点和return_station安排交通");
  const names = new Set<string>();
  for (const visit of visits) {
    const name = visit.name.trim();
    if (!name) fail("景点名称不能为空");
    if (names.has(name)) fail(`「${name}」在同一天被重复选中，请合并为一项`);
    names.add(name);
  }
  for (const item of old?.items ?? []) {
    if (!item.time_locked) continue;
    const selected = visits.find((visit) => visit.name === item.name);
    if (item.type !== "visit" || !selected || selected.at !== undefined && selected.at !== item.time) {
      fail(`已有固定安排「${item.name}」${item.time ?? ""}，请通过edits明确修改`);
    }
  }
  const mode = input.mode ?? "transit";
  const sharedStay = inheritedScheduleStay(plan, input, role);
  const startPlace = input.start_place ?? sharedStay ?? previousStay, endPlace = input.end_place ?? sharedStay;
  // 已选的内部路段方式按原顺序保留。新增的酒店路段采用当天默认方式。
  const legModes = sharedStay && input.leg_modes && visits.length ? [
    ...(visits[0]!.name === sharedStay ? [] : [mode]),
    ...input.leg_modes,
    ...(visits.at(-1)!.name === sharedStay ? [] : [mode]),
  ] : input.leg_modes;
  const items: ItineraryItem[] = [];
  let cursor = start, last = startPlace, leg = 0, lunch = start >= 14 * 60 || end <= 12 * 60;
  const id = (type: string, name: string, role = "") => `schedule-${createHash("sha256").update(JSON.stringify([date, type, name, role])).digest("hex").slice(0, 16)}`;
  const add = (item: Omit<ItineraryItem, "id" | "time" | "end_time">, duration: number, role = "") => {
    if (cursor + duration > end) fail(`「${item.name}」需要${duration}分钟，剩余${Math.max(0, end - cursor)}分钟（结束上限${clock(end)}）`);
    items.push({ ...item, id: id(item.type, item.name, role), time: clock(cursor), ...(duration ? { end_time: clock(cursor + duration), planned_duration_min: duration } : {}) });
    cursor += duration;
  };
  const meal = () => {
    add({ type: "rest", name: "午餐与午休", note: "预留45分钟，餐厅待确认。" }, 45);
    lunch = true;
  };
  const isStay = (name: string) => name === previousStay || evidence.stayNames(city).includes(name) || /酒店|旅馆|宾馆|旅舍|青旅|民宿|客栈/.test(name);
  const travel = (to: string) => {
    if (!last || last === to) return;
    const chosenMode = legModes?.[leg] ?? mode;
    leg += 1;
    const route = evidence.routesForItinerary(last, to, city).find((value) => value.mode === chosenMode);
    const a = evidence.point(last, city), b = evidence.point(to, city);
    const x = a && convertPoint(a, "wgs84"), y = b && convertPoint(b, "wgs84");
    const distance = x && y ? haversineKm(x.latitude, x.longitude, y.latitude, y.longitude) : undefined;
    const estimate = distance === undefined ? 30 : Math.ceil(distance * 1.4 / (chosenMode === "walking" ? 4 : chosenMode === "driving" ? 25 : 18) * 60 + (chosenMode === "walking" ? 0 : 10));
    const fare = old?.items.find((item) => item.type === "transport" && item.from === last && item.to === to && item.transport_mode === chosenMode)?.cost_per_person;
    const estimateNote = route ? undefined : distance === undefined ? "缺少坐标，暂留30分钟；查询真实路线后重新排时。" : "按直线距离、绕行系数和出行方式估算；待真实路线核验。";
    const note = [estimateNote, to === station ? "请按返程票务信息确认班次和进站提前量。" : undefined].filter(Boolean).join(" ");
    add({ type: "transport", name: `${last} → ${to}`, from: last, to, transport_mode: chosenMode, ...(fare === undefined ? {} : { cost_per_person: fare }),
      ...(route ? { route_evidence_id: route.id } : { confidence: "low", source: "规划估算，待核实" }), ...(note ? { note } : {}),
    }, Math.max(1, Math.ceil(route?.duration_min ?? estimate)));
  };
  if (last) {
    const checkout = departure && isStay(last);
    add({ type: departure && !checkout ? "rest" : "accommodation", name: last,
      activity: checkout ? "退房后出发" : "出发", ...(departure && !checkout ? {} : { stay_nights: 0 }) }, 0, "start");
  }
  const resolved: NonNullable<DayScheduleInput["visits"]>[number][] = [];
  for (const visit of visits) {
    const previous = old?.items.find((item) => item.type === "visit" && item.name === visit.name);
    const duration = visit.duration_min ?? previous?.planned_duration_min ?? (previous?.time && previous.end_time ? minutes(previous.end_time) - minutes(previous.time) : 120);
    const fixed = previous?.time_locked ? previous.time : visit.at;
    resolved.push({ name: visit.name, duration_min: duration, ...(fixed ? { at: fixed } : {}) });
    if (!lunch && cursor >= 12 * 60) meal();
    travel(visit.name);
    const allocated = plan.outline?.find((day) => day.date === date)?.visits.find((item) => item.name === visit.name);
    const bound = evidence.bind({ ...previous, ...allocated, id: id("visit", visit.name), type: "visit", name: visit.name }, city, date);
    const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(date).getUTCDay()]!;
    if (bound.closed_dates?.includes(date) || bound.closure_verified && !bound.closure_holiday_exception && bound.closed_on?.includes(weekday)) {
      fail(`「${visit.name}」有已核验的闭馆记录，请替换本日景点`);
    }
    if (fixed && minutes(fixed) < cursor) fail(`「${visit.name}」固定${fixed}开始，最早只能${clock(cursor)}到达`);
    let begin = fixed ? minutes(fixed) : cursor;
    if (bound.opening_hours) {
      const hours = bound.opening_hours;
      const intervals = hours.intervals?.length ? hours.intervals : [hours];
      const slot = intervals.map((period) => ({ begin: Math.max(begin, minutes(period.opens)), end: minutes(period.closes) }))
        .find((period) => period.begin + duration <= period.end && (!fixed || period.begin === begin) && (!hours.last_admission || period.begin <= minutes(hours.last_admission)));
      if (!slot) fail(`「${visit.name}」的${duration}分钟游览无法放进已知开放时间`);
      begin = slot!.begin;
    }
    if (begin > cursor) {
      if (!lunch && begin - Math.max(cursor, 12 * 60) >= 45) {
        if (cursor < 12 * 60) add({ type: "rest", name: "休息等待" }, 12 * 60 - cursor);
        meal();
      }
      if (begin > cursor) add({ type: "rest", name: `等待${visit.name}入场` }, begin - cursor);
    }
    const { time: _time, end_time: _end, planned_duration_min: _duration, time_locked: _lock, ...content } = bound;
    add({ ...content, ...(fixed ? { time_locked: true } : {}), note: [previous?.note, visit.duration_min === undefined && !previous ? "游览时长暂按120分钟估算，可调整；不代表已核实时长。" : undefined].filter(Boolean).join("；") || undefined }, duration);
    last = visit.name;
  }
  if (!lunch && !departure) meal();
  if (endPlace) {
    travel(endPlace);
    const stay = old?.items.find((item) => item.type === "accommodation" && item.name === endPlace && item.stay_nights !== 0);
    if (departure && !isStay(endPlace)) add({ type: "rest", name: endPlace, activity: "到达" }, 0, "end");
    else add({ ...stay, type: "accommodation", name: endPlace, activity: departure ? "取行李" : "返回住宿", ...(departure ? { stay_nights: 0 } : {}) }, 0, "end");
    last = endPlace;
  }
  if (station && last !== station) travel(station);
  if (legModes && legModes.length !== leg) fail(`leg_modes应为${leg}段，实际${legModes.length}段`);
  const supplied = input.meal_candidates ?? [];
  const replaced = new Set(supplied.map((item) => item.subtype));
  const previousMeals = old?.items.filter((item) => item.type === "meal" && !replaced.has(item.subtype as "lunch" | "dinner")) ?? [];
  const newMeals = [...new Map(supplied.map((item) => [id("meal", item.name, item.subtype), item])).entries()].map(([itemId, item]) =>
    evidence.bind({ ...item, type: "meal", id: itemId }, city, date));
  return { ...old, date, ...(availableEnd ? { available_end: availableEnd } : {}), ...(departure ? { day_type: "departure" as const } : {}), items: [...items, ...previousMeals, ...newMeals], schedule_input: { ...input, visits: resolved, mode,
    ...(sharedStay ? { start_place: sharedStay, end_place: sharedStay, ...(legModes ? { leg_modes: legModes } : {}) } : {}),
  } };
}
