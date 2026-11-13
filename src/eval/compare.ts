import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDashboardRuns } from "./dashboard.ts";
import type { DashboardAttempt, DashboardCase, DashboardRun } from "./dashboard-model.ts";
import { atomicWrite } from "../tools/plan-files.ts";
import { requireSafeRunId } from "./run-store.ts";

/**
 * Agent vs Workflow 对照报告。
 *
 *   node src/eval/compare.ts --agent <run-id> --workflow <run-id>
 *   npm run eval:compare -- --agent <run-id> --workflow <run-id>
 *
 * 只读既有 live 批次，不重新跑模型；对齐案例后输出 JSON/Markdown/HTML。
 */

export interface AttemptView {
  readonly status: string;
  readonly stage?: string;
  readonly reason?: string;
  readonly passed: boolean;
  readonly score: number | null;
  readonly issues: { readonly P0: number; readonly P1: number; readonly P2: number } | null;
  readonly savedDays: number | null;
  readonly expectedDays: number;
  readonly tokens: number;
  readonly cost: number;
  readonly durationMs: number;
  readonly rounds: number;
  readonly calls: number;
  readonly checks: { readonly passed: number; readonly total: number } | null;
}

export interface CaseComparison {
  readonly id: string;
  readonly title: string;
  readonly expectedDays: number;
  readonly agent: AttemptView | null;
  readonly workflow: AttemptView | null;
  /** agent - workflow；正数表示 agent 更高/更贵/更慢。 */
  readonly delta: {
    readonly score: number | null;
    readonly costYuan: number | null;
    readonly durationMs: number | null;
  };
  readonly verdict: "agent" | "workflow" | "both" | "neither" | "missing";
}

export interface ArchitectureSummary {
  readonly architecture: "agent" | "workflow";
  readonly runId: string;
  readonly model: string;
  readonly environment: string;
  readonly cases: number;
  readonly passed: number;
  readonly strictRate: number;
  readonly avgScore: number | null;
  readonly avgCostYuan: number;
  readonly costPerSuccessYuan: number | null;
  readonly avgDurationMs: number;
  readonly p50DurationMs: number | null;
  readonly p95DurationMs: number | null;
  readonly avgTokens: number;
  readonly avgToolRounds: number;
  readonly avgToolCalls: number;
  readonly failureStages: Readonly<Record<string, number>>;
}

export interface ComparisonReport {
  readonly generated_at: string;
  readonly agent_run_id: string;
  readonly workflow_run_id: string;
  readonly warnings: readonly string[];
  readonly agent: ArchitectureSummary;
  readonly workflow: ArchitectureSummary;
  readonly cases: readonly CaseComparison[];
  readonly aggregates: {
    readonly agentWins: number;
    readonly workflowWins: number;
    readonly ties: number;
    readonly missing: number;
    readonly avgScoreDelta: number | null;
    readonly avgCostDeltaYuan: number | null;
    readonly avgDurationDeltaMs: number | null;
  };
}

export function compareRuns(agent: DashboardRun, workflow: DashboardRun): ComparisonReport {
  const warnings = fairnessWarnings(agent, workflow);
  const cases = alignCases(agent, workflow);
  return {
    generated_at: new Date().toISOString(),
    agent_run_id: agent.id,
    workflow_run_id: workflow.id,
    warnings,
    agent: summarizeRun(agent),
    workflow: summarizeRun(workflow),
    cases,
    aggregates: {
      agentWins: cases.filter((item) => item.verdict === "agent").length,
      workflowWins: cases.filter((item) => item.verdict === "workflow").length,
      ties: cases.filter((item) => item.verdict === "both" || item.verdict === "neither").length,
      missing: cases.filter((item) => item.verdict === "missing").length,
      avgScoreDelta: average(cases.map((item) => item.delta.score).filter(isNumber)),
      avgCostDeltaYuan: average(cases.map((item) => item.delta.costYuan).filter(isNumber)),
      avgDurationDeltaMs: average(cases.map((item) => item.delta.durationMs).filter(isNumber)),
    },
  };
}

