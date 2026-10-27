import { MIN_RECOMMENDATION_EVIDENCE_RATE } from "../tools/recommendation-policy.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  baselineFromResults,
  diffBaselines,
  latestBaseline,
  loadBaseline,
  renderBaselineDiff,
  saveBaseline,
} from "./baseline.ts";
import { loadSuite, type EvalCase, type EvalSuite } from "./cases.ts";
import { findItinerary } from "./itinerary-file.ts";
import { defaultRunId, resumeLiveSuite, runNewLiveSuite } from "./live.ts";
import { computeItineraryMetrics, type ItineraryEvalMetrics } from "./metrics.ts";
import { loadPlanSamples } from "./plans.ts";
import { requireSafeRunId, type EvalRunManifest } from "./run-store.ts";
import { parseItinerary } from "../tools/itinerary-schema.ts";

/**
 * 行程质量评测。
 *
 *   npm run eval -- --suite core
 *   npm run eval:live -- --suite representative --run-id 2026-10-26-representative
 *   npm run eval:live -- --resume 2026-10-26-representative
 *   npm run eval:plans -- --diff
 *
 * 新 live 评测写入 eval/runs/<run-id>/，每次运行不可覆盖。
 * 旧 eval/out 仅用于兼容默认离线检查，不再接收 live 生成产物。
 */

interface RunMeta {
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly provider: string;
}

interface CaseResult {
  readonly evalCase: EvalCase;
  readonly metrics: ItineraryEvalMetrics | null;
  readonly itineraryPath: string | null;
  readonly note: string | null;
  readonly run: RunMeta | null;
}

interface Sample {
  readonly evalCase: EvalCase;
  readonly path: string | null;
}

interface Summary {
  readonly evaluated: number;
  readonly missing: number;
  readonly avgScore: number;
  readonly totalIssues: { P0: number; P1: number; P2: number };
  readonly avgEvidenceRate: number;
  readonly strictFailures: string[];
}

const STRICT_MIN_EVIDENCE_RATE = MIN_RECOMMENDATION_EVIDENCE_RATE;
const root = join(import.meta.dirname, "..", "..");
const outRoot = join(root, "eval", "out");
const baselineDir = join(root, "eval", "baselines");

