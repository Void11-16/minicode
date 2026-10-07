import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/factory.ts";
import { MockProvider } from "../src/llm/mock.ts";

test("DEEPSEEK_API_KEY 优先选择 DeepSeek Provider", () => {
  const provider = createProvider({
    env: { DEEPSEEK_API_KEY: "sk-ds-test", LLM_API_KEY: "sk-other" },
  });
  assert.equal(provider.name, "deepseek:deepseek-chat");
});

test("DS_API_KEY / DEEPSEEK_MODEL 同样生效", () => {
  const provider = createProvider({
    env: { DS_API_KEY: "sk-ds-test", DEEPSEEK_MODEL: "deepseek-reasoner" },
  });
  assert.equal(provider.name, "deepseek:deepseek-reasoner");
});

test("无 DeepSeek Key 时回退到 OpenAI 兼容 Provider", () => {
  const provider = createProvider({
    env: { LLM_API_KEY: "sk-test", LLM_MODEL: "gpt-4o-mini" },
  });
  assert.equal(provider.name, "openai:gpt-4o-mini");
});

test("没有任何 Key 时使用 Mock", () => {
  const provider = createProvider({ env: {} });
  assert.ok(provider instanceof MockProvider);
});
