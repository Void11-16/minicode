import type { RecommendationMode } from "./recommendation-policy.ts";
import type { CoordinateSystem } from "./coordinates.ts";

export const ITINERARY_ITEM_TYPES = [
  "visit",
  "meal",
  "transport",
  "rest",
  "free_time",
  "accommodation",
  "note",
] as const;

export type ItineraryItemType = (typeof ITINERARY_ITEM_TYPES)[number];
export type MealSubtype = "breakfast" | "lunch" | "dinner" | "snack";
export type ItineraryConfidence = "high" | "medium" | "low";

export interface ItineraryLocation {
  readonly poi_id?: string;
  readonly crs?: CoordinateSystem;
  readonly name?: string;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly source?: string;
}

export interface ItineraryItem {
  readonly id: string;
  readonly time?: string;
  readonly end_time?: string;
  /** 用户指定或已确认预约/车次的固定开始时刻，自动路线修复不得顺延。 */
  readonly time_locked?: boolean;
  readonly type: ItineraryItemType;
  readonly subtype?: MealSubtype;
  /** 业务细分类型，如古迹/博物馆/公园；meal 可填菜系 */
  readonly place_type?: string;
  readonly name: string;
  /** 动作说明，与地点身份分开，如返回酒店、办理入住。 */
  readonly activity?: string;
  /** 重游说明；不构成用户授权，不能据此跳过重复检查。 */
  readonly repeat_reason?: string;
  /** 程序根据地点证据回填的包含关系；不是第二个独立游览安排。 */
  readonly parent_visit?: ScenicParent;
  readonly closure_holiday_exception?: boolean;
  /** 主景区内部可选地点，不单独计数、不生成路线停留点。 */
  readonly recommended_spots?: readonly string[];
  readonly location?: ItineraryLocation;
  readonly planned_duration_min?: number;
  readonly transport_mode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly distance_km?: number;
  readonly cost_per_person?: number;
  readonly ticket_price_per_person?: number;
  /** 住宿参考价：元/房/晚。锚点重复出现不重复计费。 */
  readonly room_price_per_night?: number;
  readonly room_count?: number;
  readonly stay_nights?: number;
  readonly evidence_observed_at?: number;
  readonly opening_hours?: ItineraryOpeningHours;
  /** 开放信息由证据仓库回填，保留实际采用的字段证据ID。 */
  readonly opening_evidence_ids?: readonly string[];
  readonly opening_sessions?: readonly { readonly starts: string; readonly ends?: string }[];
  readonly closed_dates?: readonly string[];
  readonly closed_on?: readonly string[];
  readonly closure_verified?: boolean;
  readonly closure_policy_version?: number;
  readonly reservation_required?: boolean;
  readonly cuisine?: string;
  readonly source?: string;
  readonly confidence?: ItineraryConfidence;
  readonly note?: string;
  readonly evidence_id?: string;
  readonly evidence_verified?: boolean;
  readonly rating?: number;
  readonly route_evidence_id?: string;
  readonly route_verified?: boolean;
  readonly route_duration_min?: number;
  /** 程序生成的路线绑定/日序差异；每次保存重新计算，模型无需填写。 */
  readonly route_binding_error?: string;
}

export interface ItineraryOpeningHours {
  readonly opens: string;
  readonly closes: string;
  readonly last_admission?: string;
  readonly source?: string;
  readonly intervals?: readonly { readonly opens: string; readonly closes: string }[];
}

export type ItineraryDayType = "full" | "arrival" | "departure" | "transfer";
export interface ItineraryDay {
  readonly day_type?: ItineraryDayType;
  readonly available_start?: string;
  readonly available_end?: string;
  readonly date?: string;
  readonly theme?: string;
  readonly items: readonly ItineraryItem[];
}

