import { readFile } from "node:fs/promises";
import { getAmapClient } from "../tools/amap-access.ts";
import { convertPoint, type CoordinateSystem } from "../tools/coordinates.ts";
import { poiCityVerdict } from "../tools/geocoding.ts";
import { rankPoisByRating, type AmapPoi } from "../tools/amap.ts";
import { geocodeLocation } from "../tools/geocoding.ts";
import { updateSavedItinerary } from "../tools/itinerary.ts";
import { planFileFor } from "../tools/plan-files.ts";
import { TravelEvidenceStore } from "../tools/travel-evidence.ts";
import type { ToolContext } from "../tools/tool.ts";

/**
 * 行程条目编辑（地图界面的"改行程"）：
 * - suggestPlanOptions：按条目位置就近推荐可替换的景点/餐厅（高德 POI，带缓存省配额）
 * - applyPlanEdit：替换 / 调换顺序 / 删除，写回 JSON 并重生成 Markdown 与质量报告
 */

interface PlanItem {
  id?: string;
  name?: string;
  type?: string;
  subtype?: string;
  note?: string;
  cuisine?: string;
  source?: string;
  confidence?: string;
  time?: string;
  end_time?: string;
  planned_duration_min?: number;
  opening_hours?: unknown;
  closed_on?: unknown;
  location?: { crs?: "gcj02" | "wgs84"; name?: string; address?: string; latitude?: number; longitude?: number; source?: string };
  [key: string]: unknown;
}

interface PlanDay {
  date?: string;
  theme?: string;
  items?: PlanItem[];
  [key: string]: unknown;
}

interface PlanFile {
  title?: string;
  days?: PlanDay[];
  [key: string]: unknown;
}

export interface SuggestOption {
  readonly name: string;
  readonly address?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly rating?: number;
  readonly cost?: number;
  readonly cuisine?: string;
  readonly distanceKm: number;
  readonly crs: CoordinateSystem;
}

export interface SuggestResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly options: SuggestOption[];
}

/** 可参与"调换顺序"的条目类型（餐饮候选不进时间线，不做移动） */
const STOP_TYPES = new Set(["visit", "accommodation", "rest"]);
/** 推荐结果缓存：条目编辑反复打开时不重复消耗高德 POI 配额（个人版配额很紧） */
const SUGGEST_TTL_MS = 10 * 60_000;
const suggestCache = new Map<string, { value: SuggestResult; expiresAt: number }>();

export function planPaths(rootDir: string, title: string): { json: string; md: string; qualityJson: string; qualityMd: string } {
  const base = planFileFor(rootDir, "plans", title, "json").slice(0, -5);
  return {
    json: `${base}.json`,
    md: `${base}.md`,
    qualityJson: `${base}.quality.json`,
    qualityMd: `${base}.quality.md`,
  };
}

