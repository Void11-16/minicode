import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteGeometry } from "../tools/amap.ts";
import { atomicWrite } from "../tools/plan-files.ts";

interface CacheEntry { readonly savedAt: number; readonly value: RouteGeometry }
export const ROUTE_SHAPE_TTL_MS = 30 * 24 * 60 * 60_000;
export const ROUTE_METRICS_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 800;
const CACHE_VERSION = "v2";

export function validGeometry(value: unknown): value is RouteGeometry {
  if (value === null || typeof value !== "object") return false;
  const v = value as RouteGeometry;
  const points = (p: unknown): boolean => Array.isArray(p) && p.length >= 2 && p.every((x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Math.abs(x[0]) <= 90 && Math.abs(x[1]) <= 180);
  return Number.isFinite(v.distanceM) && v.distanceM >= 0 && Number.isFinite(v.durationSec) && v.durationSec >= 0
    && points(v.points) && (v.parts === undefined || (Array.isArray(v.parts) && v.parts.every((part) => (part.mode === "walking" || part.mode === "transit") && points(part.points))));
}

/** 几何保存 30 天；耗时只在采集后 30 分钟内作为查询结果展示，路线证据不受缓存 TTL 影响。 */
export class RouteCache {
  private readonly file: string;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) { this.file = file; this.now = now; }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(raw)) {
        if (key.startsWith(`${CACHE_VERSION}|`) && entry !== null && validGeometry(entry.value) && this.fresh(entry)) {
          this.entries.set(key, structuredClone(entry));
        }
      }
      this.prune();
    } catch { /* 首次运行或缓存损坏：不影响路线请求。 */ }
  }

  private fresh(entry: CacheEntry): boolean {
    const age = this.now() - entry.savedAt;
    return Number.isFinite(age) && age >= 0 && age < ROUTE_SHAPE_TTL_MS;
  }

  private prune(): void {
    for (const [key, entry] of this.entries) if (!this.fresh(entry)) this.entries.delete(key);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  read(key: string): { geometry: RouteGeometry; observedAt: number; metricsFresh: boolean } | undefined {
    const fullKey = `${CACHE_VERSION}|${key}`;
    const entry = this.entries.get(fullKey);
    if (entry === undefined) return undefined;
    if (!this.fresh(entry)) { this.entries.delete(fullKey); return undefined; }
    return { geometry: structuredClone(entry.value), observedAt: entry.savedAt, metricsFresh: this.now() - entry.savedAt < ROUTE_METRICS_TTL_MS };
  }

  get(key: string): RouteGeometry | undefined { return this.read(key)?.geometry; }

  set(key: string, value: RouteGeometry): void {
    if (!validGeometry(value)) return;
    const fullKey = `${CACHE_VERSION}|${key}`;
    this.entries.delete(fullKey);
    this.entries.set(fullKey, { savedAt: this.now(), value: structuredClone(value) });
    this.prune();
  }

  /** 串行、原子落盘；失败不影响路线响应，下一次仍可重试。 */
  persist(): Promise<void> {
    this.persistTail = this.persistTail.then(async () => {
      try {
        this.prune();
        await mkdir(dirname(this.file), { recursive: true });
        await atomicWrite(this.file, JSON.stringify(Object.fromEntries(this.entries)));
      } catch { /* 缓存是可丢弃数据。 */ }
    });
    return this.persistTail;
  }
}
