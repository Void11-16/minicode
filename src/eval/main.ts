import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Session } from "../core/session.ts";
import { ChatAgent } from "../agent/agent.ts";
import { composeSystemPrompt, readWorkspaceRules } from "../agent/prompt.ts";
import { ConfigStore } from "../config/config.ts";
import { ModelProfileStore } from "../config/models.ts";
import type { ModelProfile } from "../config/models.ts";
import { createProvider, createProviderFromProfile } from "../llm/factory.ts";
import type { ChatProvider } from "../llm/provider.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { planFileFor } from "../tools/itinerary.ts";
import { parseItinerary } from "../tools/itinerary-schema.ts";
import {
  baselineFromResults,
  diffBaselines,
  latestBaseline,
  loadBaseline,
  renderBaselineDiff,
  saveBaseline,
} from "./baseline.ts";
import { loadCases, type EvalCase } from "./cases.ts";
import { computeItineraryMetrics, type ItineraryEvalMetrics } from "./metrics.ts";
import { loadPlanSamples } from "./plans.ts";

/**
 * 行程质量离线评测。
 *
 * 用法（在项目根目录）：
 *   npm run eval                       # 评测 eval/out/<id>/plans 下已有的产出
 *   npm run eval -- --live             # 先用真实模型为每个样例生成行程，再评测（耗 API 费用）
 *   npm run eval -- --case quzhou-3d-couple   # 只评测单个样例
 *   npm run eval -- --strict           # 质量闸门：P0/P1 必须为 0、推荐证据率 ≥ 80%、全部样例有产出
 *   npm run eval:plans                 # 评测 plans/ 下的真实产出（零生成费用）
 *   npm run eval:plans -- --diff       # 与最新基线对比：这批行程是变好还是变差
 *   npm run eval:plans -- --save       # 把本轮指标存成基线（eval/baselines/<时间戳>.json）
 *
 * 报告写入 eval/out/report.json（机器可读）与 eval/out/report.md（可读）。
 * --live 的生成产物在 eval/out/<id>/plans/ 下，可提交/对比多次运行的差异。
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

/** 一次评测的输入：金标准样例（path 为 null，按约定去 eval/out 找）或真实产出（path 固定） */
interface Sample {
  readonly evalCase: EvalCase;
  readonly path: string | null;
}

const STRICT_MIN_EVIDENCE_RATE = 0.8;
/** live 生成单样例的最大工具轮数（旅行规划全流程较长） */
const LIVE_MAX_TOOL_ROUNDS = 40;

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
  const live = args.includes("--live");
  const strict = args.includes("--strict");
  // 注意：npm script 自带 --plans，所以目录要用 --plans-dir 传，避免 indexOf 命中脚本里的那个开关
  const plansDir = args.includes("--plans") ? resolve(root, optionalFlagValue(args, "--plans-dir") ?? "plans") : null;
  if (plansDir !== null && live) {
    throw new Error("--plans 与 --live 不能同时使用：真实产出是现成的，不需要重新生成");
  }
  const caseFilter = flagValue(args, "--case");
  const profileFilter = flagValue(args, "--profile");

  const samples = filterSamples(
    plansDir === null
      ? (await loadCases(join(root, "eval", "cases.json"))).map((evalCase): Sample => ({ evalCase, path: null }))
      : await loadPlanSamples(plansDir),
    caseFilter,
  );

  const liveContext = live ? await prepareLiveContext(profileFilter) : null;

  const scope = plansDir === null
    ? `共 ${samples.length} 个样例${live ? " · live 生成" : ""}`
    : `真实产出 ${relative(root, plansDir)} · 共 ${samples.length} 份 · 仅离线重评`;
  console.log(`\nminicode 行程评测 · ${new Date().toLocaleString("zh-CN")} · ${scope}\n`);

  const results: CaseResult[] = [];
  for (const sample of samples) {
    const result = sample.path !== null
      ? await evaluateFile(sample.evalCase, sample.path, null)
      : live && liveContext !== null
        ? await runLiveCase(sample.evalCase, liveContext)
        : await runOfflineCase(sample.evalCase);
    results.push(result);
    printCaseResult(result);
  }

  const reportBase = join(outRoot, plansDir === null ? "report" : "plans-report");
  const mode = plansDir === null ? (live ? "live" : "cases") : "plans";
  const summary = summarize(results);
  printSummary(summary, reportBase);
  await writeReports(results, summary, liveContext?.providerName ?? null, reportBase);
  await reportAgainstBaseline(args, results, mode);

  if (strict && summary.strictFailures.length > 0) {
    console.error(`\nstrict 闸门未通过: ${summary.strictFailures.join("；")}\n`);
    process.exitCode = 1;
  }
}

