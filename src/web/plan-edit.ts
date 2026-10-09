import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAmapClient } from "../tools/amap-access.ts";
import { rankPoisByRating, type AmapPoi } from "../tools/amap.ts";
import { geocodeLocation } from "../tools/geocoding.ts";
import { parseItinerary } from "../tools/itinerary-schema.ts";
import { renderMarkdown } from "../tools/itinerary.ts";
import { renderQualityReport, validateItinerary } from "../tools/itinerary-validator.ts";

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
  location?: { name?: string; address?: string; latitude?: number; longitude?: number; source?: string };
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
  const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-");
  const base = join(rootDir, "plans", safe);
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
      ? { latitude: item.location.latitude, longitude: item.location.longitude }
      : firstLocated(day);
  if (center === undefined) {
    return { available: false, reason: "该条目没有坐标，无法就近推荐（可手动输入名称）", options: [] };
  }
  const amap = getAmapClient();
  if (amap === undefined) {
    return { available: false, reason: "未配置高德 Key，推荐不可用（可手动输入名称）", options: [] };
  }

  const cacheKey = `${title}|${dayNo}|${itemId}|${center.latitude.toFixed(3)},${center.longitude.toFixed(3)}|${kind}`;
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

  const value: SuggestResult = { available: true, options };
  suggestCache.set(cacheKey, { value, expiresAt: Date.now() + SUGGEST_TTL_MS });
  return value;
}

export interface PlanEditResult {
  readonly quality: { readonly status: string; readonly score: number };
}

export async function applyPlanEdit(
  rootDir: string,
  body: { title?: unknown; day?: unknown; item_id?: unknown; op?: unknown; replacement?: unknown; direction?: unknown },
): Promise<PlanEditResult> {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
  const dayNo = typeof body.day === "number" ? body.day : Number.NaN;
  if (title === "" || itemId === "" || !Number.isInteger(dayNo) || dayNo < 1) {
    throw new Error("缺少 title / day / item_id");
  }
  const plan = await readPlan(rootDir, title);
  const day = plan.days?.[dayNo - 1];
  if (day === undefined || day.items === undefined) throw new Error(`行程里没有第 ${dayNo} 天`);
  const items = day.items;
  const byId = items.findIndex((entry) => entry.id === itemId);
  const index = byId >= 0 ? byId : items.findIndex((entry) => entry.name === itemId);
  if (index < 0) throw new Error("未找到该条目（可能已被修改，刷新试试）");
  const item = items[index];

  if (body.op === "replace") {
    const replacement = isRecord(body.replacement) ? body.replacement : {};
    await replaceItem(item, replacement);
  } else if (body.op === "move") {
    if (body.direction !== "up" && body.direction !== "down") throw new Error("direction 只能是 up / down");
    moveItem(items, index, body.direction);
  } else if (body.op === "remove") {
    items.splice(index, 1);
  } else {
    throw new Error("op 只能是 replace / move / remove");
  }

  const itinerary = parseItinerary(plan); // 编辑后仍须满足行程结构约束
  const report = validateItinerary(itinerary);
  const paths = planPaths(rootDir, title);
  await writeFile(paths.json, JSON.stringify(plan, null, 2), "utf8");
  await writeFile(paths.md, renderMarkdown(itinerary), "utf8");
  await writeFile(paths.qualityJson, JSON.stringify(report, null, 2), "utf8");
  await writeFile(paths.qualityMd, renderQualityReport(report), "utf8");
  return { quality: { status: report.status, score: report.score } };
}

/** 替换条目：优先用推荐卡片带来的坐标；手输名称时按就近 POI → 自由地理编码依次解析 */
async function replaceItem(item: PlanItem, replacement: Record<string, unknown>): Promise<void> {
  const name = typeof replacement.name === "string" ? replacement.name.trim() : "";
  if (name === "") throw new Error("缺少替换名称");

  let latitude = typeof replacement.latitude === "number" ? replacement.latitude : undefined;
  let longitude = typeof replacement.longitude === "number" ? replacement.longitude : undefined;
  let address = typeof replacement.address === "string" && replacement.address !== "" ? replacement.address : undefined;
  let rating = typeof replacement.rating === "number" ? replacement.rating : undefined;
  let cost = typeof replacement.cost === "number" ? replacement.cost : undefined;
  let cuisine = typeof replacement.cuisine === "string" ? replacement.cuisine : undefined;

  if (latitude === undefined || longitude === undefined) {
    const resolved = await resolvePlace(item, name);
    if (resolved === null) throw new Error(`没找到地点「${name}」，换个名称或从推荐里选`);
    latitude = resolved.latitude;
    longitude = resolved.longitude;
    address = resolved.address ?? address;
    rating = resolved.rating ?? rating;
    cost = resolved.cost ?? cost;
    cuisine = resolved.cuisine ?? cuisine;
  }

  item.name = name;
  item.location = {
    name,
    ...(address !== undefined ? { address } : {}),
    latitude,
    longitude,
    source: "手动替换",
  };
  item.source = "amap";
  item.confidence = "high";
  // 旧地点的营业时间/闭馆日对新地点无效，必须清掉
  delete item.opening_hours;
  delete item.closed_on;
  if (item.type === "meal" && cuisine !== undefined && cuisine !== "") item.cuisine = cuisine;
  const parts: string[] = [];
  if (rating !== undefined) parts.push(`高德${rating}分`);
  if (cost !== undefined) parts.push(`人均约¥${cost}`);
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
  readonly address?: string;
  readonly rating?: number;
  readonly cost?: number;
  readonly cuisine?: string;
}

async function resolvePlace(item: PlanItem, name: string): Promise<ResolvedPlace | null> {
  const near =
    item.location?.latitude !== undefined && item.location?.longitude !== undefined
      ? { latitude: item.location.latitude, longitude: item.location.longitude }
      : undefined;
  const amap = getAmapClient();
  if (amap !== undefined) {
    try {
      const pois = near !== undefined ? await amap.poiSearch(name, near, 20_000) : [];
      const first = pois.find((poi) => parsePoiLocation(poi) !== null);
      if (first !== undefined) {
        const located = parsePoiLocation(first)!;
        return {
          name: first.name,
          latitude: located.latitude,
          longitude: located.longitude,
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
  const geo = await geocodeLocation(name).catch(() => null);
  if (geo === null) return null;
  return { name: geo.name !== "" ? geo.name : name, latitude: geo.latitude, longitude: geo.longitude };
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
      return { latitude: entry.location.latitude, longitude: entry.location.longitude };
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
