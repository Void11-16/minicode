import { calendarDate } from "./opening-schedule.ts";
export const TRAVEL_QUERY_TOOLS: readonly string[] = ["search_attractions", "search_stays", "search_restaurants", "get_place_reviews", "get_weather", "plan_day_routes"];
export const TRAVEL_ATTRACTION_MIN_RATING = 4.3;
export function attractionMinRating(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5 ? value : undefined;
}
export const QUERY_TTL_MS = 30 * 60_000;
export type QueryStatus = "verified" | "returned" | "unavailable" | "failed";
export interface QueryObservation {
  readonly opening_policy_version?: number;
  readonly closure_policy_version?: number;
  readonly key: string;
  readonly tool: string;
  readonly city: string;
  readonly entity: string;
  readonly topic: string;
  readonly status: QueryStatus;
  readonly at: number;
}

/** 将检索限定词与实体分离；闭馆/开放原本就执行相同检索，统一缓存键。 */
export function normalizeReviewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const place = typeof args.place === "string" ? args.place.trim().replace(/\s+(?:开放时间|闭馆时间|(?:每?周|星期)[一二三四五六日天]|官网|预约|门票).*$/, "").trim().replace(/(?:开放时间|闭馆时间|闭馆日|预约要求|门票价格)[？?。!！]*$/, "").trim() : args.place;
  const aspect = typeof args.aspect === "string" ? args.aspect.trim() : "口碑";
  const topic = ["闭馆时间", "闭馆日"].includes(aspect) ? "开放时间" : ["口碑", "人均价格", "招牌菜", "排队", "游玩时长", "开放时间"].includes(aspect) ? aspect : "口碑";
  const fields = topic === "开放时间" ? requestedOpeningFields({ ...args, place }) : undefined;
  const visitDate = fields?.includes("notices") && typeof args.visit_date === "string" ? calendarDate(args.visit_date.trim()) : undefined;
  return { ...args, place, aspect: topic, fields, visit_date: visitDate };
}

export function queryFields(tool: string, args: Record<string, unknown>) {
  return { tool, city: String(args.region ?? args.city ?? ""), entity: String(args.place ?? args.location ?? args.city ?? ""),
    topic: tool === "get_place_reviews" ? String(args.aspect) : tool };
}

/** 只比较工具实际使用的参数；省略默认值与显式默认值表示同一事项。 */
export function queryKeyArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : value;
  const bounded = (value: unknown, fallback: number, max: number, integer = false) => {
    const result = typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, value)) : fallback;
    return integer ? Math.floor(result) : result;
  };
  let values: Record<string, unknown>;
  if (tool === "get_place_reviews") values = normalizeReviewArgs(args);
  else if (tool === "search_attractions") values = { city: text(args.city), location: text(args.location), radius_km: bounded(args.radius_km, 10, 50), limit: bounded(args.limit, 10, 30, true), min_rating: attractionMinRating(args.min_rating) };
  else if (tool === "search_stays") values = { region: text(args.region), city: text(args.city), radius_km: bounded(args.radius_km, 10, 30), limit: bounded(args.limit, 10, 30, true) };
  else if (tool === "search_restaurants") values = { region: text(args.region), city: text(args.city), cuisine: text(args.cuisine) ?? "", max_cost: args.max_cost, min_rating: args.min_rating,
    avoid_cuisines: typeof args.avoid_cuisines === "string" ? [...new Set(args.avoid_cuisines.split(/[,，、;；]+/).map((v) => v.trim()).filter(Boolean))].sort() : [],
    radius_km: bounded(args.radius_km, 3, 30), limit: bounded(args.limit, 8, 20, true) };
  else if (tool === "plan_day_routes") {
    const stops = Array.isArray(args.stops) ? args.stops.filter((v) => typeof v === "string" && v.trim() !== "").map(text) : args.stops;
    values = { city: text(args.city), stops, modes: routeModes(args, Array.isArray(stops) ? Math.max(0, stops.length - 1) : 0).map((mode) => mode === "auto" ? "transit" : mode) };
  }
  else if (tool === "get_weather") values = { city: text(args.city), location: text(args.location), ...(args.start_date === undefined ? { days: bounded(args.days, 3, 16, true) } : { start_date: args.start_date, end_date: args.end_date ?? args.start_date }) };
  else values = args;
  const allowed = tool === "get_place_reviews" ? ["place", "city", "aspect", "fields", "visit_date"] : undefined;
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && key !== "refresh" && (allowed === undefined || allowed.includes(key))).sort(([a], [b]) => a.localeCompare(b)));
}

export function querySummary(record: QueryObservation): string {
  const status = { verified: "已有核验规则，保存时自动回填", returned: "已返回数据，请复用已有证据", unavailable: "已查询但未找到该项可核验事实，保持待确认，先补齐其他日期", failed: "服务未返回有效数据，恢复后可显式刷新一次" }[record.status];
  return `${record.tool} · ${record.city} · ${record.entity} · ${record.topic}：${status}`;
}
import { routeModes } from "./route-request.ts";
import { requestedOpeningFields } from "./opening-facts.ts";
