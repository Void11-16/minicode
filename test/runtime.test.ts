import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRuntime, STEERED_NOTE } from "../src/runtime/runtime.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent, type AgentEvent, type PermissionRequest } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResult, ToolDefinition } from "../src/llm/provider.ts";
import type { PromptMessage } from "../src/core/message.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await delay(10);
  }
}

/** 手动控制每轮 LLM 响应的 Provider，用于精确测试运行时行为 */
class ManualProvider implements ChatProvider {
  readonly name = "manual";
  readonly pending: Array<{ history: PromptMessage[]; resolve: (result: LLMResult) => void }> = [];
  readonly completed: PromptMessage[][] = [];

  async chat(): Promise<string> {
    throw new Error("不应被调用");
  }

  chatWithTools(history: readonly PromptMessage[], _tools: readonly ToolDefinition[], signal?: AbortSignal): Promise<LLMResult> {
    const snapshot = [...history];
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      this.pending.push({ history: snapshot, resolve });
    });
  }

  /** 手动完成第 n 次（从 0 开始）LLM 调用 */
  complete(index: number, result: LLMResult): void {
    const call = this.pending[index];
    if (call === undefined) throw new Error(`没有第 ${index} 次调用`);
    this.completed.push(call.history);
    call.resolve(result);
  }
}

function echoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: {} },
    execute: async (args) => `回显: ${String(args.text ?? "")}`,
  });
  return registry;
}

function makeRuntime(
  provider: ChatProvider,
  events: AgentEvent[] = [],
  permissions: PermissionRequest[] = [],
) {
  const runtime = new AgentRuntime({
    summarize: async () => "摘要",
    maxToolRounds: 5,
    onEvent: (_id, event) => events.push(event),
    onPermission: async (_id, request) => {
      permissions.push(request);
      return true;
    },
  });
  return runtime;
}

test("steer: 消息注入执行中的轮次，模型下一轮可见", async () => {
  const provider = new ManualProvider();
  const session = new Session("sess_steer");
  const runtime = makeRuntime(provider);
  runtime.registerAgent("sess_steer", new ChatAgent(session, provider, echoRegistry()));

  const turn = runtime.send("sess_steer", "第一问", "queue");
  await waitFor(() => provider.pending.length === 1);

  // 第一轮 LLM 调用进行中 → steer 注入
  assert.equal(runtime.hasActiveTurn("sess_steer"), true);
  const note = await runtime.send("sess_steer", "中途换个方向", "steer");
  assert.equal(note, STEERED_NOTE);

  // 第一轮返回工具调用
  provider.complete(0, {
    type: "tool_calls",
    toolCalls: [{ id: "call_1", name: "echo", arguments: '{"text":"hi"}' }],
  });
  await waitFor(() => provider.pending.length === 2);

  // 第二轮的历史应包含注入的 steer 消息（在 tool 结果之后）
  const secondHistory = provider.pending[1].history;
  const steeredMessage = secondHistory.find((m) => m.role === "user" && m.content === "中途换个方向");
  assert.ok(steeredMessage !== undefined, "steer 消息应出现在第二轮历史");
  const toolMessageIndex = secondHistory.findIndex((m) => m.role === "tool");
  assert.ok(secondHistory.indexOf(steeredMessage) > toolMessageIndex, "steer 应在工具结果之后追加");

  provider.complete(1, { type: "text", content: "收到新指示" });
  assert.equal(await turn, "收到新指示");
});

test("steer 到达太晚（模型已给最终回复）→ 自动转为下一轮", async () => {
  const provider = new ManualProvider();
  const session = new Session("sess_late");
  const runtime = makeRuntime(provider);
  runtime.registerAgent("sess_late", new ChatAgent(session, provider, echoRegistry()));

  const turn = runtime.send("sess_late", "第一问", "queue");
  await waitFor(() => provider.pending.length === 1);

  await runtime.send("sess_late", "迟到的消息", "steer");
  // 直接给出最终回复 → 本轮结束
  provider.complete(0, { type: "text", content: "第一轮答复" });
  assert.equal(await turn, "第一轮答复");

  // 残留 steer 应自动作为下一轮开始
  await waitFor(() => provider.pending.length === 2);
  assert.ok(
    provider.pending[1].history.some((m) => m.role === "user" && m.content === "迟到的消息"),
    "迟到的 steer 应转为下一轮输入",
  );
  provider.complete(1, { type: "text", content: "补答" });
  await delay(30);
});

