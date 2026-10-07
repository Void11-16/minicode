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
