import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { AgentRuntime } from "../src/runtime/runtime.ts";
import { createExecutionBudget, DEFAULT_EXECUTION_LIMITS, executionInputLimit } from "../src/core/execution-budget.ts";
import { measureRequestContext, ContextInputLimitError, type RequestContextMetrics } from "../src/context/request.ts";
import { summarizeContext } from "../src/context/summarize.ts";
import { renderFocusedTravelState, travelFocusDay } from "../src/core/travel-context.ts";
import { updateTravelStateFromBrief, updateTravelStateFromItinerary, type TravelState } from "../src/core/travel-state.ts";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { activeToolNames } from "../src/tools/activation.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { DeepSeekProvider } from "../src/llm/deepseek.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import { ConfigStore } from "../src/config/config.ts";

function registry() { return new ToolRegistry().register({ name: "echo", alwaysActive: true, description: "测试只读", parameters: { type: "object" }, execute: async () => "回执".repeat(30) }); }
function state(): TravelState {
  const brief = updateTravelStateFromBrief(undefined, { title: "杭州三日游", destination: "杭州", startDate: "2026-11-01", endDate: "2026-11-03", mustVisit: ["景点3"], avoid: ["花生过敏"], notes: "不能丢失的硬约束" });
  const result = updateTravelStateFromItinerary(brief, { title: "杭州三日游", days: [1, 2, 3].map((day) => ({ date: `2026-11-0${day}`, items: [{ type: "visit", name: `景点${day}` }, { type: "meal", name: `餐厅${day}` }] })) });
  return { ...result, itinerary: { ...result.itinerary!, revision: 7, timeline: "D1 第一日完整时间线\nD2 第二日完整时间线\nD3 第三日完整时间线", issues: [{ level: "P1", code: "test", day: 2, message: "第二天待修" }] } };
}

test("普通模式不常驻 save 等旅行工具，旅行模式常驻，显式激活仍可使用", () => {
  const r = createDefaultRegistry(), session = new Session();
  assert.deepEqual([...activeToolNames(r, session)], ["read_file"]);
  session.setTravelMode(true);
  assert.equal(activeToolNames(r, session).has("save_itinerary"), true);
  assert.equal(activeToolNames(r, session).has("plan_day_routes"), true);
  session.setTravelMode(false);
  assert.equal(activeToolNames(r, session).has("save_itinerary"), false);
  session.setActiveTools(["save_itinerary"]);
  assert.equal(activeToolNames(r, session).has("save_itinerary"), true);
});

test("普通模式实际模型请求不携带旅行 schema，旅行模式请求携带", async () => {
  const seen: string[][] = [];
  const provider: ChatProvider = { name: "mode", chat: async () => "ok", chatWithTools: async (_, tools) => { seen.push(tools.map((t) => t.name)); return { type: "text", content: "ok" }; } };
  const session = new Session(), agent = new ChatAgent(session, provider, createDefaultRegistry());
  await agent.run("普通聊天"); session.setTravelMode(true); await agent.run("做旅行规划");
  assert.equal(seen[0]!.includes("save_itinerary"), false);
  assert.equal(seen[1]!.includes("save_itinerary"), true);
});

test("完整计量包含 Provider 固定提示、工具 schema、历史和临时上下文", () => {
  const session = new Session(); session.add("user", "你好");
  const tools = [{ name: "f", description: "工具", parameters: { type: "object" } }];
  const fixed = new DeepSeekProvider({ apiKey: "not-used", systemPrompt: "固定提示".repeat(100) });
  const metric = measureRequestContext(session, fixed.systemPrompt, session.toPrompt(), [{ role: "system", content: "临时约束" }], tools);
  assert.equal(metric.systemChars, 400); assert.ok(metric.toolDefinitionChars > 50);
  assert.ok(metric.transientChars > 4); assert.ok(metric.historyChars > 2);
  assert.equal(metric.totalChars, metric.systemChars + metric.toolDefinitionChars + metric.historyChars + metric.transientChars);
  assert.ok(metric.estimatedInputTokens > session.estimateHistoryTokens());
});

