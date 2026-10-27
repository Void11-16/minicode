import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import type { PromptMessage } from "../src/core/message.ts";

test("token 校准: EMA 修正系数并影响估算", () => {
  const session = new Session("sess_cal");
  session.add("user", "x".repeat(1000)); // 初始估算 1000 × 0.7 = 700 tokens
  assert.equal(session.estimateHistoryTokens(), 704); // 700 + 4 条消息开销

  // 真实 usage: 1000 字符实际用了 1000 tokens（观测系数 1.0）
  // EMA: 0.7 × 0.8 + 1.0 × 0.2 = 0.76
  session.calibrateTokens(1000, 1000);
  assert.ok(Math.abs(session.calibrationFactor - 0.76) < 1e-9);

  // 估算随系数变化: 1000 × 0.76 + 4 = 764
  assert.equal(session.estimateHistoryTokens(), 764);

  // 继续校准向 1.0 收敛
  session.calibrateTokens(1000, 1000);
  assert.ok(session.calibrationFactor > 0.76);
});

test("token 估算: tool_calls 参数与正文一样计入上下文", () => {
  const session = new Session("sess_tool_chars");
  const argumentsJson = JSON.stringify({ title: "北京五日游", days: ["x".repeat(6000)] });
  session.add("assistant", "", {
    toolCalls: [{ id: "call_save", name: "save_itinerary", arguments: argumentsJson }],
  });

  assert.ok(session.estimateHistoryTokens() > 4000, "工具参数不能因 content 为空而漏算");
  assert.ok(session.promptCharCount() > argumentsJson.length, "校准字符量应包含调用 id、名称与协议开销");
});

test("token 压缩: 工具执行完成后可立即压缩参数并保留调用配对", () => {
  const session = new Session("sess_tool_runtime_trim");
  const argumentsJson = JSON.stringify({ title: "北京五日游", days: ["x".repeat(7000)] });
  session.add("assistant", "", {
    toolCalls: [{ id: "call_save", name: "save_itinerary", arguments: argumentsJson }],
  });
  session.add("tool", "已保存「北京五日游」", {
    toolCallId: "call_save",
    toolName: "save_itinerary",
  });
  const before = session.estimateHistoryTokens();

  assert.equal(session.compactCompletedToolCalls(undefined, 0), 1);

  const call = session.history[0].toolCalls?.[0];
  assert.equal(call?.id, "call_save");
  assert.equal(call?.name, "save_itinerary");
  assert.ok((call?.arguments.length ?? Infinity) < 300);
  assert.equal(JSON.parse(call?.arguments ?? "{}")._truncated, true);
  assert.equal(
    session.history[0].archivedToolCalls?.[0].arguments,
    argumentsJson,
    "本地审计副本应保留原始参数，但不参与 Prompt 和 token 估算",
  );
  assert.equal(session.history[1].toolCallId, "call_save");
  assert.ok(session.estimateHistoryTokens() < before / 10, "参数压缩后应立即反映到 token 估算");
});

test("token 校准: 系数限制在 [0.2, 2.0] 范围内", () => {
  const session = new Session("sess_clamp");
  for (let i = 0; i < 50; i++) {
    session.calibrateTokens(10_000, 100); // 观测系数 100 → 拉向上限
  }
  assert.equal(session.calibrationFactor, 2);

  for (let i = 0; i < 50; i++) {
    session.calibrateTokens(1, 100_000); // 观测系数 0.00001 → 拉向下限
  }
  assert.equal(session.calibrationFactor, 0.2);
});

test("token 校准: 非法输入不生效", () => {
  const session = new Session("sess_invalid");
  const before = session.calibrationFactor;
  session.calibrateTokens(0, 1000);
  session.calibrateTokens(100, 0);
  session.calibrateTokens(-5, 100);
  assert.equal(session.calibrationFactor, before);
});

test("token 校准: 系数随会话持久化", () => {
  const session = new Session("sess_persist_cal");
  session.calibrateTokens(1000, 1000); // → 0.76

  const restored = Session.fromData(session.toData());
  assert.equal(restored.calibrationFactor, session.calibrationFactor);
});

test("Agent 用真实 usage 校准会话估算系数", async () => {
  const { ChatAgent } = await import("../src/agent/agent.ts");
  const { ToolRegistry } = await import("../src/tools/tool.ts");

  const provider = {
    name: "fake",
    async chat() {
      return "ok";
    },
    async chatWithTools(history: readonly PromptMessage[], _tools: never[]) {
      // 返回与请求字符量一致的真实 usage（观测系数 1.0）
      const chars = history.reduce((sum, m) => sum + m.content.length + 8, 0);
      return {
        type: "text" as const,
        content: "回复",
        usage: { promptTokens: chars, completionTokens: 10, totalTokens: chars + 10 },
      };
    },
  };

  const session = new Session("sess_agent_cal");
  const agent = new ChatAgent(session, provider, new ToolRegistry().register({
    name: "noop",
    description: "无操作",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  }));

  const before = session.calibrationFactor;
  // 长输入才会触发校准（短历史中固定开销主导，不校准）
  await agent.run(`详细分析以下内容：${"旅行细节".repeat(1000)}`);

  assert.ok(session.calibrationFactor > before, "校准系数应向真实值靠拢");
});

test("Agent: 短历史不校准（固定开销会失真）", async () => {
  const { ChatAgent } = await import("../src/agent/agent.ts");
  const { ToolRegistry } = await import("../src/tools/tool.ts");

  const provider = {
    name: "fake",
    async chat() {
      return "ok";
    },
    async chatWithTools(history: readonly PromptMessage[], _tools: never[]) {
      // 故意返回夸张的 usage（模拟固定开销主导）
      const chars = history.reduce((sum, m) => sum + m.content.length + 8, 0);
      return {
        type: "text" as const,
        content: "回复",
        usage: { promptTokens: chars * 10, completionTokens: 10, totalTokens: chars * 10 + 10 },
      };
    },
  };

  const session = new Session("sess_agent_short");
  const agent = new ChatAgent(session, provider, new ToolRegistry().register({
    name: "noop",
    description: "无操作",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  }));

  await agent.run("短消息");
  assert.equal(session.calibrationFactor, 0.7, "短历史不应校准");
});
