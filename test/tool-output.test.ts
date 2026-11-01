import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool } from "../src/tools/files.ts";
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

test("JSON 地点摘要保留整组名称、坐标、来源、证据和房晚单位，不被长描述挤掉", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-place-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = JSON.stringify({ source: "amap", crs: "gcj02", places: [1, 2].map((i) => ({ description: "介绍".repeat(4000), name: `酒店${i}`, evidence_id: `verified-${i}`, location: { latitude: 30.123456, longitude: 120.654321, crs: "gcj02" }, price: 380, price_unit: "room_night", rating: 4.8 })) });
  const [result] = await compactToolResults([{ callId: "places", toolName: "search_stays", output, outputKind: "place-list" }], { workspace, sessionId: "test" });
  assert.match(result.text, /字段摘要/);
  for (const i of [1, 2]) {
    const line = result.text.split("\n").find((line) => line.includes(`酒店${i}`))!;
    assert.match(line, new RegExp(`verified-${i}`));
    assert.match(line, /30\.123456/); assert.match(line, /120\.654321/);
    assert.match(line, /room_night/); assert.match(line, /gcj02/);
  }
  assert.doesNotMatch(result.text, /介绍/);
  assert.ok(result.text.length <= TOOL_RESULT_MAX_CHARS);
  assert.equal(await readFile(join(workspace, result.artifactPath!), "utf8"), output);
});

test("实际地点文本将尾部证据 ID 绑定到候选，并保留数据降级警告", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-text-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = ["杭州周边景点：", ...Array.from({ length: 12 }, (_, i) => `${i + 1}. 景点${i} | 古迹 | ${"长描述".repeat(120)} | 评分 4.7 | 开放时间 08:00-18:00 | 坐标 30.12,120.34`), "⚠️ 高德数据源失败，以上为 OpenStreetMap 数据（无评分）", "已核验地点 evidence_id：", ...Array.from({ length: 12 }, (_, i) => `景点${i}: place-${i}`)].join("\n");
  const [result] = await compactToolResults([{ callId: "text", toolName: "search_attractions", output, outputKind: "place-list" }], { workspace, sessionId: "test" });
  assert.match(result.text, /景点0 \| 古迹 \| 评分 4\.7 \| 开放时间 08:00-18:00 \| 坐标 30\.12,120\.34 \| evidence_id=place-0/);
  assert.match(result.text, /高德数据源失败/); assert.doesNotMatch(result.text, /长描述/);
});

test("交通文本摘要保留端点、单位、估算标记及匹配的路线 ID", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-route-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = ["杭州 行程通勤规划：", "1. 公园 → 酒店: 驾车约 35 分钟（估算）", "   距离 12.4 公里", "说明".repeat(4000), "全天通勤合计约 35 分钟", "路线证据：", "公园 → 酒店: route-1 / 35分钟 / driving"].join("\n");
  const [result] = await compactToolResults([{ callId: "routes", toolName: "plan_day_routes", output, outputKind: "route" }], { workspace, sessionId: "test" });
  assert.match(result.text, /公园 → 酒店.*35 分钟（估算）.*route_evidence_id=route-1.*距离 12\.4 公里/);
  assert.match(result.text, /全天通勤合计约 35 分钟/);
});