function fairnessWarnings(agent: DashboardRun, workflow: DashboardRun): string[] {
  const warnings: string[] = [];
  if (agent.architecture !== "agent") warnings.push(`agent 批次架构是 ${agent.architecture}，不是 agent`);
  if (workflow.architecture !== "workflow") warnings.push(`workflow 批次架构是 ${workflow.architecture}，不是 workflow`);
  if (agent.suite !== workflow.suite || agent.suiteVersion !== workflow.suiteVersion) {
    warnings.push(`套件不一致：${agent.suite}@${agent.suiteVersion} vs ${workflow.suite}@${workflow.suiteVersion}`);
  }
  if (agent.model !== workflow.model) {
    warnings.push(
      agent.architecture === "workflow" || workflow.architecture === "workflow"
        ? `模型口径不同（workflow 无模型调用）：${agent.model} vs ${workflow.model}；成本差异属于架构差异。`
        : `模型不一致：${agent.model} vs ${workflow.model}`,
    );
  }
  if (agent.environmentKey !== workflow.environmentKey) warnings.push(`数据环境不一致：${agent.environment} vs ${workflow.environment}`);
  if (agent.suiteSize !== workflow.suiteSize) warnings.push(`套件案例数不一致：${agent.suiteSize} vs ${workflow.suiteSize}`);
  return warnings;
}

function alignCases(agent: DashboardRun, workflow: DashboardRun): CaseComparison[] {
  const ids = [...new Set([...agent.cases.map((item) => item.id), ...workflow.cases.map((item) => item.id)])].sort();
  return ids.map((id) => {
    const a = agent.cases.find((item) => item.id === id);
    const w = workflow.cases.find((item) => item.id === id);
    const agentView = a ? attemptView(a) : null;
    const workflowView = w ? attemptView(w) : null;
    const verdict = verdictOf(agentView, workflowView);
    return {
      id,
      title: a?.title ?? w?.title ?? id,
      expectedDays: a?.expectedDays ?? w?.expectedDays ?? 0,
      agent: agentView,
      workflow: workflowView,
      delta: {
        score: difference(agentView?.score ?? null, workflowView?.score ?? null),
        costYuan: difference(agentView?.cost ?? null, workflowView?.cost ?? null),
        durationMs: difference(agentView?.durationMs ?? null, workflowView?.durationMs ?? null),
      },
      verdict,
    };
  });
}

function attemptView(item: DashboardCase): AttemptView | null {
  const attempt: DashboardAttempt | undefined = item.attempts.at(-1);
  if (attempt === undefined) return null;
  return {
    status: attempt.status,
    ...(attempt.stage === undefined ? {} : { stage: attempt.stage }),
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    passed: attempt.status === "passed",
    score: attempt.score ?? null,
    issues: attempt.issues ?? null,
    savedDays: attempt.delivery?.materializedDays ?? attempt.savedDays ?? null,
    expectedDays: item.expectedDays,
    tokens: attempt.tokens ?? 0,
    cost: attempt.cost ?? 0,
    durationMs: attempt.durationMs ?? 0,
    rounds: attempt.rounds ?? 0,
    calls: attempt.calls ?? 0,
    checks: attempt.checks ? { passed: attempt.checks.passed, total: attempt.checks.total } : null,
  };
}

function verdictOf(agent: AttemptView | null, workflow: AttemptView | null): CaseComparison["verdict"] {
  if (agent === null || workflow === null) return "missing";
  if (agent.passed && !workflow.passed) return "agent";
  if (!agent.passed && workflow.passed) return "workflow";
  if (agent.passed && workflow.passed) return "both";
  return "neither";
}

