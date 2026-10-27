import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type AppConfig } from "../src/config/config.ts";
import { resolvePricing } from "../src/config/pricing.ts";
import type { ModelProfile } from "../src/config/models.ts";
import {
  estimateCostBreakdown,
  estimateCostYuan,
  formatUsage,
} from "../src/core/usage.ts";

const usage = {
  promptTokens: 1_000_000,
  completionTokens: 400_000,
  totalTokens: 1_400_000,
  requests: 2,
  cacheHitTokens: 800_000,
};

test("缓存命中 token 使用缓存输入单价，未命中 token 使用普通输入单价", () => {
  const breakdown = estimateCostBreakdown(usage, 2, 3, 0.5);

  assert.deepEqual(breakdown, {
    cacheHitTokens: 800_000,
    cacheMissTokens: 200_000,
    outputTokens: 400_000,
    cacheHitCostYuan: 0.4,
    cacheMissCostYuan: 0.4,
    outputCostYuan: 1.2,
    totalCostYuan: 2,
  });
  assert.equal(estimateCostYuan(usage, 2, 3, 0.5), 2);
  assert.match(formatUsage(usage, 2, 3, 0.5), /缓存输入 ¥0\.4000/);
});

test("未配置缓存单价时按普通输入价保守估算，缓存命中数不会超过输入数", () => {
  const overreported = { ...usage, cacheHitTokens: 2_000_000 };
  const breakdown = estimateCostBreakdown(overreported, 2, 3);

  assert.equal(breakdown.cacheHitTokens, 1_000_000);
  assert.equal(breakdown.cacheMissTokens, 0);
  assert.equal(breakdown.cacheHitCostYuan, 2);
  assert.equal(breakdown.totalCostYuan, 3.2);
});

test("profile 只覆盖显式配置的价格字段，空缓存价回退全局缓存价", () => {
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    priceIn: "2",
    priceCacheIn: "0.5",
    priceOut: "3",
  };
  const profile: ModelProfile = {
    id: "cheap-cache",
    name: "Cheap Cache",
    provider: "openai",
    priceIn: "4",
    priceCacheIn: "",
    priceOut: "5",
  };

  assert.deepEqual(resolvePricing(config, profile), {
    inputPerM: 4,
    cacheInputPerM: 0.5,
    outputPerM: 5,
    hasCachePrice: true,
  });
  assert.deepEqual(resolvePricing(config, {
    ...profile,
    priceCacheIn: "0.25",
  }), {
    inputPerM: 4,
    cacheInputPerM: 0.25,
    outputPerM: 5,
    hasCachePrice: true,
  });
  assert.deepEqual(resolvePricing(DEFAULT_CONFIG), {
    inputPerM: 2,
    cacheInputPerM: 2,
    outputPerM: 3,
    hasCachePrice: false,
  });
});
