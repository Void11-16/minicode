import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteGeometry } from "../tools/amap.ts";

interface CacheEntry {
  readonly savedAt: number;
  readonly value: RouteGeometry;
}

const TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 800;
const CACHE_VERSION = "v1";

/**
 * 路段几何磁盘缓存。道路不会随行程编辑变化，按起终点和交通方式缓存后，
 * 刷新页面或重启服务都不必再次消耗高德方向 API 配额。
 */
export class RouteCache {
  private readonly file: string;
  private readonly entries = new Map<string, CacheEntry>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, CacheEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (
          key.startsWith(`${CACHE_VERSION}|`) &&
          now - entry.savedAt < TTL_MS &&
          Array.isArray(entry.value?.points) &&
          entry.value.points.length >= 2
        ) {
          this.entries.set(key, entry);
        }
      }
    } catch {
      // 首次运行或缓存损坏：从空缓存开始，不影响路线请求
    }
  }

  get(key: string): RouteGeometry | undefined {
    const value = this.entries.get(`${CACHE_VERSION}|${key}`)?.value;
    if (value === undefined) return undefined;
    return {
      distanceM: value.distanceM,
      durationSec: value.durationSec,
      points: value.points.map((point): [number, number] => [point[0], point[1]]),
    };
  }

  set(key: string, value: RouteGeometry): void {
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(`${CACHE_VERSION}|${key}`, { savedAt: Date.now(), value });
  }

  /** 串行落盘，避免多个按天请求同时写同一文件互相覆盖 */
  persist(): Promise<void> {
    this.persistTail = this.persistTail.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(Object.fromEntries(this.entries)), "utf8");
      } catch {
        // 缓存写入失败不影响路线响应
      }
    });
    return this.persistTail;
  }
}