test("输入预算超限时在模型请求之前拒绝，不静默丢弃过长用户信息", async () => {
  let calls = 0;
  const provider: ChatProvider = { name: "oversize", systemPrompt: "固定".repeat(3000), chat: async () => { calls++; return "ok"; }, chatWithTools: async () => { calls++; return { type: "text", content: "ok" }; } };
  await assert.rejects(new ChatAgent(new Session(), provider, registry()).run("短输入", { maxPromptTokens: 500 }), ContextInputLimitError);
  assert.equal(calls, 0);
  await assert.rejects(new ChatAgent(new Session(), provider).run("短输入", { maxPromptTokens: 500 }), ContextInputLimitError);
  assert.equal(calls, 0);
});

test("校准分母包含固定提示与 schema，不把固定成本摊到几个用户字符上", async () => {
  let metric: RequestContextMetrics | undefined;
  const session = new Session();
  const provider: ChatProvider = { name: "calibration", systemPrompt: "固定提示".repeat(1000), chat: async () => "ok", chatWithTools: async () => {
    const promptTokens = Math.round(metric!.totalChars * 0.5);
    return { type: "text", content: "ok", usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } };
  } };
  await new ChatAgent(session, provider, registry()).run("你好", { onRequestContext: (m) => { metric = m; } });
  assert.ok(metric!.totalChars > 4000);
  assert.ok(Math.abs(session.calibrationFactor - 0.66) < 0.001);
});

test("同一用户任务的后续工具轮次也会检查完整上下文并压缩，保持工具消息配对", async () => {
  let requests = 0, summaries = 0;
  const provider: ChatProvider = { name: "loop-context", chat: async () => "摘要", chatWithTools: async (history): Promise<LLMResult> => {
    const pending = new Set<string>();
    for (const message of history) {
      for (const call of message.toolCalls ?? []) pending.add(call.id);
      if (message.role === "tool") { assert.ok(pending.has(message.toolCallId!)); pending.delete(message.toolCallId!); }
    }
    assert.equal(pending.size, 0);
    requests++;
    return requests <= 4 ? { type: "tool_calls", toolCalls: [{ id: `c${requests}`, name: "echo", arguments: JSON.stringify({ value: "x".repeat(350) }) }] } : { type: "text", content: "done" };
  } };
  const session = new Session();
  session.setTravelState(updateTravelStateFromBrief(undefined, { title: "杭州四日游", destination: "杭州", mustVisit: [], avoid: [] }));
  const runtime = new AgentRuntime({ maxPromptTokens: 1100, keepRecent: 2, summarize: async () => { summaries++; return "任务摘要"; } });
  runtime.registerAgent(session.id, new ChatAgent(session, provider, registry()));
  assert.equal(await runtime.send(session.id, "连续测试"), "done");
  assert.equal(requests, 5); assert.ok(summaries >= 1); assert.ok(session.epoch >= 1);
});

test("保存返回具体问题和版本，问题与持久化质量报告一致", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-save-feedback-")); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await createSaveItineraryTool(root).execute({ title: "杭州三日游", days: [{ date: "2026-11-01", items: [{ id: "a", name: "景点", type: "visit", time: "10:00" }] }] });
  const report = JSON.parse(await readFile(join(root, "plans/杭州三日游.quality.json"), "utf8"));
  assert.match(result, /版本:/); assert.match(result, /strict: 未通过/);
  assert.ok(report.issues.length > 0);
  assert.ok(report.issues.some((issue: { code: string; message: string }) => result.includes(`${issue.code}: ${issue.message}`)));
});

test("当前日上下文保留全局硬约束、版本及跨天去重，只展开当前日时间线", () => {
  const text = renderFocusedTravelState(state(), 2)!;
  assert.match(text, /花生过敏/); assert.match(text, /不能丢失的硬约束/); assert.match(text, /v7/);
  for (const n of [1, 2, 3]) assert.match(text, new RegExp(`景点${n}`));
  assert.match(text, /第二日完整时间线/); assert.doesNotMatch(text, /第一日完整时间线|第三日完整时间线/);
  assert.match(text, /第二天待修/); assert.doesNotMatch(text, /餐厅1|餐厅3/);
  assert.match(renderFocusedTravelState(state(), 2, 10)!, /花生过敏/, "小预算也不截断硬约束");
});

