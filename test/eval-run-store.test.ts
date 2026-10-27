import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalSuite } from "../src/eval/cases.ts";
import {
  attemptDirectory,
  casesToResume,
  createAttemptDirectory,
  createRun,
  finalizeRun,
  markRunningAttemptsInterrupted,
  nextAttemptNumber,
  nextAvailableAttemptNumber,
  runDirectory,
  summarizeRun,
  upsertAttempt,
  writeAttemptRecord,
  writeManifest,
  type EvalAttemptRecord,
  type EvalAttemptStatus,
  type EvalModelInfo,
  type EvalPricing,
  type EvalPromptInfo,
  type EvalRunManifest,
} from "../src/eval/run-store.ts";

const model: EvalModelInfo = {
  profile_id: "deepseek-chat",
  profile_name: "DeepSeek",
  provider: "deepseek",
  model: "deepseek-chat",
};

const pricing: EvalPricing = {
  currency: "CNY",
  input_per_million_tokens: 2,
  output_per_million_tokens: 3,
  estimated: true,
};

const prompt: EvalPromptInfo = {
  version: "travel-v1",
  static_sha256: "static-hash",
  custom_sha256: "custom-hash",
  rendered_sha256: "rendered-hash",
  kind: "default",
};

const beijing: EvalCase = {
  id: "beijing-3d",
  title: "北京三日游",
  days: 3,
  budget_per_person_yuan: 2500,
  tags: ["representative", "popular"],
  request: "去北京三天",
};

const chifeng: EvalCase = {
  id: "chifeng-7d",
  title: "赤峰七日游",
  days: 7,
  tags: ["representative", "remote-day"],
  request: "去赤峰七天",
};

const suite: EvalSuite = {
  id: "representative",
  name: "代表案例",
  version: "2026.10",
  cases: [beijing, chifeng],
};

function manifest(runId: string): EvalRunManifest {
  return {
    schema_version: 1,
    run_id: runId,
    status: "running",
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
    mode: "live",
    suite: {
      id: suite.id,
      name: suite.name,
      version: suite.version,
      source: "eval/suites/representative.json",
      sha256: "suite-hash",
      case_count: suite.cases.length,
    },
    filters: { case_ids: [], tags: ["representative"] },
    model,
    prompt: {
      version: prompt.version,
      static_sha256: prompt.static_sha256,
      custom_sha256: prompt.custom_sha256,
    },
    pricing,
    budget_policy: {
      fallback_rounds: 30,
      ceiling_rounds: 150,
      extension_step: 15,
    },
    cases: suite.cases.map((evalCase) => ({
      eval_case: evalCase,
      status: "pending",
      attempts: [],
    })),
  };
}

function attempt(
  caseId: string,
  number: number,
  status: EvalAttemptStatus,
  overrides: Partial<EvalAttemptRecord> = {},
): EvalAttemptRecord {
  return {
    attempt: number,
    case_id: caseId,
    status,
    started_at: `2026-10-26T00:0${number}:00.000Z`,
    ...(status === "running" ? {} : { finished_at: `2026-10-26T00:0${number}:30.000Z` }),
    output_dir: `cases/${caseId}/attempt-${number}`,
    model,
    prompt,
    pricing,
    telemetry: {
      duration_ms: 30_000,
      tool_rounds: number * 3,
      tool_calls: number * 5,
      completion_retries: 0,
      tokens: {
        prompt: 1000,
        completion: 200,
        total: 1200,
        requests: number * 4,
        cache_hit: 300,
      },
      estimated_cost_yuan: 0.0123,
      budget: {
        initial_rounds: 28,
        current_rounds: 43,
        ceiling_rounds: 150,
        extensions: [{
          from_rounds: 28,
          to_rounds: 43,
          quality_score: 86,
          repair_summary: "补交通并复验",
        }],
      },
    },
    ...(status === "quality_failed"
      ? {
          failure: {
            stage: "quality_gate" as const,
            reason: "P0 0 / P1 1",
            reasons: ["P0 0 / P1 1"],
          },
        }
      : {}),
    ...overrides,
  };
}