export interface Itinerary {
  readonly title: string;
  readonly days: readonly ItineraryDay[];
  readonly itinerary_id?: string;
  readonly revision?: number;
  readonly budget_per_person_yuan?: number;
  readonly budget_source?: "brief" | "explicit";
  readonly travelers?: number;
  readonly room_count?: number;
  readonly constraints?: ItineraryConstraints;
  /** 粗排预留不计入已完成日期；实际安排仍以days为准。 */
  readonly outline?: readonly ItineraryOutlineDay[];
  readonly excluded_visits?: readonly ExcludedVisit[];
}

export interface ScenicParent { readonly name: string; readonly evidence_id?: string }
export interface RepeatVisitPermission { readonly name: string; readonly user_message_id: string; readonly user_quote: string }
export interface PlannedVisit { readonly name: string; readonly evidence_id?: string; readonly repeat_reason?: string; readonly parent_visit?: ScenicParent }
export interface ItineraryOutlineDay { readonly date: string; readonly theme?: string; readonly visits: readonly PlannedVisit[] }
export interface ExcludedVisit extends PlannedVisit { readonly reason: string }

export interface ItineraryConstraints {
  /** 仅由宿主根据真实用户消息生成；保存工具不接受模型提供的授权。 */
  readonly repeat_visit_permissions?: readonly RepeatVisitPermission[];
  readonly must_visit?: readonly string[];
  readonly route_tolerance_min?: number;
  readonly route_tolerance_ratio?: number;
  readonly allow_hotel_changes?: boolean;
  readonly base_stay_name?: string;
  /** 远郊日单段交通上限，分钟；默认 240，普通城市日仍为 150。 */
  readonly remote_leg_limit_min?: number;
  readonly start_date?: string;
  readonly end_date?: string;
  readonly expected_days?: number;
  readonly destination?: string;
  readonly day_start?: string;
  readonly day_end?: string;
  readonly require_accommodation?: boolean;
  readonly require_routes?: boolean;
  readonly require_place_evidence?: boolean;
  readonly recommendations?: boolean;
  readonly recommendation_mode?: RecommendationMode;
  readonly meal_candidates_target?: number;
  readonly meal_evidence_target?: number;
}

const TYPE_ALIASES: Record<string, ItineraryItemType> = {
  visit: "visit",
  景点: "visit",
  attraction: "visit",
  sightseeing: "visit",
  meal: "meal",
  餐饮: "meal",
  restaurant: "meal",
  早餐: "meal",
  午餐: "meal",
  晚餐: "meal",
  小吃: "meal",
  transport: "transport",
  交通: "transport",
  transit: "transport",
  walking: "transport",
  cycling: "transport",
  driving: "transport",
  rest: "rest",
  休息: "rest",
  free_time: "free_time",
  自由活动: "free_time",
  accommodation: "accommodation",
  住宿: "accommodation",
  note: "note",
  备注: "note",
};

const MEAL_SUBTYPE_ALIASES: Record<string, MealSubtype> = {
  breakfast: "breakfast",
  早餐: "breakfast",
  brunch: "breakfast",
  lunch: "lunch",
  午餐: "lunch",
  午饭: "lunch",
  dinner: "dinner",
  晚餐: "dinner",
  晚饭: "dinner",
  snack: "snack",
  小吃: "snack",
  下午茶: "snack",
};

const CONFIDENCE_ALIASES: Record<string, ItineraryConfidence> = {
  high: "high",
  高: "high",
  medium: "medium",
  中: "medium",
  low: "low",
  低: "low",
};

const TRANSPORT_MODE_ALIASES: Record<string, string> = {
  walking: "walking",
  步行: "walking",
  transit: "transit",
  公交: "transit",
  地铁: "transit",
  driving: "driving",
  驾车: "driving",
  cycling: "cycling",
  骑行: "cycling",
  taxi: "taxi",
  打车: "taxi",
};

