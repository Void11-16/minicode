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
  seenToolsHistories: ToolDefinition[][] = [];
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
    this.seenToolsHistories.push([...tools]);
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
  toolCalls = 0;

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

class RepeatedFailureProvider implements ChatProvider {
  readonly name = "repeated-failure";
  readonly chatWithToolsHistories: PromptMessage[][] = [];
  readonly finalChatHistories: PromptMessage[][] = [];
  toolCalls = 0;

  async chat(history: readonly PromptMessage[]): Promise<string> {
    this.finalChatHistories.push([...history]);
    return "连续失败已熔断，当前行程尚未完成。";
  }

  async chatWithTools(history: readonly PromptMessage[]): Promise<LLMResult> {
    this.chatWithToolsHistories.push([...history]);
    this.toolCalls += 1;
    return {
      type: "tool_calls",
      toolCalls: [{ id: `failure-${this.toolCalls}`, name: "always_fail", arguments: "{}" }],
    };
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
  assert.match(agent.history[2].content, /^\[tool-result type=generic chars=6\]\n/);
  assert.match(agent.history[2].content, /回显: 你好/);

  // 工具定义传给了 Provider，工具结果出现在第二轮的历史里
  assert.equal(provider.seenTools?.[0].name, "echo");
  assert.match(provider.seenHistories[1][2].content, /回显: 你好/);

  assert.deepEqual(
    events.map((e) => e.type),
    ["tool_start", "tool_end"],
  );
});

test("Agent: 同一用户请求只保存一次需求单，换标题重试会被拦下", async () => {
  const provider = new ScriptedProvider([
    {
      type: "tool_calls",
      toolCalls: [{
        id: "brief-1",
        name: "save_travel_brief",
        arguments: '{"title":"北京三日游","destination":"北京"}',
      }],
    },
    {
      type: "tool_calls",
      toolCalls: [{
        id: "brief-2",
        name: "save_travel_brief",
        arguments: '{"title":"北京三日历史之旅","destination":"北京"}',
      }],
    },
    { type: "text", content: "继续生成行程" },
  ]);
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "save_travel_brief",
    description: "测试需求单",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executions += 1;
      return "需求单已保存";
    },
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  assert.equal(await agent.run("去北京玩三天", { maxToolRounds: 3 }), "继续生成行程");
  assert.equal(executions, 1);
  assert.equal(agent.history.find((message) => message.toolCallId === "brief-2")?.content.includes("重复保存已忽略"), true);
});

