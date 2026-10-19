import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineFromResults,
  diffBaselines,
  latestBaseline,
  loadBaseline,
  renderBaselineDiff,
  saveBaseline,
  type Baseline,
  type BaselineSample,
} from "../src/eval/baseline.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { loadPlanSamples } from "../src/eval/plans.ts";
import type { Itinerary } from "../src/tools/itinerary-schema.ts";

function sample(id: string, overrides: Partial<BaselineSample> = {}): BaselineSample {
  return {
    id,
    title: id,
    days: 3,
    status: "ok",
    score: 90,
    issues: { P0: 0, P1: 0, P2: 0 },
    issueCodes: [],
    evidenceRate: 1,
    mealSlotsOk: 6,
    mealSlotsTotal: 6,
    visitsPerDay: 3.5,
    maxGapMinutes: 30,
    routeIssueCount: 0,
    costPerPerson: 1000,
    ...overrides,
  };
}

function baseline(samples: readonly BaselineSample[], missing: readonly string[] = []): Baseline {
  return { generated_at: "2026-10-15T12:00:00.000Z", mode: "plans", samples, missing };
}

test("基线快照记录指标，未评测样本单列", () => {
  const itinerary: Itinerary = { title: "测试", days: [{ items: [] }, { items: [] }] };
  const metrics = computeItineraryMetrics(itinerary, { expectedDays: 4 });
  const snapshot = baselineFromResults([
    { id: "有产出", title: "有产出", metrics },
    { id: "解析失败", title: "解析失败", metrics: null },
  ], "plans");

  assert.equal(snapshot.mode, "plans");
  assert.deepEqual(snapshot.missing, ["解析失败"]);
  assert.equal(snapshot.samples.length, 1);
  assert.equal(snapshot.samples[0].days, 2);
  assert.equal(snapshot.samples[0].score, metrics.score);
});

test("对比基线能分出改善、变差与无变化", () => {
  const before = baseline([
    sample("北京四日游", { score: 82, status: "needs_revision", issues: { P0: 0, P1: 2, P2: 2 }, issueCodes: ["long-transport"] }),
    sample("赤峰七日游", { score: 98, issueCodes: [] }),
    sample("衢州三日游", { score: 100 }),
  ]);
  const after = baseline([
    sample("北京四日游", { score: 88, status: "ok", issues: { P0: 0, P1: 0, P2: 2 }, issueCodes: [] }),
    sample("赤峰七日游", { score: 92, issueCodes: ["missing-source"], issues: { P0: 0, P1: 0, P2: 2 } }),
    sample("衢州三日游", { score: 100 }),
  ]);

  const diff = diffBaselines(before, after);
  assert.equal(diff.improved, 1);
  assert.equal(diff.regressed, 1);
  assert.deepEqual(Object.fromEntries(diff.rows.map((row) => [row.id, row.kind])), {
    北京四日游: "changed",
    赤峰七日游: "changed",
    衢州三日游: "same",
  });
  assert.deepEqual(Object.fromEntries(diff.rows.map((row) => [row.id, row.verdict])), {
    北京四日游: "improved",
    赤峰七日游: "regressed",
    衢州三日游: "same",
  });

  const lines = renderBaselineDiff(diff, "eval/baselines/x.json").join("\n");
  assert.match(lines, /北京四日游 改善 · 评分 82 → 88（\+6） · 状态 needs_revision → ok/);
  assert.match(lines, /消失问题码 long-transport/);
  assert.match(lines, /赤峰七日游 变差/);
  assert.match(lines, /新增问题码 missing-source/);
  assert.match(lines, /= 衢州三日游 无变化/);
});

test("分数持平时按硬问题数和证据率判方向", () => {
  const hardIssues = diffBaselines(
    baseline([sample("a", { issues: { P0: 1, P1: 0, P2: 0 } })]),
    baseline([sample("a", { issues: { P0: 0, P1: 0, P2: 0 } })]),
  );
  assert.equal(hardIssues.rows[0].verdict, "improved");

  const evidence = diffBaselines(
    baseline([sample("a", { evidenceRate: 1 })]),
    baseline([sample("a", { evidenceRate: 0.6 })]),
  );
  assert.equal(evidence.rows[0].verdict, "regressed");
});

test("样本增删与未评测单列，不计入改善/变差", () => {
  const before = baseline([sample("老样本")], ["掉线的样本"]);
  const after = baseline([sample("新样本")], ["掉线的样本"]);
  const diff = diffBaselines(before, after);

  assert.equal(diff.improved, 0);
  assert.equal(diff.regressed, 0);
  assert.deepEqual(Object.fromEntries(diff.rows.map((row) => [row.id, row.kind])), {
    掉线的样本: "missing",
    新样本: "added",
    老样本: "removed",
  });

  const lines = renderBaselineDiff(diff, "baseline.json").join("\n");
  assert.match(lines, /＋ 新样本 新增样本/);
  assert.match(lines, /⚠ 掉线的样本 本次未评测/);
  assert.match(lines, /－ 老样本 本次样本消失/);
});

test("基线可存可取，latestBaseline 取文件名排序最靠后的一份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-baseline-"));
  await saveBaseline(join(dir, "2026-10-15-initial.json"), baseline([sample("a", { score: 90 })]));
  await saveBaseline(join(dir, "2026-10-16-second.json"), baseline([sample("a", { score: 95 })]));

  const path = await latestBaseline(dir);
  assert.equal(path, join(dir, "2026-10-16-second.json"));
  assert.equal((await loadBaseline(path)).samples[0].score, 95);
  await assert.rejects(loadBaseline(join(dir, "不存在.json")), /基线不存在或无法解析/);
});

test("加载真实产出样本：跳过 quality 报告，坏文件留给评测阶段报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-plans-"));
  await writeFile(
    join(dir, "plan-b.json"),
    JSON.stringify({ title: "北京四日游", days: [{ items: [] }, { items: [] }] }),
    "utf8",
  );
  await writeFile(join(dir, "plan-a.quality.json"), JSON.stringify({ score: 82 }), "utf8");
  await writeFile(join(dir, "broken.json"), "{ 这不是 JSON", "utf8");

  const samples = await loadPlanSamples(dir);
  assert.deepEqual(samples.map((item) => item.evalCase.id), ["broken", "plan-b"]);
  assert.equal(samples[1].evalCase.title, "北京四日游");
  assert.equal(samples[1].evalCase.days, 2);
  assert.equal(samples[0].evalCase.days, 0);
});
