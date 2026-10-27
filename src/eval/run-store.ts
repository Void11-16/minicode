import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireSafeCaseId, type EvalCase, type EvalSuite } from "./cases.ts";
import type { ItineraryEvalMetrics } from "./metrics.ts";

export type EvalAttemptStatus =
  | "pending"
  | "running"
  | "passed"
  | "quality_failed"
  | "generation_failed"
  | "evaluation_failed"
  | "interrupted"
  | "blocked";

export type EvalRunStatus = "running" | "completed" | "completed_with_failures";

export interface EvalModelInfo {
  readonly profile_id: string;
  readonly profile_name: string;
  readonly provider: string;
  readonly model: string;
}

export interface EvalPromptInfo {
  readonly version: string;
  readonly static_sha256: string;
  readonly custom_sha256: string;
  readonly rendered_sha256: string;
  readonly kind: "default" | "custom";
}

export interface EvalPricing {
  readonly currency: "CNY";
  readonly input_per_million_tokens: number;
  /** 缓存命中输入价；旧批次可能缺省 */
  readonly cache_input_per_million_tokens?: number;
  readonly output_per_million_tokens: number;
  readonly estimated: true;
}

export interface EvalBudgetExtension {
  readonly from_rounds: number;
  readonly to_rounds: number;
  readonly quality_score?: number;
  readonly quality_status?: string;
  readonly issue_counts?: {
    readonly P0: number;
    readonly P1: number;
    readonly P2: number;
  };
  readonly repair_summary: string;
}

export interface EvalAttemptTelemetry {
  readonly duration_ms: number;
  readonly tool_rounds: number;
  readonly tool_calls: number;
  /** runner 为解决未产出或未排满天数而自动追加的用户轮次数 */
  readonly completion_retries?: number;
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
    readonly requests: number;
    readonly cache_hit: number;
  };
  readonly estimated_cost_yuan: number;
  readonly budget: {
    readonly initial_rounds: number;
    readonly current_rounds: number;
    readonly ceiling_rounds: number;
    readonly extensions: readonly EvalBudgetExtension[];
  };
}

export interface EvalAttemptFailure {
  readonly stage: "generation" | "quality_gate" | "evaluation" | "provider" | "interrupted";
  readonly reason: string;
  readonly reasons: readonly string[];
}

export interface EvalAttemptRecord {
  readonly attempt: number;
  readonly case_id: string;
  readonly status: EvalAttemptStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly output_dir: string;
  readonly itinerary_path?: string;
  readonly note?: string;
  readonly failure?: EvalAttemptFailure;
  readonly metrics?: ItineraryEvalMetrics;
  readonly model: EvalModelInfo;
  readonly prompt: EvalPromptInfo;
  readonly pricing: EvalPricing;
  readonly telemetry: EvalAttemptTelemetry;
}

export interface EvalRunCase {
  readonly eval_case: EvalCase;
  readonly status: EvalAttemptStatus;
  readonly attempts: readonly EvalAttemptRecord[];
}

export interface EvalRunManifest {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly status: EvalRunStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly mode: "live";
  readonly suite: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly source: string;
    readonly sha256: string;
    readonly case_count: number;
  };
  readonly filters: {
    readonly case_ids: readonly string[];
    readonly tags: readonly string[];
    readonly limit?: number;
  };
  readonly model: EvalModelInfo;
  readonly prompt: {
    readonly version: string;
    readonly static_sha256: string;
    readonly custom_sha256: string;
  };
  readonly pricing: EvalPricing;
  readonly budget_policy: {
    readonly fallback_rounds: number;
    readonly ceiling_rounds: number;
    readonly extension_step: number;
  };
  readonly cases: readonly EvalRunCase[];
}

export interface EvalRunSummary {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly running: number;
  readonly attempts: number;
  readonly tool_rounds: number;
  readonly tool_calls: number;
  readonly tokens: number;
  readonly estimated_cost_yuan: number;
}

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function requireSafeRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error("run id 只能包含字母、数字、点、下划线和连字符，最长 80 字符");
  }
  return value;
}

export function runDirectory(rootDir: string, runId: string): string {
  return join(rootDir, requireSafeRunId(runId));
}

export function attemptDirectory(rootDir: string, runId: string, caseId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt <= 0) throw new Error("attempt 需要正整数");
  return join(
    runDirectory(rootDir, runId),
    "cases",
    requireSafeCaseId(caseId, "case id"),
    `attempt-${attempt}`,
  );
}

/** 创建新批次；目录已存在时立即失败，绝不覆盖上一批 */
export async function createRun(
  rootDir: string,
  manifest: EvalRunManifest,
  suite: EvalSuite,
): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  const directory = runDirectory(rootDir, manifest.run_id);
  await mkdir(directory);
  await writeJsonAtomic(join(directory, "suite.json"), suite);
  await writeManifest(rootDir, manifest);
  await writeRunArtifacts(rootDir, manifest);
  return directory;
}

