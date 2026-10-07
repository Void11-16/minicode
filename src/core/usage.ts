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

/** 按单价（元/百万 tokens）估算成本 */
export function estimateCostYuan(
  summary: UsageSummary,
  priceInPerM: number,
  priceOutPerM: number,
): number {
  return (summary.promptTokens * priceInPerM + summary.completionTokens * priceOutPerM) / 1_000_000;
}

/** 会话估算花费是否达到预算（budgetYuan <= 0 视为不限制） */
export function isOverBudget(
  summary: UsageSummary,
  priceInPerM: number,
  priceOutPerM: number,
  budgetYuan: number,
): boolean {
  if (budgetYuan <= 0) return false;
  return estimateCostYuan(summary, priceInPerM, priceOutPerM) >= budgetYuan;
}

export function formatUsage(
  summary: UsageSummary,
  priceInPerM?: number,
  priceOutPerM?: number,
): string {
  const base =
    `tokens: 输入 ${summary.promptTokens} / 输出 ${summary.completionTokens} / ` +
    `共 ${summary.totalTokens}（${summary.requests} 次请求）`;
  if (priceInPerM === undefined || priceOutPerM === undefined) {
    return base;
  }
  const cost = estimateCostYuan(summary, priceInPerM, priceOutPerM);
  let result = `${base}，估算成本 ¥${cost.toFixed(4)}`;
  if (summary.cacheHitTokens > 0 && summary.promptTokens > 0) {
    const percent = Math.round((summary.cacheHitTokens / summary.promptTokens) * 100);
    result += `，缓存命中 ${percent}%`;
  }
  return result;
}
