type FetchLike = typeof fetch;

/**
 * Overpass 公共镜像列表（按 2026-09-24 实测可用性排序）：
 * - overpass-api.de   主站，快但负载抖动（间歇 504 XML 错误页）
 * - z.overpass-api.de 主站的 zombie 实例，实测 4.5s 可用
 * - maps.mail.ru      慢（约 17s）但稳定可用
 * - kumi.systems      实测已超时不可用，保留为最后兜底
 */
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** 单次尝试超时：镜像多时不应让一次工具调用吃掉整轮 LLM 预算 */
const ATTEMPT_TIMEOUT_MS = 25_000;
/** 最多尝试的镜像数（即使列表更长也不无限轮询） */
const MAX_ATTEMPTS = 3;

const USER_AGENT = "minicode-travel-planner/0.1";

export interface OsmElement {
  readonly type: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly center?: { lat: number; lon: number };
  readonly tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OsmElement[];
}

/** 简单 TTL 缓存：LLM 失败重试/多工具重复查询时不再打慢服务 */
class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  /** maxSize：容量上限，超限时删最早条目（近似 LRU），防长驻进程无限增长 */
  constructor(ttlMs: number, maxSize = 100) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const responseCache = new TtlCache<OverpassResponse>(10 * 60_000, 50);

/**
 * 执行 Overpass 查询（OpenStreetMap 数据，免费无 Key）。
 *
 * 可靠性设计（针对公共实例的负载抖动）：
 * - 相同查询 10 分钟内直接走缓存（LLM 重试风暴不再打服务）
 * - 依次尝试多个镜像（实测 kumi 等节点会长期挂掉，不能只依赖一个备用）
 * - 单次尝试 25s 超时，最多试 3 个镜像
 * - 响应体可能是 XML 错误页（504 时未必带 5xx 状态码），解析失败视为该镜像不可用
 */
export async function overpassQuery(
  query: string,
  fetchFn: FetchLike = fetch,
): Promise<OverpassResponse> {
  const cached = responseCache.get(query);
  if (cached !== undefined) {
    return cached;
  }

  let lastError = "";

  for (const url of OVERPASS_URLS.slice(0, MAX_ATTEMPTS)) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": USER_AGENT,
        },
        body: query,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `${hostOf(url)}: HTTP ${response.status}`;
        continue; // 尝试下一个镜像
      }
      // 504 等错误可能以 XML 体返回（状态码未必是 5xx），解析守卫
      let data: OverpassResponse;
      try {
        data = (await response.json()) as OverpassResponse;
      } catch {
        lastError = `${hostOf(url)}: 响应不是 JSON（可能是错误页）`;
        continue;
      }
      if (data.elements === undefined) {
        lastError = `${hostOf(url)}: 响应缺少 elements`;
        continue;
      }
      responseCache.set(query, data);
      return data;
    } catch (error) {
      lastError = `${hostOf(url)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  throw new Error(
    `Overpass 服务暂时不可用（已尝试 ${MAX_ATTEMPTS} 个镜像，最后错误: ${lastError}）。` +
    "公共服务负载波动，建议稍后重试或先用其他工具（如 get_place_reviews）",
  );
}

function hostOf(url: string): string {
  return url.replace(/^https:\/\//, "").split("/")[0];
}
