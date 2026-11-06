import type { AmapPoi } from "./amap.ts";
import type { GeoResult } from "./geocoding.ts";
import { convertPoint } from "./coordinates.ts";
import { haversineKm } from "./geo.ts";
import { QUERY_TTL_MS } from "./travel-query.ts";

export type DiscoveryTool = "search_attractions" | "search_restaurants";
export interface DiscoveryPool {
  readonly tool: DiscoveryTool;
  readonly city: string;
  readonly center: string;
  readonly geo: GeoResult;
  /** 上游关键词不同不能互相冒充，例如“美食”样本不等于“火锅”搜索。 */
  readonly keyword: string;
  readonly radius_km: number;
  readonly pois: readonly AmapPoi[];
  readonly warning?: string;
  readonly observed_at: number;
}

const cityKey = (city: string) => city.trim().replace(/市$/, "");

/** 只移除有分隔的城市前缀，不把“西安城墙”随意改成“城墙”。 */
export function discoveryCenterName(name: string, city: string): string {
  const text = name.trim().replace(/\s+/g, " ");
  const base = cityKey(city);
  if (text === city.trim() || text === base || text === `${base}市`) return base;
  for (const prefix of [city.trim(), base, `${base}市`]) {
    if (prefix && text.startsWith(`${prefix} `)) return text.slice(prefix.length).trim();
  }
  return text;
}

export function discoveryPoolKey(pool: DiscoveryPool): string {
  return JSON.stringify([pool.tool, cityKey(pool.city), pool.center, pool.keyword, pool.radius_km]);
}

function fresh(pool: DiscoveryPool, now = Date.now()): boolean {
  return pool.observed_at <= now && now - pool.observed_at < QUERY_TTL_MS;
}

/** 持久化只保留本工具支持的结构，旧格式或不合法快照不参与复用。 */
export function validDiscoveryPool(value: unknown): value is DiscoveryPool {
  if (!value || typeof value !== "object") return false;
  const p = value as DiscoveryPool;
  return ["search_attractions", "search_restaurants"].includes(p.tool)
    && [p.city, p.center, p.keyword, p.geo?.name].every((v) => typeof v === "string" && v.length <= 500)
    && Number.isFinite(p.geo?.latitude) && Math.abs(p.geo.latitude) <= 90
    && Number.isFinite(p.geo?.longitude) && Math.abs(p.geo.longitude) <= 180
    && [undefined, "wgs84", "gcj02"].includes(p.geo.crs)
    && [p.geo.country, p.geo.admin1, p.geo.admin2, p.geo.admin3, p.warning].every((v) => v === undefined || typeof v === "string")
    && Number.isFinite(p.radius_km) && p.radius_km >= 1 && p.radius_km <= 50
    && Number.isFinite(p.observed_at) && Array.isArray(p.pois) && p.pois.length <= 100
    && p.pois.every((poi) => poi && typeof poi.id === "string" && typeof poi.name === "string" && typeof poi.location === "string"
      && [poi.type, poi.typecode, poi.parent, poi.address, poi.cityname, poi.pname, poi.adname, poi.biz_ext?.rating, poi.biz_ext?.cost, poi.biz_ext?.open_time].every((v) => v === undefined || typeof v === "string"));
}

/** 候选池保存原始采集样本，筛选/排序留在各自工具中，避免两套算法。 */
export class DiscoveryPoolStore {
  private pools: DiscoveryPool[] = [];

  merge(values: readonly unknown[]): void {
    const merged = new Map<string, DiscoveryPool>();
    for (const pool of [...this.pools, ...values.filter(validDiscoveryPool)]) {
      if (!fresh(pool)) continue;
      const key = discoveryPoolKey(pool);
      if ((merged.get(key)?.observed_at ?? -1) <= pool.observed_at) merged.set(key, {
        ...pool,
        // 保留重筛所需的原始字段，不持久化无关照片/供应商附加数据，也不持有可变响应对象。
        geo: { ...pool.geo },
        pois: pool.pois.map(({ id, parent, name, type, typecode, address, location, cityname, pname, adname, biz_ext }) => ({
          id, parent, name, type, typecode, address, location, cityname, pname, adname,
          ...(biz_ext ? { biz_ext: { rating: biz_ext.rating, cost: biz_ext.cost, open_time: biz_ext.open_time } } : {}),
        })),
      });
    }
    this.pools = [...merged.values()].sort((a, b) => a.observed_at - b.observed_at).slice(-60);
  }

  snapshot(): readonly DiscoveryPool[] {
    this.merge([]);
    return this.pools;
  }

  find(tool: DiscoveryTool, city: string, center: string, keyword: string, radiusKm: number, geo?: GeoResult): DiscoveryPool | undefined {
    const name = discoveryCenterName(center, city);
    return [...this.snapshot()].reverse().find((p) => {
      if (p.tool !== tool || cityKey(p.city) !== cityKey(city) || p.keyword !== keyword || radiusKm > p.radius_km) return false;
      // 已解析坐标时只认真实覆盖范围；半径有交集但未包含请求圆，仍须补查。
      if (geo) {
        const a = convertPoint(geo, "gcj02"), b = convertPoint(p.geo, "gcj02");
        return haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) + radiusKm <= p.radius_km + 1e-6;
      }
      return [p.center, p.geo.name].some((n) => discoveryCenterName(n, city) === name);
    });
  }

  context(names: readonly string[]): string[] {
    const recent = new Map<string, DiscoveryPool>();
    for (const p of this.snapshot()) {
      const key = JSON.stringify([p.tool, cityKey(p.city), p.center, p.keyword]);
      // 一次较小的新查询不能让更大的已查范围从提示中消失。
      if ((recent.get(key)?.radius_km ?? -1) <= p.radius_km) recent.set(key, p);
    }
    const relevant = (p: DiscoveryPool) => names.some((n) => [p.center, p.geo.name].some((v) => discoveryCenterName(v, p.city) === discoveryCenterName(n, p.city)));
    return [...recent.values()].sort((a, b) => Number(relevant(b)) - Number(relevant(a)) || b.observed_at - a.observed_at).slice(0, 5).map((p) =>
      `${p.tool} · ${p.city}/${p.center} · 已采集${p.radius_km}km/${p.pois.length}个原始候选${p.keyword ? ` · 关键词=${p.keyword}` : ""}；同中心缩圈、改limit/评分/预算/排除菜系本地重筛；样本非全量，确缺区域/实体才补查。${p.warning ? "部分来源缺失，沿用原警告。" : ""}`);
  }
}

export class DiscoveryBudgetError extends Error {}