export async function suggestPlanOptions(
  rootDir: string,
  title: string,
  dayNo: number,
  itemId: string,
): Promise<SuggestResult> {
  const plan = await readPlan(rootDir, title);
  const day = plan.days?.[dayNo - 1];
  if (day === undefined) throw new Error(`行程里没有第 ${dayNo} 天`);
  const item = findItem(day, itemId);
  if (item === undefined) throw new Error("未找到该条目");

  const kind = item.type === "meal" ? "meal" : item.type === "visit" ? "visit" : null;
  if (kind === null) {
    return { available: false, reason: "该类型条目不支持附近推荐（可调整顺序或删除）", options: [] };
  }
  const center =
    item.location?.latitude !== undefined && item.location?.longitude !== undefined
      ? convertPoint({ latitude: item.location.latitude, longitude: item.location.longitude, crs: item.location.crs ?? (item.location.source === "osm" ? "wgs84" : "gcj02") }, "gcj02")
      : firstLocated(day);
  if (center === undefined) {
    return { available: false, reason: "该条目没有坐标，无法就近推荐（可手动输入名称）", options: [] };
  }
  const amap = getAmapClient();
  if (amap === undefined) {
    return { available: false, reason: "未配置高德 Key，推荐不可用（可手动输入名称）", options: [] };
  }

  const cacheKey = `${planPaths(rootDir, title).json}|${plan.revision ?? 0}|${dayNo}|${itemId}|${center.latitude.toFixed(3)},${center.longitude.toFixed(3)}|${kind}`;
  const hit = suggestCache.get(cacheKey);
  if (hit !== undefined && Date.now() < hit.expiresAt) return hit.value;

  // 已在行程中的同名地点不再推荐；名称粒度不同（"三坊七巷" vs "三坊七巷历史文化街区"）也要算
  const existingNames: string[] = item.name !== undefined && item.name !== "" ? [item.name] : [];
  for (const other of plan.days ?? []) {
    for (const entry of other.items ?? []) {
      if (entry.type === item.type && entry.name !== undefined) existingNames.push(entry.name);
    }
  }

  const pois = kind === "visit" ? await searchVisitPois(center) : await amap.poiSearch("美食", center, 2000, "050000");
  const options = rankPoisByRating(pois, center)
    .filter((entry) => !existingNames.some((existing) => namesOverlap(existing, entry.poi.name)))
    .flatMap((entry) => {
      const located = parsePoiLocation(entry.poi);
      if (located === null) return [];
      return [
        {
          crs: "gcj02" as const,
          name: entry.poi.name,
          address: entry.poi.address,
          latitude: located.latitude,
          longitude: located.longitude,
          rating: entry.rating,
          cost: kind === "meal" ? poiCost(entry.poi) : undefined,
          cuisine: kind === "meal" ? poiCuisine(entry.poi) : undefined,
          distanceKm: entry.distanceKm,
        },
      ];
    })
    .slice(0, 12);

  const destination = String((plan.constraints as Record<string, unknown> | undefined)?.destination ?? "");
  const evidence = new TravelEvidenceStore(rootDir);
  await evidence.observePlaces(kind === "meal" ? "search_restaurants" : "search_attractions", destination,
    options.map((o) => `${o.name} | 坐标 ${o.latitude.toFixed(6)},${o.longitude.toFixed(6)}${o.rating === undefined ? "" : ` | 评分 ${o.rating}`}${o.cost === undefined ? "" : ` | 人均 ¥${o.cost}`}`).join("\n"), "amap");
  const value: SuggestResult = { available: true, options };
  suggestCache.set(cacheKey, { value, expiresAt: Date.now() + SUGGEST_TTL_MS });
  return value;
}

export interface PlanEditResult {
  readonly quality: { readonly status: string; readonly score: number };
  readonly revision?: number;
}

export async function applyPlanEdit(
  rootDir: string,
  body: { title?: unknown; day?: unknown; item_id?: unknown; op?: unknown; replacement?: unknown; direction?: unknown; expected_revision?: unknown },
  ctx?: ToolContext,
): Promise<PlanEditResult> {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
  const dayNo = typeof body.day === "number" ? body.day : Number.NaN;
  if (title === "" || itemId === "" || !Number.isInteger(dayNo) || dayNo < 1) {
    throw new Error("缺少 title / day / item_id");
  }
  const evidence = ctx?.evidence ?? new TravelEvidenceStore(rootDir);
  await evidence.load();
  const snapshot = await updateSavedItinerary(rootDir, title, async (raw) => {
    const plan = raw as PlanFile;
    if (body.expected_revision !== undefined && body.expected_revision !== plan.revision) throw new Error("行程版本冲突，请刷新后重试");
    const day = plan.days?.[dayNo - 1];
    if (day === undefined || day.items === undefined) throw new Error(`行程里没有第 ${dayNo} 天`);
    const items = day.items;
    const byId = items.findIndex((entry) => entry.id === itemId);
    const index = byId >= 0 ? byId : items.findIndex((entry) => entry.name === itemId);
    if (index < 0) throw new Error("未找到该条目（可能已被修改，刷新试试）");
    const item = items[index];

    if (body.op === "replace") {
      const replacement = isRecord(body.replacement) ? body.replacement : {};
      await replaceItem(item, replacement, String((plan.constraints as Record<string, unknown> | undefined)?.destination ?? ""), evidence);
    } else if (body.op === "move") {
      if (body.direction !== "up" && body.direction !== "down") throw new Error("direction 只能是 up / down");
      moveItem(items, index, body.direction);
    } else if (body.op === "remove") {
      items.splice(index, 1);
    } else {
      throw new Error("op 只能是 replace / move / remove");
    }

  }, { workspace: rootDir, ...ctx, evidence });
  return { quality: { status: snapshot.report.status, score: snapshot.report.score }, revision: snapshot.itinerary.revision };
}