main().catch((error) => {
  console.error(`评测失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }

  if (args.includes("--plans")) {
    await runPlansMode(args);
    return;
  }
  if (args.includes("--live") || args.includes("--resume")) {
    await runLiveMode(args);
    return;
  }
  await runOfflineSuiteMode(args);
}

async function runLiveMode(args: readonly string[]): Promise<void> {
  if (!args.includes("--live")) {
    throw new Error("--resume 需要配合 live 评测脚本使用：npm run eval:live -- --resume <run-id>");
  }
  const resumeId = optionalFlagValue(args, "--resume");
  if (args.includes("--resume") && resumeId === undefined) {
    throw new Error("--resume 需要批次 ID，例如 --resume 20261026-153012-representative");
  }
  const profileFilter = optionalFlagValue(args, "--profile");
  const progress = (message: string): void => console.log(message);
  const manifest = resumeId === undefined
    ? await createLiveRun(args, profileFilter, progress)
    : await resumeLiveSuite({
        rootDir: root,
        runId: requireSafeRunId(resumeId),
        ...(profileFilter === undefined ? {} : { profileFilter }),
        caseIds: flagValues(args, "--case"),
        tags: flagValues(args, "--tag"),
        ...(optionalLimit(args) === undefined ? {} : { limit: optionalLimit(args) }),
        onProgress: progress,
      });

  console.log(`\n机器可读报告: ${relative(root, join(root, "eval", "runs", manifest.run_id, "report.json"))}`);
  console.log(`可读报告: ${relative(root, join(root, "eval", "runs", manifest.run_id, "report.md"))}\n`);

  if (args.includes("--strict") && manifest.status !== "completed") {
    console.error("strict 闸门未通过：批次中仍有未通过案例\n");
    process.exitCode = 1;
  }
  await reportLiveAgainstBaseline(args, manifest);
}

async function createLiveRun(
  args: readonly string[],
  profileFilter: string | undefined,
  onProgress: (message: string) => void,
): Promise<EvalRunManifest> {
  const suitePath = resolveSuitePath(optionalFlagValue(args, "--suite") ?? "core");
  const suite = await loadSuite(suitePath);
  const cases = filterSuiteCases(suite, args);
  const runId = requireSafeRunId(optionalFlagValue(args, "--run-id") ?? defaultRunId(suite.id));
  return runNewLiveSuite({
    rootDir: root,
    suitePath,
    suite,
    cases,
    runId,
    caseIds: flagValues(args, "--case"),
    tags: flagValues(args, "--tag"),
    ...(optionalLimit(args) === undefined ? {} : { limit: optionalLimit(args) }),
    ...(profileFilter === undefined ? {} : { profileFilter }),
    onProgress,
  });
}

async function runOfflineSuiteMode(args: readonly string[]): Promise<void> {
  if (args.includes("--resume") || args.includes("--run-id")) {
    throw new Error("--resume / --run-id 只用于 live 批次；离线检查请用 npm run eval");
  }
  const suitePath = resolveSuitePath(optionalFlagValue(args, "--suite") ?? "core");
  const suite = await loadSuite(suitePath);
  const cases = filterSuiteCases(suite, args);
  const samples = cases.map((evalCase): Sample => ({ evalCase, path: null }));
  const results: CaseResult[] = [];
  console.log(
    `\nminicode 行程评测 · ${new Date().toLocaleString("zh-CN")} · ` +
    `${suite.id}@${suite.version} · ${samples.length} 个案例 · 离线检查旧 eval/out\n`,
  );
  for (const sample of samples) {
    const result = await runOfflineCase(sample.evalCase);
    results.push(result);
    printCaseResult(result);
  }
  await finishOfflineResults(args, results, "cases", join(outRoot, "report"));
}

async function runPlansMode(args: readonly string[]): Promise<void> {
  const plansDir = resolve(root, optionalFlagValue(args, "--plans-dir") ?? "plans");
  const samples = filterPlans(await loadPlanSamples(plansDir), flagValues(args, "--case"));
  const results: CaseResult[] = [];
  console.log(
    `\nminicode 行程评测 · ${new Date().toLocaleString("zh-CN")} · ` +
    `真实产出 ${relative(root, plansDir)} · ${samples.length} 份 · 仅离线重评\n`,
  );
  for (const sample of samples) {
    const result = await evaluateFile(sample.evalCase, sample.path, null);
    results.push(result);
    printCaseResult(result);
  }
  await finishOfflineResults(args, results, "plans", join(outRoot, "plans-report"));
}

async function finishOfflineResults(
  args: readonly string[],
  results: readonly CaseResult[],
  mode: string,
  reportBase: string,
): Promise<void> {
  const summary = summarize(results);
  printSummary(summary, reportBase);
  await writeReports(results, summary, null, reportBase);
  await reportAgainstBaseline(args, results, mode);
  if (args.includes("--strict") && summary.strictFailures.length > 0) {
    console.error(`\nstrict 闸门未通过: ${summary.strictFailures.join("；")}\n`);
    process.exitCode = 1;
  }
}

function resolveSuitePath(value: string): string {
  if (value.endsWith(".json") || value.includes("/")) return resolve(root, value);
  return join(root, "eval", "suites", `${value}.json`);
}

function filterSuiteCases(suite: EvalSuite, args: readonly string[]): EvalCase[] {
  const caseIds = flagValues(args, "--case");
  const tags = flagValues(args, "--tag");
  const unknownIds = caseIds.filter((id) => !suite.cases.some((evalCase) => evalCase.id === id));
  if (unknownIds.length > 0) {
    throw new Error(
      `没有匹配的案例: ${unknownIds.join(", ")}（可用: ${suite.cases.map((evalCase) => evalCase.id).join(", ")}）`,
    );
  }
  const filtered = suite.cases.filter((evalCase) =>
    (caseIds.length === 0 || caseIds.includes(evalCase.id)) &&
    (tags.length === 0 || evalCase.tags?.some((tag) => tags.includes(tag)) === true)
  );
  if (filtered.length === 0) {
    throw new Error(`套件 ${suite.id} 没有匹配 --case / --tag 的案例`);
  }
  const limit = optionalLimit(args);
  return limit === undefined ? [...filtered] : filtered.slice(0, limit);
}

function filterPlans(samples: Awaited<ReturnType<typeof loadPlanSamples>>, caseIds: readonly string[]): typeof samples {
  if (caseIds.length === 0) return samples;
  const matched = samples.filter((sample) => caseIds.includes(sample.evalCase.id));
  if (matched.length === 0) {
    throw new Error(`没有匹配的真实产出: ${caseIds.join(", ")}`);
  }
  return matched;
}

function optionalLimit(args: readonly string[]): number | undefined {
  const raw = optionalFlagValue(args, "--limit");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error("--limit 需要正整数");
  return value;
}

async function runOfflineCase(evalCase: EvalCase): Promise<CaseResult> {
  const outDir = join(outRoot, evalCase.id);
  const itineraryPath = await findItinerary(outDir, evalCase.title, evalCase.days);
  if (itineraryPath === null) {
    return {
      evalCase,
      metrics: null,
      itineraryPath: null,
      note: "旧 eval/out 无产出；新 live 评测会写入独立 eval/runs 批次",
      run: null,
    };
  }
  return evaluateFile(evalCase, itineraryPath, null);
}

async function evaluateFile(evalCase: EvalCase, path: string, run: RunMeta | null): Promise<CaseResult> {
  try {
    const itinerary = parseItinerary(JSON.parse(await readFile(path, "utf8")));
    const metrics = computeItineraryMetrics(itinerary, {
      expectedDays: evalCase.days,
      ...(evalCase.budget_per_person_yuan === undefined
        ? {}
        : { budgetPerPersonYuan: evalCase.budget_per_person_yuan }),
    });
    return { evalCase, metrics, itineraryPath: path, note: null, run };
  } catch (error) {
    return {
      evalCase,
      metrics: null,
      itineraryPath: path,
      note: `解析失败: ${error instanceof Error ? error.message : String(error)}`,
      run,
    };
  }
}

function summarize(results: readonly CaseResult[]): Summary {
  const withMetrics = results.filter(
    (result): result is CaseResult & { metrics: ItineraryEvalMetrics } => result.metrics !== null,
  );
  const missing = results.length - withMetrics.length;
  const avgScore = average(withMetrics.map((result) => result.metrics.score));
  const totalIssues = withMetrics.reduce(
    (acc, result) => ({
      P0: acc.P0 + result.metrics.issueCounts.P0,
      P1: acc.P1 + result.metrics.issueCounts.P1,
      P2: acc.P2 + result.metrics.issueCounts.P2,
    }),
    { P0: 0, P1: 0, P2: 0 },
  );
  const avgEvidenceRate = average(withMetrics.map((result) => result.metrics.mealEvidenceRate));
  const strictFailures = results.flatMap((result) => strictFailuresFor(result.evalCase, result.metrics));
  return { evaluated: withMetrics.length, missing, avgScore, totalIssues, avgEvidenceRate, strictFailures };
}

function strictFailuresFor(evalCase: EvalCase, metrics: ItineraryEvalMetrics | null): string[] {
  if (metrics === null) return [`${evalCase.id}: 无产出`];
  const failures: string[] = [];
  if (metrics.days !== evalCase.days) {
    failures.push(`${evalCase.id}: 行程天数 ${metrics.days}/${evalCase.days}`);
  }
  if (metrics.issueCounts.P0 > 0 || metrics.issueCounts.P1 > 0) {
    failures.push(`${evalCase.id}: P0 ${metrics.issueCounts.P0} / P1 ${metrics.issueCounts.P1}`);
  }
  if (metrics.mealEvidenceRate < STRICT_MIN_EVIDENCE_RATE) {
    failures.push(
      `${evalCase.id}: 推荐证据率 ${(metrics.mealEvidenceRate * 100).toFixed(0)}% < 80%`,
    );
  }
  return failures;
}

function printCaseResult(result: CaseResult): void {
  const { evalCase, metrics } = result;
  const head = `${evalCase.id} · ${evalCase.title}（${evalCase.days} 天）`;
  if (metrics === null) {
    console.log(`○ ${head}\n    ${result.note ?? "无数据"}\n`);
    return;
  }
  console.log(`● ${head}`);
  console.log(
    `    质量 ${metrics.score} 分 · ${metrics.status} · 天数 ${metrics.days}/${metrics.expectedDays} · ` +
    `P0 ${metrics.issueCounts.P0} / P1 ${metrics.issueCounts.P1} / P2 ${metrics.issueCounts.P2}`,
  );
  console.log(
    `    美食 候选 ${metrics.mealCandidates} · 证据 ${(metrics.mealEvidenceRate * 100).toFixed(0)}%` +
    ` · 时段达标 ${metrics.mealSlotsOk}/${metrics.mealSlotsTotal}` +
    `${metrics.mealSlotsMissing > 0 ? `（缺 ${metrics.mealSlotsMissing}）` : ""}` +
    ` · 菜系 ${metrics.cuisineDiversityAvg.toFixed(1)} · 价位 ${metrics.priceTierAvg.toFixed(1)} 档` +
    ` · 本地特色 ${metrics.localSpecialtySlots} 段`,
  );
  console.log(
    `    行程 游览 ${metrics.visitsPerDay.toFixed(1)}/天 · 最大空档 ${metrics.maxGapMinutes} 分` +
    ` · 路线问题 ${metrics.routeIssueCount} · 人均 ¥${Math.round(metrics.costPerPerson)}` +
    (metrics.budgetPerPersonYuan === undefined
      ? ""
      : `（预算 ¥${metrics.budgetPerPersonYuan}，${((metrics.budgetRatio ?? 0) * 100).toFixed(0)}%）`),
  );
  if (result.run !== null) {
    console.log(
      `    运行 ${(result.run.durationMs / 1000).toFixed(0)}s · ` +
      `工具 ${result.run.toolCalls} 次 · tokens ${result.run.totalTokens}`,
    );
  }
  if (metrics.issueCodes.length > 0) console.log(`    问题码 ${metrics.issueCodes.join(", ")}`);
  console.log("");
}

function printSummary(summary: Summary, reportBase: string): void {
  console.log("————————————————————————————————————");
  console.log(
    `样例 ${summary.evaluated + summary.missing} · 已评测 ${summary.evaluated} · 缺失 ${summary.missing}` +
    ` · 均分 ${summary.avgScore.toFixed(1)}` +
    ` · P0 ${summary.totalIssues.P0} / P1 ${summary.totalIssues.P1} / P2 ${summary.totalIssues.P2}` +
    ` · 推荐证据率 ${(summary.avgEvidenceRate * 100).toFixed(0)}%`,
  );
  console.log(`报告: ${relative(root, reportBase)}.md · ${relative(root, reportBase)}.json`);
  console.log("");
}

async function writeReports(
  results: readonly CaseResult[],
  summary: Summary,
  providerName: string | null,
  reportBase: string,
): Promise<void> {
  await mkdir(outRoot, { recursive: true });
  const generatedAt = new Date().toISOString();
  const json = {
    generated_at: generatedAt,
    provider: providerName,
    summary,
    results: results.map((result) => ({
      id: result.evalCase.id,
      title: result.evalCase.title,
      itinerary: result.itineraryPath,
      note: result.note,
      run: result.run,
      metrics: result.metrics,
    })),
  };
  await writeFile(`${reportBase}.json`, JSON.stringify(json, null, 2), "utf8");

  const lines = [
    "# 行程质量评测报告",
    "",
    `- 生成时间: ${generatedAt}`,
    ...(providerName === null ? [] : [`- 模型: ${providerName}`]),
    `- 样例: ${summary.evaluated + summary.missing} · 已评测 ${summary.evaluated} · 缺失 ${summary.missing}`,
    `- 均分 ${summary.avgScore.toFixed(1)} · P0 ${summary.totalIssues.P0} / ` +
      `P1 ${summary.totalIssues.P1} / P2 ${summary.totalIssues.P2} · ` +
      `推荐证据率 ${(summary.avgEvidenceRate * 100).toFixed(0)}%`,
    "",
    "| 样例 | 状态 | 分数 | 天数 | P0/P1/P2 | 候选达标 | 证据率 | 游览/天 | 最大空档 | 路线 | 人均/预算 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const metrics = result.metrics;
    lines.push(
      metrics === null
        ? `| ${result.evalCase.id} | — | — | — | — | — | — | — | — | — | ${result.note ?? "无产出"} |`
        : `| ${result.evalCase.id} | ${metrics.status} | ${metrics.score} | ${metrics.days}/${metrics.expectedDays} | ` +
          `${metrics.issueCounts.P0}/${metrics.issueCounts.P1}/${metrics.issueCounts.P2} | ` +
          `${metrics.mealSlotsOk}/${metrics.mealSlotsTotal} | ${(metrics.mealEvidenceRate * 100).toFixed(0)}% | ` +
          `${metrics.visitsPerDay.toFixed(1)} | ${metrics.maxGapMinutes} 分 | ${metrics.routeIssueCount} | ` +
          `¥${Math.round(metrics.costPerPerson)}/${metrics.budgetPerPersonYuan ?? "—"} |`,
    );
  }
  lines.push("");
  for (const result of results) {
    if (result.metrics === null) continue;
    lines.push(
      `## ${result.evalCase.id} · ${result.evalCase.title}`,
      "",
      `问题码: ${result.metrics.issueCodes.join(", ") || "（无）"}`,
      "",
    );
  }
  await writeFile(`${reportBase}.md`, lines.join("\n"), "utf8");
}