test("Agent: 落盘提醒保留检索能力，不再把必要证据请求封锁成循环", async () => {
  const search = (round: number): LLMResult => ({
    type: "tool_calls",
    toolCalls: [{
      id: `search-${round}`,
      name: "search_attractions",
      arguments: JSON.stringify({ city: "北京", query: `候选-${round}` }),
    }],
  });
  const provider = new ScriptedProvider([
    {
      type: "tool_calls",
      toolCalls: [{
        id: "brief",
        name: "save_travel_brief",
        arguments: '{"title":"北京三日游","destination":"北京","pace":"适中"}',
      }],
    },
    ...[1, 2, 3, 4, 5, 6, 7].map(search),
    search(8),
    {
      type: "tool_calls",
      toolCalls: [{
        id: "save-day-1",
        name: "save_itinerary",
        arguments: JSON.stringify({
          title: "北京三日游",
          days: [{
            date: "2026-10-27",
            items: [{
              name: "故宫",
              type: "visit",
              location: { latitude: 39.9163, longitude: 116.3972 },
            }],
          }],
        }),
      }],
    },
    { type: "text", content: "第 1 天已保存，继续完善。" },
  ]);
  const registry = new ToolRegistry();
  let searchExecutions = 0;
  let itineraryExecutions = 0;
  registry.register({
    name: "save_travel_brief",
    description: "保存需求",
    parameters: { type: "object", properties: {} },
    alwaysActive: true,
    execute: async () => "需求单已保存",
  });
  registry.register({
    name: "search_attractions",
    description: "搜索景点",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      searchExecutions += 1;
      return "找到一批景点";
    },
  });
  registry.register({
    name: "save_itinerary",
    description: "保存行程",
    parameters: { type: "object", properties: {} },
    alwaysActive: true,
    execute: async () => {
      itineraryExecutions += 1;
      return "行程已保存";
    },
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  assert.equal(
    await agent.run("规划北京三日游", { maxToolRounds: 11 }),
    "第 1 天已保存，继续完善。",
  );
  assert.equal(searchExecutions, 8, "第 8 次必要检索仍可执行");
  assert.equal(itineraryExecutions, 1);

  assert.ok(provider.seenToolsHistories[8].some((tool) => tool.name === "search_attractions"));
  assert.equal(agent.history.find((message) => message.toolCallId === "search-8")?.content.includes("资料检索已暂停"), false);

});

test("Agent 保留最近一轮完整工具参数，旧轮次压缩后仍能读取并继续修改", async () => {
  const hugeArguments = JSON.stringify({
    title: "北京五日游",
    days: [{ date: "2026-10-22", items: [{ name: "故宫", note: "详情".repeat(4000) }] }],
  });
  const provider = new ScriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "call_save", name: "save_itinerary", arguments: hugeArguments }] },
    { type: "tool_calls", toolCalls: [{ id: "call_load", name: "load_itinerary", arguments: '{"title":"北京五日游"}' }] },
    { type: "text", content: "已继续修改" },
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "save_itinerary",
    description: "保存测试行程",
    parameters: { type: "object", properties: {} },
    execute: async () => "已保存「北京五日游」",
  });
  registry.register({
    name: "load_itinerary",
    description: "读取测试行程",
    parameters: { type: "object", properties: {} },
    execute: async () => "当前行程：北京五日游",
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  assert.equal(await agent.run("规划北京五日游", { maxToolRounds: 3 }), "已继续修改");

  const secondRequest = provider.seenHistories[1];
  const savedCall = secondRequest
    .find((message) => message.toolCalls?.some((call) => call.id === "call_save"))
    ?.toolCalls?.find((call) => call.id === "call_save");
  assert.ok(savedCall !== undefined);
  assert.equal(savedCall.name, "save_itinerary");
  assert.equal(
    savedCall.arguments,
    hugeArguments,
    "最近一轮应保留完整参数，让模型基于真实上一版继续修改",
  );
  assert.match(
    secondRequest.find((message) => message.toolCallId === "call_save")?.content ?? "",
    /^\[tool-result .*\]\n已保存「北京五日游」/,
    "压缩参数不能破坏 tool_call / tool_result 配对",
  );

  const thirdRequest = provider.seenHistories[2];
  assert.equal(
    thirdRequest.some((message) =>
      message.toolCalls?.some((call) => call.id === "call_save") === true ||
      message.toolCallId === "call_save"
    ),
    false,
    "已压缩的大参数调用与结果不再进入模型上下文，避免占位符被模仿",
  );
  assert.equal(
    thirdRequest.some((message) =>
      message.toolCalls?.some((call) => call.arguments.includes("_truncated")) === true
    ),
    false,
  );
  assert.match(
    thirdRequest.find((message) => message.toolCallId === "call_load")?.content ?? "",
    /^\[tool-result .*\]\n当前行程：北京五日游/,
    "压缩后模型仍可重新读取行程并继续修改",
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

test("Agent: onEvent 抛错不影响工具执行", async () => {
  // 第一次让模型调用工具，第二次给最终回答
  const provider = new ScriptedProvider([
    {
      type: "tool_calls",
      toolCalls: [
        {
          id: "call_1",
          name: "test_tool",
          arguments: "{}"
        }
      ]
    },
    {
      type: "text",
      content: "工具已执行成功"
    }
  ]);

  const registry = new ToolRegistry();

  let toolExecuted = false;

  registry.register({
    name: "test_tool",
    description: "测试工具",
    parameters: {
      type: "object",
      properties: {}
    },
    execute: async () => {
      toolExecuted = true;
      return "西湖、灵隐寺";
    }
  });

  const agent = new ChatAgent(
    new Session(),
    provider,
    registry
  );

  // 故意让事件回调失败
  const onEvent = () => {
    throw new Error("日志系统故障");
  };

  const reply = await agent.run("测试", {
    onEvent
  });

  // 验证工具确实执行
  assert.equal(toolExecuted, true);

  // 验证工具结果没有被日志错误覆盖
  assert.match(
    agent.history[2].content,
    /西湖、灵隐寺/
  );

  // 验证 Agent 仍能完成任务
  assert.equal(reply, "工具已执行成功");
});


test("Agent 工具循环: 历史压缩占位符被拒绝，不会触发真实工具", async () => {
  const provider = new ScriptedProvider([
    {
      type: "tool_calls",
      toolCalls: [{
        id: "call_placeholder",
        name: "save_itinerary",
        arguments: JSON.stringify({
          _truncated: true,
          original_chars: 9000,
          note: "工具已执行，历史参数已压缩",
        }),
      }],
    },
    { type: "text", content: "我会重新读取行程后再修改" },
  ]);
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "save_itinerary",
    description: "测试",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executed = true;
      return "不应执行";
    },
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  assert.equal(await agent.run("继续修改"), "我会重新读取行程后再修改");
  assert.equal(executed, false);
  assert.match(agent.history[2].content, /历史压缩占位符/);
  assert.match(agent.history[2].content, /工具未执行/);
  assert.equal(
    provider.seenHistories[1].some((message) =>
      message.toolCalls?.some((call) => call.arguments.includes("_truncated")) === true
    ),
    false,
    "模型自己提交过的占位参数也不能再回灌到下一轮上下文",
  );
});

test("Agent 工具循环: 同一工具错误连续出现时熔断，不空跑到预算上限", async () => {
  const provider = new RepeatedFailureProvider();
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "always_fail",
    description: "测试连续失败",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executions += 1;
      throw new Error("同一参数无法执行");
    },
  });
  const agent = new ChatAgent(new Session(), provider, registry);

  const reply = await agent.run("测试", { maxToolRounds: 12 });

  assert.equal(reply, "连续失败已熔断，当前行程尚未完成。");
  assert.equal(provider.toolCalls, 5, "第 5 次相同失败后应停止继续请求工具");
  assert.equal(executions, 5);
  assert.match(
    provider.finalChatHistories[0].at(-1)?.content ?? "",
    /同一工具错误连续重复.*熔断/,
  );
  assert.match(
    agent.history.filter((message) => message.role === "tool").at(-1)?.content ?? "",
    /防循环.*连续出现 5 次/,
  );
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

test("Agent 工具循环: 预算用尽时 onBudgetExhausted 可以放宽轮次继续跑", async () => {
  const provider = new EndlessToolProvider("收尾总结：整合已获得的数据如下…");
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);

  // 宿主按轮读取预算：第一次用尽放宽到 4，第二次拒绝 → 走收尾
  let limit = 2;
  const exhaustedAt: number[] = [];
  const reply = await agent.run("测试", {
    maxToolRounds: () => limit,
    onBudgetExhausted: (current) => {
      exhaustedAt.push(current);
      if (exhaustedAt.length > 1) return false;
      limit = 4;
      return true;
    },
  });

  assert.equal(reply, "收尾总结：整合已获得的数据如下…");
  assert.deepEqual(exhaustedAt, [2, 4]);
  // 续期后多跑了两轮工具调用
  assert.equal(provider.toolCalls, 4);
});

test("Agent 工具循环: 异步动态预算生效，onToolRound 统计模型轮数而非工具次数", async () => {
  const provider = new EndlessToolProvider("收尾总结：整合已获得的数据如下…");
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const agent = new ChatAgent(new Session(), provider, registry);
  const rounds: Array<{ round: number; limit: number; toolCalls: number }> = [];

  const reply = await agent.run("测试", {
    maxToolRounds: async () => 2,
    onToolRound: (info) => rounds.push(info),
  });

  assert.equal(reply, "收尾总结：整合已获得的数据如下…");
  assert.equal(provider.toolCalls, 2);
  assert.deepEqual(rounds, [
    { round: 1, limit: 2, toolCalls: 1 },
    { round: 2, limit: 2, toolCalls: 1 },
  ]);
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
