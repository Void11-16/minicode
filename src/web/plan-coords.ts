import { setTimeout as delay } from "node:timers/promises";
import { bestPoiByName, type AmapPoi } from "../tools/amap.ts";
import { poiCityVerdict } from "../tools/geocoding.ts";
import { convertPoint, type CoordinateSystem } from "../tools/coordinates.ts";
import { haversineKm } from "../tools/geo.ts";

/**
 * 行程坐标校准：模型写入 save_itinerary 的经纬度常是"编"的近似值
 * （实测偏差 700–2200 米且方向随机），直接画在地图上会明显错位。
 * 地图加载时用高德 POI 搜索按地点名重新解析坐标，写回行程文件（一次性修正）。
 */

interface PlanLocation {
  crs?: CoordinateSystem;
  name?: string;
  latitude?: number;
  longitude?: number;
  source?: string;
  [key: string]: unknown;
}

interface PlanItem {
  name?: string;
  location?: PlanLocation;
  [key: string]: unknown;
}

export interface PlanJson {
  days?: Array<{ items?: PlanItem[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
  poiId?: string;
}

/** 单点解析器：按查询名 + 参考中心找权威坐标；失败返回 null */
export interface ResolveContext { city?: string; poiId?: string }
export type CoordinateResolver = (query: string, near: Coordinate, context: ResolveContext) => Promise<Coordinate | null>;

/** 已校准标记：带此 source 的条目跳过重复解析（避免反复消耗高德配额） */
const RESOLVED_SOURCE = "amap-resolved";
const MAX_ITEMS_PER_PLAN = 60;

/** 结果缓存：同一查询 + 邻域在 TTL 内不重复请求 */
const caches = new WeakMap<CoordinateResolver, Map<string, { value: Coordinate | null; expiresAt: number }>>();
const CACHE_TTL_MS = 24 * 60 * 60_000;
/** 失败结果只短缓存：高德限流(QPS)是瞬时故障，不能毒化 24 小时 */
const NULL_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

/** 请求间隔：实测连发 20 个 POI 搜索会触发高德 QPS 限流，前 9 个成功后其余全部失败 */
const DEFAULT_INTERVAL_MS = 150;
/** 解析结果与条目原坐标的最大允许偏差（公里）：超过视为匹配到同名异地，拒绝写入 */
const MAX_RESOLVE_DRIFT_KM = 8;

export async function resolvePlanCoordinates(
  plan: PlanJson,
  resolve: CoordinateResolver,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ plan: PlanJson; resolved: number; attempted: number }> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const items = collectItems(plan);
  const near = planCentroid(items);
  if (near === null) return { plan, resolved: 0, attempted: 0 };

  // 深拷贝后再改，失败时可安全丢弃
  const next = JSON.parse(JSON.stringify(plan)) as PlanJson;
  let resolved = 0;
  let attempted = 0;

  for (const item of collectItems(next)) {
    options.signal?.throwIfAborted();
    if (attempted >= MAX_ITEMS_PER_PLAN) break;
    const location = item.location;
    if (location === undefined || item.evidence_verified === true || location.source === RESOLVED_SOURCE) continue;
    if (location.latitude === undefined || location.longitude === undefined) continue;
    const query = resolutionQuery(item);
    if (query === null) continue;

    attempted += 1;
    // 以条目自身坐标作为搜索中心（而非全行程质心），否则"龙游包子店"这类同名异地分店
    // 会因离质心更近而被错认；解析结果与原坐标偏差过大也直接拒绝（匹配错误的保护）
    const originLatitude = location.latitude;
    const originLongitude = location.longitude;
    const itemNear = convertPoint({ latitude: originLatitude, longitude: originLongitude, crs: location.crs ?? (location.source === "osm" ? "wgs84" : "gcj02") }, "gcj02");
    const constraints = plan.constraints as { destination?: string } | undefined;
    const context = { city: constraints?.destination, poiId: typeof location.poi_id === "string" ? location.poi_id : undefined };
    let coordinate: Coordinate | null = null;
    for (const variant of queryVariants(query)) {
      if (intervalMs > 0) {
        await delay(intervalMs, undefined, { signal: options.signal });
      }
      coordinate = await cachedResolve(resolve, variant, itemNear, context, options.signal);
      if (
        coordinate !== null &&
        haversineKm(itemNear.latitude, itemNear.longitude, coordinate.latitude, coordinate.longitude) > MAX_RESOLVE_DRIFT_KM
      ) {
        coordinate = null; // 同名异地（分店/同名地点）：拒绝后继续尝试下一个变体
      }
      if (coordinate !== null) break;
    }
    if (coordinate === null) continue;
    location.latitude = coordinate.latitude;
    location.longitude = coordinate.longitude;
    location.source = RESOLVED_SOURCE;
    location.crs = "gcj02";
    if (coordinate.poiId !== undefined) location.poi_id = coordinate.poiId;
    resolved += 1;
  }

  return { plan: next, resolved, attempted };
}

/** 地图首屏无需同步等待校准，但要据此告知前端“后台仍在校准” */
export function unresolvedCoordinateCount(plan: PlanJson): number {
  return collectItems(plan).filter(
    (item) =>
      item.evidence_verified !== true &&
      item.location?.source !== RESOLVED_SOURCE &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined &&
      resolutionQuery(item) !== null,
  ).length;
}

const GENERIC_MEAL_LABELS = new Set(["早餐", "午餐", "晚餐", "夜宵", "宵夜", "加餐", "下午茶", "小吃"]);

/** 校准用的查询名：优先 location.name，去掉展示前缀（"入住 ""早餐："等）；餐饮条目优先用餐厅名 */
export function resolutionQuery(item: PlanItem): string | null {
  // 餐饮条目：location.name 可能是街区/景点等区域名（解析后会偏离餐厅实际位置），
  // 条目 name（餐厅名）更可靠，优先用它；name 是"午餐"/"6个候选"这类泛称时回退 location.name
  const candidates = [item.location?.name ?? "", item.name ?? ""].filter((value) => value.trim() !== "");
  const ordered = item.type === "meal" ? [...candidates].reverse() : candidates;
  for (const raw of ordered) {
    const tail = raw.includes("：") ? raw.slice(raw.indexOf("：") + 1) : raw;
    const cleaned = tail.replace(/^(入住|退房|早餐|午餐|晚餐|夜宵)\s*/, "").trim();
    // 泛称/聚合名（"午餐"、"水亭门午餐 · 6个候选"）没有可定位的实体，换下一个候选名
    if (cleaned === "" || GENERIC_MEAL_LABELS.has(cleaned) || cleaned.includes("候选")) continue;
    return cleaned;
  }
  return null;
}

/**
 * 查询变体（按精确度排序，逐个尝试直到命中）：
 * 高德关键词搜索对长精确短语常无结果，需要逐步放宽——
 * 如「水亭门历史文化街区」搜不到，但「水亭门」可以；
 * 「衢州古城文化旅游区鹿鸣大草坪」要剥掉景区前缀。
 */
export function queryVariants(query: string): string[] {
  const variants: string[] = [query];
  const noParens = query.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (noParens !== "" && noParens !== query) variants.push(noParens);
  // 剥景区前缀：衢州古城文化旅游区鹿鸣大草坪 → 鹿鸣大草坪
  const strippedPrefix = query.replace(/^.*?(?:旅游区|景区)(?=.)/, "").trim();
  if (strippedPrefix.length >= 2 && strippedPrefix !== query) variants.push(strippedPrefix);
  // 剥区域类型后缀：水亭门历史文化街区 → 水亭门
  const strippedSuffix = query
    .replace(/(历史文化街区|文化街区|历史街区|步行街|商业街|街区|夜市|夜游|大草坪|公园|广场|风景区)$/, "")
    .trim();
  if (strippedSuffix.length >= 2 && strippedSuffix !== query && strippedSuffix.length < query.length) {
    variants.push(strippedSuffix);
  }
  return [...new Set(variants)];
}

/** 所有条目坐标的质心——作为 POI 搜索的参考中心，把结果约束在行程所在地附近 */
export function planCentroid(items: readonly PlanItem[]): Coordinate | null {
  const located = items.filter(
    (item): item is PlanItem & { location: PlanLocation & { latitude: number; longitude: number } } =>
      item.location?.latitude !== undefined && item.location?.longitude !== undefined,
  );
  if (located.length === 0) return null;
  return {
    latitude: located.reduce((sum, item) => sum + item.location.latitude, 0) / located.length,
    longitude: located.reduce((sum, item) => sum + item.location.longitude, 0) / located.length,
  };
}

function collectItems(plan: PlanJson): PlanItem[] {
  return (plan.days ?? []).flatMap((day) => day.items ?? []);
}

async function cachedResolve(
  resolve: CoordinateResolver,
  query: string,
  near: Coordinate,
  context: ResolveContext,
  signal?: AbortSignal,
): Promise<Coordinate | null> {
  let cache = caches.get(resolve);
  if (cache === undefined) { cache = new Map(); caches.set(resolve, cache); }
  const key = JSON.stringify([query, near.latitude, near.longitude, context.city, context.poiId]);
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() < hit.expiresAt) return hit.value;

