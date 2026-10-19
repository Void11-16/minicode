import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ItineraryEvalMetrics } from "./metrics.ts";

/**
 * 基线快照：一次评测的关键指标，落成可提交、可对比的 JSON。
 * 只存数字不存行程正文 —— 正文每次生成都不同、体积又大，
 * 而"这轮改动是优化还是削弱"只需要同一批样本上的指标差。
 */
export interface BaselineSample {
  readonly id: string;
  readonly title: string;
  readonly days: number;
  readonly status: string;
  readonly score: number;
  readonly issues: { readonly P0: number; readonly P1: number; readonly P2: number };
  readonly issueCodes: readonly string[];
  readonly evidenceRate: number;
  readonly mealSlotsOk: number;
  readonly mealSlotsTotal: number;
  readonly visitsPerDay: number;
  readonly maxGapMinutes: number;
  readonly routeIssueCount: number;
  readonly costPerPerson: number;
}

export interface Baseline {
  readonly generated_at: string;
  readonly mode: string;
  /** 未能评测的样本 id（解析失败/无产出）；对比时要能看出样本掉了 */
  readonly missing: readonly string[];
  readonly samples: readonly BaselineSample[];
}

export interface BaselineInput {
  readonly id: string;
  readonly title: string;
  readonly metrics: ItineraryEvalMetrics | null;
}

export function baselineFromResults(results: readonly BaselineInput[], mode: string): Baseline {
  return {
    generated_at: new Date().toISOString(),
    mode,
    missing: results.filter((result) => result.metrics === null).map((result) => result.id),
    samples: results.flatMap((result) =>
      result.metrics === null ? [] : [sampleFrom(result.id, result.title, result.metrics)]),
  };
}

function sampleFrom(id: string, title: string, metrics: ItineraryEvalMetrics): BaselineSample {
  return {
    id,
    title,
    days: metrics.days,
    status: metrics.status,
    score: metrics.score,
    issues: metrics.issueCounts,
    issueCodes: [...metrics.issueCodes],
    evidenceRate: metrics.mealEvidenceRate,
    mealSlotsOk: metrics.mealSlotsOk,
    mealSlotsTotal: metrics.mealSlotsTotal,
    visitsPerDay: metrics.visitsPerDay,
    maxGapMinutes: metrics.maxGapMinutes,
    routeIssueCount: metrics.routeIssueCount,
    costPerPerson: metrics.costPerPerson,
  };
}

