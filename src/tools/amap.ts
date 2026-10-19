type FetchLike = typeof fetch;

import { haversineKm } from "./geo.ts";

const AMAP_BASE = "https://restapi.amap.com";

/** 并发/QPS 超限：个人 Key 的并发极低（实测并行 4 个 POI 查询全被拒），退避重试后多数能过 */
const QPS_INFOCODE = "10021";
/** 全局请求闸门的最小间隔：再密会被 10021 拒，250ms 实测稳 */
const REQUEST_GAP_MS = 250;
/** 撞到 10021 后的退避时长（重试两次：闸门后仍偶发超限，重试比整条链路降级划算） */
const QPS_RETRY_DELAY_MS = 700;
const QPS_RETRY_COUNT = 2;

/** 全局闸门状态：所有高德请求共用（工具并行调用时上游仍是串行） */
let lastRequestAt = 0;
let gateTail: Promise<unknown> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 串行闸门：同一时刻只放行一个请求，并在两次请求之间补足最小间隔。
 * 模型常在一轮里并行发多个 search_* 工具，每个工具又要打 3~4 个接口，
 * 不限速就会整批被 10021 拒掉，然后静默降级到 OSM——那正是 Overpass 报错的来源。
 */
function scheduleAmapRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = gateTail.then(async () => {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
    return task();
  });
  // 闸门只关心"上一个请求结束"，失败不阻塞后续
  gateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
  /** 行政区划字段（用于省市校验，拦截外地同名地点） */
  readonly pname?: string;
  readonly cityname?: string;
  readonly adname?: string;
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

  /**
   * GET 请求并校验高德 status/infocode；失败抛错（上层决定降级）。
   * 走全局闸门限速；撞到 10021（并发/QPS 超限）退避后重试，仍失败才放弃（交给上层降级）。
   */
  private async getJson<T>(url: URL, retriesLeft = QPS_RETRY_COUNT): Promise<T> {
    const response = await scheduleAmapRequest(() => this.fetchFn(url, { signal: AbortSignal.timeout(15_000) }));
    if (!response.ok) {
      throw new Error(`高德服务 HTTP ${response.status}`);
    }

    const data = (await response.json()) as { status?: string; infocode?: string; info?: string };
    // 高德约定: status "1" + infocode "10000" = 成功
    if (data.status === "1" && data.infocode === "10000") return data as T;

    if (data.infocode === QPS_INFOCODE && retriesLeft > 0) {
      await delay(QPS_RETRY_DELAY_MS);
      return this.getJson<T>(url, retriesLeft - 1);
    }
    const reason =
      (data.infocode !== undefined ? ERROR_MESSAGES[data.infocode] : undefined) ??
      data.info ??
      `infocode ${data.infocode ?? "?"}`;
    throw new Error(`高德 API 失败: ${reason}`);
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
   * 地理编码的全部候选（按 API 顺序去重截断）。
   * 无城市上下文时同名地点会返回一长串（实测「北海公园」10 条、北京那条排第 10），
   * 调用方应展示带省市字段的候选并提示传 city 重查，而不是只取第一条。
   */
  async geocodeAll(address: string, limit = 3, city?: string): Promise<AmapGeocodeResult[]> {
    const params: Record<string, string> = { address };
    if (city !== undefined && city !== "") params.city = city;
    const data = await this.getJson<AmapGeocodeResponse>(this.buildUrl("/v3/geocode/geo", params));
    const seen = new Set<string>();
    const results: AmapGeocodeResult[] = [];
    for (const result of data.geocodes ?? []) {
      const key = `${result.formatted_address}@${result.location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
      if (results.length >= limit) break;
    }
    return results;
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
    const matched = rankPoisByName(pois, keywords)[0];
    if (matched === undefined) return [];
    return (matched.photos ?? [])
      .map((photo) => photo.url)
      .filter((url): url is string => url !== undefined && url !== "")
      .slice(0, limit);
  }

  /**
   * 在城市内按关键词搜 POI，返回候选列表（含 pname/cityname/adname）。
   * 解析地标名（灵隐寺/西湖）的坐标比地理编码准确——geocode 即使带 city
   * 也可能命中外地同名地点（实测 灵隐寺@浙江 → 重庆合川灵隐寺）。
   * city 参数大体能把结果约束在城市内，但调用方仍需校验省市字段。
   */
  async poiSearchInCity(keywords: string, city: string, offset = 5): Promise<AmapPoi[]> {
    const data = await this.getJson<{ pois?: AmapPoi[] }>(
      this.buildUrl("/v3/place/text", {
        keywords,
        city,
        offset: String(offset),
        page: "1",
        extensions: "base",
      }),
    );
    return (data.pois ?? []).filter((poi) => poi.location.includes(","));
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

/** 名称相似度低于该值就认为不是同一地点，宁可不给图也不贴错图 */
const POI_NAME_SIMILARITY_MIN = 0.6;

/** 归一化：去掉括号/分隔符/空白并统一小写，让「赤峰博物馆（新馆）」≡「赤峰博物馆新馆」 */
function normalizePoiName(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 最长公共子序列长度：容忍中间插入的修饰词（「乌兰布统旅游景区-欧式风光区」） */
function lcsLength(left: string, right: string): number {
  let previous = Array.from<number>({ length: right.length + 1 }).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = Array.from<number>({ length: right.length + 1 }).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * 按名称把搜索结果排到最像目标的前面，只保留有照片的 POI。
 * 高德对同一地点常返回带修饰词的别名或泛化结果，两级排序都容易出错：
 * 取首个命中会贴错（「赤峰博物馆南停车场」排在「赤峰博物馆」前），
 * 只允许包含关系又会漏掉别名（「乌兰布统旅游景区-欧式风光区」不含「乌兰布统欧式风光区」）。
 * 因此按 同名 > 包含 > 相似度 分级，同级再比名称长度与相似度。
 */
export function rankPoisByName(pois: readonly AmapPoi[], keywords: string): AmapPoi[] {
  const key = normalizePoiName(keywords);
  return pois
    .filter((poi) => (poi.photos ?? []).length > 0)
    .map((poi) => {
      const name = normalizePoiName(poi.name);
      const relation = name === key ? 0 : name.includes(key) || key.includes(name) ? 1 : 2;
      return {
        poi,
        name,
        relation,
        similarity: relation === 2 ? lcsLength(name, key) / Math.max(name.length, key.length, 1) : 1,
      };
    })
    .filter((entry) => entry.name !== "" && (entry.relation < 2 || entry.similarity >= POI_NAME_SIMILARITY_MIN))
    .sort((a, b) => a.relation - b.relation || b.similarity - a.similarity || a.name.length - b.name.length)
    .map((entry) => entry.poi);
}

/** 附属设施类关键词：停车场/售票处/入口等衍生 POI 不是目的地本体 */
const POI_NOISE_PATTERN = /(停车|售票|检票|出入口|入口|出口|大门|门岗|码头|厕所|卫生间|警务|派出所|游客中心|咨询点|服务点|公交站|地铁站|车站)/;

/**
 * 按名称挑最像目标的一个 POI（不做城市校验，调用方负责）。
 * 高德对地标名会混出大量衍生 POI：实测「水亭门历史文化街区」的首条是
 * 「…地下停车点」、「鹿鸣大草坪」首条是「…驿站厕所」——先降噪再按
 * 同名 > 包含 > 相似度 分级比较，避免坐标虽近、名称却指向附属设施。
 */
export function bestPoiByName(pois: readonly AmapPoi[], keywords: string): AmapPoi | null {
  const key = normalizePoiName(keywords);
  if (key === "") return null;
  const scored = pois
    .map((poi) => {
      const name = normalizePoiName(poi.name);
      if (name === "") return null;
      const relation = name === key ? 0 : name.includes(key) || key.includes(name) ? 1 : 2;
      const similarity = relation === 2 ? lcsLength(name, key) / Math.max(name.length, key.length, 1) : 1;
      if (relation === 2 && similarity < POI_NAME_SIMILARITY_MIN) return null;
      return { poi, relation, noise: POI_NOISE_PATTERN.test(poi.name) ? 1 : 0, similarity };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(
      (a, b) =>
        a.relation - b.relation ||
        a.noise - b.noise ||
        b.similarity - a.similarity ||
        a.poi.name.length - b.poi.name.length,
    );
  return scored[0]?.poi ?? null;
}

/** 高德 "lng,lat" → 行程条目用的「纬度,经度」显示串（4 位小数约 10 米精度） */
export function formatPoiCoordinates(location: string): string | null {
  const [longitude, latitude] = location.split(",").map(Number);
  if (Number.isNaN(longitude) || Number.isNaN(latitude)) return null;
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}
