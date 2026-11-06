import { createServer } from "node:http";
import { runNewLiveSuite } from "../src/eval/live.ts";
import type { EvalSuite } from "../src/eval/cases.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolDiagnostics, diagnosticFetch, toolErrorCategory } from "../src/core/tool-diagnostics.ts";
import { summarizeToolDiagnostics, finalEvidenceKeys } from "../src/eval/tool-diagnostics.ts";
import { auditLegacyToolMessages, auditToolRun } from "../src/eval/tool-audit.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { cancellableFetch } from "../src/tools/travel-request.ts";
import { AmapClient } from "../src/tools/amap.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import { createMessage } from "../src/core/message.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { CLOSURE_POLICY_VERSION } from "../src/tools/closure-policy.ts";

async function temp(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "tool-diag-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const call = (id: string, name = "search_attractions", args: object = { city: "北京", location: "天坛" }) => ({ id, name, arguments: JSON.stringify(args) });
const source = "高德数据\n1. 天坛公园 | 评分 4.8 | 坐标 39.9000,116.4000\n2. 景山公园 | 评分 4.5 | 坐标 39.9200,116.3900";
const invoke = (d: ToolDiagnostics, registry: ToolRegistry, c: ReturnType<typeof call>, ctx = {}) => d.run(c, 1, async () => {
  try { return { output: await registry.execute(c.name, c.arguments, { workspace: process.cwd(), ...ctx }) }; }
  catch (error) { return { output: "失败", error: error instanceof Error ? error.message : String(error) }; }
});

test("真实 Registry 路径区分执行、缓存、重复拦截、无依据和参数错误，证据引用不按候选总数冒充利用", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), d = new ToolDiagnostics();
  let httpCalls = 0;
  const fetchFn = (async () => { httpCalls++; return new Response(source); }) as typeof fetch;
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async (_args, ctx) => (await cancellableFetch(fetchFn, ctx?.signal)("https://example.com/search?key=do-not-log")).text() });
  registry.register({ name: "get_place_reviews", description: "test", parameters: {}, execute: async () => "未获得可核验的简单闭馆规则" });
  const ctx = { queryAttempts: new Map<string, number>() };
  await invoke(d, registry, call("one"), ctx); await invoke(d, registry, call("two"), ctx); await invoke(d, registry, call("three"), ctx);
  await invoke(d, registry, call("reviews", "get_place_reviews", { place: "天坛公园", city: "北京", aspect: "闭馆时间" }), ctx);
  await invoke(d, registry, { id: "bad", name: "search_attractions", arguments: "{" }, ctx);
  assert.deepEqual(d.records.map((r) => r.execution), ["executed", "cache_hit", "blocked", "executed", "executed"]);
  assert.equal(httpCalls, 1); assert.equal(d.records[0]!.http.length, 1); assert.equal(d.records[1]!.http.length, 0);
  assert.equal(d.records[3]!.query_status, "unavailable"); assert.equal(d.records[4]!.error, "invalid_arguments");
  assert.equal(d.records[0]!.evidence_keys.length, 2); assert.equal(d.records[0]!.new_evidence_keys.length, 2);
  const id = d.records[0]!.evidence_keys[0]!.slice("place:".length);
  const itinerary = parseItinerary({ title: "采用一个候选", days: [{ items: [{ id: "v", type: "visit", name: "天坛公园", evidence_verified: true, evidence_id: id }] }] });
  const summary = summarizeToolDiagnostics(d, itinerary);
  assert.equal(summary.execution.executed, 3); assert.equal(summary.execution.errors, 1);
  assert.equal(summary.queries.duplicate_requests, 2); assert.equal(summary.evidence.final_reference_rate, .5);
  assert.equal(summary.evidence.adopted_calls, 1); assert.equal(summary.http.requests, 1); assert.equal(summary.http.success_rate, 1);
  assert.equal(summarizeToolDiagnostics(d).evidence.final_reference_rate, null);
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /do-not-log|example.com\/search|天坛|景山/);
});

test("并行请求、嵌套 fetch 包装以及网络异常精确归属，不把 HTTP500 记为成功", async () => {
  const d = new ToolDiagnostics();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const underlying = (async () => { entered++; if (entered === 2) release(); await gate; return new Response("bad", { status: 500 }); }) as typeof fetch;
  const twice = cancellableFetch(cancellableFetch(underlying));
  await d.run(call("parallel", "test"), 1, async () => {
    await Promise.all([twice("https://example.com/a"), twice("https://example.com/b")]); return { output: "已降级" };
  });
  assert.equal(d.peak_http_in_flight, 2); assert.equal(d.records[0]!.http.length, 2);
  const summary = summarizeToolDiagnostics(d);
  assert.deepEqual(summary.http.status_counts, { "500": 2 }); assert.equal(summary.http.failures, 2); assert.equal(summary.http.success_rate, 0); assert.equal(summary.execution.success_rate, 1);
  await assert.rejects(() => d.run(call("network", "test"), 2, async () => { await diagnosticFetch((async () => { throw new TypeError("fetch failed"); }) as typeof fetch, "https://example.com/?token=secret"); return { output: "" }; }));
  assert.equal(d.records[1]!.http[0]!.error, "network"); assert.equal(d.records[1]!.outcome, "error");
  assert.equal(d.peak_http_in_flight, 2); assert.doesNotMatch(JSON.stringify(d.snapshot()), /token=|secret/);
});

