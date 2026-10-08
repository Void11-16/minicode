import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { SessionService } from "../src/service/session-service.ts";

test("SessionService: persist 写入可被 store.load 完整读回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-service-"));
  const store = new JsonFileSessionStore(dir);
  const service = new SessionService(store);

  const session = new Session("svc_roundtrip");
  session.add("user", "你好");
  session.add("assistant", "你好！");
  session.setWorkspace("/tmp/ws");
  await service.persist(session);

  const reloaded = await store.load("svc_roundtrip");
  assert.ok(reloaded !== null);
  assert.equal(reloaded.history.length, 2);
  assert.equal(reloaded.workspace, "/tmp/ws");
});

test("SessionService: 恢复路径是纯加载（不触发任何摘要/网络调用）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-service-"));
  const store = new JsonFileSessionStore(dir);
  const service = new SessionService(store);

  // 构造一个"超长"会话（若走旧的 resume 压缩逻辑会调用 LLM 摘要）
  const session = new Session("svc_fast");
  for (let i = 0; i < 12; i++) {
    session.add("user", `问题${i} ${"细节".repeat(80)}`);
    session.add("assistant", `回答${i} ${"内容".repeat(80)}`);
  }
  await service.persist(session);

  // 纯加载：无 summarize 回调可调，加载后历史完整未压缩
  const loaded = await store.load("svc_fast");
  assert.ok(loaded !== null);
  assert.equal(loaded.history.length, 24);
  assert.equal(loaded.epoch, 0);
});
