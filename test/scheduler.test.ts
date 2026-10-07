import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionScheduler } from "../src/runtime/scheduler.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("不同 session 的任务并发执行", async () => {
  const scheduler = new SessionScheduler();
  const order: string[] = [];

  const slow = scheduler.submit("session-a", async () => {
    await delay(60);
    order.push("slow-done");
    return "slow";
  });
  const fast = scheduler.submit("session-b", async () => {
    await delay(10);
    order.push("fast-done");
    return "fast";
  });

  assert.equal(await fast, "fast");
  assert.equal(await slow, "slow");
  // fast 先完成说明两者确实并发（若串行 fast 必须等 slow）
  assert.deepEqual(order, ["fast-done", "slow-done"]);
});

test("同一 session 的任务串行合并执行", async () => {
  const scheduler = new SessionScheduler();
  const order: string[] = [];
  let running = 0;
  let maxConcurrent = 0;

  const track = async (label: string, ms: number) => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await delay(ms);
    order.push(label);
    running -= 1;
    return label;
  };

  const first = scheduler.submit("same", () => track("first", 50));
  const second = scheduler.submit("same", () => track("second", 10));

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(maxConcurrent, 1, "同一 session 不允许并发");
});

test("前一任务失败不阻塞同 session 后续任务", async () => {
  const scheduler = new SessionScheduler();
  const failing = scheduler.submit("s", async () => {
    throw new Error("boom");
  });
  const next = scheduler.submit("s", async () => "recovered");

  await assert.rejects(() => failing, /boom/);
  assert.equal(await next, "recovered");
});
