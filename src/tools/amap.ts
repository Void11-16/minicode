type FetchLike = typeof fetch;

import { haversineKm } from "./geo.ts";

const AMAP_BASE = "https://restapi.amap.com";

/** 高德错误码 → 可读信息（常见子集） */
const ERROR_MESSAGES: Record<string, string> = {
  "10001": "Key 不正确",
  "10003": "日配额已用完",
  "10019": "Key 类型错误（需要 Web 服务类型）",
  "10021": "并发/QPS 超限（短时间请求过多，稍后会自动重试）",
  "10044": "日调用量超限",
};

export interface AmapConfig {
  readonly apiKey: string;
  readonly fetchFn?: FetchLike;
}

export interface AmapGeocodeResult {
  readonly formatted_address: string;
  readonly location: string; // "lng,lat"
  readonly city?: string;
  readonly province?: string;
}

interface AmapGeocodeResponse {
  geocodes?: AmapGeocodeResult[];
}

export interface AmapPoi {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly typecode?: string;
  readonly address?: string;
  readonly location: string; // "lng,lat"
  readonly distance?: string;
  readonly tel?: string;
  readonly biz_ext?: { rating?: string; cost?: string; open_time?: string };
  readonly photos?: ReadonlyArray<{ title?: string; url?: string }>;
}

export interface TransitRouteResult {
  /** 推荐方案总耗时（秒） */
  readonly durationSec: number;
  /** 步行总距离（米） */
  readonly walkingDistanceM: number;
  /** 分段描述，如 ["地铁1号线", "步行 660 米", "7路"] */
  readonly segments: string[];
}

/** 路径几何：沿真实道路的点串 + 距离/耗时 */
export interface RouteGeometry {
  readonly distanceM: number;
  readonly durationSec: number;
  /** [lat, lng] 点串（已从高德 "lng,lat" 转换） */
  readonly points: ReadonlyArray<readonly [number, number]>;
}

interface AmapDirectionResponse {
  route?: {
    paths?: Array<{
      distance?: string;
      duration?: string;
      steps?: Array<{ polyline?: string }>;
    }>;
  };
}

interface AmapTransitOption {
  duration?: string;
  walking_distance?: string;
  segments?: Array<{
    walking?: { distance?: string };
    bus?: { buslines?: Array<{ name?: string }> };
  }>;
}

interface AmapTransitResponse {
  route?: { transits?: AmapTransitOption[] };
}

/**
 * 高德 Web 服务客户端。
 * - 免费配额：个人认证后地理编码等 5000 次/天，POI 搜索 100 次/天
 * - 工具层各自有 TTL 缓存，这里只统一请求与错误处理
 */
