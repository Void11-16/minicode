/**
 * POI 照片缓存：高德 POI 搜索有每日配额，照片只在用户点开弹窗时按需获取，
 * 结果落盘缓存并带 TTL，重启服务后不重复消耗配额。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface CacheEntry {
  readonly photos: readonly string[];
  readonly savedAt: number;
}

const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 500;
/** 载荷版本：照片「挑最像的 POI」逻辑改动时必须 +1，否则旧的错图/空结果会被继续复用 */
const CACHE_VERSION = "v2";

function versioned(key: string): string {
  return `${CACHE_VERSION}|${key}`;
}

export class PhotoCache {
  private readonly file: string;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(file: string) {
    this.file = file;
  }

  /** 启动时加载；文件缺失或损坏时从空缓存开始 */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, CacheEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (key.startsWith(`${CACHE_VERSION}|`) && now - entry.savedAt < TTL_MS && Array.isArray(entry.photos)) {
          this.entries.set(key, entry);
        }
      }
    } catch {
      // 首次运行或文件损坏：忽略
    }
  }

  get(key: string): string[] | undefined {
    const entry = this.entries.get(versioned(key));
    if (entry === undefined || Date.now() - entry.savedAt >= TTL_MS) return undefined;
    return [...entry.photos];
  }

  set(key: string, photos: readonly string[]): void {
    // 超出上限丢最早的（Map 保持插入序，近似 LRU）
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(versioned(key), { photos: [...photos], savedAt: Date.now() });
  }

  async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(this.entries)), "utf8");
    } catch {
      // 缓存写入失败不影响主流程
    }
  }
}