/** 替换条目：优先用推荐卡片带来的坐标；手输名称时按就近 POI → 自由地理编码依次解析 */
async function replaceItem(item: PlanItem, replacement: Record<string, unknown>, city: string, evidence: TravelEvidenceStore): Promise<void> {
  let name = typeof replacement.name === "string" ? replacement.name.trim() : "";
  if (name === "") throw new Error("缺少替换名称");

  let latitude = typeof replacement.latitude === "number" ? replacement.latitude : undefined;
  let longitude = typeof replacement.longitude === "number" ? replacement.longitude : undefined;
  let address = typeof replacement.address === "string" && replacement.address !== "" ? replacement.address : undefined;
  let rating = typeof replacement.rating === "number" ? replacement.rating : undefined;
  let cost = typeof replacement.cost === "number" ? replacement.cost : undefined;
  let cuisine = typeof replacement.cuisine === "string" ? replacement.cuisine : undefined;
  let crs: CoordinateSystem = replacement.crs === "gcj02" ? "gcj02" : "wgs84";

  if (latitude === undefined || longitude === undefined) {
    const resolved = await resolvePlace(item, name, city, evidence);
    if (resolved === null) throw new Error(`没找到地点「${name}」，换个名称或从推荐里选`);
    name = resolved.name;
    latitude = resolved.latitude;
    longitude = resolved.longitude;
    address = resolved.address ?? address;
    rating = resolved.rating ?? rating;
    cost = resolved.cost ?? cost;
    cuisine = resolved.cuisine ?? cuisine;
    crs = resolved.crs;
  }

  // 地点身份变化后，旧证据、评分、价格和预约信息全部失效。
  for (const field of ["evidence_id", "evidence_verified", "evidence_observed_at", "closure_verified", "rating", "cost_per_person", "ticket_price_per_person", "room_price_per_night", "opening_hours", "closed_on", "reservation_required", "cuisine"]) delete item[field];
  item.name = name;
  item.location = {
    name,
    ...(address !== undefined ? { address } : {}),
    latitude,
    longitude,
    source: "手动替换",
    crs,
  };
  item.source = "manual";
  item.confidence = "low";
  if (rating !== undefined) item.rating = rating;
  if (cost !== undefined) {
    if (item.type === "accommodation") item.room_price_per_night = cost;
    else item.cost_per_person = cost;
  }
  // 旧地点的营业时间/闭馆日对新地点无效，必须清掉
  delete item.opening_hours;
  delete item.closed_on;
  if (item.type === "meal" && cuisine !== undefined && cuisine !== "") item.cuisine = cuisine;
  const parts: string[] = [];
  if (rating !== undefined) parts.push(`评分${rating}（待核实）`);
  if (cost !== undefined) parts.push(item.type === "accommodation" ? `每房每晚约¥${cost}` : `人均约¥${cost}`);
  if (parts.length > 0) item.note = parts.join("｜");
  else delete item.note;
}

/** 调换顺序：与同侧最近的停留点（景点/住宿/休息）交换位置，时间槽跟着槽位走 */
function moveItem(items: PlanItem[], index: number, direction: "up" | "down"): void {
  const step = direction === "up" ? -1 : 1;
  let swapIndex = -1;
  for (let i = index + step; i >= 0 && i < items.length; i += step) {
    if (STOP_TYPES.has(items[i].type ?? "")) {
      swapIndex = i;
      break;
    }
  }
  if (swapIndex < 0) throw new Error(direction === "up" ? "上面没有可交换的条目了" : "下面没有可交换的条目了");
  const item = items[index];
  const other = items[swapIndex];
  items[index] = other;
  items[swapIndex] = item;
  // 时间槽随槽位走：交换 time/end_time/planned_duration_min 三组值（经 Record 规避联合键读取限制）
  const itemSlot: Record<string, string | number | undefined> = {
    time: item.time,
    end_time: item.end_time,
    planned_duration_min: item.planned_duration_min,
  };
  const otherSlot: Record<string, string | number | undefined> = {
    time: other.time,
    end_time: other.end_time,
    planned_duration_min: other.planned_duration_min,
  };
  for (const key of Object.keys(itemSlot)) {
    const a = itemSlot[key];
    const b = otherSlot[key];
    if (b === undefined) delete item[key];
    else item[key] = b;
    if (a === undefined) delete other[key];
    else other[key] = a;
  }
}

interface ResolvedPlace {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly crs: CoordinateSystem;
  readonly address?: string;
  readonly rating?: number;
  readonly cost?: number;
  readonly cuisine?: string;
}

