import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExternalWorld, worldSuite } from "../src/eval/external-world.ts";
import { runWorkflowSuite } from "../src/eval/workflow.ts";

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minicode-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("W1 workflow 在固定世界上无模型调用完成 strict 交付", async (t) => {
  const root = await temp(t);
  const worldPath = resolve("eval/worlds/xian-3d.json");
  const { world } = await loadExternalWorld(worldPath);
  const suite = worldSuite(world);
  const manifest = await runWorkflowSuite({
    rootDir: root,
    suitePath: worldPath,
    suite,
    cases: suite.cases,
    runId: "workflow-frozen",
    worldPath,
  });

  assert.equal(manifest.architecture, "workflow");
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.cases[0]?.status, "passed");
  const attempt = manifest.cases[0]?.attempts[0];
  assert.equal(attempt?.status, "passed");
  assert.equal(attempt?.metrics?.issueCounts.P0, 0);
  assert.equal(attempt?.metrics?.issueCounts.P1, 0);
  assert.equal(attempt?.metrics?.days, 3);
  assert.equal(attempt?.telemetry.tokens.total, 0);
  assert.equal(attempt?.telemetry.estimated_cost_yuan, 0);
  assert.ok((attempt?.telemetry.tool_calls ?? 0) > 0);
});
