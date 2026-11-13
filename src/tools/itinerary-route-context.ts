import { timeToMinutes, type ItineraryDay } from "./itinerary-schema.ts";
import { routeQueryHint } from "./route-request.ts";

/** 只比较影响交通衔接的时间线；补价格、备注或证据不会触发整日顺延。 */
export function routeTimelineSignature(day: ItineraryDay): string {
  return JSON.stringify(day.items.filter((item) => item.time !== undefined && item.type !== "meal" && item.type !== "note")
    .map(({ id, type, name, time, end_time, planned_duration_min, transport_mode, location }) => ({ id, type, name, time, end_time, planned_duration_min, transport_mode,
      location: location && { latitude: location.latitude, longitude: location.longitude, crs: location.crs } }))
    .sort((a, b) => a.time!.localeCompare(b.time!) || a.id.localeCompare(b.id)));
}

/** 地点新增、改名、删除或重排后，只失效与实际相邻主停留点不符的交通引用。 */
export function alignRouteContext(day: ItineraryDay, city?: string): ItineraryDay {
  const timeline = day.items.filter((item) => item.time !== undefined && ["visit", "accommodation", "transport"].includes(item.type))
    .slice().sort((a, b) => timeToMinutes(a.time!) - timeToMinutes(b.time!));
  return { ...day, items: day.items.map((item) => {
    if (item.type !== "transport" || item.time === undefined) return item;
    const index = timeline.indexOf(item);
    const from = timeline.slice(0, index).reverse().find((entry) => entry.type !== "transport");
    const to = timeline.slice(index + 1).find((entry) => entry.type !== "transport");
    if (!from || !to || (item.from === from.name && item.to === to.name)) return item;
    if (item.route_verified === false && item.route_binding_error) return item;
    return { ...item, route_verified: false, route_duration_min: undefined,
      route_binding_error: `相邻地点已变化：交通块仍为「${item.from ?? "未填"} → ${item.to ?? "未填"}」，当前应为「${from.name} → ${to.name}」。${routeQueryHint(city, from.name, to.name, item.transport_mode)}` };
  }) };
}
