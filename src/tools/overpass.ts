type FetchLike = typeof fetch;

/**
 * Overpass 公共镜像列表（按 2026-10-15 实测可用性排序）：
 * - private.coffee    实测 1.5s 出结果，目前最稳的节点
 * - overpass-api.de   主站，健康时最快；过载时秒回 502「All query workers are busy」
 * - z / lz4           主站集群的别名实例，与主站同时好坏
 * - maps.mail.ru      能用但很慢（实测 17~21s），排后面免得拖时间
 * - kumi.systems      近日常年 HTTP 500，仅作最后兜底
 * 排序只是初始顺序，实际按「最近失败过的排最后」动态调整（见 mirrorsByHealth）。
 */
const OVERPASS_URLS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** 单次尝试超时：主站过载时会挂住不回，超时必须短，否则一次工具调用吃掉整轮 LLM 预算 */
const ATTEMPT_TIMEOUT_MS = 8_000;
/** 全部镜像的总预算：用完了就带着错误返回，不让模型干等 */
const TOTAL_BUDGET_MS = 20_000;
/** 失败镜像的冷却期：这期间它排到最后再试 */
const MIRROR_COOLDOWN_MS = 5 * 60_000;

const USER_AGENT = "minicode-travel-planner/0.1";

/** 镜像 → 冷却到期时间（毫秒时间戳） */
const mirrorCooldownUntil = new Map<string, number>();

/** 没刚失败过的镜像排前面：避免每次都先在同一个坏节点上耗满超时 */
function mirrorsByHealth(): string[] {
  const now = Date.now();
  return OVERPASS_URLS.map((url) => ({ url, cooling: (mirrorCooldownUntil.get(url) ?? 0) > now }))
    .sort((a, b) => Number(a.cooling) - Number(b.cooling))
    .map((entry) => entry.url);
}

/** 记一次失败（进冷却）并返回给用户看的错误前缀 */
function noteFailure(url: string, reason: string): string {
  mirrorCooldownUntil.set(url, Date.now() + MIRROR_COOLDOWN_MS);
  return `${hostOf(url)}: ${reason}`;
}

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
 * - 依次尝试全部镜像；最近失败的排到最后（各镜像好坏并不同步）
 * - 单次尝试 8s 超时 + 全部镜像合计 20s 预算，避免一次调用吃掉整轮 LLM 预算
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

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let attempts = 0;
  let lastError = "";

  for (const url of mirrorsByHealth()) {
    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) break;
    attempts += 1;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": USER_AGENT,
        },
        body: query,
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, budgetLeft)),
      });
      if (!response.ok) {
        lastError = noteFailure(url, `HTTP ${response.status}`);
        continue; // 尝试下一个镜像
      }
      // 504 等错误可能以 XML 体返回（状态码未必是 5xx），解析守卫
      let data: OverpassResponse;
      try {
        data = (await response.json()) as OverpassResponse;
      } catch {
        lastError = noteFailure(url, "响应不是 JSON（可能是错误页）");
        continue;
      }
      if (data.elements === undefined) {
        lastError = noteFailure(url, "响应缺少 elements");
        continue;
      }
      mirrorCooldownUntil.delete(url);
      responseCache.set(query, data);
      return data;
    } catch (error) {
      lastError = noteFailure(url, error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Overpass 服务暂时不可用（已尝试 ${attempts} 个镜像，最后错误: ${lastError}）。` +
    "公共服务负载波动，建议稍后重试或先用其他工具（如 get_place_reviews）",
  );
}

function hostOf(url: string): string {
  return url.replace(/^https:\/\//, "").split("/")[0];
}

/**
 * OSM 兜底查询：失败时把主源（高德）的失败原因一起带出来。
 * 否则工具报的只有 Overpass 的错，看起来像 OSM 的锅——实际多数是高德限流触发了降级。
 */
export async function overpassFallback(
  query: string,
  primaryError: string | undefined,
  fetchFn: FetchLike,
): Promise<OverpassResponse> {
  try {
    return await overpassQuery(query, fetchFn);
  } catch (error) {
    const osmError = error instanceof Error ? error.message : String(error);
    if (primaryError === undefined) throw new Error(osmError);
    throw new Error(`高德请求失败（${primaryError}）后转 OpenStreetMap 兜底，OSM 也不可用：${osmError}`);
  }
}