test("日期焦点遵循用户指定，未完成时先补缺失日期，完成后定位待修日", () => {
  const s = state();
  assert.equal(travelFocusDay(s, "修改第3天"), 3);
  assert.equal(travelFocusDay(s, "修改第三天"), 3);
  assert.equal(travelFocusDay(s, "check Day 1"), 1);
  assert.equal(travelFocusDay(s, "继续"), 2);
  const missing = { ...s, itinerary: { ...s.itinerary!, daySummaries: s.itinerary!.daySummaries!.slice(1) } };
  assert.equal(travelFocusDay(missing, "继续补齐"), 1);
});

test("相关证据优先于最近的其他候选，按最新记录去重且总字符有界", async () => {
  const evidence = new TravelEvidenceStore();
  await evidence.observePlaces("search_attractions", "杭州", "1. 相关地点 | 坐标 30.0000,120.0000", "amap");
  for (let i = 0; i < 40; i++) await evidence.observePlaces("search_attractions", "杭州", `1. 无关${i} | 坐标 30.0010,120.0010`, "amap");
  const text = evidence.summary("杭州", ["相关地点"], 600);
  assert.match(text, /相关地点 id=/); assert.match(text, /crs=gcj02/); assert.ok(text.length <= 600);
  assert.equal(evidence.summary("杭州", ["相关地点"], 0), "");
});