function summarizeRun(run: DashboardRun): ArchitectureSummary {
  const attempts = run.cases.flatMap((item) => item.attempts.at(-1) ?? []);
  const passed = attempts.filter((attempt) => attempt.status === "passed").length;
  const scores = attempts.map((attempt) => attempt.score).filter(isNumber);
  const costs = attempts.map((attempt) => attempt.cost ?? 0);
  const durations = attempts.map((attempt) => attempt.durationMs ?? 0);
  const totalCost = costs.reduce((sum, value) => sum + value, 0);
  const failures: Record<string, number> = {};
  for (const attempt of attempts) {
    if (attempt.status === "passed") continue;
    const key = attempt.stage ?? attempt.status;
    failures[key] = (failures[key] ?? 0) + 1;
  }
  return {
    architecture: run.architecture,
    runId: run.id,
    model: run.model,
    environment: run.environment,
    cases: run.cases.length,
    passed,
    strictRate: run.cases.length === 0 ? 0 : (passed / run.cases.length) * 100,
    avgScore: average(scores),
    avgCostYuan: average(costs) ?? 0,
    costPerSuccessYuan: passed === 0 ? null : totalCost / passed,
    avgDurationMs: average(durations) ?? 0,
    p50DurationMs: quantile(durations, 0.5),
    p95DurationMs: quantile(durations, 0.95),
    avgTokens: average(attempts.map((attempt) => attempt.tokens ?? 0)) ?? 0,
    avgToolRounds: average(attempts.map((attempt) => attempt.rounds ?? 0)) ?? 0,
    avgToolCalls: average(attempts.map((attempt) => attempt.calls ?? 0)) ?? 0,
    failureStages: failures,
  };
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const index = Math.floor(position);
  return sorted[index]! + (sorted[Math.ceil(position)]! - sorted[index]!) * (position - index);
}

export function renderMarkdown(report: ComparisonReport): string {
  const lines = [
    `# Agent vs Workflow 对照`,
    "",
    `- 生成: ${report.generated_at}`,
    `- Agent 批次: ${report.agent_run_id}（${report.agent.model}）`,
    `- Workflow 批次: ${report.workflow_run_id}（${report.workflow.model}）`,
    ...(report.warnings.length === 0 ? [] : ["", "## 可比性说明", "", ...report.warnings.map((warning) => `- ${warning}`)]),
    "",
    "## 汇总",
    "",
    "| 指标 | Agent | Workflow |",
    "| --- | ---: | ---: |",
    `| Cases | ${report.agent.cases} | ${report.workflow.cases} |`,
    `| Strict 通过 | ${report.agent.passed} | ${report.workflow.passed} |`,
    `| Strict 通过率 | ${report.agent.strictRate.toFixed(1)}% | ${report.workflow.strictRate.toFixed(1)}% |`,
    `| 平均分 | ${format(report.agent.avgScore)} | ${format(report.workflow.avgScore)} |`,
    `| 平均成本 | ¥${report.agent.avgCostYuan.toFixed(4)} | ¥${report.workflow.avgCostYuan.toFixed(4)} |`,
    `| 单次成功成本 | ${report.agent.costPerSuccessYuan === null ? "—" : `¥${report.agent.costPerSuccessYuan.toFixed(4)}`} | ${report.workflow.costPerSuccessYuan === null ? "—" : `¥${report.workflow.costPerSuccessYuan.toFixed(4)}`} |`,
    `| 平均耗时 | ${seconds(report.agent.avgDurationMs)} | ${seconds(report.workflow.avgDurationMs)} |`,
    `| P50 耗时 | ${seconds(report.agent.p50DurationMs)} | ${seconds(report.workflow.p50DurationMs)} |`,
    `| P95 耗时 | ${seconds(report.agent.p95DurationMs)} | ${seconds(report.workflow.p95DurationMs)} |`,
    `| 平均 Token | ${report.agent.avgTokens.toFixed(0)} | ${report.workflow.avgTokens.toFixed(0)} |`,
    "",
    "## 逐案",
    "",
    "| 案例 | 天数 | Agent | Workflow | 分数差 | 成本差 | 耗时差 | 结论 |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | --- |",
    ...report.cases.map((item) => `| ${escapeTable(item.title)} | ${item.expectedDays} | ${status(item.agent)} | ${status(item.workflow)} | ${signed(item.delta.score)} | ${moneyDelta(item.delta.costYuan)} | ${timeDelta(item.delta.durationMs)} | ${item.verdict} |`),
    "",
    "分数差 / 成本差 / 耗时差均为 **Agent - Workflow**；正数表示 Agent 更高、更贵或更慢。",
    "",
  ];
  return lines.join("\n");
}

