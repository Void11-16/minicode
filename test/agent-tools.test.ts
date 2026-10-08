import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import { ChatAgent, TurnAbortedError, type AgentEvent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResponse, ToolDefinition } from "../src/llm/provider.ts";
import type { LLMResult } from "../src/llm/provider.ts";
import type { PromptMessage } from "../src/core/message.ts";

/** 按脚本依次返回预设结果的 Provider，用于测试 Agent 循环 */
class ScriptedProvider implements ChatProvider {
  readonly name = "scripted";
  private calls = 0;
  seenTools: ToolDefinition[] | undefined;
  seenHistories: PromptMessage[][] = [];
  private readonly script: LLMResponse[];

  constructor(script: LLMResult[]) {
    this.script = script;
  }

  async chat(): Promise<string> {
    throw new Error("不应被调用");
  }

  chatWithTools(history: readonly PromptMessage[], tools: readonly ToolDefinition[]): Promise<LLMResult> {
    this.seenHistories.push([...history]);
    if (this.calls === 0) this.seenTools = [...tools];
    const result = this.script[this.calls];
    this.calls += 1;
    if (result === undefined) throw new Error("脚本耗尽");
    return Promise.resolve(result);
  }
}

function echoTool() {
  return {
    name: "echo",
    description: "测试用回显工具",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args: Record<string, unknown>) => `回显: ${String(args.text)}`,
  };
}

/** 永远请求工具调用的 Provider；chat（收尾请求）返回预设总结 */
class EndlessToolProvider implements ChatProvider {
  readonly name = "endless";
  readonly chatHistories: PromptMessage[][] = [];
  private readonly wrapUpReply: string;
  private toolCalls = 0;

  constructor(wrapUpReply: string) {
    this.wrapUpReply = wrapUpReply;
  }

  async chat(history: readonly PromptMessage[]): Promise<string> {
    this.chatHistories.push([...history]);
    return this.wrapUpReply;
  }

  async chatWithTools(): Promise<LLMResult> {
    this.toolCalls += 1;
    return { type: "tool_calls", toolCalls: [{ id: `c${this.toolCalls}`, name: "echo", arguments: "{}" }] };
  }
}

test("Agent 工具循环: 调用工具 → 结果回传 → 最终回答", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "echo", arguments: '{"text":"你好"}' }] },
    { type: "text", content: "工具说：你好" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  const events: AgentEvent[] = [];
  const reply = await agent.run("测试", { onEvent: (e) => events.push(e) });

  assert.equal(reply, "工具说：你好");
  assert.equal(agent.history.length, 4); // user, assistant(toolCalls), tool, assistant
  assert.deepEqual(
    agent.history.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(agent.history[1].toolCalls?.[0].name, "echo");
  assert.equal(agent.history[2].toolCallId, "call_1");
  assert.equal(agent.history[2].content, "回显: 你好");

  // 工具定义传给了 Provider，工具结果出现在第二轮的历史里
  assert.equal(provider.seenTools?.[0].name, "echo");
  assert.match(provider.seenHistories[1][2].content, /回显: 你好/);

  assert.deepEqual(
    events.map((e) => e.type),
    ["tool_start", "tool_end"],
  );
});

test("Agent 安全检查点：用户消息后、工具批次后、最终回答后各触发一次", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "echo", arguments: '{"text":"你好"}' }] },
    { type: "text", content: "完成" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  const snapshots: number[] = [];
  const reply = await agent.run("测试", {
    onCheckpoint: () => {
      snapshots.push(agent.history.length);
    },
  });

  assert.equal(reply, "完成");
  // 落盘时机：仅用户消息 → 工具结果全部回填 → 最终回答入库
  assert.deepEqual(snapshots, [1, 3, 4]);
});

