import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { withExternalEnvironment, type ExternalEnvironment } from "../core/external-environment.ts";
import { convertPoint } from "../tools/coordinates.ts";
import { haversineKm } from "../tools/geo.ts";
import type { Itinerary } from "../tools/itinerary-schema.ts";
import { parseEvalCase, type EvalCase, type EvalSuite } from "./cases.ts";

export interface WorldPlace {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly kind: "attraction" | "museum" | "stay" | "restaurant";
  /** 原始供应商坐标：经度,纬度；实际工具负责转成行程需要的格式。 */
  readonly location: string;
  readonly rating: number;
  readonly cost: number;
  readonly parent?: string;
  readonly type: string;
  readonly address: string;
  readonly hours?: { readonly opens: string; readonly closes: string; readonly closed_on: readonly number[] };
  /** 原始网页，而非已经抽取好的工具结果；仍要运行实际搜索解析/导航/事实提取。 */
  readonly pages: readonly { readonly url: string; readonly title: string; readonly text: string; readonly links?: readonly string[]; readonly search?: boolean }[];
}

export interface ExternalWorld {
  readonly schema_version: 1;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly provenance: { readonly kind: "synthetic" | "recorded"; readonly note: string };
  readonly now: string;
  readonly time_zone: string;
  readonly eval_case: EvalCase;
  readonly travel_dates: readonly string[];
  readonly city: { readonly name: string; readonly aliases: readonly string[]; readonly province: string; readonly adcode: string; readonly location: string };
  readonly places: readonly WorldPlace[];
  /** 对称 OD 表，必须明确覆盖；不会根据直线距离猜一个“真实”路线耗时。 */
  readonly routes: readonly { readonly from: string; readonly to: string; readonly distance_m: number; readonly driving_minutes: number; readonly transit_minutes: number; readonly walking_minutes: number }[];
  readonly weather: readonly { readonly date: string; readonly code: number; readonly min: number; readonly max: number; readonly rain_mm: number }[];
  /** 明确声明“已知查无结果”，与快照根本未覆盖的查询分开。 */
  readonly known_empty_queries: readonly string[];
  readonly faults?: readonly { readonly service: "amap" | "weather" | "search" | "page" | "osrm" | "geocode" | "overpass"; readonly occurrence: number; readonly status: number; readonly amap_code?: string }[];
}

export interface WorldSnapshot {
  readonly world: ExternalWorld;
  readonly text: string;
  readonly sha256: string;
}

export interface WorldCheck { readonly code: string; readonly message: string }
export interface WorldRequest { readonly service: string; readonly request: string; readonly outcome: "returned" | "known_empty" | "uncovered" | "fault"; readonly detail?: string }

export async function loadExternalWorld(path: string): Promise<WorldSnapshot> {
  const text = await readFile(path, "utf8");
  const world = parseExternalWorld(JSON.parse(text));
  return { world, text, sha256: createHash("sha256").update(text).digest("hex") };
}

/** 包含未提交改动的实际源码指纹；只记录 Git HEAD 会漏掉开发中的 A/B 版本。 */
export async function evalImplementationHash(): Promise<string> {
  const root = join(import.meta.dirname, ".."); const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) hash.update(relative(root, path)).update("\0").update(await readFile(path)).update("\0");
    }
  };
  await visit(root); return hash.digest("hex");
}

