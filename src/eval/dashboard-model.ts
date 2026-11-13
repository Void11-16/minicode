import type { DeliveryMetrics } from "./delivery-metrics.ts";
import type { EvalAttemptStatus } from "./run-store.ts";

export interface DashboardAttempt {
  number: number;
  status: EvalAttemptStatus;
  stage?: string;
  reason?: string;
  sourceVersion?: string;
  score?: number;
  scoreVersion?: string;
  issues?: { P0: number; P1: number; P2: number };
  issueCodes?: readonly string[];
  delivery?: DeliveryMetrics;
  savedDays?: number;
  basicDays?: number;
  readyDays?: number;
  checkedDays?: number;
  checks?: { passed: number; total: number; failed: readonly string[] };
  durationMs?: number;
  rounds?: number;
  calls?: number;
  tokens?: number;
  cost?: number;
  repeatQueries?: { n: number; total: number };
  queryData?: { n: number; total: number };
  adoptedEvidence?: { n: number; total: number };
}

export interface DashboardCase {
  id: string;
  title: string;
  signature: string;
  expectedDays: number;
  requiredVisits: number;
  status: EvalAttemptStatus;
  attempts: DashboardAttempt[];
}

export interface DashboardRun {
  id: string;
  created: string;
  suite: string;
  suiteVersion: string;
  suiteSize: number;
  architecture: "agent" | "workflow";
  model: string;
  prompt: string;
  customPrompt?: string;
  environment: string;
  environmentKey: string;
  budget?: string;
  pricing?: string;
  sourceVersions: string[];
  cases: DashboardCase[];
}

export type AttemptSelection = "first" | "latest";
export type Sample = { task: DashboardCase; attempt?: DashboardAttempt };

export function selectSamples(run: DashboardRun, selection: AttemptSelection): Sample[] {
  return run.cases.map((task) => ({ task, attempt: selection === "first" ? task.attempts[0] : task.attempts.at(-1) }));
}

export function statusOf(sample: Sample): EvalAttemptStatus {
  return sample.attempt?.status ?? sample.task.status;
}

function assessable(sample: Sample): boolean {
  const status = statusOf(sample);
  return ["passed", "quality_failed", "generation_failed"].includes(status)
    && !["provider", "environment"].includes(sample.attempt?.stage ?? "");
}

/** 生成失败明确计零。旧批次缺产物则无法确认时间线，保留未知。 */
export function timedDays(sample: Sample): number | undefined {
  return sample.attempt?.delivery?.materializedDays ?? (statusOf(sample) === "generation_failed" && sample.attempt?.savedDays === undefined ? 0 : undefined);
}

export interface Reading { value: number; n: number; total?: number; samples: number }
export interface Metric {
  key: string;
  label: string;
  group: "交付" | "质量与证据" | "效率";
  unit: "percent" | "number" | "seconds" | "yuan";
  direction: "up" | "down";
  rubric?: boolean;
  price?: boolean;
  description: string;
  read: (samples: Sample[]) => Reading | undefined;
}
function ratio(rows: Sample[], counts: (sample: Sample) => readonly [number, number] | undefined): Reading | undefined {
  let n = 0, total = 0, samples = 0;
  for (const row of rows) {
    const pair = counts(row);
    if (!pair || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1]) || pair[1] <= 0) continue;
    n += pair[0]; total += pair[1]; samples++;
  }
  return total ? { value: n / total * 100, n, total, samples } : undefined;
}
function aggregate(rows: Sample[], pick: (sample: Sample) => number | undefined, reduce: (values: number[]) => number): Reading | undefined {
  const values = rows.map(pick).filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (!values.length) return undefined;
  return { value: reduce(values), n: values.length, samples: values.length };
}
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function quantile(values: number[], percentile: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const index = Math.floor(position);
  return sorted[index]! + (sorted[Math.ceil(position)]! - sorted[index]!) * (position - index);
}