test("Agent 检查点失败不打断对话，后续边界仍会尝试", async () => {
  const provider = new ScriptedProvider([{ type: "text", content: "照常回答" }]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  let calls = 0;
  const reply = await agent.run("测试", {
    onCheckpoint: () => {
      calls += 1;
      throw new Error("磁盘已满");
    },
  });

  assert.equal(reply, "照常回答");
  assert.equal(calls, 2);
});

test("Agent 工具循环: 工具出错时错误回传给模型", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "no_such_tool", arguments: "{}" }] },
    { type: "text", content: "那个工具不可用，我直接回答" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  const events: AgentEvent[] = [];
  const reply = await agent.run("测试", { onEvent: (e) => events.push(e) });

  assert.equal(reply, "那个工具不可用，我直接回答");
  assert.match(agent.history[2].content, /工具执行失败: 工具不存在/);
  assert.equal(events[1].type, "tool_error");
});

test("Agent 工具循环: 超过最大轮数且收尾失败时抛错（兜底路径）", async () => {
  const endless: LLMResponse = { type: "tool_calls", toolCalls: [{ id: "c", name: "echo", arguments: "{}" }] };
  const provider = new ScriptedProvider([endless, endless, endless]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  // ScriptedProvider 的 chat 会抛错 → 收尾请求失败 → 回落到原始错误
  await assert.rejects(() => agent.run("测试", { maxToolRounds: 3 }), /超过 3 轮上限/);
});

test("Agent 工具循环: 打满轮次后自动收尾给出最终回答", async () => {
  const provider = new EndlessToolProvider("收尾总结：整合已获得的数据如下…");
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  const deltas: string[] = [];
  const reply = await agent.run("测试", { maxToolRounds: 2, onTextDelta: (delta) => deltas.push(delta) });

  assert.equal(reply, "收尾总结：整合已获得的数据如下…");
  // 收尾请求的历史以「禁用工具」系统指令结尾
  assert.equal(provider.chatHistories.length, 1);
  const wrapHistory = provider.chatHistories[0];
  assert.equal(wrapHistory[wrapHistory.length - 1].role, "system");
  assert.match(wrapHistory[wrapHistory.length - 1].content, /用尽|禁用/);
  // 收尾回答写入会话，成为最终产出
  assert.equal(agent.history.at(-1)?.content, "收尾总结：整合已获得的数据如下…");
});

test("Agent 工具循环: 剩余轮数不足时注入收尾提醒（不写入会话历史）", async () => {
  const endless: LLMResponse = { type: "tool_calls", toolCalls: [{ id: "c", name: "echo", arguments: "{}" }] };
  const provider = new ScriptedProvider([
    endless,
    endless,
    { type: "text", content: "最终回答" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  // maxToolRounds=5：前 2 轮剩余 ≥3 不提醒；第 3 轮剩余 2 起开始提醒
  const reply = await agent.run("测试", { maxToolRounds: 5 });
  assert.equal(reply, "最终回答");

  const hasHint = (history: PromptMessage[]) => history.some((message) => message.content.includes("轮次提醒"));
  assert.equal(hasHint(provider.seenHistories[0]), false);
  assert.equal(hasHint(provider.seenHistories[1]), false);
  const third = provider.seenHistories[2];
  assert.equal(third.at(-1)?.role, "system");
  assert.match(third.at(-1)?.content ?? "", /轮次提醒|还剩 2 轮/);
  // 提醒是请求级的临时消息，不持久化进会话历史
  assert.equal(agent.history.some((message) => message.content.includes("轮次提醒")), false);
});

test("Agent: 无工具注册表时 supportsTools 为 false 并降级", async () => {
  const provider: ChatProvider = { name: "plain", chat: async () => "纯文本回复" };
  const agent = new ChatAgent(new Session(), provider);
  assert.equal(agent.supportsTools, false);

  const reply = await agent.run("你好");
  assert.equal(reply, "纯文本回复");
});

test("Agent 中断: 工具执行中 abort，下一轮开始前抛 TurnAbortedError", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "slow_tool", arguments: "{}" }] },
    { type: "text", content: "不应到达" },
  ]);
  const registry = new ToolRegistry();
  let agentRef: ChatAgent | undefined;
  registry.register({
    name: "slow_tool",
    description: "执行中触发中断",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      agentRef?.abort(); // 工具执行中用户按下 /stop
      return "工具结果";
    },
  });
  const agent = new ChatAgent(new Session("sess_abort"), provider, registry);
  agentRef = agent;

  await assert.rejects(() => agent.run("测试"), (error: unknown) => {
    assert.ok(error instanceof TurnAbortedError);
    assert.match(error.message, /已中断/);
    return true;
  });

  // 中断前的历史保留（用户消息 + 工具调用请求 + 工具结果），但没有最终回复
  assert.deepEqual(
    agent.history.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.ok(!agent.history.some((m) => m.content === "不应到达"));
});

