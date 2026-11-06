import { timeToMinutes, type ItineraryDay, type ItineraryItem } from "./itinerary-schema.ts";
import { itemEndMinutes } from "./itinerary-timeline.ts";
import { TravelEvidenceStore, evidenceId } from "./travel-evidence.ts";
import { routeQueryHint } from "./route-request.ts";
import { convertPoint } from "./coordinates.ts";
import { haversineKm } from "./geo.ts";

function clock(minutes: number): string {
  minutes = Math.ceil(minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) throw new Error("路线修复将时间推到次日，未提交修改；请减少该日安排或显式调整日期，不会把跨日时间折回当天");
  return `${Math.floor(minutes / 60).toString().padStart(2, "0")}:${Math.floor(minutes % 60).toString().padStart(2, "0")}`;
}

function colocated(a: ItineraryItem, b: ItineraryItem): boolean {
  if (a.name === b.name) return true;
  if (a.location?.latitude === undefined || a.location.longitude === undefined || b.location?.latitude === undefined || b.location.longitude === undefined) return false;
  const x = convertPoint({ latitude: a.location.latitude, longitude: a.location.longitude, crs: a.location.crs }, "wgs84");
  const y = convertPoint({ latitude: b.location.latitude, longitude: b.location.longitude, crs: b.location.crs }, "wgs84");
  return haversineKm(x.latitude, x.longitude, y.latitude, y.longitude) < .25;
}

