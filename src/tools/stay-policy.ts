import type { Itinerary, ItineraryItem } from "./itinerary-schema.ts";
import { haversineKm } from "./geo.ts";
import { convertPoint } from "./coordinates.ts";

function stayLabel(name: string): { name: string; activity?: string } {
  const match = /^(返回|回到|回|抵达|到达|入住|办理入住|离开)(.+?)([（(].*?[）)])?$/.exec(name.trim());
  return match ? { name: match[2]!.trim(), activity: `${match[1]}酒店${match[3] ?? ""}` } : { name: name.trim() };
}
export function isGenericStayName(name: string): boolean { return /^(?:酒店|住处|住宿点|酒店待定|待定酒店|酒店自选|未定)$/.test(name); }
export function isConcreteStayName(name: string): boolean { return !stayLabel(name).activity && !isGenericStayName(name); }
export function compatibleStay(a: ItineraryItem, b: ItineraryItem): boolean {
  const differentIds = a.evidence_id && b.evidence_id && a.evidence_id !== b.evidence_id;
  const x = a.location, y = b.location;
  if (x?.latitude !== undefined && x.longitude !== undefined && y?.latitude !== undefined && y.longitude !== undefined) {
    const p = convertPoint({ latitude: x.latitude, longitude: x.longitude, crs: x.crs ?? (["amap", "amap-resolved"].includes(x.source ?? a.source ?? "") ? "gcj02" : "wgs84") }, "wgs84");
    const q = convertPoint({ latitude: y.latitude, longitude: y.longitude, crs: y.crs ?? (["amap", "amap-resolved"].includes(y.source ?? b.source ?? "") ? "gcj02" : "wgs84") }, "wgs84");
    if (haversineKm(p.latitude, p.longitude, q.latitude, q.longitude) > .25) return false;
  }
  else if (differentIds) return false;
  return a.name === b.name;
}

/** 身份保留真实酒店名，返回/退房放activity；只归并明确同酒店引用，不替用户换酒店。 */
export function normalizeStayReferences(itinerary: Itinerary, knownNames: readonly string[] = []): Itinerary {
  const all = itinerary.days.flatMap((day) => day.items.filter((item) => item.type === "accommodation"));
  const concrete = all.filter((item) => !isGenericStayName(item.name) && (knownNames.includes(item.name) || item.evidence_verified === true || !stayLabel(item.name).activity));
  const names = new Set([...knownNames, ...concrete.map((item) => item.name)]);
  const uniqueNames = [...new Set(concrete.map((item) => item.name))];
  const base = uniqueNames.length === 1 ? uniqueNames[0] : itinerary.constraints?.base_stay_name ?? concrete[0]?.name;
  return { ...itinerary, days: itinerary.days.map((day) => {
    const dayNames = [...new Set(day.items.filter((item) => item.type === "accommodation").map((item) => stayLabel(item.name).name).filter((name) => names.has(name)))];
    const genericBase = itinerary.constraints?.allow_hotel_changes === true ? dayNames.length === 1 ? dayNames[0] : undefined : base ?? (dayNames.length === 1 ? dayNames[0] : undefined);
    const aliases = new Map<string, string>();
    const stays = day.items.map((item) => {
      if (item.type !== "accommodation") return item;
      const label = stayLabel(item.name);
      const name = names.has(label.name) ? label.name : isGenericStayName(label.name) && genericBase ? genericBase : item.name;
      aliases.set(item.name, name);
      let result: ItineraryItem = { ...item, name, ...(label.activity && name !== item.name && item.activity === undefined ? { activity: label.activity } : {}) };
      const peers = concrete.filter((peer) => peer.name === name && compatibleStay({ ...result, name }, peer));
      const verified = peers.filter((peer) => peer.evidence_verified);
      // 同一明确酒店已有证据时复用引用；不同ID或位置冲突不继承。
      const peer = verified[0];
      if (peer && verified.every((other) => compatibleStay(peer, other))) result = { ...result,
        evidence_id: result.evidence_id ?? peer.evidence_id, evidence_verified: true,
        location: result.location ?? peer.location, source: result.source ?? peer.source, confidence: result.confidence ?? peer.confidence,
      };
      return result;
    });
    const endpoint = (name: string | undefined) => name === undefined ? undefined : aliases.get(name) ?? (isGenericStayName(stayLabel(name).name) && genericBase ? genericBase : name);
    return { ...day, items: stays.map((item) => item.type === "transport" ? { ...item, from: endpoint(item.from), to: endpoint(item.to) } : item) };
  }) };
}