test("Agent 中断: abort 后可以正常开始新一轮", async () => {
  const provider = new ScriptedProvider([
    { type: "text", content: "新一轮回复" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session("sess_abort2"), provider, registry);

  // 上一轮被中断后（无残留 controller），新轮次正常执行
  const reply = await agent.run("新问题");
  assert.equal(reply, "新一轮回复");
});

test("Agent 权限: 需确认工具被拒绝时不执行，拒绝原因回传模型", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "write_file", arguments: '{"path":"x.md"}' }] },
    { type: "text", content: "好的，那我不写文件了" },
  ]);
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "write_file",
    description: "测试",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executed = true;
      return "written";
    },
    requiresConfirmation: true,
    confirmationMessage: (args) => `写入文件 ${String(args.path)}`,
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  const events: AgentEvent[] = [];
  const permissionRequests: Array<{ tool: string; message: string }> = [];
  const reply = await agent.run("写个文件", {
    onEvent: (e) => events.push(e),
    onPermission: async (request) => {
      permissionRequests.push({ tool: request.tool, message: request.message });
      return false;
    },
  });

  assert.equal(reply, "好的，那我不写文件了");
  assert.equal(executed, false, "被拒绝的工具不应执行");
  assert.deepEqual(permissionRequests, [{ tool: "write_file", message: "写入文件 x.md" }]);
  assert.match(agent.history[2].content, /用户拒绝授权/);
  assert.ok(events.some((e) => e.type === "tool_denied"));
});

test("Agent 权限: 用户同意后正常执行", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "write_file", arguments: '{"path":"x.md"}' }] },
    { type: "text", content: "已写入" },
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "测试",
    parameters: { type: "object", properties: {} },
    execute: async () => "written",
    requiresConfirmation: true,
    confirmationMessage: (args) => `写入文件 ${String(args.path)}`,
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  const reply = await agent.run("写个文件", {
    onPermission: async () => true,
  });

  assert.equal(reply, "已写入");
  assert.match(agent.history[2].content, /written/);
});

test("Agent 权限: 无回调时（非交互场景）默认放行", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "write_file", arguments: "{}" }] },
    { type: "text", content: "完成" },
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "测试",
    parameters: { type: "object", properties: {} },
    execute: async () => "written",
    requiresConfirmation: true,
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  const reply = await agent.run("写个文件");
  assert.equal(reply, "完成");
});

test("Agent 权限: 无需确认的工具不触发权限回调", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_1", name: "echo", arguments: "{}" }] },
    { type: "text", content: "done" },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  let asked = 0;
  await agent.run("测试", { onPermission: async () => { asked += 1; return true; } });
  assert.equal(asked, 0);
});

test("Agent 累计多轮请求的 token 用量", async () => {
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }], usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
    { type: "text", content: "ok", usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 } },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  await agent.run("测试");
  assert.deepEqual(agent.session.usage, {
    promptTokens: 250,
    completionTokens: 50,
    totalTokens: 300,
    requests: 2,
    cacheHitTokens: 0,
  });
});
