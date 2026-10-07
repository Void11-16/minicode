import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import { estimateCostYuan, formatUsage, isOverBudget } from "../src/core/usage.ts";
import { OpenAICompatProvider } from "../src/llm/openai.ts";
import { createMessage } from "../src/core/message.ts";

test("Session 累计 token 用量并随会话持久化", () => {
  const session = new Session("sess_usage");
  session.addUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  session.addUsage({ promptTokens: 200, completionTokens: 80, totalTokens: 280 });

  assert.deepEqual(session.usage, {
    promptTokens: 300,
    completionTokens: 130,
    totalTokens: 430,
    requests: 2,
    cacheHitTokens: 0,
  });

  const restored = Session.fromData(session.toData());
  assert.deepEqual(restored.usage, session.usage);
});

test("旧格式会话数据（无 usage 字段）兼容", () => {
  const restored = Session.fromData({ id: "old", messages: [] });
  assert.equal(restored.usage.requests, 0);
});

test("成本估算与格式化", () => {
  const summary = { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000, requests: 10, cacheHitTokens: 0 };
  // 输入 1M × ¥2 + 输出 0.5M × ¥3 = ¥3.5
  assert.equal(estimateCostYuan(summary, 2, 3), 3.5);
  assert.match(
    formatUsage(summary, 2, 3),
    /输入 1000000 \/ 输出 500000 \/ 共 1500000（10 次请求），估算成本 ¥3\.5000/,
  );
  assert.match(formatUsage(summary), /tokens: 输入 1000000/);
});

test("OpenAI 兼容 Provider 解析响应中的 usage", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "好的" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-t", model: "deepseek-chat", fetchFn });
  const result = await provider.chatWithTools!([createMessage("user", "hi")], []);
  assert.deepEqual(result.usage, {
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 40,
  });
});

test("缓存命中 token 累计并显示百分比", () => {
  const session = new Session("sess_cache");
  session.addUsage({ promptTokens: 1000, completionTokens: 100, totalTokens: 1100, promptCacheHitTokens: 700 });
  session.addUsage({ promptTokens: 500, completionTokens: 50, totalTokens: 550 });

  assert.equal(session.usage.cacheHitTokens, 700);
  assert.equal(session.usage.promptTokens, 1500);
  assert.match(formatUsage(session.usage, 2, 3), /缓存命中 47%/);
});

test("isOverBudget: 预算判断", () => {
  const summary = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, requests: 1, cacheHitTokens: 0 };
  // 1M 输入 × ¥2/M = ¥2 成本
  assert.equal(isOverBudget(summary, 2, 3, 0), false, "预算 0 = 不限制");
  assert.equal(isOverBudget(summary, 2, 3, 1), true, "¥2 成本 ≥ ¥1 预算");
  assert.equal(isOverBudget(summary, 2, 3, 2), true, "刚好达到也算超");
  assert.equal(isOverBudget(summary, 2, 3, 5), false, "未达预算");
});
