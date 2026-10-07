import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/llm/mock.ts";
import { ChatAgent } from "../src/agent/agent.ts";

test("Agent 完整对话链路：user -> provider -> assistant", async () => {
  const agent = new ChatAgent(new Session(), new MockProvider("测试回复"));

  const reply = await agent.send("第一轮");

  assert.equal(reply, "测试回复\n(收到的用户消息: 第一轮)");
  assert.equal(agent.history.length, 2);
  assert.equal(agent.history[0].role, "user");
  assert.equal(agent.history[1].role, "assistant");
});

test("Agent 拒绝空输入", async () => {
  const agent = new ChatAgent(new Session(), new MockProvider());
  await assert.rejects(() => agent.send("   "), /输入不能为空/);
  assert.equal(agent.history.length, 0);
});

test("多轮对话历史保持完整", async () => {
  const agent = new ChatAgent(new Session(), new MockProvider("ok"));
  await agent.send("第一轮");
  await agent.send("第二轮");

  assert.equal(agent.history.length, 4);
  assert.deepEqual(
    agent.history.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});
