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
