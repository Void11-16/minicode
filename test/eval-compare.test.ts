import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRuns, renderHtml, renderMarkdown } from "../src/eval/compare.ts";
import type { DashboardAttempt, DashboardRun } from "../src/eval/dashboard-model.ts";

function attempt(overrides: Partial<DashboardAttempt>): DashboardAttempt {
  return {
    number: 1,
    status: "passed",
    score: 90,
    durationMs: 1000,
    calls: 10,
    rounds: 5,
    tokens: 100,
    cost: 0.01,
    issues: { P0: 0, P1: 0, P2: 0 },
    ...overrides,
  };
}

function run(
  id: string,
  architecture: "agent" | "workflow",
  latest: DashboardAttempt,
): DashboardRun {
  return {
    id,
    created: "2026-11-13T00:00:00Z",
    suite: "frozen",
    suiteVersion: "3",
    suiteSize: 1,
    architecture,
    model: architecture === "agent" ? "deepseek / deepseek-chat" : "workflow / rule-v1",
    prompt: architecture === "agent" ? "travel-v1" : "workflow-v1",
    environment: "固定世界 · xian@3",
    environmentKey: "frozen:abc",
    sourceVersions: [architecture],
    cases: [{
      id: "xian",
      title: "西安三日",
      signature: "sig",
      expectedDays: 3,
      requiredVisits: 3,
      status: latest.status,
      attempts: [latest],
    }],
  };
}

test("Agent/Workflow 对照汇总成功率、成本、延迟与逐案 delta", () => {
  const agent = run("agent-run", "agent", attempt({
    status: "quality_failed",
    stage: "quality_gate",
    score: 97,
    issues: { P0: 0, P1: 1, P2: 5 },
    cost: 0.2819,
    durationMs: 43210,
    tokens: 392747,
    rounds: 34,
    calls: 43,
  }));
  const workflow = run("workflow-run", "workflow", attempt({
    status: "passed",
    score: 99,
    issues: { P0: 0, P1: 0, P2: 12 },
    cost: 0,
    durationMs: 3621,
    tokens: 0,
    rounds: 9,
    calls: 23,
  }));

  const report = compareRuns(agent, workflow);
  assert.equal(report.agent.strictRate, 0);
  assert.equal(report.workflow.strictRate, 100);
  assert.equal(report.agent.avgScore, 97);
  assert.equal(report.workflow.avgScore, 99);
  assert.equal(report.agent.avgCostYuan, 0.2819);
  assert.equal(report.workflow.avgCostYuan, 0);
  assert.equal(report.cases[0]?.verdict, "workflow");
  assert.equal(report.cases[0]?.delta.score, -2);
  assert.equal(report.cases[0]?.delta.costYuan, 0.2819);
  assert.equal(report.cases[0]?.delta.durationMs, 39589);
  assert.equal(report.aggregates.workflowWins, 1);
  assert.equal(report.agent.failureStages.quality_gate, 1);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /Agent vs Workflow/);
  assert.match(markdown, /100\.0%/);
  assert.match(markdown, /workflow/);
  const html = renderHtml(report);
  assert.match(html, /成本 - 质量/);
  assert.match(html, /Strict 通过率/);
});

test("套件或数据环境不一致时给出可比性说明", () => {
  const agent = run("agent-run", "agent", attempt({}));
  const workflow = {
    ...run("workflow-run", "workflow", attempt({})),
    suiteVersion: "4",
    environmentKey: "frozen:def",
  };
  const report = compareRuns(agent, workflow);
  assert.ok(report.warnings.some((warning) => warning.includes("套件不一致")));
  assert.ok(report.warnings.some((warning) => warning.includes("数据环境不一致")));
  assert.ok(report.warnings.some((warning) => warning.includes("workflow 无模型调用")));
});

test("缺案例时标为 missing，不把缺失当失败或成功", () => {
  const agent = run("agent-run", "agent", attempt({}));
  const workflow = { ...run("workflow-run", "workflow", attempt({})), cases: [] };
  const report = compareRuns(agent, workflow);
  assert.equal(report.cases[0]?.verdict, "missing");
  assert.equal(report.aggregates.missing, 1);
  assert.equal(report.workflow.cases, 0);
});
