import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactToolResults,
  TOOL_RESULT_BATCH_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
} from "../src/agent/tool-output.ts";

test("大工具结果落盘为 artifact，上下文只保留有界预览", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-output-"));
  const firstOutput = [
    "头部摘要",
    "普通内容".repeat(1_200),
    "类型 古迹",
    "坐标 39.9163,116.3972",
    "尾部结果",
  ].join("\n");
  const secondOutput = `第二个结果\n${"候选数据".repeat(1_000)}`;
  const compacted = await compactToolResults([
    {
      callId: "call/../first",
      toolName: "search_attractions",
      output: firstOutput,
      outputKind: "place-list",
    },
    {
      callId: "call-second",
      toolName: "load_itinerary",
      output: secondOutput,
      outputKind: "itinerary",
    },
  ], {
    workspace,
    sessionId: "session/../one",
  });

  assert.equal(compacted.length, 2);
  assert.ok(compacted[0].truncated);
  assert.ok(compacted[1].truncated);
  assert.ok(compacted.every((item) => item.text.length <= TOOL_RESULT_MAX_CHARS));
  assert.ok(
    compacted.reduce((sum, item) => sum + item.text.length, 0) <= TOOL_RESULT_BATCH_MAX_CHARS,
  );
  assert.match(compacted[0].text, /^\[tool-result type=place-list chars=\d+\] truncated=true artifact=/);
  assert.match(compacted[0].text, /类型 古迹|坐标 39\.9163,116\.3972/);

  assert.ok(compacted[0].artifactPath !== undefined);
  assert.ok(!compacted[0].artifactPath.includes(".."));
  assert.equal(await readFile(join(workspace, compacted[0].artifactPath), "utf8"), firstOutput);
  assert.equal(
    await readFile(join(workspace, compacted[1].artifactPath ?? ""), "utf8"),
    secondOutput,
  );
});

test("并行工具批次总预览严格受 8,000 字符预算限制", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-output-batch-"));
  const results = Array.from({ length: 20 }, (_, index) => ({
    callId: `parallel-${index}`,
    toolName: "search_attractions",
    output: `结果 ${index}\n${"候选".repeat(1_500)}`,
    outputKind: "place-list" as const,
  }));

  const compacted = await compactToolResults(results, { workspace, sessionId: "parallel" });

  assert.equal(compacted.length, results.length);
  assert.ok(
    compacted.reduce((sum, item) => sum + item.text.length, 0) <= TOOL_RESULT_BATCH_MAX_CHARS,
  );
  assert.ok(compacted.every((item) => item.truncated));
  assert.ok(compacted.every((item) => item.artifactPath !== undefined));
});

test("小结果保持内联且带结构类型；错误结果标记为 error", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-output-small-"));
  const [small, error] = await compactToolResults([
    {
      callId: "small",
      toolName: "get_weather",
      output: "晴 24℃",
      outputKind: "weather",
    },
    {
      callId: "error",
      toolName: "plan_day_routes",
      output: `路线失败\n${"错误上下文".repeat(700)}`,
      error: "Overpass unavailable",
      outputKind: "route",
    },
  ], { workspace, sessionId: "small" });

  assert.equal(small.truncated, false);
  assert.equal(small.artifactPath, undefined);
  assert.equal(small.text, "[tool-result type=weather chars=5]\n晴 24℃");
  assert.match(error.text, /^\[tool-result type=error chars=\d+\] truncated=true artifact=/);
  assert.ok(error.artifactPath?.endsWith(".error"));
});

test("归档目录不可写时降级为内联预览，不破坏工具结果协议", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-output-failure-"));
  const workspace = join(root, "not-a-directory");
  await writeFile(workspace, "file", "utf8");
  const output = `${"普通内容".repeat(1_000)}\n质量 P1 未通过`;

  const [compacted] = await compactToolResults([{
    callId: "failed-write",
    toolName: "validate_itinerary",
    output,
    outputKind: "validation",
  }], { workspace, sessionId: "failure" });

  assert.equal(compacted.artifactPath, undefined);
  assert.ok(compacted.truncated);
  assert.match(compacted.text, /artifact=unavailable/);
  assert.match(compacted.text, /质量 P1 未通过/);
  assert.ok(compacted.text.length <= TOOL_RESULT_MAX_CHARS);
});
