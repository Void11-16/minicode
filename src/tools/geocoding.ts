type FetchLike = typeof fetch;

import { bestPoiByName, type AmapGeocodeResult, type AmapPoi } from "./amap.ts";
import { getAmapClient } from "./amap-access.ts";

export interface GeoResult {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly country?: string;
  /** 省 / 自治区 / 直辖市 */
  readonly admin1?: string;
  /** 地级市（直辖市与 admin1 相同） */
  readonly admin2?: string;
  /** 区 / 县 */
  readonly admin3?: string;
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
 * 地名 → 坐标：
 * 1. 传了 city（目标城市）→ geocodeInCity：高德 POI/地理编码 + 省市字段校验 + 换词重查；
 *    核实不了宁返回 null——不退回未校验的结果，避免外地同名地点污染地图
 * 2. 无 city → 高德地理编码 → Photon（OSM）→ Open-Meteo（GeoNames）兜底
 */
export async function geocodeLocation(
  name: string,
  fetchFn: FetchLike = fetch,
  city?: string,
): Promise<GeoResult | null> {
  const cacheKey = `loc:${name}@${city ?? ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  if (city !== undefined && city !== "") {
    const verified = await geocodeInCity(name, city, fetchFn);
    if (verified !== null) cacheSet(cacheKey, verified);
    return verified;
  }

  const amap = getAmapClient();
  if (amap !== undefined) {
    try {
      const result = await amap.geocode(name);
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

/**
 * 在城市内核实地点坐标（省市字段校验 + 换查询词重查）：
 * 1. 名称≈城市时直接地理编码（POI 搜索会命中车站/政府等无关 POI）
 * 2. 高德 POI 搜索（place/text 限定 city）：候选先过省市校验，再按名称取最优
 * 3. 仍无 → 高德地理编码（city 限定 + 「城市+名称」重查），结果再校验 province/city
 * 4. 无高德或全部失败 → Photon（结果也需与城市对得上）
 * 全部失败返回 null——调用方应标记「坐标待核实」，禁止退回未经校验的结果。
 */
export async function geocodeInCity(
  name: string,
  city: string,
  fetchFn: FetchLike = fetch,
): Promise<GeoResult | null> {
  const cacheKey = `city:${name}@${city}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const amap = getAmapClient();
  if (amap !== undefined) {
    if (regionMatchesCity(name, city)) {
      try {
        const result = await amap.geocode(name, city);
        if (result !== null && geocodeCityVerdict(result, city) !== "mismatch") {
          const geo = amapToGeoResult(result);
          cacheSet(cacheKey, geo);
          return geo;
        }
      } catch {
        // 失败 → 继续走 POI 检索
      }
    }

    for (const variant of poiQueryVariants(name, city)) {
      let pois: AmapPoi[] = [];
      try {
        pois = await amap.poiSearchInCity(variant, city);
      } catch {
        continue; // 配额/网络失败 → 换下一个变体
      }
      const hit = bestPoiByName(
        pois.filter((poi) => poiCityVerdict(poi, city) !== "mismatch"),
        variant,
      );
      if (hit !== null) {
        const geo = poiToGeoResult(hit);
        cacheSet(cacheKey, geo);
        return geo;
      }
    }

    for (const variant of geocodeQueryVariants(name, city)) {
      try {
        const result = await amap.geocode(variant, city);
        if (result !== null && geocodeCityVerdict(result, city) !== "mismatch") {
          const geo = amapToGeoResult(result);
          cacheSet(cacheKey, geo);
          return geo;
        }
      } catch {
        // 换下一个变体
      }
    }
  }

  // Photon 兜底：只接受能与目标城市对上的结果，对不上按未核实处理
  try {
    const candidates = await photonGeocode(name, fetchFn, 3);
    const hit = candidates.find(
      (candidate) => regionMatchesCity(candidate.admin2, city) || regionMatchesCity(candidate.admin1, city),
    );
    if (hit !== undefined) {
      cacheSet(cacheKey, hit);
      return hit;
    }
  } catch {
    // 未核实
  }
  return null;
}

/** POI 检索的重查词：原始 → 去括号 → 去「城市+市/省」前缀（北京市西城区北海公园 → 西城区北海公园） */
function poiQueryVariants(name: string, city: string): string[] {
  const variants = [name];
  const noParens = name.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (noParens !== "" && noParens !== name) variants.push(noParens);
  const withoutPrefix = stripCityPrefix(name, city);
  if (withoutPrefix !== null && !variants.includes(withoutPrefix)) variants.push(withoutPrefix);
  return variants.slice(0, 3);
}

/** 地理编码的重查词：原始 → 「城市+全名」（北海公园 → 北京北海公园，对 geocode API 更稳） */
function geocodeQueryVariants(name: string, city: string): string[] {
  const variants = [name];
  const cityCore = stripAdminSuffix(city);
  if (cityCore !== "" && !name.startsWith(cityCore)) {
    variants.push(`${cityCore}${name}`);
  }
  return variants.slice(0, 2);
}

/** 剥掉名称开头的「城市+市/省」前缀；剩余不足 2 字视为误剥 */
function stripCityPrefix(name: string, city: string): string | null {
  for (const prefix of [city.trim(), stripAdminSuffix(city)]) {
    if (prefix === "") continue;
    for (const suffix of ["省", "市"]) {
      const full = `${prefix}${suffix}`;
      if (!name.startsWith(full)) continue;
      const rest = name.slice(full.length).trim();
      if (rest.length >= 2) return rest;
    }
  }
  return null;
}

/** POI 的省市字段与目标城市的关系：match=同城；mismatch=确定是外地；unknown=字段缺失无从判断 */
function poiCityVerdict(poi: AmapPoi, city: string): "match" | "mismatch" | "unknown" {
  const fields = [poi.cityname, poi.pname, poi.adname].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  if (fields.length === 0) return "unknown";
  return fields.some((field) => regionMatchesCity(field, city)) ? "match" : "mismatch";
}

/** 地理编码结果的省市字段与目标城市的关系（字段缺失时退回对 formatted_address 的包含判断） */
function geocodeCityVerdict(result: AmapGeocodeResult, city: string): "match" | "mismatch" | "unknown" {
  const fields = [result.city, result.province].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  if (fields.length > 0) {
    return fields.some((field) => regionMatchesCity(field, city)) ? "match" : "mismatch";
  }
  const cityCore = stripAdminSuffix(city);
  return cityCore !== "" && result.formatted_address.includes(cityCore) ? "match" : "unknown";
}

function poiToGeoResult(poi: AmapPoi): GeoResult {
  const [longitude, latitude] = poi.location.split(",").map(Number);
  return {
    name: poi.name,
    latitude,
    longitude,
    country: "中国",
    admin1: poi.pname,
    admin2: poi.cityname,
    admin3: poi.adname,
  };
}

/**
 * 行政区名归一化：去掉层级后缀与民族修饰，保留核心词
 * （「北京市」→「北京」、「西城区」→「西城」、「西双版纳傣族自治州」→「西双版纳」）
 */
function stripAdminSuffix(text: string): string {
  let value = text.trim();
  for (;;) {
    const next = value.replace(
      /(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|自治州|自治县|地区|省|市|区|县|盟|旗|维吾尔|壮族|回族|傣族|藏族|彝族|苗族|侗族|白族|朝鲜族|土家族|哈尼族|蒙古族|哈萨克族|柯尔克孜族)$/,
      "",
    );
    if (next === value || next.length < 2) return value;
    value = next;
  }
}

/** 行政区名是否指向同一地区（「北京市」≡「北京」、「西双版纳」≡「西双版纳傣族自治州」） */
export function regionMatchesCity(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || actual === "") return false;
  const a = stripAdminSuffix(actual);
  const b = stripAdminSuffix(expected);
  if (a === "" || b === "") return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 展示用行政区标签：省市区去重拼接（「北京市西城区」「浙江省杭州市西湖区」） */
export function regionLabel(geo: Pick<GeoResult, "admin1" | "admin2" | "admin3">): string {
  let label = "";
  for (const part of [geo.admin1, geo.admin2, geo.admin3]) {
    if (part === undefined || part === "" || label.includes(part)) continue;
    // 中文行政区名连续拼接（浙江省杭州市西湖区）；跨语言/编码（ZJ + 杭州市）留空格避免粘连
    const boundaryIsCjk = /[\u4e00-\u9fff]$/.test(label) && /^[\u4e00-\u9fff]/.test(part);
    label += label === "" || boundaryIsCjk ? part : ` ${part}`;
  }
  return label;
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
      // 取多条候选：同名地点 API 会把目标城市排在很后面（北海公园→北京第 10），
      // 只给第一条反而把模型引向错误城市；候选带省市字段供模型判断
      const results = await amap.geocodeAll(name, limit);
      if (results.length > 0) {
        return results.map((result) => amapToGeoResult(result));
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
    county?: string;
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
    admin1: props.state,
    admin2: props.city,
    admin3: props.county,
  };
}

function amapToGeoResult(result: AmapGeocodeResult): GeoResult {
  const [lng, lat] = result.location.split(",").map(Number);
  return {
    name: result.formatted_address,
    latitude: lat,
    longitude: lng,
    country: "中国",
    admin1: result.province,
    admin2: result.city,
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
