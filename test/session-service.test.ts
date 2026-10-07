import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { SessionService } from "../src/service/session-service.ts";

async function makeService(resumeMaxTokens: number, summarizeError = false) {
  const dir = await mkdtemp(join(tmpdir(), "minicode-service-"));
  const store = new JsonFileSessionStore(dir);
  const service = new SessionService(store, {
    resumeMaxTokens,
    summarize: async () => {
      if (summarizeError) throw new Error("摘要服务不可用");
      return "会话摘要：讨论了旅行规划。";
    },
  });
  return { store, service };
}

test("SessionService: 短会话直接加载不压缩", async () => {
  const { store, service } = await makeService(8000);
  const session = new Session("svc_short");
  session.add("user", "你好");
  await store.save(session);

  const result = await service.loadWithPrepare("svc_short");
  assert.ok(result !== null);
  assert.equal(result.compacted, undefined);
  assert.equal(result.session.history.length, 1);
});

test("SessionService: 长会话自动压缩 + 归档 + 回写", async () => {
  const { store, service } = await makeService(800);
  const session = new Session("svc_long");
  for (let i = 0; i < 8; i++) {
    session.add("user", `问题${i} ${"细节".repeat(60)}`);
    session.add("assistant", `回答${i} ${"内容".repeat(60)}`);
  }
  await store.save(session);

  const result = await service.loadWithPrepare("svc_long");
  assert.ok(result !== null);
  assert.ok(result.compacted !== undefined);
  assert.equal(result.compacted.epoch, 1);

  // 回写后的主文件是轻量版
  const reloaded = await store.load("svc_long");
  assert.ok(reloaded !== null);
  assert.ok(reloaded.history.length < 16);
});

test("SessionService: 压缩失败时回退全量恢复（不丢数据）", async () => {
  const { store, service } = await makeService(800, true);
  const session = new Session("svc_fail");
  for (let i = 0; i < 8; i++) {
    session.add("user", `问题${i} ${"细节".repeat(60)}`);
    session.add("assistant", `回答${i} ${"内容".repeat(60)}`);
  }
  await store.save(session);

  const result = await service.loadWithPrepare("svc_fail");
  assert.ok(result !== null);
  assert.match(result.compactionError ?? "", /摘要服务不可用/);
  // 全量历史完好
  assert.equal(result.session.history.length, 16);
  assert.equal(result.session.epoch, 0);
});

test("SessionService: 阈值为 0 时永不压缩", async () => {
  const { store, service } = await makeService(0);
  const session = new Session("svc_disabled");
  for (let i = 0; i < 10; i++) {
    session.add("user", `问题${i} ${"细节".repeat(60)}`);
  }
  await store.save(session);

  const result = await service.loadWithPrepare("svc_disabled");
  assert.ok(result !== null);
  assert.equal(result.compacted, undefined);
});