async function reportLiveAgainstBaseline(args: readonly string[], manifest: EvalRunManifest): Promise<void> {
  const results = manifest.cases.map((item): CaseResult => {
    const latest = item.attempts.at(-1);
    return {
      evalCase: item.eval_case,
      metrics: latest?.metrics ?? null,
      itineraryPath: latest?.itinerary_path ?? null,
      note: latest?.failure?.reason ?? null,
      run: null,
    };
  });
  await reportAgainstBaseline(args, results, "live");
}

async function reportAgainstBaseline(
  args: readonly string[],
  results: readonly CaseResult[],
  mode: string,
): Promise<void> {
  if (!args.includes("--diff") && !args.includes("--save")) {
    console.log("提示: 加 --diff 与最新基线对比，加 --save 把本轮存成基线\n");
    return;
  }
  const baseline = baselineFromResults(
    results.map((result) => ({
      id: result.evalCase.id,
      title: result.evalCase.title,
      metrics: result.metrics,
    })),
    mode,
  );
  if (args.includes("--diff")) {
    const diffName = optionalFlagValue(args, "--diff");
    const path = diffName === undefined ? await latestBaseline(baselineDir) : join(baselineDir, `${diffName}.json`);
    console.log(renderBaselineDiff(diffBaselines(await loadBaseline(path), baseline), relative(root, path)).join("\n"));
  }
  if (args.includes("--save")) {
    const path = join(baselineDir, `${optionalFlagValue(args, "--save") ?? timestampName(new Date())}.json`);
    await saveBaseline(path, baseline);
    console.log(`基线已保存: ${relative(root, path)}\n`);
  }
}

