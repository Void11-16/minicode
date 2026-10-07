type FetchLike = typeof fetch;

import type { AmapGeocodeResult } from "./amap.ts";
import { getAmapClient } from "./amap-access.ts";

export interface GeoResult {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly country?: string;
  readonly admin1?: string;
}

/** 地理编码结果 TTL 缓存：坐标基本不变，天气/景点/住宿工具会重复查询同一城市 */
const geoCache = new Map<string, { value: GeoResult; expiresAt: number }>();
const GEO_CACHE_TTL_MS = 30 * 60_000;
/** 容量上限：Map 按插入序，超限时删最早条目（近似 LRU），防止长驻进程无限增长 */
const GEO_CACHE_MAX = 500;

function cacheGet(key: string): GeoResult | undefined {
  const entry = geoCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() > entry.expiresAt) {
    geoCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: GeoResult): void {
  if (geoCache.size >= GEO_CACHE_MAX) {
    const oldest = geoCache.keys().next().value;
    if (oldest !== undefined) geoCache.delete(oldest);
  }
  geoCache.set(key, { value, expiresAt: Date.now() + GEO_CACHE_TTL_MS });
}

/**
 * 地名 → 坐标（多后端自动降级）：
 * 1. 高德（配置了 Key 时）：有城市上下文先 POI 搜索（地标名 geocode 经常命中外地同名地点），
 *    无城市上下文用地理编码
 * 2. Photon（OpenStreetMap）：支持地标/车站/POI
 * 3. Open-Meteo（GeoNames）：城市级兜底
 */
export async function geocodeLocation(
  name: string,
  fetchFn: FetchLike = fetch,
  city?: string,
): Promise<GeoResult | null> {
  const cacheKey = `loc:${name}@${city ?? ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const amap = getAmapClient();
  if (amap !== undefined) {
    if (city !== undefined && city !== "") {
      // 有城市上下文：POI 搜索把结果约束在城市内（灵隐寺→杭州灵隐寺，而不是重庆同名寺庙）
      try {
        const poi = await amap.poiSearchByName(name, city);
        if (poi !== null) {
          const geo = { name: poi.name, latitude: poi.latitude, longitude: poi.longitude, country: "中国", admin1: city };
          cacheSet(cacheKey, geo);
          return geo;
        }
      } catch {
        // POI 搜索失败（配额/网络）→ 地理编码
      }
    }
    try {
      const result = await amap.geocode(name, city);
      if (result !== null) {
        const geo = amapToGeoResult(result);
        cacheSet(cacheKey, geo);
        return geo;
      }
    } catch {
      // 高德失败（配额/网络）→ 降级 Photon
    }
  }

  // 2. Photon（OSM）→ 3. Open-Meteo 兜底
  try {
    const candidates = await photonGeocode(name, fetchFn, 1);
    if (candidates.length > 0) {
      cacheSet(cacheKey, candidates[0]);
      return candidates[0];
    }
  } catch {
    // Photon 不可用时降级
  }
  const fallback = await openMeteoGeocode(name, fetchFn);
  if (fallback !== null) {
    cacheSet(cacheKey, fallback);
  }
  return fallback;
}

/** 多候选地理编码（供 geocode 工具展示歧义选项） */
export async function geocodeCandidates(
  name: string,
  fetchFn: FetchLike = fetch,
  limit: number = 3,
): Promise<GeoResult[]> {
  // 高德主源（配置了 Key 时）：国内地名优先，避免 OSM 歧义（如"西湖"命中日本/台湾）
  const amap = getAmapClient();
  if (amap !== undefined) {
    try {
      const result = await amap.geocode(name);
      if (result !== null) {
        return [amapToGeoResult(result)];
      }
    } catch {
      // 降级 Photon 多候选
    }
  }
  try {
    const candidates = await photonGeocode(name, fetchFn, limit);
    if (candidates.length > 0) return candidates;
  } catch {
    // 降级到 Open-Meteo（单结果）
  }
  const fallback = await openMeteoGeocode(name, fetchFn);
  return fallback === null ? [] : [fallback];
}

/** 逆地理编码：坐标 → 地名（Photon） */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  fetchFn: FetchLike = fetch,
): Promise<GeoResult | null> {
  const url = `https://photon.komoot.io/reverse?lat=${latitude}&lon=${longitude}&limit=1`;
  const response = await fetchFn(url, {
    headers: { "User-Agent": "minicode-travel-planner/0.1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`逆地理编码服务返回 ${response.status}`);
  }
  const data = (await response.json()) as PhotonResponse;
  return photonToGeoResult(data.features?.[0]);
}

interface PhotonFeature {
  readonly properties?: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  readonly geometry?: { coordinates?: [number, number] };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

function photonToGeoResult(feature: PhotonFeature | undefined): GeoResult | null {
  if (feature === undefined) return null;
  const coords = feature.geometry?.coordinates;
  if (coords === undefined) return null;
  const props = feature.properties ?? {};
  const name = props.name ?? props.city ?? props.state;
  if (name === undefined) return null;
  return {
    name,
    latitude: coords[1],
    longitude: coords[0],
    country: props.country,
    admin1: props.state ?? props.city,
  };
}

function amapToGeoResult(result: AmapGeocodeResult): GeoResult {
  const [lng, lat] = result.location.split(",").map(Number);
  return {
    name: result.formatted_address,
    latitude: lat,
    longitude: lng,
    country: "中国",
    admin1: [result.province, result.city].filter(Boolean).join(""),
  };
}

async function photonGeocode(
  query: string,
  fetchFn: FetchLike,
  limit: number,
): Promise<GeoResult[]> {
  // 注意: Photon 不支持 lang 参数（传了会 400）
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetchFn(url, {
    headers: { "User-Agent": "minicode-travel-planner/0.1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Photon 服务返回 ${response.status}`);
  }
  const data = (await response.json()) as PhotonResponse;
  return (data.features ?? [])
    .map((feature) => photonToGeoResult(feature))
    .filter((result): result is GeoResult => result !== null);
}

/** Open-Meteo 地理编码（城市级，作为 Photon 的兜底） */
async function openMeteoGeocode(
  name: string,
  fetchFn: FetchLike,
): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`地理编码服务返回 ${response.status}`);
  }
  const data = (await response.json()) as {
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      country?: string;
      admin1?: string;
    }>;
  };
  const first = data.results?.[0];
  return first === undefined ? null : first;
}
