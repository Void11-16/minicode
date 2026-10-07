import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatProvider } from "../src/llm/openai.ts";
import { MockProvider } from "../src/llm/mock.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { createMessage, type Message } from "../src/core/message.ts";
import type { ChatProvider } from "../src/llm/provider.ts";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

test("OpenAICompatProvider 流式解析 SSE 增量", async () => {
  const deltas: string[] = [];

  const fetchFn = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"！"}}]}\n',
      "data: [DONE]\n\n",
    ])) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-test", model: "deepseek-chat", fetchFn });
  const reply = await provider.chatStream!([createMessage("user", "hi")], (d) => deltas.push(d));
  assert.equal(reply, "你好！");
  assert.deepEqual(deltas, ["你", "好", "！"]);
});

test("SSE 分块边界不完整时正确拼接", async () => {
  const deltas: string[] = [];

  // 一条 data 行被拆到两个网络 chunk 里
  const fetchFn = (async () =>
    sseResponse([
      'data: {"choices":[{"del',
      'ta":{"content":"OK"}}]}\n\n',
      "data: [DONE]\n\n",
    ])) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-test", model: "deepseek-chat", fetchFn });
  const reply = await provider.chatStream!([createMessage("user", "hi")], (d) => deltas.push(d));
  assert.equal(reply, "OK");
  assert.deepEqual(deltas, ["OK"]);
});

test("流式响应为空时抛错", async () => {
  const fetchFn = (async () => sseResponse(["data: [DONE]\n\n"])) as typeof fetch;
  const provider = new OpenAICompatProvider({ apiKey: "sk-test", model: "deepseek-chat", fetchFn });

  await assert.rejects(
    () => provider.chatStream!([createMessage("user", "hi")], () => {}),
    /返回内容为空/,
  );
});

test("MockProvider 流式按块回调且完整返回", async () => {
  const provider = new MockProvider("0123456789abcdefghij");
  const deltas: string[] = [];

  const reply = await provider.chatStream!([createMessage("user", "hi")], (d) => deltas.push(d));

  assert.equal(reply, "0123456789abcdefghij\n(收到的用户消息: hi)");
  assert.ok(deltas.length > 1, "应该分多块");
  assert.equal(deltas.join(""), reply);
});

test("Agent.sendStream 对不支持流式的 Provider 自动降级", async () => {
  const nonStreaming: ChatProvider = {
    name: "legacy",
    async chat(_history: readonly Message[]): Promise<string> {
      return "一次性回复";
    },
  };

  const agent = new ChatAgent(new Session(), nonStreaming);
  const deltas: string[] = [];
  const reply = await agent.sendStream("你好", (d) => deltas.push(d));

  assert.equal(reply, "一次性回复");
  assert.deepEqual(deltas, ["一次性回复"]);
  assert.equal(agent.history.length, 2);
});

test("Agent.sendStream 保存完整回复到历史", async () => {
  const agent = new ChatAgent(new Session(), new MockProvider("流式回复测试"));
  await agent.sendStream("问题", () => {});

  assert.equal(agent.history[1].content, "流式回复测试\n(收到的用户消息: 问题)");
});