export function renderHtml(report: ComparisonReport): string {
  const points = report.cases.flatMap((item) => {
    const rows: { x: number; y: number; label: string; kind: "agent" | "workflow" }[] = [];
    if (item.agent !== null && item.agent.score !== null) rows.push({ x: item.agent.cost, y: item.agent.score, label: `${item.title} · Agent`, kind: "agent" });
    if (item.workflow !== null && item.workflow.score !== null) rows.push({ x: item.workflow.cost, y: item.workflow.score, label: `${item.title} · Workflow`, kind: "workflow" });
    return rows;
  });
  const maxCost = Math.max(0.01, ...points.map((point) => point.x));
  const width = 640, height = 260, padding = 38;
  const px = (x: number) => padding + (x / maxCost) * (width - padding * 2);
  const py = (y: number) => height - padding - (y / 100) * (height - padding * 2);
  const circles = points.map((point) =>
    `<circle cx="${px(point.x).toFixed(1)}" cy="${py(point.y).toFixed(1)}" r="4" fill="${point.kind === "agent" ? "#2563eb" : "#15803d"}"><title>${escapeHtml(point.label)} · ¥${point.x.toFixed(4)} · ${point.y.toFixed(1)}</title></circle>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent vs Workflow 对照</title>
<style>
body{margin:0;background:#f6f8fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.55}
header{padding:30px 24px;background:linear-gradient(135deg,#0f1b33,#1e3a6e 60%,#2563eb);color:#fff}
header h1{margin:0 0 6px;font-size:24px} header p{margin:0;color:#d7e4ff;font-size:13px}
main{max-width:1100px;margin:0 auto;padding:22px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.card{background:#fff;border:1px solid #e4e9f2;border-radius:12px;padding:14px}
.card b{display:block;font-size:11px;color:#667085;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.card strong{font-size:22px} .card small{color:#667085}
section{background:#fff;border:1px solid #e4e9f2;border-radius:12px;padding:16px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:7px 8px;border-bottom:1px solid #eef2f7;text-align:left;vertical-align:top}
th{color:#667085;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600}
.pass{background:#e9f7ef;color:#15803d}.fail{background:#feeceb;color:#b42318}.missing{background:#f2f4f7;color:#475467}
.warn{background:#fff4e5;border:1px solid #f5d9a8;color:#b45309;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12.5px}
.legend{display:flex;gap:16px;color:#667085;font-size:12px;margin-top:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.note{color:#667085;font-size:12px}
@media(max-width:800px){.cards{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1>Agent vs Workflow 对照</h1><p>Agent ${escapeHtml(report.agent_run_id)} · Workflow ${escapeHtml(report.workflow_run_id)} · ${escapeHtml(report.generated_at)}</p></header>
<main>
${report.warnings.length ? `<div class="warn"><strong>可比性说明</strong><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
<div class="cards">
  <div class="card"><b>Strict 通过率</b><strong>${report.agent.strictRate.toFixed(1)}%</strong><small> vs ${report.workflow.strictRate.toFixed(1)}%</small></div>
  <div class="card"><b>平均分</b><strong>${format(report.agent.avgScore)}</strong><small> vs ${format(report.workflow.avgScore)}</small></div>
  <div class="card"><b>平均成本</b><strong>¥${report.agent.avgCostYuan.toFixed(4)}</strong><small> vs ¥${report.workflow.avgCostYuan.toFixed(4)}</small></div>
  <div class="card"><b>P95 耗时</b><strong>${seconds(report.agent.p95DurationMs)}</strong><small> vs ${seconds(report.workflow.p95DurationMs)}</small></div>
</div>
<section><h2>成本 - 质量</h2>
<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="成本质量散点图">
<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#d0d5dd"/>
<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#d0d5dd"/>
<text x="${width - padding}" y="${height - 10}" text-anchor="end" fill="#667085" font-size="11">成本 / 元</text>
<text x="6" y="${padding}" fill="#667085" font-size="11">分数</text>
${circles}
</svg>
<div class="legend"><span><i class="dot" style="background:#2563eb"></i>Agent</span><span><i class="dot" style="background:#15803d"></i>Workflow</span></div>
<p class="note">横轴为单案成本，纵轴为质量分。点越靠左上越好。</p>
</section>
<section><h2>逐案对比</h2><table><thead><tr><th>案例</th><th>天数</th><th>Agent</th><th>Workflow</th><th>分数差</th><th>成本差</th><th>结论</th></tr></thead><tbody>
${report.cases.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td class="num">${item.expectedDays}</td><td>${badge(item.agent)}</td><td>${badge(item.workflow)}</td><td class="num">${signed(item.delta.score)}</td><td class="num">${moneyDelta(item.delta.costYuan)}</td><td>${item.verdict}</td></tr>`).join("")}
</tbody></table><p class="note">分数差 / 成本差为 Agent - Workflow；正数表示 Agent 更高或更贵。</p></section>
<section><h2>失败分类</h2>
<table><thead><tr><th>阶段</th><th>Agent</th><th>Workflow</th></tr></thead><tbody>
${[...new Set([...Object.keys(report.agent.failureStages), ...Object.keys(report.workflow.failureStages)])].sort().map((stage) => `<tr><td>${escapeHtml(stage)}</td><td class="num">${report.agent.failureStages[stage] ?? 0}</td><td class="num">${report.workflow.failureStages[stage] ?? 0}</td></tr>`).join("")}
</tbody></table></section>
</main></body></html>`;
}

function format(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}
function seconds(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(2)}s`;
}
function signed(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
function moneyDelta(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}¥${value.toFixed(4)}`;
}
function timeDelta(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value / 1000).toFixed(2)}s`;
}
function status(view: AttemptView | null): string {
  return view === null ? "—" : `${view.status}${view.score === null ? "" : ` / ${view.score}`}`;
}
function badge(view: AttemptView | null): string {
  if (view === null) return '<span class="badge missing">missing</span>';
  return `<span class="badge ${view.passed ? "pass" : "fail"}">${escapeHtml(view.status)}${view.score === null ? "" : ` · ${view.score}`}</span>`;
}
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export async function writeComparison(report: ComparisonReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await atomicWrite(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(join(directory, "report.md"), `${renderMarkdown(report)}\n`);
  await atomicWrite(join(directory, "report.html"), renderHtml(report));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agentId = flag(args, "--agent") ?? args[0];
  const workflowId = flag(args, "--workflow") ?? args[1];
  if (!agentId || !workflowId) {
    console.error("用法: node src/eval/compare.ts --agent <agent-run-id> --workflow <workflow-run-id>");
    process.exitCode = 1;
    return;
  }
  const root = resolve(import.meta.dirname, "../..");
  const { runs } = await loadDashboardRuns(join(root, "eval", "runs"));
  const agent = runs.find((run) => run.id === requireSafeRunId(agentId));
  const workflow = runs.find((run) => run.id === requireSafeRunId(workflowId));
  if (!agent) throw new Error(`找不到 agent 批次: ${agentId}`);
  if (!workflow) throw new Error(`找不到 workflow 批次: ${workflowId}`);
  const report = compareRuns(agent, workflow);
  const directory = join(root, "eval", "compare", `${agent.id}__vs__${workflow.id}`);
  await writeComparison(report, directory);
  console.log(renderMarkdown(report));
  console.log(`\n报告目录: ${directory}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(`对照报告失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