export async function saveBaseline(path: string, baseline: Baseline): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export async function loadBaseline(path: string): Promise<Baseline> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Baseline;
  } catch (error) {
    throw new Error(`${path}: 基线不存在或无法解析（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 基线目录里文件名排序最靠后的一个（命名用时间戳时即为最新） */
export async function latestBaseline(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`${dir}: 还没有基线（先运行 --save 保存一份）`);
  return join(dir, names[names.length - 1]);
}

/** improved/regressed 只统计"同一份样本的指标变化"；样本增删和未评测单列为 incomparable */
export type DiffVerdict = "improved" | "regressed" | "same" | "incomparable";

export interface DiffRow {
  readonly id: string;
  readonly title: string;
  readonly kind: "changed" | "same" | "added" | "removed" | "missing";
  readonly verdict: DiffVerdict;
  readonly before: BaselineSample | null;
  readonly after: BaselineSample | null;
}

export interface BaselineDiff {
  readonly beforeGeneratedAt: string;
  readonly rows: readonly DiffRow[];
  readonly improved: number;
  readonly regressed: number;
}

export function diffBaselines(before: Baseline, after: Baseline): BaselineDiff {
  const ids = [...new Set([
    ...before.samples.map((sample) => sample.id),
    ...before.missing,
    ...after.samples.map((sample) => sample.id),
    ...after.missing,
  ])].sort();
  const rows = ids.map((id) => rowFor(id, before, after));
  return {
    beforeGeneratedAt: before.generated_at,
    rows,
    improved: rows.filter((row) => row.verdict === "improved").length,
    regressed: rows.filter((row) => row.verdict === "regressed").length,
  };
}

function rowFor(id: string, before: Baseline, after: Baseline): DiffRow {
  const previous = before.samples.find((sample) => sample.id === id) ?? null;
  const current = after.samples.find((sample) => sample.id === id) ?? null;
  const kind = kindFor(previous, current, after.missing.includes(id));
  return {
    id,
    title: current?.title ?? previous?.title ?? id,
    kind,
    verdict: verdictOf(kind, previous, current),
    before: previous,
    after: current,
  };
}

function verdictOf(
  kind: DiffRow["kind"],
  previous: BaselineSample | null,
  current: BaselineSample | null,
): DiffVerdict {
  if (kind === "same") return "same";
  if (kind === "changed" && previous !== null && current !== null) return verdictFor(previous, current);
  return "incomparable";
}

function kindFor(
  previous: BaselineSample | null,
  current: BaselineSample | null,
  reportedMissing: boolean,
): DiffRow["kind"] {
  if (current === null) {
    if (previous === null) return "missing";
    return reportedMissing ? "missing" : "removed";
  }
  if (previous === null) return "added";
  return isSameSample(previous, current) ? "same" : "changed";
}

function isSameSample(before: BaselineSample, after: BaselineSample): boolean {
  return before.score === after.score
    && before.status === after.status
    && before.days === after.days
    && before.issues.P0 === after.issues.P0
    && before.issues.P1 === after.issues.P1
    && before.issues.P2 === after.issues.P2
    && sameCodes(before.issueCodes, after.issueCodes)
    && metricLine(before, after) === "";
}

function sameCodes(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((code) => after.includes(code));
}

/** 先看分数、再看硬问题数、最后看推荐证据率 —— 变好/变差的口径 */
function verdictFor(before: BaselineSample, after: BaselineSample): DiffVerdict {
  const scoreDelta = after.score - before.score;
  if (scoreDelta !== 0) return scoreDelta > 0 ? "improved" : "regressed";
  const issueDelta = (after.issues.P0 + after.issues.P1) - (before.issues.P0 + before.issues.P1);
  if (issueDelta !== 0) return issueDelta < 0 ? "improved" : "regressed";
  const evidenceDelta = after.evidenceRate - before.evidenceRate;
  if (evidenceDelta === 0) return "same";
  return evidenceDelta > 0 ? "improved" : "regressed";
}

export function renderBaselineDiff(diff: BaselineDiff, baselineLabel: string): string[] {
  const lines: string[] = [
    "",
    "————————————————————————————————————",
    `对比基线 ${baselineLabel}（生成于 ${new Date(diff.beforeGeneratedAt).toLocaleString("zh-CN")}）`,
    "",
  ];
  for (const row of diff.rows) lines.push(...renderRow(row));
  const changed = diff.rows.filter((row) => row.kind === "changed").length;
  lines.push(
    "",
    `样本 ${diff.rows.length} · 有变化 ${changed} · 改善 ${diff.improved} · 变差 ${diff.regressed}`,
    "",
  );
  return lines;
}

function renderRow(row: DiffRow): string[] {
  if (row.kind === "added") return [`＋ ${row.id} 新增样本（评分 ${row.after?.score ?? "—"}）`];
  if (row.kind === "removed") return [`－ ${row.id} 本次样本消失`];
  if (row.kind === "missing") return [`⚠ ${row.id} 本次未评测（解析失败或无产出）`];
  if (row.before === null || row.after === null) return [`${row.id} 无对比数据`];
  if (row.kind === "same") return [`= ${row.id} 无变化`];

  const marker = row.verdict === "improved" ? "改善" : row.verdict === "regressed" ? "变差" : "变化";
  const head: string[] = [];
  if (row.before.score !== row.after.score) head.push(`评分 ${row.before.score} → ${row.after.score}（${signed(row.after.score - row.before.score)}）`);
  if (row.before.status !== row.after.status) head.push(`状态 ${row.before.status} → ${row.after.status}`);
  const lines = [`${marker === "改善" ? "↑" : marker === "变差" ? "↓" : "·"} ${row.id} ${marker}${head.length === 0 ? "" : ` · ${head.join(" · ")}`}`];
  const issues = issueLine(row.before, row.after);
  if (issues !== "") lines.push(`    ${issues}`);
  const metrics = metricLine(row.before, row.after);
  if (metrics !== "") lines.push(`    ${metrics}`);
  return lines;
}

function issueLine(before: BaselineSample, after: BaselineSample): string {
  const parts: string[] = [];
  if (counts(before) !== counts(after)) parts.push(`问题 ${counts(before)} → ${counts(after)}`);
  const added = after.issueCodes.filter((code) => !before.issueCodes.includes(code));
  const removed = before.issueCodes.filter((code) => !after.issueCodes.includes(code));
  if (added.length > 0) parts.push(`新增问题码 ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`消失问题码 ${removed.join(", ")}`);
  return parts.join(" · ");
}

function metricLine(before: BaselineSample, after: BaselineSample): string {
  const parts: string[] = [];
  if (before.evidenceRate !== after.evidenceRate) parts.push(`证据率 ${pct(before.evidenceRate)} → ${pct(after.evidenceRate)}`);
  if (before.mealSlotsOk !== after.mealSlotsOk || before.mealSlotsTotal !== after.mealSlotsTotal) {
    parts.push(`候选达标 ${before.mealSlotsOk}/${before.mealSlotsTotal} → ${after.mealSlotsOk}/${after.mealSlotsTotal}`);
  }
  if (before.visitsPerDay !== after.visitsPerDay) {
    parts.push(`游览 ${before.visitsPerDay.toFixed(1)} → ${after.visitsPerDay.toFixed(1)}/天`);
  }
  if (before.maxGapMinutes !== after.maxGapMinutes) parts.push(`最大空档 ${before.maxGapMinutes} → ${after.maxGapMinutes} 分`);
  if (before.routeIssueCount !== after.routeIssueCount) parts.push(`路线问题 ${before.routeIssueCount} → ${after.routeIssueCount}`);
  if (Math.round(before.costPerPerson) !== Math.round(after.costPerPerson)) {
    parts.push(`人均 ¥${Math.round(before.costPerPerson)} → ¥${Math.round(after.costPerPerson)}`);
  }
  if (before.days !== after.days) parts.push(`天数 ${before.days} → ${after.days}`);
  return parts.join(" · ");
}

function counts(sample: BaselineSample): string {
  return `${sample.issues.P0}/${sample.issues.P1}/${sample.issues.P2}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}