test("评测批次: 新批次生成完整报告，重复 run id 绝不覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-eval-run-"));
  const run = manifest("20261026-example");
  await createRun(root, run, suite);

  const report = JSON.parse(await readFile(join(runDirectory(root, run.run_id), "report.json"), "utf8"));
  assert.equal(report.run_id, run.run_id);
  assert.equal(report.model.model, "deepseek-chat");
  assert.equal(report.prompt.version, "travel-v1");
  assert.equal(report.pricing.estimated, true);
  assert.deepEqual(report.summary, {
    cases: 2,
    passed: 0,
    failed: 0,
    running: 2,
    attempts: 0,
    tool_rounds: 0,
    tool_calls: 0,
    tokens: 0,
    estimated_cost_yuan: 0,
  });

  await assert.rejects(() => createRun(root, run, suite), /EEXIST|file already exists/i);
});

test("attempt: 记录追加、汇总、失败续跑和通过后跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-eval-attempt-"));
  let run = manifest("run-attempts");
  await createRun(root, run, suite);

  const first = attempt(beijing.id, 1, "quality_failed");
  await createAttemptDirectory(root, run.run_id, beijing.id, 1);
  await writeAttemptRecord(root, run.run_id, first);
  run = upsertAttempt(run, first);
  assert.equal(nextAttemptNumber(run, beijing.id), 2);
  assert.deepEqual(casesToResume(run).map((item) => item.eval_case.id), [beijing.id, chifeng.id]);

  const second = attempt(beijing.id, 2, "passed");
  await createAttemptDirectory(root, run.run_id, beijing.id, 2);
  await writeAttemptRecord(root, run.run_id, second);
  run = upsertAttempt(run, second);
  assert.deepEqual(casesToResume(run).map((item) => item.eval_case.id), [chifeng.id]);

  const summary = summarizeRun(run);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.running, 1);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.tool_rounds, 9);
  assert.equal(summary.tool_calls, 15);
  assert.equal(summary.tokens, 2400);
  assert.equal(summary.estimated_cost_yuan, 0.0246);
});

test("attempt: 崩溃留下的目录也会占号，续跑不会撞到已有目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-eval-orphan-"));
  const run = manifest("run-orphan");
  await createRun(root, run, suite);
  await createAttemptDirectory(root, run.run_id, beijing.id, 1);
  await createAttemptDirectory(root, run.run_id, beijing.id, 2);

  assert.equal(await nextAvailableAttemptNumber(root, run.run_id, beijing.id), 3);
});

test("resume: 运行中的 attempt 标记为中断，并保留失败原因", () => {
  const run = manifest("run-interrupted");
  const running = attempt(beijing.id, 1, "running");
  const withRunning: EvalRunManifest = {
    ...run,
    cases: [{
      eval_case: beijing,
      status: "running",
      attempts: [running],
    }],
  };

  const interrupted = markRunningAttemptsInterrupted(
    withRunning,
    "2026-10-26T01:00:00.000Z",
  );
  const record = interrupted.cases[0].attempts[0];
  assert.equal(interrupted.status, "completed_with_failures");
  assert.equal(record.status, "interrupted");
  assert.equal(record.finished_at, "2026-10-26T01:00:00.000Z");
  assert.equal(record.failure?.stage, "interrupted");
  assert.match(record.failure?.reason ?? "", /中断/);
  assert.equal(interrupted.cases[0].status, "interrupted");
});

test("评测路径: 非法 run id / case id 不能逃出批次目录", () => {
  assert.throws(() => runDirectory("/tmp/runs", "../escape"), /run id/);
  assert.throws(() => attemptDirectory("/tmp/runs", "safe-run", "../escape", 1), /case id/);
  assert.throws(() => attemptDirectory("/tmp/runs", "safe-run", "safe-case", 0), /正整数/);
});

test("最终状态: 只有全部案例通过才算 completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-eval-final-"));
  let run = manifest("run-final");
  await createRun(root, run, suite);
  const passed = attempt(beijing.id, 1, "passed");
  await createAttemptDirectory(root, run.run_id, beijing.id, 1);
  await writeAttemptRecord(root, run.run_id, passed);
  run = upsertAttempt(run, passed);
  assert.equal(finalizeRun(run).status, "completed_with_failures");

  const second = attempt(chifeng.id, 1, "passed");
  await createAttemptDirectory(root, run.run_id, chifeng.id, 1);
  await writeAttemptRecord(root, run.run_id, second);
  run = finalizeRun(upsertAttempt(run, second));
  await writeManifest(root, run);
  assert.equal(run.status, "completed");
});
