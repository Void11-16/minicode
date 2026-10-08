import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { ContextEpochManager, estimateHistoryTokens } from "../src/context/epoch.ts";
import type { Message } from "../src/core/message.ts";

test("压缩机制: 长会话压缩为摘要+最近消息，压缩结果可持久化（运行时路径）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-resume-"));
  const store = new JsonFileSessionStore(dir);

  // 构造一个长会话（模拟 CLI 里的 summarize 回调）
  const session = new Session("sess_resume_test");
  for (let i = 1; i <= 15; i++) {
    session.add("user", `第${i}个问题 ${"细节".repeat(60)}`);
    session.add("assistant", `第${i}个回答 ${"内容".repeat(60)}`);
  }
  await store.save(session);

  // —— 模拟运行时轮次开始前的压缩流程 ——
  const restored = await store.load("sess_resume_test");
  assert.ok(restored !== null);
  const resumeMaxTokens = 800;
  assert.ok(estimateHistoryTokens(restored.history) > resumeMaxTokens, "应触发压缩");

  const summarized: (readonly Message[])[] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: resumeMaxTokens,
    keepRecent: 8,
    summarize: async (messages) => {
      summarized.push(messages);
      return "用户讨论了杭州和上海的多轮旅行规划，已确定预算和日期。";
    },
  });
  const info = await manager.maybeCompact(restored);

  assert.ok(info !== null);
  assert.equal(info!.removedMessages, 22); // 30 - 8
  assert.ok(info!.tokensAfter < resumeMaxTokens || info!.tokensAfter < info!.tokensBefore / 2);
  assert.equal(summarized.length, 1);
  assert.equal(summarized[0].length, 22);

  // 恢复后历史: 1 条 system 摘要 + 最近 8 条
  assert.equal(restored.history.length, 9);
  assert.equal(restored.history[0].role, "system");
  assert.match(restored.history[0].content, /用户讨论了杭州和上海的多轮旅行规划/);
  assert.equal(restored.epoch, 1);

  // 压缩后写回存储：下次加载直接是压缩后的版本
  await store.save(restored);
  const reloaded = await store.load("sess_resume_test");
  assert.ok(reloaded !== null);
  assert.equal(reloaded.history.length, 9);
  assert.equal(reloaded.epoch, 1);

  // 短会话不触发压缩
  const short = new Session("sess_short_resume");
  short.add("user", "你好");
  await store.save(short);
  const restoredShort = await store.load("sess_short_resume");
  const noCompact = await new ContextEpochManager({
    maxPromptTokens: 800,
    keepRecent: 8,
    summarize: async () => "不应被调用",
  }).maybeCompact(restoredShort!);
  assert.equal(noCompact, null);
});