function timestampName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) => {
    if (value !== flag) return [];
    const next = args[index + 1];
    return next === undefined || next.startsWith("--") ? [] : [next];
  });
}

function optionalFlagValue(args: readonly string[], flag: string): string | undefined {
  const values = flagValues(args, flag);
  return values.at(-1);
}

function helpText(): string {
  return [
    "minicode 行程质量评测",
    "",
    "  npm run eval -- --suite core                 离线检查旧 eval/out 产出",
    "  npm run eval -- --case <id> --tag <tag>      按案例或标签筛选",
    "  npm run eval:live -- --suite representative  新建独立 live 批次",
    "     --run-id <id>                             指定批次 ID；已存在时拒绝覆盖",
    "     --case <id> --tag <tag> --limit <n>       筛选本次案例",
    "     --profile <id>                            指定 models.json 里的模型",
    "     --strict                                  有未通过案例时返回非零退出码",
    "  npm run eval:live -- --resume <run-id>        只续跑失败/未完成案例",
    "",
    "  npm run eval:plans                            评测 plans/ 下的真实产出（零生成费用）",
    "  npm run eval:plans -- --plans-dir <dir>       评测指定目录下的行程文件",
    "  npm run eval:plans -- --diff [name]           与最新（或指定）基线对比",
    "  npm run eval:plans -- --save [name]           保存本轮指标为基线",
    "",
    "  --case 与 --tag 都可重复传入；多个 --tag 之间为 OR 关系。",
  ].join("\n");
}