function filterSamples(samples: readonly Sample[], caseFilter: string | undefined): Sample[] {
  if (caseFilter === undefined) return [...samples];
  const matched = samples.filter((sample) => sample.evalCase.id === caseFilter);
  if (matched.length === 0) {
    throw new Error(`没有匹配的样例: ${caseFilter}（可用: ${samples.map((sample) => sample.evalCase.id).join(", ")}）`);
  }
  return matched;
}

/** --diff 与最新/指定基线对比，--save 把本轮指标存成基线；两者都没给就提示用法 */
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
    results.map((result) => ({ id: result.evalCase.id, title: result.evalCase.title, metrics: result.metrics })),
    mode,
  );
  const diffName = optionalFlagValue(args, "--diff");
  if (args.includes("--diff")) {
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
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 离线评测
// ---------------------------------------------------------------------------

async function runOfflineCase(evalCase: EvalCase): Promise<CaseResult> {
  const outDir = join(outRoot, evalCase.id);
  const itineraryPath = await findItinerary(outDir, evalCase.title);
  if (itineraryPath === null) {
    return { evalCase, metrics: null, itineraryPath: null, note: "未生成（先运行 npm run eval:live）", run: null };
  }
  return evaluateFile(evalCase, itineraryPath, null);
}

async function evaluateFile(evalCase: EvalCase, path: string, run: RunMeta | null): Promise<CaseResult> {
  try {
    const itinerary = parseItinerary(JSON.parse(await readFile(path, "utf8")));
    const metrics = computeItineraryMetrics(itinerary, {
      expectedDays: evalCase.days,
      ...(evalCase.budget_per_person_yuan === undefined ? {} : { budgetPerPersonYuan: evalCase.budget_per_person_yuan }),
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

// ---------------------------------------------------------------------------
// live 生成
// ---------------------------------------------------------------------------

interface LiveContext {
  readonly config: Awaited<ReturnType<ConfigStore["load"]>>;
  readonly profile: ModelProfile | undefined;
  /** 探测出的 provider 名称（报告用）；名称是 mock 时 live 无法生成 */
  readonly providerName: string;
}

async function prepareLiveContext(profileFilter: string | undefined): Promise<LiveContext> {
  const config = await new ConfigStore(join(root, ".minicode", "config.json")).load();
  setAmapKey(config.amapApiKey);
  const modelsFile = await new ModelProfileStore(join(root, ".minicode", "models.json")).loadWithSeed(config);
  const profile = modelsFile.profiles.find((item) => item.id === (profileFilter ?? modelsFile.defaultProfile))
    ?? modelsFile.profiles[0];
  const probe = profile === undefined ? createProvider({ config }) : createProviderFromProfile(profile, undefined);
  return { config, profile, providerName: probe.name };
}

function providerFor(context: LiveContext, systemPrompt: string): ChatProvider {
  if (context.profile === undefined) return createProvider({ config: context.config, systemPrompt });
  return createProviderFromProfile(context.profile, systemPrompt);
}

async function runLiveCase(evalCase: EvalCase, context: LiveContext): Promise<CaseResult> {
  if (context.providerName === "mock") {
    return {
      evalCase,
      metrics: null,
      itineraryPath: null,
      note: "未配置真实模型（.minicode/config.json / models.json），跳过生成",
      run: null,
    };
  }

  const outDir = join(outRoot, evalCase.id);
  await mkdir(outDir, { recursive: true });
  const registry = createDefaultRegistry({ writeRoot: outDir, workspace: outDir });
  const systemPrompt = composeSystemPrompt({
    travelMode: true,
    workspace: outDir,
    customPrompt: context.config.systemPrompt,
    tastePreferences: evalCase.taste ?? context.config.tastePreferences,
    rulesContent: readWorkspaceRules(outDir),
  });
  const provider = providerFor(context, systemPrompt);
  const session = new Session();
  const agent = new ChatAgent(session, provider, registry, outDir);

  const started = Date.now();
  let toolCalls = 0;
  const runTurn = (message: string): Promise<string> =>
    agent.run(message, {
      maxToolRounds: LIVE_MAX_TOOL_ROUNDS,
      onEvent: (event) => {
        if (event.type === "tool_start") {
          toolCalls += 1;
          console.log(`    · ${event.name}`);
        }
        if (event.type === "tool_error") console.log(`    ✗ ${event.name}: ${event.error ?? ""}`);
      },
    });

  const meta = (): RunMeta => ({
    durationMs: Date.now() - started,
    toolCalls,
    totalTokens: session.usage.totalTokens,
    provider: provider.name,
  });

  await runTurn(evalCase.request);
  let file = await findItinerary(outDir, evalCase.title);
  if (file === null) {
    // 单轮对话里模型可能先追问确认（真实交互是用户会回复）；评测场景自动补一次确认
    console.log("    ↻ 首轮未产出行程，补充确认后重试一轮");
    await runTurn(
      "确认，请直接一步到位生成完整行程：缺项按默认值处理，不要再追问。" +
      "用 save_itinerary 保存（条目多时按天 merge 保存），最后用 validate_itinerary（strict=true）复核。",
    );
    file = await findItinerary(outDir, evalCase.title);
  }
  if (file === null) {
    return { evalCase, metrics: null, itineraryPath: null, note: "生成完成但未找到行程文件", run: meta() };
  }
  return evaluateFile(evalCase, file, meta());
}

// ---------------------------------------------------------------------------
// 文件定位与报告
// ---------------------------------------------------------------------------

async function findItinerary(outDir: string, title: string): Promise<string | null> {
  const expected = planFileFor(outDir, "plans", title, "json");
  try {
    await stat(expected);
    return expected;
  } catch {
    // 没按标题保存 → 回退到目录里最新的行程文件
  }
  const plansDir = join(outDir, "plans");
  let names: string[];
  try {
    names = await readdir(plansDir);
  } catch {
    return null;
  }
  const candidates = names.filter((name) => name.endsWith(".json") && !name.endsWith(".quality.json"));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(
    candidates.map(async (name) => {
      const info = await stat(join(plansDir, name));
      return { path: join(plansDir, name), mtime: info.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].path;
}

interface Summary {
  readonly evaluated: number;
  readonly missing: number;
  readonly avgScore: number;
  readonly totalIssues: { P0: number; P1: number; P2: number };
  readonly avgEvidenceRate: number;
  readonly strictFailures: string[];
}

function summarize(results: readonly CaseResult[]): Summary {
  const withMetrics = results.filter((result) => result.metrics !== null);
  const missing = results.length - withMetrics.length;
  const avgScore = withMetrics.length === 0
    ? 0
    : withMetrics.reduce((sum, result) => sum + (result.metrics?.score ?? 0), 0) / withMetrics.length;
  const totalIssues = withMetrics.reduce(
    (acc, result) => ({
      P0: acc.P0 + (result.metrics?.issueCounts.P0 ?? 0),
      P1: acc.P1 + (result.metrics?.issueCounts.P1 ?? 0),
      P2: acc.P2 + (result.metrics?.issueCounts.P2 ?? 0),
    }),
    { P0: 0, P1: 0, P2: 0 },
  );
  const avgEvidenceRate = withMetrics.length === 0
    ? 0
    : withMetrics.reduce((sum, result) => sum + (result.metrics?.mealEvidenceRate ?? 0), 0) / withMetrics.length;

  const strictFailures: string[] = [];
  for (const result of results) {
    if (result.metrics === null) {
      strictFailures.push(`${result.evalCase.id}: 无产出`);
      continue;
    }
    if (result.metrics.issueCounts.P0 > 0 || result.metrics.issueCounts.P1 > 0) {
      strictFailures.push(`${result.evalCase.id}: P0 ${result.metrics.issueCounts.P0} / P1 ${result.metrics.issueCounts.P1}`);
    }
    if (result.metrics.mealEvidenceRate < STRICT_MIN_EVIDENCE_RATE) {
      strictFailures.push(`${result.evalCase.id}: 推荐证据率 ${(result.metrics.mealEvidenceRate * 100).toFixed(0)}% < 80%`);
    }
  }
  return { evaluated: withMetrics.length, missing, avgScore, totalIssues, avgEvidenceRate, strictFailures };
}

function printCaseResult(result: CaseResult): void {
  const { evalCase, metrics } = result;
  const head = `${evalCase.id} · ${evalCase.title}（${evalCase.days} 天）`;
  if (metrics === null) {
    console.log(`○ ${head}\n    ${result.note ?? "无数据"}\n`);
    return;
  }
  console.log(`● ${head}`);
  console.log(`    质量 ${metrics.score} 分 · ${metrics.status} · P0 ${metrics.issueCounts.P0} / P1 ${metrics.issueCounts.P1} / P2 ${metrics.issueCounts.P2}`);
  console.log(
    `    美食 候选 ${metrics.mealCandidates} · 证据 ${(metrics.mealEvidenceRate * 100).toFixed(0)}%` +
    ` · 时段达标 ${metrics.mealSlotsOk}/${metrics.mealSlotsTotal}` +
    `${metrics.mealSlotsMissing > 0 ? `（缺 ${metrics.mealSlotsMissing}）` : ""}` +
    ` · 菜系 ${metrics.cuisineDiversityAvg.toFixed(1)} · 价位 ${metrics.priceTierAvg.toFixed(1)} 档` +
    ` · 本地特色 ${metrics.localSpecialtySlots} 段`,
  );
  console.log(
    `    行程 游览 ${metrics.visitsPerDay.toFixed(1)}/天 · 最大空档 ${metrics.maxGapMinutes} 分` +
    ` · 路线问题 ${metrics.routeIssueCount}` +
    ` · 人均 ¥${Math.round(metrics.costPerPerson)}` +
    `${metrics.budgetPerPersonYuan === undefined ? "" : `（预算 ¥${metrics.budgetPerPersonYuan}，${((metrics.budgetRatio ?? 0) * 100).toFixed(0)}%）`}`,
  );
  if (result.run !== null) {
    console.log(`    运行 ${(result.run.durationMs / 1000).toFixed(0)}s · 工具 ${result.run.toolCalls} 次 · tokens ${result.run.totalTokens}`);
  }
  if (metrics.issueCodes.length > 0) {
    console.log(`    问题码 ${metrics.issueCodes.join(", ")}`);
  }
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

  const lines: string[] = [
    `# 行程质量评测报告`,
    ``,
    `- 生成时间: ${generatedAt}`,
    ...(providerName === null ? [] : [`- 模型: ${providerName}`]),
    `- 样例: ${summary.evaluated + summary.missing} · 已评测 ${summary.evaluated} · 缺失 ${summary.missing}`,
    `- 均分 ${summary.avgScore.toFixed(1)} · P0 ${summary.totalIssues.P0} / P1 ${summary.totalIssues.P1} / P2 ${summary.totalIssues.P2} · 推荐证据率 ${(summary.avgEvidenceRate * 100).toFixed(0)}%`,
    ``,
    `| 样例 | 状态 | 分数 | P0/P1/P2 | 候选达标 | 证据率 | 游览/天 | 最大空档 | 路线 | 人均/预算 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const result of results) {
    const m = result.metrics;
    lines.push(m === null
      ? `| ${result.evalCase.id} | — | — | — | — | — | — | — | — | ${result.note ?? "无产出"} |`
      : `| ${result.evalCase.id} | ${m.status} | ${m.score} | ${m.issueCounts.P0}/${m.issueCounts.P1}/${m.issueCounts.P2} ` +
        `| ${m.mealSlotsOk}/${m.mealSlotsTotal} | ${(m.mealEvidenceRate * 100).toFixed(0)}% | ${m.visitsPerDay.toFixed(1)} ` +
        `| ${m.maxGapMinutes} 分 | ${m.routeIssueCount} | ¥${Math.round(m.costPerPerson)}/${m.budgetPerPersonYuan ?? "—"} |`,
    );
  }
  lines.push("");
  for (const result of results) {
    if (result.metrics === null) continue;
    lines.push(`## ${result.evalCase.id} · ${result.evalCase.title}`, "");
    lines.push(`问题码: ${result.metrics.issueCodes.join(", ") || "（无）"}`, "");
  }
  await writeFile(`${reportBase}.md`, lines.join("\n"), "utf8");
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

/** 可选参数：`--flag` 后面没跟值（或紧跟另一个 flag）时返回 undefined */
function optionalFlagValue(args: readonly string[], flag: string): string | undefined {
  const value = flagValue(args, flag);
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function helpText(): string {
  return [
    "minicode 行程质量评测",
    "",
    "  npm run eval                          评测 eval/out 下已有产出",
    "  npm run eval -- --live                先用真实模型生成再评测（耗 API 费用）",
    "  npm run eval -- --case <id>           只评测单个样例",
    "  npm run eval -- --profile <id>        live 模式指定模型配置（models.json 的 id）",
    "  npm run eval -- --strict              质量闸门：P0/P1=0、证据率≥80%、全部有产出",
    "",
    "  npm run eval:plans                    评测 plans/ 下的真实产出（零生成费用）",
    "  npm run eval:plans -- --plans-dir <dir>   评测指定目录下的行程文件",
    "  npm run eval:plans -- --diff [name]   与最新（或指定）基线对比",
    "  npm run eval:plans -- --save [name]   把本轮指标存成基线，缺省用时间戳命名",
  ].join("\n");
}