export async function loadManifest(rootDir: string, runId: string): Promise<EvalRunManifest> {
  const file = join(runDirectory(rootDir, runId), "manifest.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as EvalRunManifest;
  } catch (error) {
    throw new Error(`${file}: 批次不存在或 manifest 无法解析（${error instanceof Error ? error.message : String(error)}）`);
  }
}

export async function loadSuiteSnapshot(rootDir: string, runId: string): Promise<EvalSuite> {
  const file = join(runDirectory(rootDir, runId), "suite.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as EvalSuite;
  } catch (error) {
    throw new Error(`${file}: 批次套件快照不存在或无法解析（${error instanceof Error ? error.message : String(error)}）`);
  }
}

export async function writeManifest(rootDir: string, manifest: EvalRunManifest): Promise<void> {
  await writeJsonAtomic(join(runDirectory(rootDir, manifest.run_id), "manifest.json"), manifest);
}

export async function createAttemptDirectory(
  rootDir: string,
  runId: string,
  caseId: string,
  attempt: number,
): Promise<string> {
  const file = attemptDirectory(rootDir, runId, caseId, attempt);
  await mkdir(join(file, ".."), { recursive: true });
  await mkdir(file);
  return file;
}

export async function writeAttemptRecord(
  rootDir: string,
  runId: string,
  record: EvalAttemptRecord,
): Promise<void> {
  const directory = attemptDirectory(rootDir, runId, record.case_id, record.attempt);
  await writeJsonAtomic(join(directory, "attempt.json"), record);
}

export function upsertAttempt(manifest: EvalRunManifest, record: EvalAttemptRecord): EvalRunManifest {
  return {
    ...manifest,
    updated_at: new Date().toISOString(),
    cases: manifest.cases.map((item) => {
      if (item.eval_case.id !== record.case_id) return item;
      const attempts = [
        ...item.attempts.filter((attempt) => attempt.attempt !== record.attempt),
        record,
      ].sort((a, b) => a.attempt - b.attempt);
      return {
        ...item,
        status: record.status,
        attempts,
      };
    }),
  };
}

export function nextAttemptNumber(manifest: EvalRunManifest, caseId: string): number {
  const item = manifest.cases.find((candidate) => candidate.eval_case.id === caseId);
  if (item === undefined) throw new Error(`批次中没有案例: ${caseId}`);
  return Math.max(0, ...item.attempts.map((attempt) => attempt.attempt)) + 1;
}

/**
 * 以磁盘上已经创建的 attempt 目录为准继续编号。
 * 进程可能在创建目录、写 attempt.json、更新 manifest 之间崩溃，只以 manifest
 * 计号会重新创建同一个目录并让整个续跑失败。
 */
export async function nextAvailableAttemptNumber(
  rootDir: string,
  runId: string,
  caseId: string,
): Promise<number> {
  const manifestAttempt = nextAttemptNumber(
    await loadManifest(rootDir, runId),
    requireSafeCaseId(caseId, "case id"),
  );
  const directory = join(runDirectory(rootDir, runId), "cases", caseId);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const diskAttempt = Math.max(
    0,
    ...names.flatMap((name) => {
      const match = /^attempt-(\d+)$/.exec(name);
      return match === null ? [] : [Number(match[1])];
    }),
  );
  return Math.max(manifestAttempt, diskAttempt + 1);
}

/** 已通过的案例不再重跑；失败、阻断、解析失败和中断的案例进入新 attempt */
export function casesToResume(manifest: EvalRunManifest): readonly EvalRunCase[] {
  return manifest.cases.filter((item) => item.status !== "passed");
}

/** 进程在 attempt 中途退出时，下次 resume 将其视为中断而不是仍在运行 */
export function markRunningAttemptsInterrupted(
  manifest: EvalRunManifest,
  now: string = new Date().toISOString(),
): EvalRunManifest {
  return {
    ...manifest,
    updated_at: now,
    status: "completed_with_failures",
    cases: manifest.cases.map((item) => {
      const interrupted = item.attempts.map((attempt) =>
        attempt.status === "running"
          ? {
              ...attempt,
              status: "interrupted" as const,
              finished_at: now,
              failure: {
                stage: "interrupted" as const,
                reason: "上次批次在 attempt 完成前中断",
                reasons: ["上次批次在 attempt 完成前中断"],
              },
            }
          : attempt
      );
      const latest = interrupted.at(-1);
      return latest === undefined ? item : { ...item, status: latest.status, attempts: interrupted };
    }),
  };
}

export function finalizeRun(
  manifest: EvalRunManifest,
  status: EvalRunStatus = manifest.cases.every((item) => item.status === "passed")
    ? "completed"
    : "completed_with_failures",
): EvalRunManifest {
  return { ...manifest, status, updated_at: new Date().toISOString() };
}