/** 文件也可能由录制导入；先验证数据，避免坏场景被误报成 Agent 回归。 */
export function parseExternalWorld(value: unknown): ExternalWorld {
  const world = value as ExternalWorld;
  const check = (ok: unknown, message: string): void => { if (!ok) throw new Error(`外部世界数据无效：${message}`); };
  check(world && world.schema_version === 1 && typeof world.id === "string" && typeof world.version === "string", "schema_version/id/version");
  check(typeof world.description === "string" && ["synthetic", "recorded"].includes(world.provenance?.kind) && typeof world.provenance?.note === "string", "说明及数据来源");
  check(typeof world.now === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(world.now) && Number.isFinite(Date.parse(world.now)), "now 必须含时区");
  try { new Intl.DateTimeFormat("en", { timeZone: world.time_zone }).format(); } catch { check(false, "time_zone"); }
  check(typeof world.time_zone === "string", "time_zone");
  const c = world.eval_case;
  check(c && typeof c.id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(c.id) && typeof c.title === "string" && typeof c.request === "string" && Number.isInteger(c.days) && c.days > 0, "eval_case");
  check((c.must_visit === undefined || strings(c.must_visit)) && (c.tags === undefined || strings(c.tags)) && (c.taste === undefined || typeof c.taste === "string") && (c.budget_per_person_yuan === undefined || (Number.isFinite(c.budget_per_person_yuan) && c.budget_per_person_yuan >= 0)), "案例偏好/必去/预算");
  parseEvalCase(c, "外部世界数据 eval_case");
  check(Array.isArray(world.travel_dates) && world.travel_dates.length === c.days && new Set(world.travel_dates).size === c.days && world.travel_dates.every(validDate), "travel_dates 必须是完整且不重复的出行日期");
  check(world.city && typeof world.city.name === "string" && typeof world.city.province === "string" && typeof world.city.adcode === "string" && strings(world.city.aliases) && validLocation(world.city.location), "city");
  check(Array.isArray(world.places) && world.places.length > 0, "places");
  const ids = new Set<string>(); const aliases = new Map<string, string>(); const urls = new Set<string>();
  for (const p of world.places) {
    check(p && typeof p.id === "string" && p.id.length > 0 && !ids.has(p.id) && typeof p.name === "string" && p.name.trim().length > 0 && strings(p.aliases) && ["attraction", "museum", "stay", "restaurant"].includes(p.kind), "景点 ID、别名和类别"); ids.add(p.id);
    check(validLocation(p.location) && Number.isFinite(p.rating) && p.rating >= 0 && p.rating <= 5 && Number.isFinite(p.cost) && p.cost >= 0 && typeof p.type === "string" && typeof p.address === "string", `${p.id} 坐标/评分/价格`);
    for (const alias of [p.name, ...p.aliases]) { const key = normalize(alias); check(!aliases.has(key) || aliases.get(key) === p.id, `别名冲突：${alias}`); aliases.set(key, p.id); }
    check(Array.isArray(p.pages), `${p.id} pages`);
    for (const page of p.pages) {
      check(typeof page.url === "string" && page.url.startsWith("https://") && typeof page.title === "string" && typeof page.text === "string" && (page.links === undefined || strings(page.links)), `${p.id} 网页`);
      check(!urls.has(page.url), `网页 URL 重复：${page.url}`); urls.add(page.url);
    }
    if (p.hours) check(validTime(p.hours.opens) && validTime(p.hours.closes) && p.hours.opens < p.hours.closes && Array.isArray(p.hours.closed_on) && p.hours.closed_on.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), `${p.id} 开放时段`);
  }
  for (const p of world.places) check(!p.parent || (p.parent !== p.id && ids.has(p.parent) && !world.places.find((v) => v.id === p.parent)?.parent), `${p.id} 主子景点只允许一层且父级必须存在`);
  check(Array.isArray(world.routes), "routes"); const pairs = new Set<string>();
  for (const r of world.routes) {
    const pair = [r.from, r.to].sort().join("|");
    check(ids.has(r.from) && ids.has(r.to) && r.from !== r.to && !pairs.has(pair) && [r.distance_m, r.driving_minutes, r.transit_minutes, r.walking_minutes].every((n) => Number.isFinite(n) && n > 0), "路线端点/单位/重复"); pairs.add(pair);
  }
  check(Array.isArray(world.weather) && world.weather.every((d) => validDate(d.date) && [d.code, d.min, d.max, d.rain_mm].every(Number.isFinite) && d.min <= d.max && d.rain_mm >= 0) && new Set(world.weather.map((d) => d.date)).size === world.weather.length, "weather");
  check(world.travel_dates.every((date) => world.weather.some((d) => d.date === date)), "出行天气覆盖不足");
  check(strings(world.known_empty_queries), "known_empty_queries");
  for (const f of world.faults ?? []) check(["amap", "weather", "search", "page", "osrm", "geocode", "overpass"].includes(f.service) && Number.isInteger(f.occurrence) && f.occurrence > 0 && Number.isInteger(f.status) && f.status >= 200 && f.status <= 599 && (!f.amap_code || f.service === "amap"), "faults");
  return world;
}

export function worldSuite(world: ExternalWorld): EvalSuite {
  return { id: world.id, name: world.description, version: world.version, cases: [world.eval_case] };
}

