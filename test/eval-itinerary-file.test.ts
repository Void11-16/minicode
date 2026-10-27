import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findItinerary } from "../src/eval/itinerary-file.ts";
import { planFileFor } from "../src/tools/itinerary.ts";

test("评测产物: 标题扩展后优先选择满足案例天数的完整行程", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minicode-eval-itinerary-"));
  await mkdir(join(directory, "plans"), { recursive: true });
  const stale = planFileFor(directory, "plans", "赤峰七日游", "json");
  const complete = planFileFor(directory, "plans", "赤峰七日游（草原与地质景观）", "json");
  await writeFile(stale, JSON.stringify({ title: "赤峰七日游", days: [{ items: [] }] }), "utf8");
  await writeFile(complete, JSON.stringify({
    title: "赤峰七日游（草原与地质景观）",
    days: Array.from({ length: 7 }, () => ({ items: [] })),
  }), "utf8");
  const old = new Date("2026-10-26T10:00:00Z");
  const fresh = new Date("2026-10-26T11:00:00Z");
  await utimes(stale, old, old);
  await utimes(complete, fresh, fresh);

  assert.equal(await findItinerary(directory, "赤峰七日游", 7), complete);
  assert.equal(await findItinerary(directory, "赤峰七日游", 1), stale);
});

test("评测产物: 无标题匹配时回退到最新可解析行程", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minicode-eval-itinerary-fallback-"));
  await mkdir(join(directory, "plans"), { recursive: true });
  const older = join(directory, "plans", "older.json");
  const newer = join(directory, "plans", "newer.json");
  const broken = join(directory, "plans", "zzz-broken.json");
  await writeFile(older, JSON.stringify({ title: "旧方案", days: [{ items: [] }] }), "utf8");
  await writeFile(newer, JSON.stringify({ title: "新方案", days: [{ items: [] }] }), "utf8");
  await writeFile(broken, "{", "utf8");
  await utimes(older, new Date("2026-10-26T10:00:00Z"), new Date("2026-10-26T10:00:00Z"));
  await utimes(newer, new Date("2026-10-26T11:00:00Z"), new Date("2026-10-26T11:00:00Z"));
  await utimes(broken, new Date("2026-10-26T12:00:00Z"), new Date("2026-10-26T12:00:00Z"));

  assert.equal(await findItinerary(directory, "北京三日游", 3), newer);
});

test("评测产物: 无括号副标题也按期望天数优先于同名旧文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minicode-eval-itinerary-subtitle-"));
  await mkdir(join(directory, "plans"), { recursive: true });
  const stale = join(directory, "plans", "北京三日游.json");
  const complete = join(directory, "plans", "北京三日游 故宫与长城.json");
  await writeFile(stale, JSON.stringify({ title: "北京三日游", days: [{ items: [] }] }), "utf8");
  await writeFile(complete, JSON.stringify({
    title: "北京三日游 故宫与长城",
    days: Array.from({ length: 3 }, () => ({ items: [] })),
  }), "utf8");
  await utimes(complete, new Date("2026-10-26T10:00:00Z"), new Date("2026-10-26T10:00:00Z"));
  await utimes(stale, new Date("2026-10-26T11:00:00Z"), new Date("2026-10-26T11:00:00Z"));

  assert.equal(await findItinerary(directory, "北京三日游", 3), complete);
});