/** 复用已查证据补齐单日交通；保留游览/用餐时长和交通方式，只将受影响的后续安排顺延。 */
export function repairDayRoutes(day: ItineraryDay, evidence: TravelEvidenceStore, city: string, plannedItems: readonly ItineraryItem[] = day.items): { day: ItineraryDay; messages: string[] } {
  const ordered = day.items.filter((item) => item.time !== undefined && item.type !== "meal").slice().sort((a, b) => timeToMinutes(a.time!) - timeToMinutes(b.time!));
  const stops = ordered.filter((item) => item.type === "visit" || item.type === "accommodation");
  const replacements = new Map<string, ItineraryItem>(), insertions = new Map<string, ItineraryItem>(), repaired = new Set<string>(), messages: string[] = [];
  const usedIds = new Set(day.items.map((item) => item.id));
  const intentions = new Map(plannedItems.map((item) => [item.id, item]));
  const claimed = new Set<string>();
  const legs: { from: ItineraryItem; to: ItineraryItem; slot?: ItineraryItem; between: ItineraryItem[] }[] = [];
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!, to = stops[i]!, begin = ordered.indexOf(from), end = ordered.indexOf(to);
    if (from.name === to.name) continue;
    const between = ordered.slice(begin + 1, end), slots = between.filter((item) => item.type === "transport");
    if (!slots.length && colocated(from, to)) continue;
    const label = `${from.name} → ${to.name}`;
    for (const slot of slots) claimed.add(slot.id);
    if (slots.length > 1) { messages.push(`${label} 存在多个交通条目，请按ID选择或合并，未猜测删除`); continue; }
    legs.push({ from, to, slot: slots[0], between });
  }
  // 老行程可能只有晚间酒店锚点；首段/末段仍按条目端点复用，不能漏修这些交通。
  for (const slot of ordered.filter((item) => item.type === "transport" && !claimed.has(item.id))) {
    const index = ordered.indexOf(slot);
    const from = ordered.slice(0, index).reverse().find((item) => ["visit", "accommodation"].includes(item.type)) ?? (slot.from ? { id: `${slot.id}-from`, type: "accommodation" as const, name: slot.from } : undefined);
    const to = ordered.slice(index + 1).find((item) => ["visit", "accommodation"].includes(item.type)) ?? (slot.to ? { id: `${slot.id}-to`, type: "accommodation" as const, name: slot.to } : undefined);
    if (!from || !to) { messages.push(`${slot.id}缺少明确起终点，请补齐，无需猜测路线ID`); continue; }
    legs.push({ from, to, slot, between: [] });
  }
  for (const { from, to, slot, between } of legs) {
    const label = `${from.name} → ${to.name}`, intention = slot ? intentions.get(slot.id) ?? slot : undefined;
    const candidates = evidence.routesForItinerary(from.name, to.name, city);
    // 回填结果不能冒充原计划意图；未选方式/ID的占位块不能偷偷采用驾车替代。
    const mode = intention?.transport_mode ?? (intention && /^(步行|徒步)/.test(intention.name) ? "walking" : undefined)
      ?? candidates.find((route) => route.id === intention?.route_evidence_id)?.mode;
    const eligible = candidates.filter((route) => mode ? route.mode === mode : route.request_mode === undefined || route.request_mode === route.mode);
    if (eligible.length !== 1) {
      const message = candidates.length ? `${label} 已有${candidates.map((r) => `${r.mode}(${r.id})`).join("、")}；请明确该交通条目的transport_mode后修复，未自动切换方式，无需重复查相同路线`
        : `${label} 缺少当前端点的真实证据。${routeQueryHint(city, from.name, to.name, mode)}`;
      messages.push(message);
      if (slot) replacements.set(slot.id, { ...slot, transport_mode: mode, route_evidence_id: intention?.route_evidence_id, route_verified: false, route_duration_min: undefined, distance_km: undefined, source: intention?.source, confidence: "low", route_binding_error: message });
      continue;
    }
    const route = eligible[0]!, departAfter = itemEndMinutes(from) ?? (slot?.time ? timeToMinutes(slot.time) : undefined);
    if (departAfter === undefined) { messages.push(`${label} 起点缺结束时间，请先补${from.id}的游览时长，无需重查路线`); continue; }
    const priorEnd = slot ? itemEndMinutes(slot) : undefined;
    const allocated = slot?.time && priorEnd !== undefined ? priorEnd - timeToMinutes(slot.time) : slot?.planned_duration_min ?? 0;
    const duration = Math.max(1, Math.ceil(route.duration_min), Math.ceil(allocated));
    // 新交通放在中间用餐/休整之后；已有交通位置不变，后续统一处理冲突。
    const previousEnd = between.filter((item) => item.type !== "note").reduce((latest, item) => Math.max(latest, itemEndMinutes(item) ?? timeToMinutes(item.time!)), departAfter);
    const start = slot ? timeToMinutes(slot.time!) : Math.ceil(Math.max(previousEnd, timeToMinutes(to.time!) - duration));
    let id = slot?.id ?? `route-${evidenceId([day.date, from.id, to.id])}`;
    if (!slot) { while (usedIds.has(id)) id += "-2"; usedIds.add(id); }
    const item = evidence.bind({ ...slot, id, type: "transport", evidence_verified: false, name: label, from: from.name, to: to.name, transport_mode: route.mode, route_evidence_id: route.id,
      time: clock(start), end_time: clock(start + duration), planned_duration_min: duration }, city);
    if (slot) replacements.set(slot.id, item); else insertions.set(to.id, item);
    repaired.add(id);
    if (!slot || slot.route_evidence_id !== route.id || slot.route_verified !== true || start + duration !== priorEnd || slot.from !== from.name || slot.to !== to.name) messages.push(`${label} ${slot ? "更新" : "补齐"}交通，${duration}分钟，复用证据${route.id}`);
  }

  const timeline = ordered.flatMap((item) => [...(insertions.has(item.id) ? [insertions.get(item.id)!] : []), replacements.get(item.id) ?? item]);
  const result = new Map<string, ItineraryItem>();
  let occupiedUntil = 0, repairUntil = 0;
  for (let item of timeline) {
    const oldStart = timeToMinutes(item.time!), oldEnd = itemEndMinutes(item);
    const start = Math.ceil(Math.max(oldStart, repaired.has(item.id) ? occupiedUntil : repairUntil));
    if (start > oldStart) {
      if (item.time_locked) throw new Error(`路线修复无法满足固定时刻：${day.date ?? "当天"}/${item.id}「${item.name}」固定${item.time}，最早${clock(start)}；未提交任何修改。请局部调整前序安排，不要重复查询已有路线`);
      const delta = start - oldStart;
      item = { ...item, time: clock(start), ...(item.end_time === undefined ? {} : { end_time: clock(timeToMinutes(item.end_time) + delta) }) };
      messages.push(`${item.id}「${item.name}」顺延${delta}分钟至${item.time}，原停留时长保留`);
    }
    const actualEnd = itemEndMinutes(item) ?? start;
    if (actualEnd >= 1440) clock(actualEnd);
    // 只传播修复引起的占用，遇到原有空闲即吸收；不悄悄修掉无关的原始重叠。
    repairUntil = repaired.has(item.id) || start > oldStart ? actualEnd : 0;
    occupiedUntil = Math.max(occupiedUntil, actualEnd);
    if (oldEnd === undefined && item.type === "visit") repairUntil = 0;
    result.set(item.id, item);
  }
  return { day: { ...day, items: [...day.items.filter((item) => !result.has(item.id)), ...result.values()].sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99")) }, messages };
}