test("高德 HTTP200 中的10021及重试单列，恢复成功不抹掉业务错误", async () => {
  const d = new ToolDiagnostics(); let count = 0;
  const amap = new AmapClient({ apiKey: "must-not-appear", fetchFn: (async () => new Response(JSON.stringify(++count === 1
    ? { status: "0", infocode: "10021", info: "QPS" }
    : { status: "1", infocode: "10000", geocodes: [] }))) as typeof fetch });
  await d.run(call("amap", "geocode"), 1, async () => { await amap.geocode("北京"); return { output: "完成" }; });
  const summary = summarizeToolDiagnostics(d);
  assert.equal(summary.http.requests, 2); assert.equal(summary.http.success_rate, 1);
  assert.deepEqual(summary.http.provider_errors, { "amap:10021": 1 }); assert.equal(summary.execution.errors, 0);
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /must-not-appear|address=|key=/);
});

test("Agent 所有请求都进入诊断，拒绝、预算拦截与执行失败分开，自动续跑累计", async (t) => {
  const root = await temp(t), session = new Session(), registry = new ToolRegistry(root);
  registry.register({ name: "echo", description: "test", parameters: {}, execute: async () => "ok" });
  registry.register({ name: "private", description: "test", parameters: {}, requiresConfirmation: true, execute: async () => { throw new Error("不应执行"); } });
  const batch = [call("ok", "echo", {}), call("denied", "private", {}), { ...call("bad", "echo"), arguments: "{" }, call("cap", "echo", {})];
  let sent = false;
  const provider: ChatProvider = { name: "diagnostic-test", chat: async () => "done", chatWithTools: async (): Promise<LLMResult> => sent ? { type: "text", content: "done" } : (sent = true, { type: "tool_calls", toolCalls: batch }) };
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxCalls: 2, maxRounds: 10 };
  const agent = new ChatAgent(session, provider, registry, root);
  await agent.run("开始", { cumulativeBudget: budget, maxToolRounds: 10, onPermission: async () => false });
  const summary = summarizeToolDiagnostics(budget.diagnostics!);
  assert.equal(summary.requested, 4); assert.equal(summary.execution.executed, 2); assert.equal(summary.execution.errors, 1);
  assert.equal(summary.execution.denied, 1); assert.equal(summary.execution.blocked, 1);
  await agent.run("续跑", { cumulativeBudget: budget }); assert.equal(budget.diagnostics!.total, 4);
  assert.equal(session.toPrompt().some((m) => m.content.includes('"peak_http_in_flight"')), false);
});

test("证据利用率包含已核验路线/闭馆，未核验和估算字段不能抬高引用率", () => {
  const itinerary = parseItinerary({ title: "引用", constraints: { destination: "北京" }, days: [{ items: [
    { id: "v", type: "visit", name: "故宫博物院", evidence_id: "fake", closed_on: ["Monday"], closure_verified: true, closure_policy_version: CLOSURE_POLICY_VERSION },
    { id: "t", type: "transport", name: "交通", route_evidence_id: "route", route_verified: true },
  ] }] });
  const keys = finalEvidenceKeys(itinerary)!;
  assert.equal(keys.has("place:fake"), false); assert.equal(keys.has("route:route"), true); assert.equal(keys.size, 2);
  assert.equal(finalEvidenceKeys(null), null);
});

test("旧日志恢复压缩前参数并按先后配对复用的 call id；失败提示不等同接口失败", () => {
  const first = call("same", "get_place_reviews", { place: "故宫", city: "北京", aspect: "闭馆时间" });
  const second = call("same", "get_place_reviews", { city: "北京", place: "故宫", aspect: "开放时间" });
  const legacy = auditLegacyToolMessages([
    createMessage("assistant", "", { toolCalls: [{ ...first, arguments: '{"_truncated":true}' }] }),
    createMessage("tool", "未获得可核验规则", { toolCallId: "same" }),
    { ...createMessage("assistant", "", { toolCalls: [{ ...second, arguments: '{"_truncated":true}' }] }), archivedToolCalls: [second] },
    createMessage("tool", "工具执行失败: fetch failed", { toolCallId: "same" }),
    createMessage("assistant", "", { toolCalls: [second] }),
    createMessage("tool", "返回内容", { toolCallId: "same" }),
  ]);
  assert.equal(legacy.requested, 3); assert.equal(legacy.paired_results, 3); assert.equal(legacy.argument_keys, 2);
  assert.equal(legacy.duplicate_requests, 1); assert.equal(legacy.exceptions, 1); assert.equal(legacy.failure_markers, 1);
  assert.equal(legacy.http_success_rate, null); assert.equal(legacy.evidence_reference_rate, null);
});

