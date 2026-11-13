import type { ItinerarySnapshot } from "../tools/tool.ts";
import type { Itinerary, ItineraryDay } from "../tools/itinerary-schema.ts";
import { inheritedScheduleStay } from "../tools/day-schedule.ts";
import { dayRouteLegs, repairDayRoutes } from "../tools/itinerary-route-repair.ts";
import { evidenceId, type TravelEvidenceStore } from "../tools/travel-evidence.ts";

interface RouteRequest {
  args: { city: string; stops: string[]; mode: string; leg_modes: string[] };
  key: string;
  legKeys: string[];
}
interface RouteRepair { date: string; key: string; stay?: true }

/** 连续缺段可以合成一条查询。已查段、未定方式和无坐标的端点各自跳过。 */
export function pendingDayRouteRequests(day: ItineraryDay, city: string, evidence: TravelEvidenceStore, attempted: ReadonlySet<string> = new Set()): RouteRequest[] {
  const legs = day.schedule_input
    ? day.items.filter((item) => item.type === "transport").map((item) => ({ from: item.from, to: item.to, mode: item.transport_mode }))
    : dayRouteLegs(day).legs.map(({ from, to, slot }) => ({
      from: from.name, to: to.name, mode: slot?.transport_mode ?? (slot && /^(步行|徒步)/.test(slot.name) ? "walking" : undefined),
    }));
  const groups: { stops: string[]; modes: string[]; legKeys: string[] }[] = [];
  const seen = new Set(attempted);
  let group: typeof groups[number] | undefined;
  for (const { from, to, mode } of legs) {
    if (!from || !to || from === to || !mode || !["transit", "walking", "driving"].includes(mode)
      || evidence.routesForItinerary(from, to, city).some((route) => route.mode === mode)) {
      group = undefined;
      continue;
    }
    const start = evidence.point(from, city), end = evidence.point(to, city);
    const key = evidenceId([city, from, to, mode, start, end]);
    const returnStationLeg = day.day_type === "departure" && to === day.schedule_input?.return_station;
    if ((!start || !end) && !returnStationLeg || seen.has(key)) { group = undefined; continue; }
    seen.add(key);
    if (group?.stops.at(-1) !== from) {
      group = { stops: [from], modes: [], legKeys: [] };
      groups.push(group);
    }
    group.stops.push(to);
    group.modes.push(mode);
    group.legKeys.push(key);
  }
  return groups.map(({ stops, modes, legKeys }) => ({ args: { city, stops, mode: modes[0]!, leg_modes: modes }, key: evidenceId(legKeys), legKeys }));
}

function pendingDayRouteRepair(itinerary: Itinerary, day: ItineraryDay, city: string, evidence: TravelEvidenceStore): RouteRepair | undefined {
  if (!day.date) return undefined;
  const names = day.items.flatMap((item) => {
    if (item.type === "visit" || item.type === "accommodation") return [item.name];
    return item.type === "transport" ? [item.from, item.to].filter((name): name is string => !!name) : [];
  });
  const key = evidenceId([day, evidence.usableEvidenceKeys(names, city).sort()]);
  if (day.schedule_input) {
    const stay = inheritedScheduleStay(itinerary, day.schedule_input, day.day_type);
    if (stay && !day.items.some((item) => item.type === "accommodation")) {
      return { date: day.date, stay: true, key: evidenceId([day, stay, evidence.usableEvidenceKeys([...names, stay], city).sort()]) };
    }
    const pending = day.items.some((item) => {
      if (item.type !== "transport" || !item.from || !item.to) return false;
      const route = evidence.routesForItinerary(item.from, item.to, city).find((route) => route.mode === item.transport_mode);
      return route && (item.route_evidence_id !== route.id || item.route_verified !== true || item.planned_duration_min !== Math.max(1, Math.ceil(route.duration_min)));
    });
    return pending ? { date: day.date, key } : undefined;
  }
  try {
    const repaired = repairDayRoutes(day, evidence, city);
    return repaired.messages.some((message) => /(?:更新|补齐)交通/.test(message)) ? { date: day.date, key } : undefined;
  } catch {
    // 固定时刻等冲突由真实保存返回，确保用户能看到无法重算的原因。
    return { date: day.date, key };
  }
}

/** 查询只写证据；提交修订仍走单日保存。 */
export function pendingRouteRepairs(snapshot: ItinerarySnapshot, evidence: TravelEvidenceStore): RouteRepair[] {
  const city = snapshot.itinerary.constraints?.destination;
  if (!city) return [];
  return snapshot.itinerary.days.flatMap((day) => pendingDayRouteRepair(snapshot.itinerary, day, city, evidence) ?? []);
}

export function nextRouteFollowUp(snapshot: ItinerarySnapshot, evidence: TravelEvidenceStore, options: {
  dates?: ReadonlySet<string>; maxQueries: number; queriedLegs: ReadonlySet<string>; attemptedRepairs: ReadonlySet<string>;
}): { requests: RouteRequest[] } | { repair: RouteRepair } | undefined {
  const city = snapshot.itinerary.constraints?.destination;
  if (!city) return undefined;
  for (const day of snapshot.itinerary.days) {
    if (!day.date || options.dates && !options.dates.has(day.date)) continue;
    const repair = pendingDayRouteRepair(snapshot.itinerary, day, city, evidence);
    const canRepair = repair && !options.attemptedRepairs.has(repair.key);
    if (canRepair && repair.stay) return { repair };
    if (snapshot.itinerary.constraints?.require_routes && options.maxQueries > 0) {
      const requests = pendingDayRouteRequests(day, city, evidence, options.queriedLegs).slice(0, options.maxQueries);
      if (requests.length) return { requests };
    }
    if (canRepair) return { repair };
  }
  return undefined;
}