test("校验 JSON 优先保留 P0；路线 JSON 去掉几何，行程 JSON 保留日期及条目证据", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-json-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const outputs = [
    { callId: "v", toolName: "validate_itinerary", outputKind: "validation" as const, output: JSON.stringify({ status: "invalid", score: 95, issues: [...Array.from({ length: 30 }, (_, i) => ({ level: "P2", code: `advice-${i}`, message: "建议".repeat(100) })), { level: "P0", code: "time-overlap", day: 3, item_id: "visit-3", message: "时间冲突" + "详细描述".repeat(3000) }] }) },
    { callId: "r", toolName: "plan_day_routes", outputKind: "route" as const, output: JSON.stringify({ legs: [{ from: "公园", to: "酒店", route_evidence_id: "route-json", duration_min: 34, distance_km: 12.8, estimated: true, geometry: Array.from({ length: 3000 }, () => [120, 30]) }] }) },
    { callId: "i", toolName: "load_itinerary", outputKind: "itinerary" as const, output: JSON.stringify({ title: "杭州三日游", days: [{ date: "2026-11-01", items: [{ id: "visit-1", name: "公园", type: "visit", time: "10:00", end_time: "11:00", evidence_id: "place-json", notes: "介绍".repeat(3000) }] }] }) },
  ];
  const results = await compactToolResults(outputs, { workspace, sessionId: "test" });
  assert.match(results[0]!.text, /"status":"invalid"/); assert.match(results[0]!.text, /"level":"P0".*"day":3.*"item_id":"visit-3"/);
  assert.match(results[0]!.text, /省略/);
  assert.match(results[1]!.text, /"duration_min":34,"distance_km":12.8,"estimated":true/); assert.doesNotMatch(results[1]!.text, /geometry/);
  assert.match(results[2]!.text, /D1 2026-11-01.*place-json.*10:00.*11:00/);
  assert.ok(results.reduce((sum, result) => sum + result.text.length, 0) <= TOOL_RESULT_BATCH_MAX_CHARS);
});

test("同名异地及同端点的多份证据不会被摘要错误绑定，超长单条记录明确省略", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-ambiguous-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const outputs = [
    { callId: "p", toolName: "search_attractions", outputKind: "place-list" as const, output: ["景点：", "1. 公园 | 景点 | 坐标 30.12,120.34", "2. 公园 | 景点 | 坐标 31.12,121.34", "说明".repeat(4000), "公园: place-a", "公园: place-b"].join("\n") },
    { callId: "r", toolName: "plan_day_routes", outputKind: "route" as const, output: ["交通：", "1. A → B: 驾车约 30 分钟", "说明".repeat(4000), "A → B: route-a / 30分钟 / driving", "A → B: route-b / 50分钟 / transit"].join("\n") },
    { callId: "long", toolName: "places", outputKind: "place-list" as const, output: JSON.stringify({ places: [{ name: "长名称".repeat(2000), location: { latitude: 30.12, longitude: 120.34 } }] }) },
  ];
  const results = await compactToolResults(outputs, { workspace, sessionId: "test" });
  assert.match(results[0]!.text, /未自动绑定/); assert.doesNotMatch(results[0]!.text, /evidence_id=place-/);
  assert.match(results[0]!.text, /坐标 30\.12,120\.34/); assert.match(results[0]!.text, /坐标 31\.12,121\.34/);
  assert.match(results[1]!.text, /未自动绑定/); assert.doesNotMatch(results[1]!.text, /route_evidence_id=route-/);
  assert.match(results[2]!.text, /省略 1 条记录/); assert.doesNotMatch(results[2]!.text, /长名称|latitude/);
});

test("超过 2MB 的单行归档能按 UTF-8 字节游标读取首尾，不需要整文件加载", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-big-artifact-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = "开头😀" + "中".repeat(750000) + "末尾😀";
  const [result] = await compactToolResults([{ callId: "big", toolName: "huge", output }], { workspace, sessionId: "test" });
  assert.match(result.text, /byte_offset=0/);
  const reader = createReadFileTool(workspace);
  const first = await reader.execute({ path: result.artifactPath, byte_offset: 0 });
  assert.match(first, /开头😀/); assert.doesNotMatch(first, /�/); assert.ok(first.length < 3000);
  const next = Number(/【续读】byte_offset=(\d+)/.exec(first)?.[1]);
  assert.ok(next > 0);
  assert.doesNotMatch(await reader.execute({ path: result.artifactPath, byte_offset: next }), /�/);
  const last = await reader.execute({ path: result.artifactPath, byte_offset: Buffer.byteLength(output) - Buffer.byteLength("末尾😀") });
  assert.match(last, /末尾😀\n【文件结束】/);
});

test("内联阈值包含换行，单条与批次预算都不能多出一个字符", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-exact-limit-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = "x".repeat(10);
  const maxChars = "[tool-result type=generic chars=10]".length + output.length;
  const results = await compactToolResults([{ callId: "edge", toolName: "x", output }], { workspace, sessionId: "test", maxChars, batchMaxChars: maxChars });
  assert.ok(results[0]!.truncated); assert.ok(results[0]!.text.length <= maxChars);
});
