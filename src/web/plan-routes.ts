import { createHash } from "node:crypto";
import { AmapServiceError, type AmapClient, type RouteGeometry } from "../tools/amap.ts";
import { convertPoint, type GeoPoint, type CoordinateSystem } from "../tools/coordinates.ts";
import { haversineKm } from "../tools/geo.ts";
import { TravelEvidenceStore } from "../tools/travel-evidence.ts";
import { RouteCache, validGeometry } from "./route-cache.ts";

interface MapItem {
  id?: string; name?: string; type?: string;
  transport_mode?: string; from?: string; to?: string; route_evidence_id?: string;
  location?: { name?: string; latitude?: number; longitude?: number; crs?: CoordinateSystem; source?: string };
}
export interface MapPlan {
  constraints?: { destination?: string };
  days?: Array<{ items?: MapItem[] }>;
}
function locatedStops(items: readonly MapItem[]) {
  return items.map((item, index) => ({ item, index })).filter(({ item }) =>
    ["visit", "accommodation", "rest"].includes(item.type ?? "") && Number.isFinite(item.location?.latitude) && Number.isFinite(item.location?.longitude));
}
export function mapLegCount(plan: MapPlan, dayNo: number): number {
  return Math.max(0, locatedStops(plan.days?.[dayNo - 1]?.items ?? []).length - 1);
}