export const performanceMetrics: Metric[] = [
  { key: "strict", label: "Strict 通过率", group: "交付", unit: "percent", direction: "up", rubric: true, description: "最终记录为 passed 的案例占比。",
    read: (s) => ratio(s, (r) => [Number(statusOf(r) === "passed"), 1]) },
  { key: "artifact", label: "行程产出率", group: "交付", unit: "percent", direction: "up", description: "成功留下可读取行程的案例占比。",
    read: (s) => ratio(s, (r) => [Number(r.attempt?.savedDays !== undefined || r.attempt?.delivery !== undefined), 1]) },
  { key: "complete", label: "完整交付率", group: "交付", unit: "percent", direction: "up", description: "有效日期数等于需求天数的案例占比。",
    read: (s) => ratio(s, (r) => { const days = timedDays(r); return days === undefined ? undefined : [Number(days === r.task.expectedDays), 1]; }) },
  { key: "days", label: "有效天数覆盖", group: "交付", unit: "percent", direction: "up", description: "含时间与时长的游览日或符合规则的交通日。超排按需求上限计算。",
    read: (s) => ratio(s, (r) => { const days = timedDays(r); return days === undefined ? undefined : [Math.min(days, r.task.expectedDays), r.task.expectedDays]; }) },
  { key: "must", label: "必去落实率", group: "交付", unit: "percent", direction: "up", description: "按案例要求统计已落到有效游览条目的必去目标。仅粗排预留不计。",
    read: (s) => ratio(s, (r) => { const v = r.attempt?.delivery?.requiredVisits; return v ? [v.scheduled, v.total] : timedDays(r) === 0 ? [0, r.task.requiredVisits] : undefined; }) },
  { key: "ready", label: "日内达标天数", group: "质量与证据", unit: "percent", direction: "up", rubric: true, description: "报告中日内 P0/P1 清零的日期数 ÷ 需求天数。",
    read: (s) => ratio(s, (r) => r.attempt?.readyDays !== undefined ? [r.attempt.readyDays, r.task.expectedDays] : timedDays(r) === 0 ? [0, r.task.expectedDays] : undefined) },
  { key: "requirements", label: "独立需求检查通过", group: "质量与证据", unit: "percent", direction: "up", description: "独立检查通过项 ÷ 已执行项。缺天时未执行的检查不计，需与天数一起读。",
    read: (s) => ratio(s, (r) => r.attempt?.checks && [r.attempt.checks.passed, r.attempt.checks.total]) },
  ...(["P0", "P1"] as const).map((level): Metric => ({ key: level, label: `${level} / 案例`, group: "质量与证据", unit: "number", direction: "down", rubric: true,
    description: "仅对已产生质量报告的案例取平均。无产物案例单列。", read: (s) => aggregate(s, (r) => r.attempt?.issues?.[level], average) })),
  { key: "score", label: "行程质量均分", group: "质量与证据", unit: "number", direction: "up", rubric: true, description: "仅对有分数的案例取平均，需同评分版本。",
    read: (s) => aggregate(s, (r) => r.attempt?.score, average) },
  ...([ ["visitEvidence", "景点证据覆盖"], ["routeEvidence", "已有交通段核验率"] ] as const).map(([key, label]): Metric => ({ key, label, group: "质量与证据", unit: "percent", direction: "up",
    description: "已保存条目中绑定证据的比例。缺失的交通段仍通过质量报告单独判定。", read: (s) => ratio(s, (r) => { const v = r.attempt?.delivery?.[key]; return v && [v.verified, v.total]; }) })),
  ...([ ["rounds", "工具轮次 / 案例"], ["calls", "工具调用 / 案例"], ["tokens", "Token / 案例"], ["cost", "估算成本 / 案例"] ] as const).map(([key, label]): Metric => ({ key, label, group: "效率",
    unit: key === "cost" ? "yuan" : "number", direction: "down", price: key === "cost", description: "所选 attempt 的均值，包含其自动续跑。",
    read: (s) => aggregate(s, (r) => r.attempt?.[key], average) })),
  ...([0.5, 0.95] as const).map((p): Metric => ({ key: `time${p}`, label: `耗时 P${p * 100}`, group: "效率", unit: "seconds", direction: "down",
    description: "所选 attempt 的端到端耗时分位数。小样本仅供参考。", read: (s) => aggregate(s, (r) => r.attempt?.durationMs, (values) => quantile(values, p) / 1000) })),
  ...([ ["repeatQueries", "重复查询率", "down"], ["queryData", "查询有数据率", "up"], ["adoptedEvidence", "证据引用率", "up"] ] as const).map(([key, label, direction]): Metric => ({ key, label, group: "效率", unit: "percent", direction,
    description: key === "adoptedEvidence" ? "检索返回的结构化证据中被最终行程引用的比例。" : "来自工具诊断记录，历史缺埋点时显示为空。",
    read: (s) => ratio(s, (r) => { const v = r.attempt?.[key]; return v && [v.n, v.total]; }) })),
];

