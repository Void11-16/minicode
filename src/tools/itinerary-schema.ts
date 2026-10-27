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
  readonly type: ItineraryItemType;
  readonly subtype?: MealSubtype;
  /** 业务细分类型，如古迹/博物馆/公园；meal 可填菜系 */
  readonly place_type?: string;
  readonly name: string;
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
  readonly closed_on?: readonly string[];
  readonly closure_verified?: boolean;
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
}

export interface ItineraryOpeningHours {
  readonly opens: string;
  readonly closes: string;
  readonly last_admission?: string;
  readonly source?: string;
  readonly intervals?: readonly { readonly opens: string; readonly closes: string }[];
}

export interface ItineraryDay {
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
}

export interface ItineraryConstraints {
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
  if (!Array.isArray(source.days) || source.days.length === 0) {
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
  if (source.budget_source !== undefined && !["brief", "explicit"].includes(String(source.budget_source))) throw new Error("budget_source 不合法");
  return { title, days,
    ...(source.budget_source === undefined ? {} : { budget_source: source.budget_source as "brief" | "explicit" }),
    ...(source.travelers === undefined ? {} : { travelers: positiveInteger(source.travelers, "travelers") }),
    ...(source.room_count === undefined ? {} : { room_count: positiveInteger(source.room_count, "room_count") }),
    ...(source.itinerary_id === undefined ? {} : { itinerary_id: optionalString(source.itinerary_id) }),
    ...(source.revision === undefined ? {} : { revision: positiveNumber(source.revision, "revision") }),
    ...(source.budget_per_person_yuan === undefined ? {} : { budget_per_person_yuan: nonNegativeNumber(source.budget_per_person_yuan, "budget_per_person_yuan") }),
    ...(constraints === null ? {} : { constraints: {
      ...(constraints.expected_days === undefined ? {} : { expected_days: positiveNumber(constraints.expected_days, "expected_days") }),
      ...(constraints.start_date === undefined ? {} : { start_date: optionalString(constraints.start_date) }),
      ...(constraints.end_date === undefined ? {} : { end_date: optionalString(constraints.end_date) }),
      ...(constraints.destination === undefined ? {} : { destination: optionalString(constraints.destination) }),
      ...(constraints.day_start === undefined ? {} : { day_start: optionalTime(constraints.day_start, "day_start") }),
      ...(constraints.day_end === undefined ? {} : { day_end: optionalTime(constraints.day_end, "day_end") }),
      ...Object.fromEntries(["require_accommodation", "require_routes", "require_place_evidence", "recommendations"].flatMap((key) => constraints[key] === undefined ? [] : [[key, parseBoolean(constraints[key], key)]])),
    } }),
  };
}

function parseDay(raw: unknown, dayIndex: number, ids: Map<string, number>): ItineraryDay {
  const source = objectOf(raw);
  if (source === null) throw new Error(`days[${dayIndex}] 必须是对象`);
  if (!Array.isArray(source.items) || source.items.length === 0) {
    throw new Error(`days[${dayIndex}].items 必须是非空数组`);
  }

  const date = optionalString(source.date);
  const theme = optionalString(source.theme);
  return {
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

function parseItem(raw: unknown, defaultId: string, ids: Map<string, number>, dayIndex: number): ItineraryItem {
  const source = objectOf(raw);
  if (source === null) throw new Error("行程条目必须是对象");

  const name = optionalString(source.name);
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
    ...(time !== undefined ? { time } : {}),
    ...(endTime !== undefined ? { end_time: endTime } : {}),
    type,
    ...(subtype !== undefined ? { subtype } : {}),
    ...(placeType !== undefined ? { place_type: placeType } : {}),
    name,
    ...(source.location === undefined ? {} : { location: parseLocation(source.location) }),
    ...(plannedDuration !== undefined ? { planned_duration_min: plannedDuration } : {}),
    ...(transportMode !== undefined ? { transport_mode: transportMode } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(distanceKm !== undefined ? { distance_km: distanceKm } : {}),
    ...(costPerPerson !== undefined ? { cost_per_person: costPerPerson } : {}),
    ...(ticketPrice !== undefined ? { ticket_price_per_person: ticketPrice } : {}),
    ...(source.opening_hours === undefined ? {} : { opening_hours: parseOpeningHours(source.opening_hours) }),
    ...(closedOn !== undefined ? { closed_on: closedOn } : {}),
    ...(source.closure_verified === undefined ? {} : { closure_verified: parseBoolean(source.closure_verified, "closure_verified") }),
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
  const closes = optionalTime(source.closes, "opening_hours.closes");
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
