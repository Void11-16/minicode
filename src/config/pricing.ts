import type { AppConfig } from "./config.ts";
import type { ModelProfile } from "./models.ts";

export interface ModelPricing {
  readonly inputPerM: number;
  readonly cacheInputPerM: number;
  readonly outputPerM: number;
  /** 是否显式配置了缓存价；false 时按未命中输入价保守估算 */
  readonly hasCachePrice: boolean;
}

export const DEFAULT_PRICE_IN = 2;
export const DEFAULT_PRICE_OUT = 3;

/** 模型 profile 优先，未配置的字段回退全局配置 */
export function resolvePricing(
  config: AppConfig,
  profile?: ModelProfile,
): ModelPricing {
  const inputPerM =
    priceValue(profile?.priceIn) ??
    priceValue(config.priceIn) ??
    DEFAULT_PRICE_IN;
  const outputPerM =
    priceValue(profile?.priceOut) ??
    priceValue(config.priceOut) ??
    DEFAULT_PRICE_OUT;
  const cachePrice =
    priceValue(profile?.priceCacheIn) ??
    priceValue(config.priceCacheIn);
  return {
    inputPerM,
    cacheInputPerM: cachePrice ?? inputPerM,
    outputPerM,
    hasCachePrice: cachePrice !== undefined,
  };
}

function priceValue(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
