import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { parseItinerary } from "../tools/itinerary-schema.ts";
import { atomicWrite } from "../tools/plan-files.ts";
import type { EvalCase } from "./cases.ts";
import { measureDelivery, type DeliveryMetrics } from "./delivery-metrics.ts";
import { requireSafeRunId, type EvalAttemptRecord, type EvalRunManifest } from "./run-store.ts";
import type { DashboardAttempt, DashboardRun } from "./dashboard-model.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function caseSignature({ id, title, request, days, must_visit, budget_per_person_yuan, requirements, taste }: EvalCase): string {
  return createHash("sha256").update(canonical({ id, title, request, days, must_visit, budget_per_person_yuan, requirements, taste })).digest("hex");
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return !!path && !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

/** 历史批次只在可读的最终行程上补数；原批次文件保持原样。 */
async function artifactDelivery(root: string, task: EvalCase, attempt: EvalAttemptRecord): Promise<DeliveryMetrics | undefined> {
  if (!attempt.itinerary_path) return undefined;
  const paths = [join(attempt.output_dir, "final-itinerary.json"), attempt.itinerary_path];
  for (const path of paths) {
    const candidate = resolve(root, path);
    if (!inside(root, candidate)) continue;
    try {
      const file = await realpath(candidate);
      if (!inside(root, file)) continue;
      const plan = parseItinerary(JSON.parse(await readFile(file, "utf8")));
      return measureDelivery(plan, task.must_visit ?? [], task.requirements?.dates);
    } catch { /* 旧行程缺失或格式不支持。留空，不能拿粗排或已保存天数冒充有效交付。 */ }
  }
  return undefined;
}

async function summarizeAttempt(root: string, task: EvalCase, a: EvalAttemptRecord): Promise<DashboardAttempt> {
  const m = a.metrics, t = a.telemetry, d = t?.tool_diagnostics;
  const checks = m?.requirementChecks;
  return {
    number: a.attempt, status: a.status, stage: a.failure?.stage, reason: a.failure?.reason?.slice(0, 1600),
    sourceVersion: a.implementation_sha256, score: m?.score, scoreVersion: m?.scoreVersion, issues: m?.issueCounts,
    issueCodes: m?.issueCodes, savedDays: m?.days, basicDays: m?.basicDays, readyDays: m?.readyDays, checkedDays: m?.checkedDays,
    delivery: m?.delivery ?? await artifactDelivery(root, task, a),
    checks: checks && { passed: checks.filter((check) => check.passed).length, total: checks.length, failed: checks.filter((check) => !check.passed).map((check) => `${check.code}: ${check.message}`) },
    durationMs: t?.duration_ms, rounds: t?.tool_rounds, calls: t?.tool_calls, tokens: t?.tokens?.total, cost: t?.estimated_cost_yuan,
    repeatQueries: d?.queries && { n: d.queries.duplicate_requests, total: d.queries.keyed_requests },
    queryData: d?.queries && { n: d.queries.data_returned, total: d.queries.executed },
    adoptedEvidence: d?.evidence && d.evidence.final_referenced !== null ? { n: d.evidence.final_referenced, total: d.evidence.returned_unique } : undefined,
  };
}

export async function loadDashboardRuns(runsRoot: string): Promise<{ runs: DashboardRun[]; skipped: string[] }> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const runs: DashboardRun[] = [], skipped: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = await realpath(join(runsRoot, entry.name));
    try {
      const raw = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as EvalRunManifest;
      if (raw.mode !== "live" || raw.schema_version !== 1 || !Array.isArray(raw.cases) || !raw.model || !raw.suite || !raw.prompt) {
        skipped.push(entry.name);
        continue;
      }
      if (requireSafeRunId(raw.run_id) !== entry.name) throw new Error("目录与 run_id 不一致");
      const cases = await Promise.all(raw.cases.map(async ({ eval_case: task, status, attempts }) => ({
        id: task.id, title: task.title, signature: caseSignature(task), expectedDays: task.days,
        requiredVisits: task.must_visit?.length ?? 0, status,
        attempts: await Promise.all(attempts.map((a: EvalAttemptRecord) => summarizeAttempt(dir, task, a))),
      })));
      const hashes = new Set(cases.flatMap((c) => c.attempts.map((a) => a.sourceVersion ?? raw.external_data?.implementation_sha256 ?? "")));
      const world = raw.external_data;
      runs.push({
        id: raw.run_id, created: raw.created_at, suite: raw.suite.id, suiteVersion: raw.suite.version, suiteSize: raw.suite.case_count,
        architecture: raw.architecture ?? "agent",
        model: `${raw.model.provider} / ${raw.model.model}`, prompt: raw.prompt.version, customPrompt: raw.prompt.custom_sha256,
        environment: world ? `固定世界 · ${world.id}@${world.version}` : "真实外部数据",
        environmentKey: world ? `frozen:${world.sha256}` : "online",
        budget: raw.budget_policy && canonical(raw.budget_policy), pricing: raw.pricing && canonical(raw.pricing),
        sourceVersions: [...hashes], cases,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped.push(entry.name);
    }
  }
  runs.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  return { runs, skipped };
}

export async function writeDashboard(runsRoot: string, output: string) {
  const data = await loadDashboardRuns(runsRoot);
  const [template, model, client] = await Promise.all(["dashboard.html", "dashboard-model.ts", "dashboard-client.js"].map((file) => readFile(join(import.meta.dirname, file), "utf8")));
  const app = stripTypeScriptTypes(model!);
  const reportBase = relative(dirname(output), runsRoot).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  const json = JSON.stringify({ ...data, reportBase }).replaceAll("<", "\\u003c");
  const html = template!.replace("<!--DASHBOARD_DATA-->", () => json).replace("/*DASHBOARD_APP*/", () => `${app}\n${client}`);
  await mkdir(dirname(output), { recursive: true });
  await atomicWrite(output, html);
  return data;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const root = resolve(import.meta.dirname, "../..");
  const output = join(root, "eval/out/dashboard.html");
  writeDashboard(join(root, "eval/runs"), output).then(({ runs, skipped }) => {
    console.log(`已汇总 ${runs.length} 个评测批次${skipped.length ? `，${skipped.length} 个无法读取` : ""}`);
    console.log(output);
  }).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
