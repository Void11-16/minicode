import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekProvider, DEEPSEEK_BASE_URL } from "../src/llm/deepseek.ts";
import { createMessage } from "../src/core/message.ts";

test("DeepSeekProvider 请求正确的 URL 与请求体", async () => {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: init?.headers ? new Headers(init.headers).get("Authorization") : null,
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ds 回复" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const provider = new DeepSeekProvider({ apiKey: "sk-ds-test", fetchFn });
  const reply = await provider.chat([createMessage("user", "你好")]);

  assert.equal(reply, "ds 回复");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEEPSEEK_BASE_URL}/chat/completions`);
  assert.equal(calls[0].auth, "Bearer sk-ds-test");
  assert.deepEqual(calls[0].body, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "你好" }],
  });
});