export class AmapClient {
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(config: AmapConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /** GET 请求并校验高德 status/infocode；失败抛错（上层决定降级） */
  private async getJson<T>(url: URL): Promise<T> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`高德服务 HTTP ${response.status}`);
    }

    const data = (await response.json()) as { status?: string; infocode?: string; info?: string };
    // 高德约定: status "1" + infocode "10000" = 成功
    if (data.status !== "1" || data.infocode !== "10000") {
      const reason =
        (data.infocode !== undefined ? ERROR_MESSAGES[data.infocode] : undefined) ??
        data.info ??
        `infocode ${data.infocode ?? "?"}`;
      throw new Error(`高德 API 失败: ${reason}`);
    }
    return data as T;
  }

  private buildUrl(path: string, params: Record<string, string>): URL {
    const url = new URL(`${AMAP_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("key", this.apiKey);
    return url;
  }

  /** 地理编码：地址 → 坐标（GCJ-02 坐标系，国内精度远高于 OSM） */
  async geocode(address: string, city?: string): Promise<AmapGeocodeResult | null> {
    const params: Record<string, string> = { address };
    if (city !== undefined && city !== "") params.city = city;
    const data = await this.getJson<AmapGeocodeResponse>(this.buildUrl("/v3/geocode/geo", params));
    return data.geocodes?.[0] ?? null;
  }

  /**
   * POI 关键词搜索（v3 + extensions=all）。
   * 实测 v5 的 show_fields=biz_ext 不返回评分/人均；v3 扩展信息才有真实 rating/cost。
   */
  async poiSearch(
    keywords: string,
    center: { latitude: number; longitude: number },
    radiusMeters: number,
    poiTypes?: string,
    pages = 1,
  ): Promise<AmapPoi[]> {
    // v3 单页上限 25；pages > 1 时逐页拉取，不足一页说明没有更多
    const allPois: AmapPoi[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const params: Record<string, string> = {
        keywords,
        location: `${center.longitude},${center.latitude}`,
        radius: String(Math.min(50_000, radiusMeters)),
        offset: "25",
        page: String(page),
        extensions: "all",
        sortrule: "distance",
      };
      if (poiTypes !== undefined && poiTypes !== "") {
        params.types = poiTypes;
      }
      const data = await this.getJson<{ pois?: AmapPoi[] }>(this.buildUrl("/v3/place/text", params));
      const pois = data.pois ?? [];
      allPois.push(...pois);
      if (pois.length < 25) break;
    }
    return allPois;
  }

  /**
   * 公交/地铁路径规划（v3 direction/transit/integrated）。
   * 返回推荐方案（第一个）；无方案或失败返回 null，由调用方降级驾车/步行。
   */
  async transitRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    city: string,
  ): Promise<TransitRouteResult | null> {
    const data = await this.getJson<AmapTransitResponse>(
      this.buildUrl("/v3/direction/transit/integrated", {
        origin: `${origin.longitude},${origin.latitude}`,
        destination: `${destination.longitude},${destination.latitude}`,
        city,
      }),
    );
    // API 返回的多条方案不保证按耗时排序（实测第一条常带多余换乘），取最短的
    const transit = (data.route?.transits ?? []).reduce<AmapTransitOption | undefined>(
      (fastest, transit) =>
        fastest === undefined || Number(transit.duration ?? "0") < Number(fastest.duration ?? "0")
          ? transit
          : fastest,
      undefined,
    );
    if (transit === undefined) return null;

    const segments: string[] = [];
    for (const segment of transit.segments ?? []) {
      const walkDistance = Number(segment.walking?.distance ?? "0");
      if (walkDistance > 50) segments.push(`步行${Math.round(walkDistance / 10) * 10}米`);
      for (const line of segment.bus?.buslines ?? []) {
        if (line.name !== undefined && line.name !== "") segments.push(line.name.split("(")[0]);
      }
    }
    return {
      durationSec: Number(transit.duration ?? "0"),
      walkingDistanceM: Number(transit.walking_distance ?? "0"),
      segments,
    };
  }

  /**
   * 按名称取 POI 照片（place/text + extensions=all 的 photos 字段）。
   * 只在名称匹配的 POI 上取图，避免展示到附近其他地点的照片；没有照片返回空数组。
   */
  async poiPhotos(
    keywords: string,
    center: { latitude: number; longitude: number },
    radiusMeters = 3000,
    limit = 4,
  ): Promise<string[]> {
    const pois = await this.poiSearch(keywords, center, radiusMeters);
    const normalize = (text: string) => text.replace(/[（）()·\s]/g, "");
    const key = normalize(keywords);
    const matched = pois.find((poi) => {
      const name = normalize(poi.name);
      return (name.includes(key) || key.includes(name)) && (poi.photos ?? []).length > 0;
    });
    if (matched === undefined) return [];
    return (matched.photos ?? [])
      .map((photo) => photo.url)
      .filter((url): url is string => url !== undefined && url !== "")
      .slice(0, limit);
  }

  /**
   * 按名称在城市内搜 POI，返回首个结果。
   * 解析地标名（灵隐寺/西湖）的坐标比地理编码准确——geocode 经常命中外地同名地点。
   */
  async poiSearchByName(
    keywords: string,
    city: string,
  ): Promise<{ name: string; latitude: number; longitude: number } | null> {
    const data = await this.getJson<{ pois?: AmapPoi[] }>(
      this.buildUrl("/v3/place/text", {
        keywords,
        city,
        offset: "5",
        page: "1",
        extensions: "base",
      }),
    );
    const poi = data.pois?.find((p) => p.location.includes(","));
    if (poi === undefined) return null;
    const [longitude, latitude] = poi.location.split(",").map(Number);
    return { name: poi.name ?? keywords, latitude, longitude };
  }

  /**
   * 步行/驾车路径规划（v3 direction/walking | direction/driving），
   * 返回沿真实道路的几何点串。无方案或失败返回 null。
   */
  async directionRoute(
    mode: "walking" | "driving",
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): Promise<RouteGeometry | null> {
    const data = await this.getJson<AmapDirectionResponse>(
      this.buildUrl(`/v3/direction/${mode}`, {
        origin: `${origin.longitude},${origin.latitude}`,
        destination: `${destination.longitude},${destination.latitude}`,
      }),
    );
    const path = data.route?.paths?.[0];
    if (path === undefined) return null;

    // 几何按 step 分段给出（"lng,lat;lng,lat"），逐段拼接为完整路径
    const points: Array<[number, number]> = [];
    for (const step of path.steps ?? []) {
      if (typeof step.polyline !== "string" || step.polyline === "") continue;
      for (const pair of step.polyline.split(";")) {
        const [lng, lat] = pair.split(",").map(Number);
        if (Number.isNaN(lng) || Number.isNaN(lat)) continue;
        points.push([lat, lng]);
      }
    }
    if (points.length < 2) return null;
    return {
      distanceM: Number(path.distance ?? "0"),
      durationSec: Number(path.duration ?? "0"),
      points,
    };
  }
}

/** 排序后的 POI 条目：rating/distance 由调用方展示用 */
export interface RankedPoi {
  readonly poi: AmapPoi;
  readonly rating: number | undefined;
  readonly distanceKm: number;
}

/**
 * 评分降序（无评分沉底）、同分按距离升序。
 * API 原始顺序不可控：不排序会把高分酒店/景点挤出前列（实测曾淹没 4.8 分孔庙）。
 */
export function rankPoisByRating(
  pois: readonly AmapPoi[],
  center: { latitude: number; longitude: number },
): RankedPoi[] {
  return pois
    .map((poi) => {
      const poiLocation = poi.location.split(",").map(Number);
      const ratingValue = poi.biz_ext?.rating !== undefined && poi.biz_ext.rating !== ""
        ? Number(poi.biz_ext.rating)
        : undefined;
      return {
        poi,
        rating: ratingValue !== undefined && !Number.isNaN(ratingValue) ? ratingValue : undefined,
        distanceKm: haversineKm(center.latitude, center.longitude, poiLocation[1], poiLocation[0]),
      };
    })
    .sort((a, b) => {
      const ratingDiff = (b.rating ?? 0) - (a.rating ?? 0);
      if (Math.abs(ratingDiff) > 0.01) return ratingDiff;
      return a.distanceKm - b.distanceKm;
    });
}
