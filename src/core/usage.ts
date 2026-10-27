/** 单次 API 请求的 token 用量（来自 LLM 响应的 usage 字段） */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** DeepSeek: prompt_cache_hit_tokens / OpenAI: prompt_tokens_details.cached_tokens */
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
}

/** 会话累计用量 */
export interface UsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly requests: number;
  readonly cacheHitTokens: number;
}

export const EMPTY_USAGE: UsageSummary = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  requests: 0,
  cacheHitTokens: 0,
};

export function addUsage(summary: UsageSummary, usage: TokenUsage): UsageSummary {
  return {
    promptTokens: summary.promptTokens + usage.promptTokens,
    completionTokens: summary.completionTokens + usage.completionTokens,
    totalTokens: summary.totalTokens + usage.totalTokens,
    requests: summary.requests + 1,
    cacheHitTokens: summary.cacheHitTokens + (usage.promptCacheHitTokens ?? 0),
  };
}

export interface CostBreakdown {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly outputTokens: number;
  readonly cacheHitCostYuan: number;
  readonly cacheMissCostYuan: number;
  readonly outputCostYuan: number;
  readonly totalCostYuan: number;
}

/**
 * 按单价（元/百万 tokens）估算成本。
 * priceInPerM 表示缓存未命中输入价；priceCacheInPerM 省略时按未命中价保守估算。
 */
export function estimateCostBreakdown(
  summary: UsageSummary,
  priceInPerM: number,
  priceOutPerM: number,
  priceCacheInPerM: number = priceInPerM,
): CostBreakdown {
  const cacheHitTokens = Math.min(Math.max(summary.cacheHitTokens, 0), summary.promptTokens);
  const cacheMissTokens = Math.max(0, summary.promptTokens - cacheHitTokens);
  const cacheHitCostYuan = (cacheHitTokens * priceCacheInPerM) / 1_000_000;
  const cacheMissCostYuan = (cacheMissTokens * priceInPerM) / 1_000_000;
  const outputCostYuan = (summary.completionTokens * priceOutPerM) / 1_000_000;
  return {
    cacheHitTokens,
    cacheMissTokens,
    outputTokens: summary.completionTokens,
    cacheHitCostYuan,
    cacheMissCostYuan,
    outputCostYuan,
    totalCostYuan: cacheHitCostYuan + cacheMissCostYuan + outputCostYuan,
  };
}

/** 按单价（元/百万 tokens）估算成本 */
export function estimateCostYuan(
  summary: UsageSummary,
  priceInPerM: number,
  priceOutPerM: number,
  priceCacheInPerM: number = priceInPerM,
): number {
  return estimateCostBreakdown(summary, priceInPerM, priceOutPerM, priceCacheInPerM).totalCostYuan;
}

/** 会话估算花费是否达到预算（budgetYuan <= 0 视为不限制） */
export function isOverBudget(
  summary: UsageSummary,
  priceInPerM: number,
  priceOutPerM: number,
  budgetYuan: number,
  priceCacheInPerM: number = priceInPerM,
): boolean {
  if (budgetYuan <= 0) return false;
  return estimateCostYuan(summary, priceInPerM, priceOutPerM, priceCacheInPerM) >= budgetYuan;
}

export function formatUsage(
  summary: UsageSummary,
  priceInPerM?: number,
  priceOutPerM?: number,
  priceCacheInPerM?: number,
): string {
  const base =
    `tokens: 输入 ${summary.promptTokens} / 输出 ${summary.completionTokens} / ` +
    `共 ${summary.totalTokens}（${summary.requests} 次请求）`;
  if (priceInPerM === undefined || priceOutPerM === undefined) {
    return base;
  }
  const cost = estimateCostBreakdown(
    summary,
    priceInPerM,
    priceOutPerM,
    priceCacheInPerM ?? priceInPerM,
  );
  let result = `${base}，估算成本 ¥${cost.totalCostYuan.toFixed(4)}`;
  if (summary.cacheHitTokens > 0 && summary.promptTokens > 0) {
    const percent = Math.round((summary.cacheHitTokens / summary.promptTokens) * 100);
    result += `，缓存命中 ${percent}%`;
    result +=
      `（缓存输入 ¥${cost.cacheHitCostYuan.toFixed(4)} / ` +
      `未命中输入 ¥${cost.cacheMissCostYuan.toFixed(4)} / ` +
      `输出 ¥${cost.outputCostYuan.toFixed(4)}）`;
  }
  return result;
}
