import assert from "node:assert/strict";
import { test } from "node:test";
import { LineQueue } from "../src/cli/line-queue.ts";

test("多行同 tick 到达不丢失（readline 竞态修复）", async () => {
  const queue = new LineQueue();

  // 模拟：两行在同一个 tick 内到达，而消费者还没开始取
  queue.push("第一行");
  queue.push("第二行");

  assert.equal(await queue.next(), "第一行");
  assert.equal(await queue.next(), "第二行");
});

test("先等待后到达也能正确交接", async () => {
  const queue = new LineQueue();
  const first = queue.next();
  const second = queue.next();

  queue.push("a");
  queue.push("b");

  assert.equal(await first, "a");
  assert.equal(await second, "b");
});

test("close 后所有等待者收到 null，不再接收新行", async () => {
  const queue = new LineQueue();
  const pending = queue.next();

  queue.push(null);

  assert.equal(await pending, null);
  assert.equal(await queue.next(), null);
});