interface Endpoint { id: string; latitude: number; longitude: number }
export type MapLegStatus = "ready" | "same_point" | "estimated" | "needs_confirmation" | "unsupported" | "no_city" | "no_key" | "no_route" | "no_geometry" | "quota" | "key" | "service_error" | "network" | "unchanged";
export interface MapLeg {
  mode: string; status: MapLegStatus; from: Endpoint; to: Endpoint;
  inferredMode?: boolean;
  straight?: boolean; points?: RouteGeometry["points"]; parts?: RouteGeometry["parts"];
  distanceM?: number; durationSec?: number; plannedDurationSec?: number;
  observedAt?: number; metricsFresh?: boolean; source?: string;
}
export function planRouteVersion(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function point(item: MapItem): GeoPoint {
  const loc = item.location!;
  return convertPoint({ latitude: loc.latitude!, longitude: loc.longitude!, crs: loc.crs ?? (loc.source === "osm" ? "wgs84" : "gcj02") }, "gcj02");
}
function endpoint(item: MapItem): Endpoint {
  const p = point(item);
  return { id: item.id ?? item.name ?? "", latitude: p.latitude, longitude: p.longitude };
}
class MissingGeometryError extends Error {}

export function routeErrorStatus(error: unknown): MapLegStatus {
  if (error instanceof MissingGeometryError) return "no_geometry";
  if (error instanceof AmapServiceError) {
    if (["10003", "10044", "10021"].includes(error.code)) return "quota";
    if (["10001", "10019"].includes(error.code)) return "key";
    return "service_error";
  }
  return "network";
}
interface Flight { controller: AbortController; promise: Promise<RouteGeometry | null>; consumers: number }

/** 一个服务实例对应一个工作区；合并相同路段，但每个 HTTP 消费者独立取消。 */
export class PlanRouteService {
  private readonly cache: RouteCache;
  private readonly flights = new WeakMap<AmapClient, Map<string, Flight>>();
  constructor(cache: RouteCache) { this.cache = cache; }

  private async geometry(key: string, amap: AmapClient, mode: string, city: string, from: GeoPoint, to: GeoPoint, signal: AbortSignal) {
    signal.throwIfAborted();
    const hit = this.cache.read(key);
    if (hit !== undefined) return { ...hit, source: "cache" };
    let flights = this.flights.get(amap);
    if (flights === undefined) { flights = new Map(); this.flights.set(amap, flights); }
    const active = flights;
    let flight = active.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const scoped = amap.withSignal(controller.signal);
      const promise = (async () => {
        let geometry: RouteGeometry | null;
        if (mode === "transit") {
          const transit = await scoped.transitRoute(from, to, city);
          if (transit !== null && transit.geometry === undefined) throw new MissingGeometryError();
          geometry = transit?.geometry ?? null;
        } else {
          geometry = await scoped.directionRoute(mode === "taxi" ? "driving" : mode as "walking" | "driving" | "cycling", from, to);
        }
        controller.signal.throwIfAborted();
        if (geometry !== null && validGeometry(geometry)) { this.cache.set(key, geometry); return geometry; }
        return null;
      })();
      flight = { controller, promise, consumers: 0 };
      active.set(key, flight);
      const current = flight;
      void promise.finally(() => { if (active.get(key) === current) active.delete(key); }).catch(() => {});
    }
    flight.consumers++;
    const current = flight;
    let abort: () => void = () => {};
    try {
      const geometry = await Promise.race([
        current.promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      return geometry === null ? null : { geometry, observedAt: this.cache.read(key)?.observedAt ?? Date.now(), metricsFresh: true, source: "amap" };
    } finally {
      signal.removeEventListener("abort", abort);
      if (--current.consumers === 0) {
        if (active.get(key) === current) active.delete(key);
        current.controller.abort();
      }
    }
  }

  async day(plan: MapPlan, dayNo: number, amap: AmapClient | undefined, evidence: TravelEvidenceStore, signal: AbortSignal, onlyLegs?: ReadonlySet<number>): Promise<{ day: number; legs: MapLeg[] }> {
    const items = plan.days?.[dayNo - 1]?.items ?? [];
    const stops = locatedStops(items);
    const city = plan.constraints?.destination ?? "";
    const legs: MapLeg[] = [];
    for (let i = 1; i < stops.length; i++) {
      signal.throwIfAborted();
      const a = stops[i - 1]!, b = stops[i]!;
      const from = point(a.item), to = point(b.item);
      const distanceM = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude) * 1000;
      const transports = items.slice(a.index + 1, b.index).filter((item) => item.type === "transport");
      // 不猜测多个交通条目的合并方式；存在明确冲突时交给用户确认。
      const transport = transports.length === 1 ? transports[0] : undefined;
      const mode = transport?.transport_mode ?? (distanceM <= 1500 ? "walking" : "driving");
      const base = { mode, inferredMode: transport === undefined, from: endpoint(a.item), to: endpoint(b.item) };
      if (onlyLegs !== undefined && !onlyLegs.has(i - 1)) { legs.push({ ...base, status: "unchanged" }); continue; }
      if (distanceM < 25) { legs.push({ ...base, status: "same_point", straight: true }); continue; }
      const matchesStop = (name: string | undefined, stop: MapItem) => name === undefined || name === stop.name || name === stop.location?.name;
      if (transports.length > 1 || (transport !== undefined && (!transport.transport_mode || !matchesStop(transport.from, a.item) || !matchesStop(transport.to, b.item)))) {
        legs.push({ ...base, status: "needs_confirmation", straight: true }); continue;
      }
      const record = transport?.route_evidence_id === undefined ? undefined : evidence.routeForMap(transport.route_evidence_id, mode, from, to, city || undefined);
      if (record?.estimated) { legs.push({ ...base, status: "estimated", straight: true, plannedDurationSec: record.duration_min * 60, source: "evidence", observedAt: record.observed_at }); continue; }
      if (record?.geometry !== undefined && validGeometry(record.geometry)) {
        legs.push({ ...base, status: "ready", ...record.geometry, durationSec: undefined, plannedDurationSec: record.duration_min * 60, observedAt: record.observed_at, source: "evidence", metricsFresh: false }); continue;
      }
      if (!["walking", "driving", "transit", "taxi", "cycling"].includes(mode)) { legs.push({ ...base, status: "unsupported", straight: true }); continue; }
      if (mode === "transit" && !city) { legs.push({ ...base, status: "no_city", straight: true }); continue; }
      const key = JSON.stringify([mode, mode === "transit" ? city : "", from.latitude, from.longitude, to.latitude, to.longitude]);
      try {
        const cached = this.cache.read(key);
        if (cached === undefined && amap === undefined) { legs.push({ ...base, status: "no_key", straight: true }); continue; }
        const result = cached === undefined ? await this.geometry(key, amap!, mode, city, from, to, signal) : { ...cached, source: "cache" };
        legs.push(result === null ? { ...base, status: "no_route", straight: true } : {
          ...base, status: "ready", points: result.geometry.points, parts: result.geometry.parts,
          distanceM: result.geometry.distanceM, ...(result.metricsFresh ? { durationSec: result.geometry.durationSec } : {}),
          ...(record === undefined ? {} : { plannedDurationSec: record.duration_min * 60 }),
          source: result.source, observedAt: result.observedAt, metricsFresh: result.metricsFresh,
        });
      } catch (error) {
        signal.throwIfAborted();
        legs.push({ ...base, status: routeErrorStatus(error), straight: true });
      }
    }
    return { day: dayNo, legs };
  }
}