test("queue: 执行中的轮次完成后才运行排队的消息", async () => {
  const provider = new ManualProvider();
  const session = new Session("sess_queue");
  const runtime = makeRuntime(provider);
  runtime.registerAgent("sess_queue", new ChatAgent(session, provider, echoRegistry()));

  const first = runtime.send("sess_queue", "第一问", "queue");
  await waitFor(() => provider.pending.length === 1);

  const second = runtime.send("sess_queue", "/queue 第二问", "queue");
  await delay(30);
  assert.equal(provider.pending.length, 1, "排队消息不应立即执行");

  provider.complete(0, { type: "text", content: "第一答" });
  assert.equal(await first, "第一答");

  await waitFor(() => provider.pending.length === 2);
  provider.complete(1, { type: "text", content: "第二答" });
  assert.equal(await second, "第二答");
});

test("steer 在空闲时等同于 queue", async () => {
  const provider = new ManualProvider();
  const runtime = makeRuntime(provider);
  runtime.registerAgent("sess_idle", new ChatAgent(new Session("sess_idle"), provider, echoRegistry()));

  const turn = runtime.send("sess_idle", "你好", "steer");
  await waitFor(() => provider.pending.length === 1);
  provider.complete(0, { type: "text", content: "答复" });
  assert.equal(await turn, "答复");
});

test("不同 session 并发执行且历史互相隔离", async () => {
  const providerA = new ManualProvider();
  const providerB = new ManualProvider();
  const runtime = makeRuntime(providerA);
  runtime.registerAgent("sess_a", new ChatAgent(new Session("sess_a"), providerA, echoRegistry()));
  runtime.registerAgent("sess_b", new ChatAgent(new Session("sess_b"), providerB, echoRegistry()));

  const turnA = runtime.send("sess_a", "A 的问题", "queue");
  const turnB = runtime.send("sess_b", "B 的问题", "queue");

  // 两个 session 的第一轮同时挂起（并发），互不等待
  await waitFor(() => providerA.pending.length === 1 && providerB.pending.length === 1);

  providerB.complete(0, { type: "text", content: "B 答复" });
  assert.equal(await turnB, "B 答复");

  providerA.complete(0, { type: "text", content: "A 答复" });
  assert.equal(await turnA, "A 答复");

  // 历史隔离：A 的会话里只有 A 的消息
  const agentA = runtime.getAgent("sess_a")!;
  const agentB = runtime.getAgent("sess_b")!;
  assert.deepEqual(
    agentA.history.map((m) => m.content),
    ["A 的问题", "A 答复"],
  );
  assert.deepEqual(
    agentB.history.map((m) => m.content),
    ["B 的问题", "B 答复"],
  );
});

test("同一 session 多条消息合并串行执行，顺序稳定", async () => {
  const provider = new ManualProvider();
  const runtime = makeRuntime(provider);
  runtime.registerAgent("sess_serial", new ChatAgent(new Session("sess_serial"), provider, echoRegistry()));

  const t1 = runtime.send("sess_serial", "消息1", "queue");
  const t2 = runtime.send("sess_serial", "消息2", "queue");
  const t3 = runtime.send("sess_serial", "消息3", "queue");

  await waitFor(() => provider.pending.length === 1);
  provider.complete(0, { type: "text", content: "答1" });
  await waitFor(() => provider.pending.length === 2);
  provider.complete(1, { type: "text", content: "答2" });
  await waitFor(() => provider.pending.length === 3);
  provider.complete(2, { type: "text", content: "答3" });

  assert.deepEqual(await Promise.all([t1, t2, t3]), ["答1", "答2", "答3"]);

  const agent = runtime.getAgent("sess_serial")!;
  assert.deepEqual(
    agent.history.map((m) => m.content),
    ["消息1", "答1", "消息2", "答2", "消息3", "答3"],
  );
});

test("/stop 中断: 挂起的 LLM 请求被中止，回调触发且 steer 残留被丢弃", async () => {
  const provider = new ManualProvider();
  const abortedSessions: string[] = [];
  const runtime = new AgentRuntime({
    summarize: async () => "摘要",
    onTurnAborted: (sessionId) => abortedSessions.push(sessionId),
  });
  runtime.registerAgent("sess_stop", new ChatAgent(new Session("sess_stop"), provider, echoRegistry()));

  const turn = runtime.send("sess_stop", "慢问题", "queue");
  await waitFor(() => provider.pending.length === 1);

  // 注入一条 steer 后立即中断
  await runtime.send("sess_stop", "中途插话", "steer");
  assert.equal(runtime.abortActiveTurn("sess_stop"), true);

  await assert.rejects(() => turn);
  await delay(50);

  assert.deepEqual(abortedSessions, ["sess_stop"]);
  // steer 残留被丢弃：没有自动开启下一轮
  assert.equal(provider.pending.length, 1, "中断后不应自动开始下一轮");

  // 没有活动轮次时 abort 返回 false
  assert.equal(runtime.abortActiveTurn("sess_stop"), false);
});