test("统一预算：默认硬限、任务费用与会话费用分别计算，缓存价参与费用核算", () => {
  const session = new Session();
  session.addUsage({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  const pricing = { inputPerM: 10, cacheInputPerM: 1, outputPerM: 20, hasCachePrice: true };
  const budget = createExecutionBudget(session, { taskBudgetYuan: "2", budgetYuan: "0" }, pricing);
  assert.equal(createExecutionBudget(session, { maxTaskRounds: "10" }).maxRounds, 10);
  assert.equal(createExecutionBudget(session, { maxTaskRounds: "999" }).maxRounds, 150);
  assert.equal(budget.maxCalls, DEFAULT_EXECUTION_LIMITS.maxCalls);
  assert.equal(budget.maxTokens, DEFAULT_EXECUTION_LIMITS.maxTokens); assert.equal(budget.costExceeded!(), false);
  session.addUsage({ promptTokens: 1_000_000, promptCacheHitTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  assert.equal(budget.costExceeded!(), false, "100万缓存输入只花1元");
  session.addUsage({ promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 });
  assert.equal(budget.costExceeded!(), true);
  assert.equal(createExecutionBudget(session, { taskBudgetYuan: "0", budgetYuan: "0" }, pricing).costExceeded!(), false);
  assert.equal(createExecutionBudget(session, { taskBudgetYuan: "0", budgetYuan: "1" }, pricing).costExceeded!(), true);
});

test("到达 token 或费用预算后普通请求也不再调用模型", async () => {
  let calls = 0;
  const session = new Session(), budget = createExecutionBudget(session, { maxTaskTokens: "1" }); budget.tokens = 1;
  const provider: ChatProvider = { name: "blocked", chat: async () => { calls++; return "bad"; } };
  assert.match(await new ChatAgent(session, provider).run("继续", { cumulativeBudget: budget }), /预算/); assert.equal(calls, 0);
});

test("摘要的 usage 计入同一会话，达到硬限后不再发送工作请求", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-context-archive-")); t.after(() => rm(root, { recursive: true, force: true }));
  const session = new Session();
  for (let i = 0; i < 10; i++) { session.add("user", "旧细节".repeat(50)); session.add("assistant", "旧回复".repeat(50)); }
  let work = 0, summary = 0;
  const provider: ChatProvider = { name: "summary-usage", chat: async () => "fallback", chatWithUsage: async () => {
    summary++; return { type: "text", content: "摘要", usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
  }, chatWithTools: async () => { work++; return { type: "text", content: "bad" }; } };
  const budget = createExecutionBudget(session, { maxTaskTokens: "100" });
  const result = await new ChatAgent(session, provider, registry(), root).run("继续", { cumulativeBudget: budget, maxPromptTokens: 1000 });
  assert.equal(summary, 1); assert.equal(work, 0); assert.equal(session.usage.totalTokens, 110); assert.equal(budget.tokens, 110); assert.match(result, /预算已用尽/);
  assert.ok(JSON.parse(await readFile(join(root, ".minicode/epochs", `${session.id}-1.json`), "utf8")).messages.length >= 20);
});

test("运行时自动承接的 steer 复用任务预算，不重置调用计数", async () => {
  const session = new Session(); let runtime: AgentRuntime, work = 0; const budgets: ReturnType<typeof createExecutionBudget>[] = [];
  const provider: ChatProvider = { name: "steer-budget", chat: async () => "ok", chatWithTools: async () => {
    work++;
    if (work === 1) {
      await runtime.send(session.id, "追加的要求", "steer");
      return { type: "tool_calls", toolCalls: [{ id: "first", name: "echo", arguments: "{}" }] };
    }
    return { type: "text", content: "ok" };
  } };
  runtime = new AgentRuntime({ summarize: async () => "summary", createBudget: (s) => { const b = createExecutionBudget(s, { maxToolCalls: "1" }); budgets.push(b); return b; } });
  runtime.registerAgent(session.id, new ChatAgent(session, provider, registry()));
  await runtime.send(session.id, "开始");
  await runtime.send(session.id, "独立请求");
  assert.equal(work, 2); assert.equal(budgets.length, 2); assert.equal(budgets[0]!.calls, 1);
});

test("预算配置可保存恢复，非法数值回退，不允许 NaN 绕过硬限", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-budget-config-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ConfigStore(join(root, "config.json"));
  await store.set("max_prompt_tokens", "32000"); await store.set("max_task_tokens", "100000"); await store.set("task_budget_yuan", "0");
  const config = await store.load(); assert.equal(executionInputLimit(config), 32000);
  const budget = createExecutionBudget(new Session(), config); assert.equal(budget.maxTokens, 100000);
  assert.equal(createExecutionBudget(new Session(), { maxTaskTokens: "NaN", maxToolCalls: "-1" }).maxCalls, 300);
  assert.equal(executionInputLimit({ maxPromptTokens: "Infinity" }), 24000);
});

test("请求大小和真实缓存用量按请求持久化，日志有界且不进入模型历史", () => {
  const session = new Session(); session.add("user", "你好");
  const metrics = measureRequestContext(session, "system", session.toPrompt(), [], []);
  for (let i = 0; i < 250; i++) session.recordRequestContext(metrics);
  session.completeRequestContext({ promptTokens: 100, promptCacheHitTokens: 60, completionTokens: 1, totalTokens: 101 });
  assert.equal(session.requestContexts.length, 200); assert.equal(session.requestContexts.at(-1)!.actualPromptTokens, 100);
  assert.equal(session.requestContexts.at(-1)!.cacheHitTokens, 60);
  const restored = Session.fromData(session.toData()); assert.deepEqual(restored.requestContexts, session.requestContexts);
  assert.equal(restored.toPrompt().length, 1); assert.equal(restored.toPrompt()[0]!.content, "你好");
});

test("摘要请求禁用工具并记录实际用量，正文及工具参数不写入计量日志", async () => {
  const session = new Session(); session.add("user", "需要保留的约束");
  const provider: ChatProvider = { name: "summary", chat: async () => "fallback", chatWithTools: async (_, tools) => {
    assert.equal(tools.length, 0);
    return { type: "text", content: "摘要", usage: { promptTokens: 80, promptCacheHitTokens: 20, completionTokens: 10, totalTokens: 90 } };
  } };
  assert.equal(await summarizeContext(provider, session, session.history), "摘要");
  assert.equal(session.usage.totalTokens, 90); assert.equal(session.requestContexts[0]!.cacheHitTokens, 20);
  assert.doesNotMatch(JSON.stringify(session.requestContexts), /需要保留的约束/);
});