export interface CasePair { before: Sample; after: Sample; reason?: string }
export type Verdict = "improved" | "regressed" | "mixed" | "same" | "unavailable";

export function pairCases(before: DashboardRun, after: DashboardRun, selection: AttemptSelection) {
  const left = selectSamples(before, selection), right = selectSamples(after, selection);
  const byId = new Map(left.map((sample) => [sample.task.id, sample]));
  const afterIds = new Set(right.map((sample) => sample.task.id));
  const pairs = right.flatMap((sample): CasePair[] => {
    const prior = byId.get(sample.task.id);
    if (!prior) return [];
    const reason = prior.task.signature !== sample.task.signature ? "案例请求或验收条件不同"
      : !assessable(prior) || !assessable(sample) ? "有外部失败、中断或未完成结果" : undefined;
    return [{ before: prior, after: sample, reason }];
  });
  const reasons = [before.model !== after.model ? "模型不同" : undefined,
    before.environmentKey !== after.environmentKey ? "外部数据环境不同" : undefined,
    before.customPrompt !== after.customPrompt ? "自定义提示词不同" : undefined,
    before.budget !== after.budget ? "轮次预算策略不同" : undefined,
    before.sourceVersions.length > 1 || after.sourceVersions.length > 1 ? "批次包含多个实现版本" : undefined,
  ].filter((reason): reason is string => !!reason);
  const eligible = pairs.filter((pair) => !pair.reason);
  const rubricChanged = eligible.some(({ before: b, after: a }) => b.attempt?.issues && a.attempt?.issues && !sameRubric(b, a));
  return { pairs, eligible, reasons, rubricChanged, onlyBefore: left.filter((s) => !afterIds.has(s.task.id)), onlyAfter: right.filter((s) => !byId.has(s.task.id)) };
}

function sameRubric(before: Sample, after: Sample): boolean {
  return !!before.attempt?.scoreVersion && before.attempt.scoreVersion === after.attempt?.scoreVersion;
}

/** 每项指标独立使用双方都有数据的案例，避免把缺埋点或缺产物当零。 */
export function readPair(metric: Metric, pairs: CasePair[]) {
  const measured = pairs.filter((pair) => metric.read([pair.before]) && metric.read([pair.after])
    && (!metric.rubric || sameRubric(pair.before, pair.after) || metric.key === "strict" && (!pair.before.attempt?.issues || !pair.after.attempt?.issues)));
  const before = metric.read(measured.map((pair) => pair.before));
  const after = metric.read(measured.map((pair) => pair.after));
  return { before, after, paired: measured.length };
}

export function caseVerdict(pair: CasePair): Verdict {
  const { before, after } = pair;
  const bDays = timedDays(before), aDays = timedDays(after);
  if (pair.reason || bDays === undefined || aDays === undefined) return "unavailable";
  if (before.attempt?.issues && after.attempt?.issues && !sameRubric(before, after)) return "unavailable";
  const delta = [Number(statusOf(after) === "passed") - Number(statusOf(before) === "passed"),
    Math.min(aDays, after.task.expectedDays) - Math.min(bDays, before.task.expectedDays)];
  const bRequired = before.attempt?.delivery?.requiredVisits, aRequired = after.attempt?.delivery?.requiredVisits;
  if (bRequired && aRequired) delta.push(aRequired.scheduled - bRequired.scheduled);
  const bIssues = before.attempt?.issues, aIssues = after.attempt?.issues;
  if (bIssues && aIssues) {
    delta.push(bIssues.P0 - aIssues.P0);
    if (bDays === aDays) {
      delta.push(bIssues.P1 - aIssues.P1);
      const bReady = before.attempt?.readyDays, aReady = after.attempt?.readyDays;
      if (bReady !== undefined && aReady !== undefined) delta.push(aReady - bReady);
    }
  }
  const bChecks = before.attempt?.checks, aChecks = after.attempt?.checks;
  if (bChecks && aChecks && bChecks.total === aChecks.total) delta.push(aChecks.passed - bChecks.passed);
  return delta.some((v) => v > 0) ? delta.some((v) => v < 0) ? "mixed" : "improved" : delta.some((v) => v < 0) ? "regressed" : "same";
}