export function summarizeRun(manifest: EvalRunManifest): EvalRunSummary {
  const attempts = manifest.cases.flatMap((item) => item.attempts);
  return {
    cases: manifest.cases.length,
    passed: manifest.cases.filter((item) => item.status === "passed").length,
    failed: manifest.cases.filter(
      (item) => item.status !== "passed" && item.status !== "running" && item.status !== "pending",
    ).length,
    running: manifest.cases.filter((item) => item.status === "running" || item.status === "pending").length,
    attempts: attempts.length,
    tool_rounds: attempts.reduce((sum, attempt) => sum + attempt.telemetry.tool_rounds, 0),
    tool_calls: attempts.reduce((sum, attempt) => sum + attempt.telemetry.tool_calls, 0),
    tokens: attempts.reduce((sum, attempt) => sum + attempt.telemetry.tokens.total, 0),
    estimated_cost_yuan: attempts.reduce((sum, attempt) => sum + attempt.telemetry.estimated_cost_yuan, 0),
  };
}

export async function writeRunArtifacts(rootDir: string, manifest: EvalRunManifest): Promise<void> {
  const directory = runDirectory(rootDir, manifest.run_id);
  const summary = summarizeRun(manifest);
  await writeJsonAtomic(join(directory, "report.json"), {
    ...manifest,
    summary,
  });
  await writeFile(join(directory, "report.md"), renderReport(manifest, summary), "utf8");
}

function renderReport(manifest: EvalRunManifest, summary: EvalRunSummary): string {
  const lines = [
    `# 评测批次 ${manifest.run_id}`,
    "",
    `- 状态: ${manifest.status}`,
    `- 套件: ${manifest.suite.id}@${manifest.suite.version}（${manifest.suite.name}）`,
    `- 模型: ${manifest.model.provider} / ${manifest.model.model}（${manifest.model.profile_name}）`,
    `- 提示词: ${manifest.prompt.version} · ${manifest.prompt.static_sha256.slice(0, 12)}`,
    `- 自定义提示词: ${manifest.prompt.custom_sha256.slice(0, 12)}`,
    `- 创建: ${manifest.created_at}`,
    `- 更新: ${manifest.updated_at}`,
    `- 案例: ${summary.cases} · 通过 ${summary.passed} · 未通过 ${summary.failed} · 运行中 ${summary.running}`,
    `- 累计 attempt: ${summary.attempts} · 工具轮次 ${summary.tool_rounds} · 工具调用 ${summary.tool_calls}`,
    `- Token: ${summary.tokens} · 估算成本 ¥${summary.estimated_cost_yuan.toFixed(4)}`,
    "",
    "| 案例 | 最新状态 | attempt | 分数 | 天数 | P0/P1/P2 | 轮次 | Token | 成本 | 耗时 | 失败原因 |",
    "| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of manifest.cases) {
    const latest = item.attempts.at(-1);
    lines.push(
      `| ${item.eval_case.id} | ${item.status} | ${item.attempts.length} | ${latest?.metrics?.score ?? "—"} ` +
      `| ${dayCounts(latest?.metrics)} | ${issueCounts(latest?.metrics)} | ${latest?.telemetry.tool_rounds ?? "—"} ` +
      `| ${latest?.telemetry.tokens.total ?? "—"} | ¥${(latest?.telemetry.estimated_cost_yuan ?? 0).toFixed(4)} ` +
      `| ${latest === undefined ? "—" : formatDuration(latest.telemetry.duration_ms)} ` +
      `| ${escapeTable(latest?.failure?.reason ?? "")} |`,
    );
  }
  lines.push("", "## Attempts", "");
  for (const item of manifest.cases) {
    if (item.attempts.length === 0) {
      lines.push(`### ${item.eval_case.id}`, "", "尚未运行。", "");
      continue;
    }
    lines.push(`### ${item.eval_case.id}`, "");
    for (const attempt of item.attempts) {
      lines.push(
        `- attempt-${attempt.attempt}: ${attempt.status} · ${formatDuration(attempt.telemetry.duration_ms)} · ` +
        `${dayCounts(attempt.metrics)} 天 · ` +
        `${attempt.telemetry.tool_rounds} 轮 / ${attempt.telemetry.tool_calls} 次调用 · ` +
        `${attempt.telemetry.completion_retries ?? 0} 次自动续跑 · ` +
        `${attempt.telemetry.tokens.total} tokens · ¥${attempt.telemetry.estimated_cost_yuan.toFixed(4)}` +
        (attempt.failure === undefined ? "" : ` · ${attempt.failure.reason}`),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function issueCounts(metrics: ItineraryEvalMetrics | undefined): string {
  if (metrics === undefined) return "—";
  return `${metrics.issueCounts.P0}/${metrics.issueCounts.P1}/${metrics.issueCounts.P2}`;
}

function dayCounts(metrics: ItineraryEvalMetrics | undefined): string {
  if (metrics === undefined) return "—";
  return `${metrics.days}/${metrics.expectedDays}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