test("诊断启用后真实保存路径和持久化质量结果保持一致", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), d = new ToolDiagnostics();
  registry.register(createSaveItineraryTool(root));
  const result = await invoke(d, registry, call("save", "save_itinerary", { title: "诊断保存", days: [{ items: [{ id: "v", type: "visit", name: "公园", time: "10:00", end_time: "12:00" }] }] }));
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(await readFile(join(root, "plans/诊断保存.json"), "utf8")).days[0].items[0].name, "公园");
  assert.equal(d.records[0]!.outcome, "ok");
});

test("诊断保留上限明确报告覆盖不足，空样本和无证据不能给出100%", async () => {
  const empty = summarizeToolDiagnostics(new ToolDiagnostics());
  assert.equal(empty.execution.success_rate, null); assert.equal(empty.http.success_rate, null); assert.equal(empty.evidence.final_reference_rate, null);
  const d = new ToolDiagnostics(); for (let i = 0; i < 2001; i++) d.skip(call(String(i)), 1, "blocked");
  assert.equal(d.snapshot().records.length, 2000); assert.equal(d.dropped, 1); assert.equal(summarizeToolDiagnostics(d).requested, 2001);
  assert.equal(toolErrorCategory("行程质量校验未通过: 纬度40.10021"), "validation");
  assert.equal(toolErrorCategory("坐标 40.10021,116.10003"), "other");
  assert.equal(toolErrorCategory("高德失败 [10021] QPS"), "rate_limit");
  assert.equal(toolErrorCategory("10003"), "quota"); assert.equal(toolErrorCategory(new DOMException("timed out", "TimeoutError")), "timeout");
});


test("真实 live runner 保存工具诊断、telemetry和派生报告；本地模型 HTTP 不混入旅行 HTTP", async (t) => {
  const root = await temp(t); await mkdir(join(root, ".minicode"));
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); const first = requests++ === 0;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "save-test", type: "function", function: { name: "save_itinerary", arguments: JSON.stringify({ title: "测试一日游", days: [{ items: [{ id: "v", type: "visit", name: "测试公园", time: "10:00", end_time: "12:00" }] }] }) } }] }
      : { role: "assistant", content: "本地测试完成" };
    res.end(`data: ${JSON.stringify({ id: `local-${requests}`, choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("未监听本地测试端口");
  await writeFile(join(root, ".minicode/config.json"), JSON.stringify({ provider: "openai", llmApiKey: "local-test", llmBaseUrl: `http://127.0.0.1:${address.port}/v1`, llmModel: "diagnostic-test" }));
  const suite: EvalSuite = { id: "diag", name: "诊断集成", version: "1", cases: [{ id: "one", title: "测试一日游", days: 1, request: "公园一日游" }] };
  const suitePath = join(root, "suite.json"); await writeFile(suitePath, JSON.stringify(suite));
  const manifest = await runNewLiveSuite({ rootDir: root, suitePath, suite, cases: suite.cases, runId: "diag-integration", caseIds: [], tags: [] });
  const attempt = manifest.cases[0]!.attempts[0]!;
  assert.equal(attempt.telemetry.tool_diagnostics?.requested, 1, JSON.stringify({ requests, failure: attempt.failure, telemetry: attempt.telemetry }));
  assert.equal(attempt.telemetry.tool_diagnostics?.execution.success_rate, 1);
  assert.equal(attempt.telemetry.tool_diagnostics?.http.requests, 0);
  assert.equal(attempt.telemetry.tool_diagnostics?.http.success_rate, null);
  const trace = JSON.parse(await readFile(join(root, "eval/runs/diag-integration", attempt.output_dir, "tool-diagnostics.json"), "utf8"));
  assert.equal(trace.records[0].tool, "save_itinerary");
  await auditToolRun(root, manifest.run_id);
  assert.match(await readFile(join(root, "eval/runs/diag-integration/tool-diagnostics-audit.md"), "utf8"), /未知\/不适用/);
});


test("不同工具的并行请求各自归属，超时与取消不会混入一般网络故障", async () => {
  const d = new ToolDiagnostics(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); let started = 0;
  const request = (async () => { if (++started === 2) release(); await gate; return new Response("ok"); }) as typeof fetch;
  await Promise.all(["one.example", "two.example"].map((host) => d.run(call(host, host), 1, async () => { await diagnosticFetch(request, `https://${host}/?key=secret`); return { output: "ok" }; })));
  assert.equal(d.peak_http_in_flight, 2);
  assert.deepEqual(d.records.map((r) => r.http.map((h) => h.host)), [["one.example"], ["two.example"]]);
  assert.equal(toolErrorCategory("The operation was aborted due to timeout"), "timeout");
  assert.equal(toolErrorCategory("This operation was aborted"), "cancelled");
});