const CLOSED_ON_ALIASES: Record<string, string> = {
  Monday: "Monday",
  周一: "Monday",
  Tuesday: "Tuesday",
  周二: "Tuesday",
  Wednesday: "Wednesday",
  周三: "Wednesday",
  Thursday: "Thursday",
  周四: "Thursday",
  Friday: "Friday",
  周五: "Friday",
  Saturday: "Saturday",
  周六: "Saturday",
  Sunday: "Sunday",
  周日: "Sunday",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseItinerary(raw: unknown): Itinerary {
  const source = objectOf(raw);
  if (source === null) throw new Error("行程必须是对象");

  const title = optionalString(source.title);
  if (title === undefined || title === "") throw new Error("title 必须是非空字符串");
  const outline = parseOutline(source.outline);
  if (!Array.isArray(source.days) || (source.days.length === 0 && !outline?.length)) {
    throw new Error("days 必须是非空数组");
  }

  // 条目 id 在整份行程内唯一：前端把 id 当作全局键（照片缓存、标记定位）。id → 所在天的下标
  const ids = new Map<string, number>();
  const days = source.days.map((day, dayIndex) => parseDay(day, dayIndex, ids));
  const dates = new Map<string, number>();
  for (const [index, day] of days.entries()) {
    if (day.date === undefined) continue;
    const previous = dates.get(day.date);
    if (previous !== undefined) {
      throw new Error(`days[${previous}] 与 days[${index}] 使用了相同日期 ${day.date}`);
    }
    dates.set(day.date, index);
  }
  const constraints = objectOf(source.constraints);
  if (constraints?.route_tolerance_min !== undefined) boundedNumber(constraints.route_tolerance_min, "route_tolerance_min", 0, 15);
  if (constraints?.route_tolerance_ratio !== undefined) boundedNumber(constraints.route_tolerance_ratio, "route_tolerance_ratio", 0, .25);
  if (constraints?.remote_leg_limit_min !== undefined) boundedNumber(constraints.remote_leg_limit_min, "remote_leg_limit_min", 60, 480);
  if (constraints?.must_visit !== undefined && (!Array.isArray(constraints.must_visit) || constraints.must_visit.some((v) => typeof v !== "string" || v.trim() === ""))) throw new Error("must_visit 必须为非空名称的数组");
  if (constraints?.recommendation_mode !== undefined && !["off", "advisory", "strict"].includes(String(constraints.recommendation_mode))) throw new Error("recommendation_mode 不合法");
  if (constraints?.meal_candidates_target !== undefined && (!Number.isInteger(constraints.meal_candidates_target) || Number(constraints.meal_candidates_target) < 1 || Number(constraints.meal_candidates_target) > 20)) throw new Error("meal_candidates_target 需要 1-20 的整数");
  if (source.budget_source !== undefined && !["brief", "explicit"].includes(String(source.budget_source))) throw new Error("budget_source 不合法");
  return { title, days,
    ...(outline === undefined ? {} : { outline }),
    ...(source.excluded_visits === undefined ? {} : { excluded_visits: parseExcludedVisits(source.excluded_visits) }),
    ...(source.budget_source === undefined ? {} : { budget_source: source.budget_source as "brief" | "explicit" }),
    ...(source.travelers === undefined ? {} : { travelers: positiveInteger(source.travelers, "travelers") }),
    ...(source.room_count === undefined ? {} : { room_count: positiveInteger(source.room_count, "room_count") }),
    ...(source.itinerary_id === undefined ? {} : { itinerary_id: optionalString(source.itinerary_id) }),
    ...(source.revision === undefined ? {} : { revision: positiveNumber(source.revision, "revision") }),
    ...(source.budget_per_person_yuan === undefined ? {} : { budget_per_person_yuan: nonNegativeNumber(source.budget_per_person_yuan, "budget_per_person_yuan") }),
    ...(constraints === null ? {} : { constraints: {
      ...(constraints.repeat_visit_permissions === undefined ? {} : { repeat_visit_permissions: parseRepeatPermissions(constraints.repeat_visit_permissions) }),
      ...(constraints.must_visit === undefined ? {} : { must_visit: [...new Set((constraints.must_visit as string[]).map((v) => v.trim()))] }),
      ...(constraints.expected_days === undefined ? {} : { expected_days: positiveNumber(constraints.expected_days, "expected_days") }),
      ...(constraints.route_tolerance_min === undefined ? {} : { route_tolerance_min: Number(constraints.route_tolerance_min) }),
      ...(constraints.route_tolerance_ratio === undefined ? {} : { route_tolerance_ratio: Number(constraints.route_tolerance_ratio) }),
      ...(constraints.allow_hotel_changes === undefined ? {} : { allow_hotel_changes: parseBoolean(constraints.allow_hotel_changes, "allow_hotel_changes") }),
      ...(constraints.base_stay_name === undefined ? {} : { base_stay_name: optionalString(constraints.base_stay_name) }),
      ...(constraints.remote_leg_limit_min === undefined ? {} : { remote_leg_limit_min: Number(constraints.remote_leg_limit_min) }),
      ...(constraints.start_date === undefined ? {} : { start_date: optionalString(constraints.start_date) }),
      ...(constraints.end_date === undefined ? {} : { end_date: optionalString(constraints.end_date) }),
      ...(constraints.destination === undefined ? {} : { destination: optionalString(constraints.destination) }),
      ...(constraints.day_start === undefined ? {} : { day_start: optionalTime(constraints.day_start, "day_start") }),
      ...(constraints.day_end === undefined ? {} : { day_end: optionalTime(constraints.day_end, "day_end") }),
      ...(constraints.recommendation_mode === undefined ? {} : { recommendation_mode: constraints.recommendation_mode as RecommendationMode }),
      ...(constraints.meal_candidates_target === undefined ? {} : { meal_candidates_target: Number(constraints.meal_candidates_target) }),
      ...(constraints.meal_evidence_target === undefined ? {} : { meal_evidence_target: boundedNumber(constraints.meal_evidence_target, "meal_evidence_target", 0, 1) }),
      ...Object.fromEntries(["require_accommodation", "require_routes", "require_place_evidence", "recommendations"].flatMap((key) => constraints[key] === undefined ? [] : [[key, parseBoolean(constraints[key], key)]])),
    } }),
  };
}

function parsePlannedVisit(raw: unknown): PlannedVisit {
  const source = objectOf(raw), name = optionalString(source?.name);
  if (!source || !name || name.length > 200) throw new Error("粗排景点需要不超过200字的name");
  return { name, ...(source.evidence_id === undefined ? {} : { evidence_id: optionalString(source.evidence_id) }), ...(source.repeat_reason === undefined ? {} : { repeat_reason: optionalString(source.repeat_reason) }), ...(source.parent_visit === undefined ? {} : { parent_visit: parseScenicParent(source.parent_visit) }) };
}

function parseScenicParent(raw: unknown): ScenicParent {
  const parent = objectOf(raw), name = parent && optionalString(parent.name);
  if (!name || name.length > 100) throw new Error("parent_visit需要有效主景区name");
  return { name, ...(parent.evidence_id === undefined ? {} : { evidence_id: optionalString(parent.evidence_id) }) };
}

function parseRepeatPermissions(raw: unknown): RepeatVisitPermission[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("repeat_visit_permissions最多100项");
  return raw.map((value) => {
    const row = objectOf(value), name = row && optionalString(row.name), user_message_id = row && optionalString(row.user_message_id), user_quote = row && optionalString(row.user_quote);
    if (!name || !user_message_id || !user_quote || name.length > 100 || user_message_id.length > 200 || user_quote.length > 500) throw new Error("重游授权需要地点、真实用户消息ID和500字以内原文");
    return { name, user_message_id, user_quote };
  });
}
function parseOutline(raw: unknown): ItineraryOutlineDay[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 90) throw new Error("outline 需要最多90天的数组");
  const dates = new Set<string>();
  return raw.map((entry) => {
    const value = objectOf(entry), date = optionalString(value?.date);
    if (!value || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || dates.has(date)) throw new Error("outline.date 必须为有效、不重复的YYYY-MM-DD日期");
    if (!Array.isArray(value.visits) || value.visits.length > 20) throw new Error("outline.visits 需要最多20个主景点的数组");
    dates.add(date);
    return { date, ...(value.theme === undefined ? {} : { theme: optionalString(value.theme) }), visits: value.visits.map(parsePlannedVisit) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}
function parseExcludedVisits(raw: unknown): ExcludedVisit[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("excluded_visits 需要最多100个景点的数组");
  return raw.map((entry) => { const value = objectOf(entry), reason = optionalString(value?.reason); if (!reason || reason.length > 500) throw new Error("排除景点必须说明reason，最多500字"); return { ...parsePlannedVisit(entry), reason }; });
}

function parseDay(raw: unknown, dayIndex: number, ids: Map<string, number>): ItineraryDay {
  const source = objectOf(raw);
  if (source === null) throw new Error(`days[${dayIndex}] 必须是对象`);
  if (!Array.isArray(source.items) || source.items.length === 0) {
    throw new Error(`days[${dayIndex}].items 必须是非空数组`);
  }

  const date = optionalString(source.date);
  const theme = optionalString(source.theme);
  if (source.day_type !== undefined && !["full", "arrival", "departure", "transfer"].includes(String(source.day_type))) throw new Error("day_type 不合法");
  const availableStart = optionalTime(source.available_start, "available_start"), availableEnd = optionalTime(source.available_end, "available_end");
  if (availableStart !== undefined && availableEnd !== undefined && timeToMinutes(availableStart) >= timeToMinutes(availableEnd)) throw new Error("当天可用时段必须先开始后结束");
  return {
    ...(source.day_type === undefined ? {} : { day_type: source.day_type as ItineraryDayType }),
    ...(availableStart === undefined ? {} : { available_start: availableStart }),
    ...(availableEnd === undefined ? {} : { available_end: availableEnd }),
    ...(date !== undefined ? { date } : {}),
    ...(theme !== undefined ? { theme } : {}),
    items: source.items.map((item, itemIndex) =>
      parseItem(item, `day-${dayIndex + 1}-item-${itemIndex + 1}`, ids, dayIndex),
    ),
  };
}

/**
 * id 全局唯一化：同一天内重名仍然报错（模型很可能漏改条目）；
 * 跨天重名改写为默认 id（day-N-item-M）——模型习惯照抄 Day 1 的自动 id，
 * 直接报错会让已保存的行程读不出来。改写不依赖原始文本，重复解析结果稳定。
 */
function uniqueId(requested: string, ids: Map<string, number>, defaultId: string, dayIndex: number): string {
  const owner = ids.get(requested);
  if (owner === undefined) return requested;
  if (owner === dayIndex) throw new Error(`行程条目 id 重复: ${requested}`);
  if (ids.get(defaultId) === undefined) return defaultId;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${defaultId}-${suffix}`;
    if (ids.get(candidate) === undefined) return candidate;
  }
}

/** 新增交通可由明确端点生成展示名，地点活动仍要求真实名称。 */
export function itineraryItemName(source: Record<string, unknown>): string | undefined {
  const name = optionalString(source.name);
  if (name !== undefined) return name;
  const type = TYPE_ALIASES[optionalString(source.type) ?? ""];
  if (type === "transport") {
    const from = optionalString(source.from), to = optionalString(source.to);
    if (from && to) return `${from} → ${to}`;
    if (optionalString(source.route_evidence_id)) return "交通";
  }
  return ["rest", "free_time", "note"].includes(type ?? "") ? optionalString(source.activity) : undefined;
}

function parseItem(raw: unknown, defaultId: string, ids: Map<string, number>, dayIndex: number): ItineraryItem {
  const source = objectOf(raw);
  if (source === null) throw new Error("行程条目必须是对象");
  const name = itineraryItemName(source);
  if (name === undefined || name === "") throw new Error("每个行程条目必须有非空 name");

  const originalType = optionalString(source.type) ?? "";
  const type = parseItemType(originalType);
  const id = uniqueId(optionalString(source.id) ?? defaultId, ids, defaultId, dayIndex);
  ids.set(id, dayIndex);

  const time = optionalTime(source.time, "time");
  const endTime = optionalTime(source.end_time, "end_time");
  if (time !== undefined && endTime !== undefined && timeToMinutes(endTime) <= timeToMinutes(time)) {
    throw new Error(`end_time 必须晚于 time（条目: ${name}）`);
  }

  const subtype = parseMealSubtype(source.subtype, originalType, type);
  const placeType =
    optionalString(source.place_type) ??
    optionalString(source.visit_type) ??
    (type === "visit" ? optionalString(source.subtype) : undefined);
  const transportMode = parseTransportMode(source.transport_mode, originalType, type);
  const plannedDuration = positiveNumber(source.planned_duration_min, "planned_duration_min");
  const from = optionalString(source.from);
  const to = optionalString(source.to);
  const distanceKm = positiveNumber(source.distance_km, "distance_km");
  const costPerPerson = nonNegativeNumber(source.cost_per_person, "cost_per_person");
  const ticketPrice = nonNegativeNumber(source.ticket_price_per_person, "ticket_price_per_person");
  const closedOn = parseClosedOn(source.closed_on);
  const cuisine = optionalString(source.cuisine);
  const sourceName = optionalString(source.source);
  const note = optionalString(source.note);
  if (source.recommended_spots !== undefined && (type !== "visit" || !Array.isArray(source.recommended_spots) || source.recommended_spots.length > 10 || source.recommended_spots.some((v) => typeof v !== "string" || v.trim() === "" || v.length > 100))) throw new Error("recommended_spots 仅用于景点，最多 10 个非空名称（各不超过 100 字）");
  return {
    id,
    ...(source.room_price_per_night === undefined ? {} : { room_price_per_night: nonNegativeNumber(source.room_price_per_night, "room_price_per_night") }),
    ...(source.room_count === undefined ? {} : { room_count: positiveInteger(source.room_count, "room_count") }),
    ...(source.stay_nights === undefined ? {} : { stay_nights: nonNegativeInteger(source.stay_nights, "stay_nights") }),
    ...(source.evidence_observed_at === undefined ? {} : { evidence_observed_at: nonNegativeNumber(source.evidence_observed_at, "evidence_observed_at") }),
    ...(source.evidence_id === undefined ? {} : { evidence_id: optionalString(source.evidence_id) }),
    ...(source.evidence_verified === undefined ? {} : { evidence_verified: parseBoolean(source.evidence_verified, "evidence_verified") }),
    ...(source.rating === undefined ? {} : { rating: boundedNumber(source.rating, "rating", 0, 5) }),
    ...(source.route_evidence_id === undefined ? {} : { route_evidence_id: optionalString(source.route_evidence_id) }),
    ...(source.route_verified === undefined ? {} : { route_verified: parseBoolean(source.route_verified, "route_verified") }),
    ...(source.route_duration_min === undefined ? {} : { route_duration_min: nonNegativeNumber(source.route_duration_min, "route_duration_min") }),
    ...(source.route_binding_error === undefined ? {} : { route_binding_error: optionalString(source.route_binding_error) }),
    ...(time !== undefined ? { time } : {}),
    ...(endTime !== undefined ? { end_time: endTime } : {}),
    ...(source.time_locked === undefined ? {} : { time_locked: parseBoolean(source.time_locked, "time_locked") }),
    type,
    ...(subtype !== undefined ? { subtype } : {}),
    ...(placeType !== undefined ? { place_type: placeType } : {}),
    name,
    ...(source.activity === undefined ? {} : { activity: optionalString(source.activity) }),
    ...(source.repeat_reason === undefined ? {} : { repeat_reason: optionalString(source.repeat_reason) }),
    ...(source.parent_visit === undefined ? {} : { parent_visit: parseScenicParent(source.parent_visit) }),
    ...(source.closure_holiday_exception === undefined ? {} : { closure_holiday_exception: parseBoolean(source.closure_holiday_exception, "closure_holiday_exception") }),
    ...(source.recommended_spots === undefined ? {} : { recommended_spots: [...new Set((source.recommended_spots as string[]).map((v) => v.trim()))] }),
    ...(source.location === undefined ? {} : { location: parseLocation(source.location) }),
    ...(plannedDuration !== undefined ? { planned_duration_min: plannedDuration } : {}),
    ...(transportMode !== undefined ? { transport_mode: transportMode } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(distanceKm !== undefined ? { distance_km: distanceKm } : {}),
    ...(costPerPerson !== undefined ? { cost_per_person: costPerPerson } : {}),
    ...(ticketPrice !== undefined ? { ticket_price_per_person: ticketPrice } : {}),
    ...(source.opening_hours === undefined ? {} : { opening_hours: parseOpeningHours(source.opening_hours) }),
    ...(source.opening_evidence_ids === undefined ? {} : { opening_evidence_ids: parseStringList(source.opening_evidence_ids, "opening_evidence_ids", 5) }),
    ...(source.closed_dates === undefined ? {} : { closed_dates: parseStringList(source.closed_dates, "closed_dates", 100).map((day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("closed_dates需要有效ISO日期"); return day;
    }) }),
    ...(source.opening_sessions === undefined ? {} : { opening_sessions: parseSessions(source.opening_sessions) }),
    ...(closedOn !== undefined ? { closed_on: closedOn } : {}),
    ...(source.closure_verified === undefined ? {} : { closure_verified: parseBoolean(source.closure_verified, "closure_verified") }),
    ...(source.closure_policy_version === undefined ? {} : { closure_policy_version: positiveInteger(source.closure_policy_version, "closure_policy_version") }),
    ...(source.reservation_required === undefined ? {} : { reservation_required: parseBoolean(source.reservation_required, "reservation_required") }),
    ...(cuisine !== undefined ? { cuisine } : {}),
    ...(sourceName !== undefined ? { source: sourceName } : {}),
    ...(source.confidence === undefined ? {} : { confidence: parseConfidence(source.confidence) }),
    ...(note !== undefined ? { note } : {}),
  };
}

function parseOpeningHours(raw: unknown): ItineraryOpeningHours {
  const source = objectOf(raw);
  if (source === null) throw new Error("opening_hours 必须是对象");

  const opens = optionalTime(source.opens, "opening_hours.opens");
  const closes = source.closes === "24:00" ? "24:00" : optionalTime(source.closes, "opening_hours.closes");
  if (opens === undefined || closes === undefined) {
    throw new Error("opening_hours.opens / closes 必须是 HH:MM");
  }
  const sourceName = optionalString(source.source);
  return {
    opens,
    closes,
    ...(source.intervals === undefined ? {} : { intervals: parseIntervals(source.intervals) }),
    ...(source.last_admission === undefined ? {} : { last_admission: optionalTime(source.last_admission, "opening_hours.last_admission") }),
    ...(sourceName !== undefined ? { source: sourceName } : {}),
  };
}

function parseIntervals(raw: unknown): readonly { opens: string; closes: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("开放区间必须是非空数组");
  return raw.map((entry) => {
    const interval = parseOpeningHours(entry);
    return { opens: interval.opens, closes: interval.closes };
  });
}

function parseStringList(raw: unknown, field: string, max: number): string[] {
  if (!Array.isArray(raw) || raw.length > max || raw.some((v) => typeof v !== "string" || !v.trim() || v.length > 200)) throw new Error(`${field}需要最多${max}项非空字符串`);
  return [...new Set(raw.map((v: string) => v.trim()))];
}
function parseSessions(raw: unknown): { starts: string; ends?: string }[] {
  if (!Array.isArray(raw) || raw.length > 30) throw new Error("opening_sessions需要最多30项");
  return raw.map((entry) => { const v = objectOf(entry), starts = v && optionalTime(v.starts, "sessions.starts"); if (!v || !starts) throw new Error("场次需要有效开始时间"); return { starts, ...(v.ends === undefined ? {} : { ends: optionalTime(v.ends, "sessions.ends") }) }; });
}

function positiveInteger(raw: unknown, field: string): number {
  const value = positiveNumber(raw, field);
  if (value === undefined || !Number.isSafeInteger(value)) throw new Error(`${field} 需要正整数`);
  return value;
}
function nonNegativeInteger(raw: unknown, field: string): number {
  const value = nonNegativeNumber(raw, field);
  if (value === undefined || !Number.isSafeInteger(value)) throw new Error(`${field} 需要非负整数`);
  return value;
}

function parseClosedOn(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw.filter((day): day is string => typeof day === "string") : [];
  if (!Array.isArray(raw) || values.length !== raw.length) {
    throw new Error("closed_on 需要字符串数组");
  }
  const days = values.map((day) => CLOSED_ON_ALIASES[day.trim()]);
  if (days.some((day) => day === undefined)) throw new Error("closed_on 包含不支持的星期");
  return days.filter((day, index) => days.indexOf(day) === index);
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw new Error(`${field} 需要布尔值`);
  return raw;
}

function parseLocation(raw: unknown): ItineraryLocation {
  const source = objectOf(raw);
  if (source === null) throw new Error("location 必须是对象");

  const latitude = boundedNumber(source.latitude, "location.latitude", -90, 90);
  const longitude = boundedNumber(source.longitude, "location.longitude", -180, 180);
  const name = optionalString(source.name);
  const address = optionalString(source.address);
  const sourceName = optionalString(source.source);
  if (source.crs !== undefined && source.crs !== "wgs84" && source.crs !== "gcj02") throw new Error("location.crs 不合法");
  return {
    ...(source.poi_id === undefined ? {} : { poi_id: optionalString(source.poi_id) }),
    ...(source.crs === undefined ? {} : { crs: source.crs as CoordinateSystem }),
    ...(name !== undefined ? { name } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(sourceName !== undefined ? { source: sourceName } : {}),
  };
}

function parseItemType(value: string): ItineraryItemType {
  if (value === "") return "visit";
  const type = TYPE_ALIASES[value];
  if (type === undefined) throw new Error(`不支持的行程条目 type: ${value}`);
  return type;
}

function parseMealSubtype(
  raw: unknown,
  originalType: string,
  type: ItineraryItemType,
): MealSubtype | undefined {
  const value = optionalString(raw);
  // 模型偶尔把景点业务类型写进 subtype；visit 已有 place_type 承接，不应让整份保存失败。
  if (type !== "meal") return undefined;
  if (value !== undefined) {
    const subtype = MEAL_SUBTYPE_ALIASES[value];
    if (subtype === undefined) throw new Error(`不支持的 meal subtype: ${value}`);
    return subtype;
  }
  return MEAL_SUBTYPE_ALIASES[originalType];
}

function parseTransportMode(
  raw: unknown,
  originalType: string,
  type: ItineraryItemType,
): string | undefined {
  const value = optionalString(raw);
  if (value !== undefined) {
    if (type !== "transport") throw new Error("transport_mode 只能用于 transport 条目");
    const mode = TRANSPORT_MODE_ALIASES[value] ?? value;
    return mode;
  }
  if (type !== "transport") return undefined;
  return TRANSPORT_MODE_ALIASES[originalType];
}

function parseConfidence(raw: unknown): ItineraryConfidence {
  const value = optionalString(raw);
  const confidence = value === undefined ? undefined : CONFIDENCE_ALIASES[value];
  if (confidence === undefined) throw new Error("confidence 必须是 high / medium / low");
  return confidence;
}

function optionalTime(raw: unknown, field: string): string | undefined {
  const value = optionalString(raw);
  if (value === undefined) return undefined;
  if (!TIME_PATTERN.test(value)) throw new Error(`${field} 需要 HH:MM 格式（24 小时制）`);
  return value;
}

export function timeToMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function optionalString(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("字段必须是字符串");
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function positiveNumber(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${field} 需要正数`);
  }
  return raw;
}

function nonNegativeNumber(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${field} 需要非负数字`);
  }
  return raw;
}

function boundedNumber(raw: unknown, field: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${field} 超出有效范围`);
  }
  return raw;
}

function objectOf(raw: unknown): Record<string, unknown> | null {
  return isRecord(raw) ? raw : null;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
