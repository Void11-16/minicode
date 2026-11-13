import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseSignature, loadDashboardRuns, writeDashboard } from "../src/eval/dashboard.ts";
import { caseVerdict, pairCases, performanceMetrics, readPair, selectSamples, type DashboardAttempt, type DashboardRun } from "../src/eval/dashboard-model.ts";

const metric = (key: string) => performanceMetrics.find((row) => row.key === key)!;
const task = { id: "hangzhou-2d", title: "杭州两日", request: "两日旅行", days: 2, must_visit: ["西湖"] };
const attempt = (days: number, overrides: Partial<DashboardAttempt> = {}): DashboardAttempt => ({
  number: 1, status: "quality_failed", scoreVersion: "rubric-1", issues: { P0: 0, P1: 2, P2: 0 },
  delivery: { materializedDays: days, requiredVisits: { scheduled: 1, total: 1 }, visitEvidence: { verified: 1, total: 1 }, routeEvidence: { verified: 1, total: 1 } },
  calls: 12, ...overrides,
});
const run = (id: string, ...attempts: DashboardAttempt[]): DashboardRun => ({
  id, created: "2026-11-12T00:00:00Z", suite: "test", suiteVersion: "1", suiteSize: 1, architecture: "agent",
  model: "deepseek / deepseek-chat", prompt: id, environment: "在线", environmentKey: "online", sourceVersions: [],
  cases: [{ id: task.id, title: task.title, expectedDays: 2, requiredVisits: 1, signature: caseSignature(task), status: attempts.at(-1)!.status, attempts }],
});

test("同案例对比以有效交付优先，额外案例和缺埋点不改变比较分母", () => {
  const before = run("before", attempt(1, { calls: 30, checks: { passed: 1, total: 1, failed: [] } }));
  const after = run("after", attempt(2, { calls: 18, issues: { P0: 0, P1: 3, P2: 0 }, checks: { passed: 2, total: 2, failed: [] } }));
  after.cases.push({ ...after.cases[0]!, id: "other", expectedDays: 7 });
  const comparison = pairCases(before, after, "latest");
  assert.equal(comparison.eligible.length, 1); assert.equal(comparison.onlyAfter.length, 1);
  assert.equal(caseVerdict(comparison.eligible[0]!), "improved");
  const coverage = readPair(metric("days"), comparison.eligible);
  assert.deepEqual([coverage.before?.n, coverage.after?.n, coverage.after?.total], [1, 2, 2]);
  assert.deepEqual(readPair(metric("repeatQueries"), comparison.eligible), { before: undefined, after: undefined, paired: 0 });
  assert.equal(readPair(metric("strict"), comparison.eligible).after?.value, 0);
});

test("案例需求、数据场景、失败阶段和评分版本各自限制可比性", () => {
  const before = run("before", attempt(1)), after = run("after", attempt(2, { scoreVersion: "rubric-2" }));
  const updated = pairCases(before, after, "latest");
  assert.equal(updated.rubricChanged, true);
  assert.equal(caseVerdict(updated.eligible[0]!), "unavailable");
  assert.equal(readPair(metric("P1"), updated.eligible).paired, 0);
  assert.equal(readPair(metric("days"), updated.eligible).after?.value, 100);
  assert.deepEqual(pairCases(before, { ...after, environmentKey: "frozen:world" }, "latest").reasons, ["外部数据环境不同"]);
  after.cases[0]!.signature = caseSignature({ ...task, request: "不同的需求" });
  assert.equal(pairCases(before, after, "latest").eligible.length, 0);
  const provider = run("provider", attempt(0, { status: "generation_failed", stage: "provider", delivery: undefined }));
  assert.equal(pairCases(before, provider, "latest").eligible.length, 0);
  const failed = run("failed", attempt(0, { status: "generation_failed", stage: "generation", delivery: undefined }));
  assert.equal(readPair(metric("days"), pairCases(before, failed, "latest").eligible).after?.value, 0);
});

test("可切换首次与最近尝试，且减少调用不会掩盖交付退化", () => {
  const before = run("before", attempt(2, { status: "passed" }));
  const after = run("after", attempt(1, { calls: 1 }), attempt(2, { number: 2, status: "passed" }));
  assert.equal(caseVerdict(pairCases(before, after, "first").eligible[0]!), "regressed");
  assert.equal(caseVerdict(pairCases(before, after, "latest").eligible[0]!), "same");
  assert.equal(selectSamples(after, "latest")[0]?.attempt?.number, 2);
  const a = run("prior", attempt(2, { readyDays: 1 }));
  const b = run("new", attempt(2, { readyDays: 0, issues: { P0: 0, P1: 1, P2: 0 } }));
  assert.equal(caseVerdict(pairCases(a, b, "latest").eligible[0]!), "mixed");
});

test("旧批次从保存时间线补有效天数，保留原分数并生成独立看板", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eval-dashboard-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, "runs"), folder = join(runs, "legacy-live"), path = "cases/hangzhou-2d/attempt-1";
  await mkdir(join(folder, path), { recursive: true });
  const manifest = { schema_version: 1, mode: "live", run_id: "legacy-live", created_at: "2026-11-12T00:00:00Z", model: { provider: "deepseek", model: "chat" },
    suite: { id: "test", version: "1", case_count: 1 }, prompt: { version: "v1" }, cases: [{ eval_case: { ...task, title: "</script>" }, status: "quality_failed", attempts: [
      { attempt: 1, status: "quality_failed", output_dir: path, itinerary_path: `${path}/final-itinerary.json`, metrics: { days: 2, score: 72, scoreVersion: "old" } },
    ] }] };
  const file = join(folder, "manifest.json"), original = JSON.stringify(manifest); await writeFile(file, original);
  await writeFile(join(folder, path, "final-itinerary.json"), JSON.stringify({ title: "杭州两日", days: [
    { date: "2026-11-13", items: [{ type: "visit", name: "西湖", time: "10:00", end_time: "12:00" }] },
    { date: "2026-11-14", items: [{ type: "visit", name: "灵隐寺" }] },
  ] }));
  const { runs: loaded } = await loadDashboardRuns(runs);
  const first = loaded[0]?.cases[0]?.attempts[0];
  assert.equal(first?.savedDays, 2); assert.equal(first?.delivery?.materializedDays, 1); assert.equal(first?.score, 72);
  const htmlPath = join(root, "out", "dashboard.html");
  await writeDashboard(runs, htmlPath);
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /"title":"\\u003c\/script>"/);
  assert.ok(!html.includes("<!--DASHBOARD_DATA-->"));
  assert.equal(await readFile(file, "utf8"), original);
});