async function resolvePlace(item: PlanItem, name: string, city: string, evidence: TravelEvidenceStore): Promise<ResolvedPlace | null> {
  const near =
    item.location?.latitude !== undefined && item.location?.longitude !== undefined
      ? convertPoint({ latitude: item.location.latitude, longitude: item.location.longitude, crs: item.location.crs ?? (item.location.source === "osm" ? "wgs84" : "gcj02") }, "gcj02")
      : undefined;
  const amap = getAmapClient();
  if (amap !== undefined) {
    try {
      const pois = near !== undefined ? await amap.poiSearch(name, near, 20_000) : [];
      const first = pois.find((poi) => parsePoiLocation(poi) !== null && (city === "" || poiCityVerdict(poi, city) === "match"));
      if (first !== undefined) {
        const located = parsePoiLocation(first)!;
        await evidence.observePlaces(item.type === "meal" ? "search_restaurants" : item.type === "accommodation" ? "search_stays" : "search_attractions", city, `${first.name} | 坐标 ${located.latitude.toFixed(6)},${located.longitude.toFixed(6)}${poiRating(first) === undefined ? "" : ` | 评分 ${poiRating(first)}`}${poiCost(first) === undefined ? "" : ` | 人均 ¥${poiCost(first)}`}`, "amap");
        return {
          name: first.name,
          latitude: located.latitude,
          longitude: located.longitude,
          crs: "gcj02",
          address: first.address,
          rating: poiRating(first),
          cost: poiCost(first),
          cuisine: poiCuisine(first),
        };
      }
    } catch {
      // 配额/网络失败 → 自由地理编码兜底
    }
  }
  const geo = await geocodeLocation(name, fetch, city || undefined).catch(() => null);
  if (geo === null) return null;
  return { name: geo.name !== "" ? geo.name : name, latitude: geo.latitude, longitude: geo.longitude, crs: geo.crs ?? "wgs84" };
}

async function searchVisitPois(center: { latitude: number; longitude: number }): Promise<AmapPoi[]> {
  const amap = getAmapClient()!;
  // 与 search_attractions 同口径的双路搜索：博物馆属科教文化类，"旅游景点"类型搜不到
  const [scenic, museums] = await Promise.all([
    amap.poiSearch("旅游景点", center, 3000, "110000"),
    amap.poiSearch("博物馆|纪念馆", center, 3000).catch(() => []),
  ]);
  const seen = new Set<string>();
  return [...scenic, ...museums].filter((poi) => {
    const key = poi.id ?? poi.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function poiRating(poi: AmapPoi): number | undefined {
  const raw = poi.biz_ext?.rating;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}

function poiCost(poi: AmapPoi): number | undefined {
  const raw = poi.biz_ext?.cost;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isNaN(value) || value <= 0 ? undefined : value;
}

function poiCuisine(poi: AmapPoi): string | undefined {
  const cuisine = poi.type?.split(";").filter((part) => part !== "餐饮服务").slice(0, 2).join("/");
  return cuisine !== undefined && cuisine !== "" ? cuisine : undefined;
}

function parsePoiLocation(poi: AmapPoi): { latitude: number; longitude: number } | null {
  const [longitude, latitude] = poi.location.split(",").map(Number);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  return { latitude, longitude };
}

function firstLocated(day: PlanDay): { latitude: number; longitude: number } | undefined {
  for (const entry of day.items ?? []) {
    if (entry.location?.latitude !== undefined && entry.location?.longitude !== undefined) {
      return convertPoint({ latitude: entry.location.latitude, longitude: entry.location.longitude, crs: entry.location.crs ?? (entry.location.source === "osm" ? "wgs84" : "gcj02") }, "gcj02");
    }
  }
  return undefined;
}

function findItem(day: PlanDay, itemId: string): PlanItem | undefined {
  const items = day.items ?? [];
  return items.find((entry) => entry.id === itemId) ?? items.find((entry) => entry.name === itemId);
}

async function readPlan(rootDir: string, title: string): Promise<PlanFile> {
  const raw = await readFile(planPaths(rootDir, title).json, "utf8");
  return JSON.parse(raw) as PlanFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 名称归一化后互相包含视为同一地点（如"三坊七巷"与"三坊七巷历史文化街区"） */
function namesOverlap(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/[（）()·\s\-–—]/g, "");
  const left = normalize(a);
  const right = normalize(b);
  if (left === "" || right === "") return false;
  return left.includes(right) || right.includes(left);
}
