import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextEpochManager, estimateTokens } from "../src/context/epoch.ts";
import { Session } from "../src/core/session.ts";
import type { Message } from "../src/core/message.ts";

test("token 估算: 中文与英文", () => {
  assert.equal(estimateTokens("你好"), 2); // 2 字 × 0.7 → 1.4 → 2
  assert.equal(estimateTokens("hello world"), 8); // 11 字符 × 0.7 → 7.7 → 8
});

function makeHistory(count: number): Session {
  const session = new Session("sess_epoch");
  for (let i = 0; i < count; i++) {
    session.add("user", `消息 ${i} ${"内容".repeat(20)}`);
    session.add("assistant", `回复 ${i} ${"内容".repeat(20)}`);
  }
  return session;
}

test("未超阈值时不压缩", async () => {
  const session = makeHistory(4); // 8 条消息，token 不多
  const summarized: Message[][] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: 100_000,
    summarize: async (messages) => {
      summarized.push([...messages]);
      return "摘要";
    },
  });

  const result = await manager.maybeCompact(session);
  assert.equal(result, null);
  assert.equal(summarized.length, 0);
  assert.equal(session.epoch, 0);
});

test("超阈值时压缩: 摘要 + 保留近期 + 纪元 +1 + 持久化", async () => {
  const session = makeHistory(10); // 20 条消息
  const tokensBefore = session.estimateHistoryTokens();

  let received: readonly Message[] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: 500, // 强制触发
    keepRecent: 6,
    summarize: async (messages) => {
      received = messages;
      return "这是压缩摘要：用户计划去杭州，偏好文化景点。";
    },
  });

  const info = await manager.maybeCompact(session);

  assert.ok(info !== null);
  assert.equal(info!.epoch, 1);
  assert.equal(info!.removedMessages, 14); // 20 - 6
  assert.equal(info!.tokensBefore, tokensBefore);
  assert.ok(info!.tokensAfter < tokensBefore / 2, "压缩后 token 应大幅下降");

  // 摘要器收到的是被移除的旧消息
  assert.equal(received.length, 14);

  // 新历史: 1 条 system 摘要 + 最近 6 条
  assert.equal(session.history.length, 7);
  assert.equal(session.history[0].role, "system");
  assert.match(session.history[0].content, /第 1 纪元/);
  assert.match(session.history[0].content, /杭州/);
  assert.equal(session.epoch, 1);

  // 纪元随会话持久化
  const restored = Session.fromData(session.toData());
  assert.equal(restored.epoch, 1);
});

test("历史条数不足 keepRecent 时不压缩（即使 token 超限）", async () => {
  const session = new Session("sess_short");
  session.add("user", "x".repeat(10_000));

  const manager = new ContextEpochManager({
    maxPromptTokens: 100,
    keepRecent: 8,
    summarize: async () => "摘要",
  });

  assert.equal(await manager.maybeCompact(session), null);
});

test("压缩时截断超长的工具消息（否则保留的最近窗口仍超阈值，导致每轮重复压缩）", async () => {
  const session = new Session("sess_tool_trim");
  session.add("user", "查一下杭州的景点");
  session.add("assistant", "好的");
  // 最近窗口里塞入超大工具结果（模拟搜索结果每次 16KB 一条）
  for (let i = 0; i < 4; i++) {
    session.add("assistant", `第${i}轮查询`);
    session.add("tool", "搜索结果：" + "数据".repeat(8000), { toolCallId: `c${i}`, toolName: "search_attractions" });
  }

  const manager = new ContextEpochManager({
    maxPromptTokens: 100,
    keepRecent: 8,
    summarize: async () => "摘要",
  });

  assert.equal(session.history.length, 10); // 超过 keepRecent 才会触发压缩
  const info = await manager.maybeCompact(session);
  assert.ok(info !== null);

  // 保留窗口内的工具消息已被截断到上限
  const keptTools = session.history.filter((message) => message.role === "tool");
  assert.equal(keptTools.length, 4);
  for (const message of keptTools) {
    assert.match(message.content, /已截断/);
    assert.ok(message.content.length < 3200, "截断后单条应接近上限");
  }
  // 截断生效后窗口显著变小（防止下轮再触发压缩）
  assert.ok(info!.tokensAfter < info!.tokensBefore);
  assert.ok(info!.tokensAfter < info!.tokensBefore / 3, "压缩后估算应大幅低于压缩前");
});

test("压缩边界不拆散工具调用组（保留窗口不以孤儿 tool 开头）", async () => {
  const session = new Session("sess_boundary");
  session.add("user", "帮我规划");
  session.add("assistant", "好的");
  session.add("assistant", "", { toolCalls: [{ id: "c1", name: "search", arguments: "{}" }] });
  session.add("tool", "结果1", { toolCallId: "c1", toolName: "search" });
  session.add("assistant", "", { toolCalls: [{ id: "c2", name: "search", arguments: "{}" }] });
  session.add("tool", "结果2", { toolCallId: "c2", toolName: "search" });
  session.add("user", "继续");
  session.add("assistant", "好");

  const manager = new ContextEpochManager({
    maxPromptTokens: 10,
    keepRecent: 3,
    summarize: async () => "摘要",
  });
  const info = await manager.maybeCompact(session);
  assert.ok(info !== null);
  // 边界原落在 tool(c2)（index 5），应回退到助手调用（index 4），整组保留
  assert.equal(info!.removedMessages, 4);
  const kept = session.history.slice(1); // 跳过摘要
  assert.notEqual(kept[0].role, "tool", "保留窗口不能以孤儿 tool 开头");
  assert.equal(kept[0].role, "assistant");
  assert.equal(kept[0].toolCalls?.[0].id, "c2");
  assert.equal(kept[1].role, "tool");
  assert.equal(kept[1].toolCallId, "c2");
});