/**
 * 语义响应器：地点别名、范围、日期和 OD 决定结果，不要求模型复制上次调用序列。
 * 未覆盖项永不转发真实网络。即使业务工具捕获异常后降级，requests 仍会保留缺口。
 */
export class FrozenWorldRuntime {
  readonly requests: WorldRequest[] = [];
  readonly environment: ExternalEnvironment;
  readonly world: ExternalWorld;
  private readonly occurrences = new Map<string, number>();
  constructor(world: ExternalWorld) {
    this.world = world;
    this.environment = { fetch: this.fetch, now: new Date(world.now), timeZone: world.time_zone, amapKey: "frozen-world-no-real-key", state: new Map() };
  }
  run<T>(task: () => T): T { return withExternalEnvironment(this.environment, task); }
  report() { return { world_id: this.world.id, cache: "cold", requests: this.requests, uncovered: this.requests.filter((r) => r.outcome === "uncovered") }; }

  readonly fetch: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined); signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    // 不保存供应商密钥、Header 或正文；请求日志仅保留脱敏 URL。
    const safe = new URL(url); for (const key of ["key", "api_key", "token"]) safe.searchParams.delete(key);
    let service = "unrecognized";
    try {
      let response: Response;
      if (url.hostname === "restapi.amap.com") { service = "amap"; response = this.amap(url); }
      else if (["photon.komoot.io", "geocoding-api.open-meteo.com"].includes(url.hostname)) { service = "geocode"; response = this.geocoding(url); }
      else if (["overpass.private.coffee", "overpass-api.de", "z.overpass-api.de", "lz4.overpass-api.de", "maps.mail.ru", "overpass.kumi.systems"].includes(url.hostname)) { service = "overpass"; response = this.overpass(String(init?.body ?? "")); }
      else if (url.hostname === "api.open-meteo.com") { service = "weather"; response = this.weather(url); }
      else if (["www.bing.com", "www.baidu.com", "www.so.com", "html.duckduckgo.com"].includes(url.hostname)) { service = "search"; response = this.search(url); }
      else if (url.hostname === "router.project-osrm.org") { service = "osrm"; response = this.osrm(url); }
      else { service = "page"; response = this.page(url); }
      const count = (this.occurrences.get(service) ?? 0) + 1; this.occurrences.set(service, count);
      const fault = this.world.faults?.find((f) => f.service === service && f.occurrence === count);
      this.requests.push({ service, request: safe.href, outcome: fault ? "fault" : response.headers.get("x-world-empty") ? "known_empty" : "returned" });
      if (fault) return fault.amap_code ? json({ status: "0", infocode: fault.amap_code, info: "场景注入的供应商错误" }) : new Response("场景注入的服务故障", { status: fault.status });
      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.requests.push({ service, request: safe.href, outcome: "uncovered", detail });
      throw new Error(`WORLD_UNCOVERED: ${detail}`);
    }
  };

  private place(query: string): WorldPlace | undefined {
    const q = normalize(query);
    return this.world.places.filter((p) => [p.name, ...p.aliases].some((a) => q.includes(normalize(a))))
      .sort((a, b) => Math.max(...[b.name, ...b.aliases].filter((v) => q.includes(normalize(v))).map((v) => normalize(v).length)) - Math.max(...[a.name, ...a.aliases].filter((v) => q.includes(normalize(v))).map((v) => normalize(v).length)))[0];
  }
  private isCity(query: string): boolean { return [this.world.city.name, ...this.world.city.aliases, this.world.city.adcode].some((a) => normalize(a) === normalize(query)); }
  private empty(query: string): boolean {
    const q = normalize(query);
    return this.world.known_empty_queries.some((empty) => normalize(empty) === q || [this.world.city.name, ...this.world.city.aliases].some((city) => normalize(city + empty) === q));
  }
  private geocode(query: string) {
    const place = this.place(query);
    if (!place && !this.isCity(query)) throw new Error(`地理编码未覆盖：${query}`);
    const c = this.world.city;
    return { formatted_address: `${c.province}${c.name}${place?.name ?? ""}`, location: place?.location ?? c.location, province: c.province, city: c.name, district: "碑林区", adcode: c.adcode };
  }
  private poi(p: WorldPlace) {
    return { id: p.id, parent: p.parent, name: p.name, type: p.type, typecode: p.kind === "museum" ? "140100" : p.kind === "attraction" ? "110000" : p.kind === "stay" ? "100000" : "050000", location: p.location, address: p.address, pname: this.world.city.province, cityname: this.world.city.name, adname: "碑林区", biz_ext: { rating: String(p.rating), cost: String(p.cost) } };
  }
  private geocoding(url: URL): Response {
    const query = url.searchParams.get("q") ?? url.searchParams.get("name") ?? "";
    let geo: ReturnType<FrozenWorldRuntime["geocode"]>;
    if (url.pathname === "/reverse") {
      const point: [number, number] = [Number(url.searchParams.get("lon")), Number(url.searchParams.get("lat"))];
      const nearest = this.world.places.slice().sort((a, b) => distance(point, coordinates(a.location)) - distance(point, coordinates(b.location)))[0]!;
      if (distance(point, coordinates(nearest.location)) > 1) throw new Error("逆地理编码坐标未覆盖");
      geo = this.geocode(nearest.name);
    } else {
      if (!["/api/", "/v1/search"].includes(url.pathname)) throw new Error("地理编码接口未覆盖");
      if (this.empty(query)) return json(url.hostname === "photon.komoot.io" ? { features: [] } : { results: [] }, true);
      geo = this.geocode(query);
    }
    const [longitude, latitude] = coordinates(geo.location), point = convertPoint({ latitude, longitude, crs: "gcj02" }, "wgs84");
    const name = this.place(query)?.name ?? geo.formatted_address;
    return url.hostname === "photon.komoot.io"
      ? json({ features: [{ geometry: { coordinates: [point.longitude, point.latitude] }, properties: { name, city: this.world.city.name, state: this.world.city.province, country: "中国" } }] })
      : json({ results: [{ name, ...point, country: "中国", admin1: this.world.city.province, admin2: this.world.city.name }] });
  }
  private overpass(query: string): Response {
    const match = /around:([\d.]+),([\d.-]+),([\d.-]+)/.exec(query);
    if (!match) throw new Error("Overpass 查询范围未覆盖");
    const center: [number, number] = [Number(match[3]), Number(match[2])], radius = Number(match[1]);
    const kind = /restaurant|cafe|fast_food/.test(query) ? "restaurant" : /hotel\|hostel/.test(query) ? "stay" : /attraction\|viewpoint/.test(query) ? "visit" : undefined;
    if (!kind) throw new Error("Overpass 查询类别未覆盖");
    return json({ elements: this.world.places.filter((p) => kind === "visit" ? ["attraction", "museum"].includes(p.kind) : p.kind === kind).flatMap((p, i) => {
      const [longitude, latitude] = coordinates(p.location), point = convertPoint({ latitude, longitude, crs: "gcj02" }, "wgs84");
      if (distance(center, [point.longitude, point.latitude]) * 1000 > radius) return [];
      return [{ id: i + 1, type: "node", lat: point.latitude, lon: point.longitude, tags: { name: p.name, ...(p.kind === "restaurant" ? { amenity: "restaurant", cuisine: "regional" } : { tourism: p.kind === "stay" ? "hotel" : p.kind === "museum" ? "museum" : "attraction" }) } }];
    }) });
  }
  private amap(url: URL): Response {
    const q = url.searchParams;
    const ok = (data: object, empty = false) => json({ status: "1", infocode: "10000", ...data }, empty);
    if (url.pathname === "/v3/geocode/geo") {
      const address = q.get("address") ?? "", empty = this.empty(address);
      return ok({ geocodes: empty ? [] : [this.geocode(address)] }, empty);
    }
    if (url.pathname === "/v3/place/text") {
      const query = q.get("keywords") ?? "";
      if (q.has("city") && !this.isCity(q.get("city")!)) throw new Error(`城市未覆盖：${q.get("city")}`);
      let places: readonly WorldPlace[];
      const explicit = this.place(query);
      if (explicit) places = [explicit];
      else if (this.empty(query)) return ok({ pois: [] }, true);
      else if (/美食|餐厅|餐馆|小吃/.test(query)) places = this.world.places.filter((p) => p.kind === "restaurant");
      else if (/陕菜|羊肉泡馍|面食/.test(query)) places = this.world.places.filter((p) => p.kind === "restaurant" && p.type.includes(query));
      else if (/酒店|住宿|民宿/.test(query)) places = this.world.places.filter((p) => p.kind === "stay");
      else if (/博物馆|纪念馆/.test(query)) places = this.world.places.filter((p) => p.kind === "museum");
      else if (/旅游景点|风景|景点/.test(query) || this.isCity(query)) places = this.world.places.filter((p) => p.kind === "attraction");
      else throw new Error(`POI 查询未覆盖：${query}`);
      if (q.has("location")) {
        const center = coordinates(q.get("location")!); const radius = Number(q.get("radius"));
        if (!Number.isFinite(radius) || radius <= 0) throw new Error("POI 半径无效");
        places = places.filter((p) => distance(center, coordinates(p.location)) * 1000 <= radius).sort((a, b) => distance(center, coordinates(a.location)) - distance(center, coordinates(b.location)));
      }
      const offset = Number(q.get("offset") ?? 25), page = Number(q.get("page") ?? 1);
      if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(page) || page < 1) throw new Error("POI 分页无效");
      return ok({ pois: places.slice((page - 1) * offset, page * offset).map((p) => this.poi(p)) });
    }
    if (/^\/v[34]\/direction\//.test(url.pathname)) {
      if (url.pathname.includes("bicycling")) throw new Error("场景未覆盖骑行耗时");
      const route = this.route(q.get("origin") ?? "", q.get("destination") ?? "");
      const mode = url.pathname.includes("transit") ? "transit" : url.pathname.includes("walking") ? "walking" : "driving";
      const duration = String(route[`${mode}_minutes`] * 60), polyline = `${q.get("origin")};${q.get("destination")}`;
      if (mode === "transit") return ok({ route: { transits: [{ duration, distance: String(route.distance_m), walking_distance: "300", segments: [{ bus: { buslines: [{ name: "场景公交线路", polyline }] } }] }] } });
      const result = { paths: [{ duration, distance: String(route.distance_m), steps: [{ polyline }] }] };
      return url.pathname.startsWith("/v4/") ? json({ errcode: 0, data: result }) : ok({ route: result });
    }
    throw new Error(`高德接口未覆盖：${url.pathname}`);
  }
  private route(from: string, to: string, wgs84 = false) {
    const find = (value: string) => {
      let point = coordinates(value);
      if (wgs84) { const p = convertPoint({ latitude: point[1], longitude: point[0], crs: "wgs84" }, "gcj02"); point = [p.longitude, p.latitude]; }
      const place = this.world.places.slice().sort((a, b) => distance(point, coordinates(a.location)) - distance(point, coordinates(b.location)))[0];
      if (!place || distance(point, coordinates(place.location)) > 0.15) throw new Error(`路线端点未覆盖：${value}`);
      return place.parent ?? place.id;
    };
    const a = find(from), b = find(to);
    const route = this.world.routes.find((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
    if (!route) throw new Error(`OD 未覆盖：${a} → ${b}`);
    return route;
  }
  private osrm(url: URL): Response {
    const match = /\/route\/v1\/(driving|walking|cycling)\/([^;]+);([^/]+)/.exec(url.pathname);
    if (!match || match[1] === "cycling") throw new Error("OSRM 路径或骑行模式未覆盖");
    const route = this.route(match[2]!, match[3]!, true);
    return json({ code: "Ok", routes: [{ distance: route.distance_m, duration: route[match[1] === "walking" ? "walking_minutes" : "driving_minutes"] * 60, geometry: { coordinates: [coordinates(match[2]!), coordinates(match[3]!)] } }] });
  }
  private weather(url: URL): Response {
    if (url.pathname !== "/v1/forecast") throw new Error("天气接口未覆盖");
    const q = url.searchParams, start = q.get("start_date"), end = q.get("end_date");
    const point: [number, number] = [Number(q.get("longitude")), Number(q.get("latitude"))];
    if (!start || !end || distance(point, coordinates(this.world.city.location)) > 80) throw new Error("天气地点或日期未覆盖");
    const days = this.world.weather.filter((d) => d.date >= start && d.date <= end);
    if (!days.length || days[0]!.date !== start || days.at(-1)!.date !== end || days.length !== (Date.parse(end) - Date.parse(start)) / 86400000 + 1) throw new Error(`天气日期未覆盖：${start}—${end}`);
    return json({ daily: { time: days.map((d) => d.date), weather_code: days.map((d) => d.code), temperature_2m_min: days.map((d) => d.min), temperature_2m_max: days.map((d) => d.max), precipitation_sum: days.map((d) => d.rain_mm) } });
  }
  private search(url: URL): Response {
    const query = url.searchParams.get("q") ?? url.searchParams.get("wd") ?? "";
    const place = this.place(query);
    if (!place && this.empty(query)) return html("<html><body>没有相关结果</body></html>", true);
    if (!place) throw new Error(`搜索实体未覆盖：${query}`);
    const pages = place.pages.filter((p) => p.search !== false);
    const cards = pages.map((p) => {
      const title = escape(p.title), href = escape(p.url), text = escape(p.text);
      if (url.hostname.includes("bing")) return `<li class="b_algo"><h2><a href="${href}">${title}</a></h2><p>${text}</p></li>`;
      if (url.hostname.includes("so.com")) return `<li class="res-list"><h3><a href="${href}">${title}</a></h3><p class="res-desc">${text}</p></li>`;
      if (url.hostname.includes("baidu")) return `<div class="result c-container" mu="${href}"><h3><a href="${href}">${title}</a></h3><span class="content-right_">${text}</span></div>`;
      return `<a class="result__a" href="${href}">${title}</a><a class="result__snippet">${text}</a>`;
    });
    return html(`<html><body>${cards.join("")}</body></html>`, pages.length === 0);
  }
  private page(url: URL): Response {
    const page = this.world.places.flatMap((p) => p.pages).find((p) => p.url === url.href);
    if (!page) throw new Error(`网页未覆盖：${url.origin}${url.pathname}`);
    const links = (page.links ?? []).map((link) => `<a href="${escape(link)}">参观指南与开放时间</a>`).join("");
    return html(`<html><head><title>${escape(page.title)}</title></head><body><h1>${escape(page.title)}</h1><article>${escape(page.text)}</article>${links}</body></html>`);
  }
}

/** 独立对照快照事实，不能只相信模型写进计划的开放时间。这里只判断确定冲突。 */
export function checkWorldItinerary(world: ExternalWorld, itinerary: Itinerary): WorldCheck[] {
  const checks: WorldCheck[] = [];
  for (const date of world.travel_dates) if (!itinerary.days.some((d) => d.date === date)) checks.push({ code: "world-missing-date", message: `缺少请求日期 ${date}` });
  for (const day of itinerary.days) {
    if (!day.date || !world.travel_dates.includes(day.date)) { checks.push({ code: "world-unexpected-date", message: `日期不在场景范围：${day.date ?? "未填写"}` }); continue; }
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    for (const item of day.items.filter((i) => i.type === "visit")) {
      const place = world.places.find((p) => [p.name, ...p.aliases].some((name) => normalize(name) === normalize(item.name)));
      if (!place) { checks.push({ code: "world-unknown-place", message: `${day.date}：景点「${item.name}」不在世界数据中` }); continue; }
      const main = world.places.find((p) => p.id === place.parent) ?? place;
      if (!main.hours) continue; // 未知与已知冲突分开；不能根据场景缺字段推断闭馆。
      if (main.hours.closed_on.includes(weekday)) checks.push({ code: "world-closed-day", message: `${day.date}：${main.name} 当天闭馆` });
      if ((item.time && item.time < main.hours.opens) || (item.end_time && item.end_time > main.hours.closes)) checks.push({ code: "world-outside-hours", message: `${day.date}：${main.name} 安排超出 ${main.hours.opens}—${main.hours.closes}` });
    }
  }
  return checks;
}

function normalize(value: string): string { return value.replace(/[\s·（）()]/g, "").toLowerCase(); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0); }
function validDate(value: string): boolean { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function validTime(value: string): boolean { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function validLocation(value: string): boolean { if (typeof value !== "string" || value.split(",").some((v) => !v.trim())) return false; const p = value.split(",").map(Number); return p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]!) <= 180 && Math.abs(p[1]!) <= 90; }
function coordinates(value: string): [number, number] { if (!validLocation(value)) throw new Error(`坐标无效：${value}`); return value.split(",").map(Number) as [number, number]; }
function distance(a: [number, number], b: [number, number]): number { return haversineKm(a[1], a[0], b[1], b[0]); }
function json(value: object, empty = false): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...(empty ? { "x-world-empty": "1" } : {}) } }); }
function html(value: string, empty = false): Response { return new Response(value, { headers: { "content-type": "text/html; charset=utf-8", ...(empty ? { "x-world-empty": "1" } : {}) } }); }
function escape(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
