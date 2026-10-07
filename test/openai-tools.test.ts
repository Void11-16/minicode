import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatProvider } from "../src/llm/openai.ts";
import { createMessage } from "../src/core/message.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test("chatWithTools: 发送 tools 参数并解析 tool_calls 响应", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_abc",
            function: { name: "get_weather", arguments: '{"location":"杭州"}' },
          }],
        },
      }],
    });
  }) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-t", model: "deepseek-chat", fetchFn });
  const result = await provider.chatWithTools([createMessage("user", "杭州天气")], [
    { name: "get_weather", description: "查天气", parameters: { type: "object", properties: {} } },
  ]);

  assert.equal(result.type, "tool_calls");
  if (result.type === "tool_calls") {
    assert.equal(result.toolCalls[0].name, "get_weather");
    assert.equal(result.toolCalls[0].arguments, '{"location":"杭州"}');
  }
  assert.deepEqual(requests[0], {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "杭州天气" }],
    tools: [{
      type: "function",
      function: { name: "get_weather", description: "查天气", parameters: { type: "object", properties: {} } },
    }],
    tool_choice: "auto",
  });
});

test("chatWithTools: 历史中的 tool 消息正确序列化", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return jsonResponse({ choices: [{ message: { content: "好的" } }] });
  }) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-t", model: "deepseek-chat", fetchFn });
  await provider.chatWithTools(
    [
      createMessage("user", "杭州天气"),
      createMessage("assistant", "", { toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }] }),
      createMessage("tool", "晴 25°C", { toolCallId: "call_1", toolName: "get_weather" }),
    ],
    [],
  );

  const body = requests[0];
  const messages = body.messages as Array<Record<string, unknown>>;
  const assistantMessage = messages[1] as { tool_calls: Array<{ id: string }> };
  assert.equal(assistantMessage.tool_calls[0].id, "call_1");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].tool_call_id, "call_1");
  assert.equal(messages[2].content, "晴 25°C");
  assert.equal(body.tools, undefined); // 空工具列表不发送 tools 字段
});

test("chatStreamWithTools: 流式 tool_calls 分片累积", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return sseResponse([
      // 第一个工具调用：首片（id+name）→ 参数分片 ×2
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"杭州\\"}"}}]}}]}\n\n',
      // 第二个工具调用：一次性完整
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"geocode","arguments":"{}"}}]}}]}\n\n',
      // 末尾 usage chunk
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n',
      "data: [DONE]\n\n",
    ]);
  }) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-t", model: "deepseek-chat", fetchFn });
  const deltas: string[] = [];
  const result = await provider.chatStreamWithTools!(
    [createMessage("user", "查杭州天气")],
    [{ name: "get_weather", description: "查天气", parameters: { type: "object", properties: {} } }],
    (delta) => deltas.push(delta),
  );

  assert.equal(result.type, "tool_calls");
  if (result.type === "tool_calls") {
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "get_weather", arguments: '{"location":"杭州"}' },
      { id: "call_2", name: "geocode", arguments: "{}" },
    ]);
  }
  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    promptCacheHitTokens: undefined,
    promptCacheMissTokens: undefined,
  });
  assert.deepEqual(deltas, [], "工具调用轮不应有文本增量");

  // 流式请求体包含 stream + include_usage
  assert.equal(requests[0].stream, true);
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
});

test("chatStreamWithTools: 流式文本回答逐字回调", async () => {
  const fetchFn = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"今天"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"晴。"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      "data: [DONE]\n\n",
    ])) as typeof fetch;

  const provider = new OpenAICompatProvider({ apiKey: "sk-t", model: "deepseek-chat", fetchFn });
  const deltas: string[] = [];
  const result = await provider.chatStreamWithTools!([createMessage("user", "hi")], [], (d) => deltas.push(d));

  assert.equal(result.type, "text");
  if (result.type === "text") {
    assert.equal(result.content, "今天晴。");
  }
  assert.deepEqual(deltas, ["今天", "晴。"]);
});
