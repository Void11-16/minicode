import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { ContextEpochManager } from "../src/context/epoch.ts";
import type { Message } from "../src/core/message.ts";

function longSession(): Session {
  const session = new Session("sess_archive");
  for (let i = 0; i < 8; i++) {
    session.add("user", `问题${i} ${"细节".repeat(60)}`);
    session.add("assistant", `回答${i} ${"内容".repeat(60)}`);
  }
  return session;
}

test("压缩前归档: 原始历史完整保存到 archive 目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-archive-"));
  const store = new JsonFileSessionStore(dir);
  const session = longSession();
  const originalCount = session.history.length;
  await store.save(session);

  let archivedSession: Session | undefined;
  let archivedEpoch: number | undefined;
  const manager = new ContextEpochManager({
    maxPromptTokens: 500,
    keepRecent: 6,
    summarize: async () => "摘要内容",
    archive: async (target, epoch) => {
      archivedSession = target;
      archivedEpoch = epoch;
      await store.archive(target, epoch);
    },
  });

  const info = await manager.maybeCompact(session);

  assert.ok(info !== null);
  assert.equal(archivedEpoch, 1);
  assert.ok(archivedSession !== undefined);

  // 归档文件包含压缩前的完整历史
  const raw = await readFile(join(dir, "archive", "sess_archive_epoch1.json"), "utf8");
  const archived = JSON.parse(raw) as { messages: Message[] };
  assert.equal(archived.messages.length, originalCount);

  // 归档文件不出现在会话列表里
  const list = await store.list();
  assert.equal(list.length, 1); // 只有主会话
});

test("压缩前归档: 归档失败时中止压缩（历史不被破坏）", async () => {
  const session = longSession();
  const historyBefore = [...session.history];

  const manager = new ContextEpochManager({
    maxPromptTokens: 500,
    keepRecent: 6,
    summarize: async () => "不应被调用",
    archive: async () => {
      throw new Error("磁盘写入失败");
    },
  });

  await assert.rejects(() => manager.maybeCompact(session), /磁盘写入失败/);

  // 历史原封不动
  assert.deepEqual(
    session.history.map((m) => m.id),
    historyBefore.map((m) => m.id),
  );
  assert.equal(session.epoch, 0);
});