  signal?.throwIfAborted();
  const value = await resolve(query, near, context).catch(() => { signal?.throwIfAborted(); return null; });
  signal?.throwIfAborted();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + (value === null ? NULL_TTL_MS : CACHE_TTL_MS) });
  return value;
}

/** 城市、名称、实体 ID 与距离联合匹配；同名分店接近时保留原坐标，等待确认。 */
export function selectCalibrationPoi(pois: readonly AmapPoi[], query: string, near: Coordinate, context: ResolveContext): Coordinate | null {
  if (!context.city && !context.poiId) return null;
  const candidates = pois.flatMap((poi) => {
    if (context.city && poiCityVerdict(poi, context.city) !== "match") return [];
    if (context.poiId && poi.id !== context.poiId) return [];
    const facility = /(停车|售票|检票|出入口|入口|出口|厕所|卫生间|公交站|地铁站|游客中心)/;
    if (facility.test(poi.name) && !facility.test(query)) return [];
    if (bestPoiByName([poi], query) === null) return [];
    const [longitude, latitude] = poi.location.split(",").map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    const distance = haversineKm(near.latitude, near.longitude, latitude, longitude);
    return distance <= MAX_RESOLVE_DRIFT_KM ? [{ poi, latitude, longitude, distance }] : [];
  });
  const best = bestPoiByName(candidates.map((c) => c.poi), query);
  if (best === null || best === undefined) return null;
  const normalize = (s: string) => s.replace(/[\s（）()·-]/g, "");
  const tier = (name: string) => normalize(name) === normalize(query) ? 3 : (normalize(name).includes(normalize(query)) || normalize(query).includes(normalize(name))) ? 2 : 1;
  const matches = candidates.filter((c) => tier(c.poi.name) === tier(best.name)).sort((a, b) => a.distance - b.distance);
  const first = matches[0];
  if (first === undefined) return null;
  // 没有持久化实体 ID 时，近邻同名点不能仅凭 API 返回顺序决定。
  if (!context.poiId && matches[1] && matches[1].distance - first.distance < 1) return null;
  return { latitude: first.latitude, longitude: first.longitude, poiId: first.poi.id };
}
