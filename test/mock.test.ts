import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../src/llm/mock.ts";
import { createMessage } from "../src/core/message.ts";

test("MockProvider 回复最后一条用户消息", async () => {
  const provider = new MockProvider();
  const history = [createMessage("user", "hello")];

  const reply = await provider.chat(history);

  assert.ok(reply.includes("hello"));
});
