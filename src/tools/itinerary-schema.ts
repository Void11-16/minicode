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
  readonly name: string;
  readonly location?: ItineraryLocation;
  readonly planned_duration_min?: number;
  readonly transport_mode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly distance_km?: number;
  readonly cost_per_person?: number;
  readonly ticket_price_per_person?: number;
  readonly opening_hours?: ItineraryOpeningHours;
  readonly closed_on?: readonly string[];
  readonly reservation_required?: boolean;
  readonly cuisine?: string;
  readonly source?: string;
  readonly confidence?: ItineraryConfidence;
  readonly note?: string;
}

export interface ItineraryOpeningHours {
  readonly opens: string;
  readonly closes: string;
  readonly source?: string;
}

export interface ItineraryDay {
  readonly date?: string;
  readonly theme?: string;
  readonly items: readonly ItineraryItem[];
}

export interface Itinerary {
  readonly title: string;
  readonly days: readonly ItineraryDay[];
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

  return {
    title,
    days: source.days.map((day, dayIndex) => parseDay(day, dayIndex)),
  };
}

function parseDay(raw: unknown, dayIndex: number): ItineraryDay {
  const source = objectOf(raw);
  if (source === null) throw new Error(`days[${dayIndex}] 必须是对象`);
  if (!Array.isArray(source.items) || source.items.length === 0) {
    throw new Error(`days[${dayIndex}].items 必须是非空数组`);
  }

  const ids = new Set<string>();
  const date = optionalString(source.date);
  const theme = optionalString(source.theme);
  return {
    ...(date !== undefined ? { date } : {}),
    ...(theme !== undefined ? { theme } : {}),
    items: source.items.map((item, itemIndex) =>
      parseItem(item, `day-${dayIndex + 1}-item-${itemIndex + 1}`, ids),
    ),
  };
}

function parseItem(raw: unknown, defaultId: string, ids: Set<string>): ItineraryItem {
  const source = objectOf(raw);
  if (source === null) throw new Error("行程条目必须是对象");

  const name = optionalString(source.name);
  if (name === undefined || name === "") throw new Error("每个行程条目必须有非空 name");

  const originalType = optionalString(source.type) ?? "";
  const type = parseItemType(originalType);
  const id = optionalString(source.id) ?? defaultId;
  if (ids.has(id)) throw new Error(`行程条目 id 重复: ${id}`);
  ids.add(id);

  const time = optionalTime(source.time, "time");
  const endTime = optionalTime(source.end_time, "end_time");
  if (time !== undefined && endTime !== undefined && timeToMinutes(endTime) <= timeToMinutes(time)) {
    throw new Error(`end_time 必须晚于 time（条目: ${name}）`);
  }

  const subtype = parseMealSubtype(source.subtype, originalType, type);
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
    ...(time !== undefined ? { time } : {}),
    ...(endTime !== undefined ? { end_time: endTime } : {}),
    type,
    ...(subtype !== undefined ? { subtype } : {}),
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
    ...(sourceName !== undefined ? { source: sourceName } : {}),
  };
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
  return {
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
  if (value !== undefined) {
    const subtype = MEAL_SUBTYPE_ALIASES[value];
    if (subtype === undefined) throw new Error(`不支持的 meal subtype: ${value}`);
    if (type !== "meal") throw new Error("subtype 只能用于 meal 条目");
    return subtype;
  }
  if (type !== "meal") return undefined;
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
