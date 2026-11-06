import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { createSaveItineraryTool, createValidateItineraryTool } from "../src/tools/itinerary.ts";
import { parseItinerary, type Itinerary } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { requiredVisitMatches } from "../src/tools/required-visits.ts";
import { CLOSURE_POLICY_VERSION, extractClosure } from "../src/tools/closure-policy.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { recordDeliveryProgress, focusedEvidenceDefinitions, isDeferredEvidenceCall } from "../src/agent/travel-progress.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { updateTravelStateFromBrief, updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";

function plan(): Itinerary {
  return parseItinerary({ title: "北京一日游", constraints: { expected_days: 1 }, days: [{ date: "2026-11-03", items: [
    { id: "v", name: "天坛公园", type: "visit", time: "10:00", end_time: "12:00", source: "manual", confidence: "high", opening_hours: { opens: "08:00", closes: "20:00" }, location: { latitude: 39.9, longitude: 116.4, crs: "wgs84" } },
  ] }] });
}
async function temp(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "minicode-convergence-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const source = (name: string, snippet: string) => [{ title: name, snippet }];
const budget = (): CumulativeToolBudget => ({ rounds: 0, calls: 0, tokens: 0, maxRounds: 150, maxCalls: 300 });

test("必去清单进入统一校验：遗漏、只有子点、餐厅/备注都不能替代游览", () => {
  const p = plan();
  assert.equal(validateItinerary(p).status, "ok");
  const required = { ...p, constraints: { ...p.constraints, must_visit: ["故宫", "故宫"] } };
  let q = validateItinerary(required);
  assert.equal(q.issues.filter((i) => i.code === "missing-required-visit").length, 1);
  assert.equal(q.daily![0]!.strict_pass, true, "全局缺少必去不能使一个已排日期的日内验收失真");
  q = validateItinerary({ ...required, days: [{ ...p.days[0]!, items: [{ ...p.days[0]!.items[0]!, name: "故宫博物院-大石雕" }] }] });
  assert.ok(q.issues.some((i) => i.code === "uncertain-required-visit" && i.kind === "pending"));
  for (const type of ["meal", "note"] as const) assert.ok(validateItinerary({ ...required, days: [{ items: [{ ...p.days[0]!.items[0]!, type, name: "故宫" }] }] }).issues.some((i) => i.code === "missing-required-visit"));
  assert.equal(computeItineraryMetrics(p, { expectedDays: 1, mustVisit: ["故宫"] }).status, "needs_revision");
});

test("明确主景区及规范别名满足必去，子点、外观、同名餐厅不满足", () => {
  for (const [required, name] of [["长城", "八达岭长城"], ["长城", "慕田峪长城景区"], ["故宫", "故宫博物院"], ["国家博物馆", "中国国家博物馆"], ["天坛", "北京市天坛公园"]]) assert.ok(requiredVisitMatches(required!, name!, "北京"));
  for (const name of ["故宫博物院-大石雕", "故宫博物院（外观）", "故宫旁餐厅", "故宫文创馆"]) assert.equal(requiredVisitMatches("故宫", name, "北京"), false);
  assert.equal(requiredVisitMatches("长城", "八达岭长城-敌楼", "北京"), false);
  assert.equal(requiredVisitMatches("国家博物馆", "国家公园", "北京"), false);
  assert.equal(requiredVisitMatches("兵马俑", "秦始皇帝陵博物院", "西安市"), true);
  assert.equal(requiredVisitMatches("兵马俑博物馆", "秦始皇帝陵博物院", "西安"), true);
  assert.equal(requiredVisitMatches("兵马俑", "秦始皇帝陵博物院", "北京"), false);
  for (const name of ["秦兵马俑壹号坑大厅", "秦始皇帝陵博物院-院史展览", "秦始皇帝陵博物院丽山园"]) {
    assert.equal(requiredVisitMatches("兵马俑", name, "西安"), false);
  }
  assert.throws(() => parseItinerary({ ...plan(), constraints: { must_visit: [""] } }), /must_visit/);
});

test("保存持久化必去，增量参数不能清空需求；旧行程复验从需求单恢复要求", async (t) => {
  const root = await temp(t), p = plan();
  await createSaveTravelBriefTool(root).execute({ title: p.title, destination: "北京", startDate: "2026-11-03", endDate: "2026-11-03", mustVisit: ["故宫"] });
  await createSaveItineraryTool(root).execute(p as unknown as Record<string, unknown>);
  let saved = JSON.parse(await readFile(join(root, "plans/北京一日游.json"), "utf8"));
  assert.deepEqual(saved.constraints.must_visit, ["故宫"]);
  await createSaveItineraryTool(root).execute({ title: p.title, merge: true, constraints: { must_visit: [] }, days: p.days });
  saved = JSON.parse(await readFile(join(root, "plans/北京一日游.json"), "utf8"));
  assert.deepEqual(saved.constraints.must_visit, ["故宫"]);
  delete saved.constraints.must_visit;
  await writeFile(join(root, "plans/北京一日游.json"), JSON.stringify(saved));
  await assert.rejects(createValidateItineraryTool(root).execute({ title: p.title, strict: true }), /missing-required-visit/);
});

test("闭馆只来自外部标题/正文关联；全年开放和生成回显不产生无休证明", async () => {
  const e = new TravelEvidenceStore(), name = "故宫博物院";
  assert.equal(extractClosure(name, source(name, "全年开放，淡旺季开放时间不同")).verified, false);
  await e.observeClosure("北京", name, source(name, "全年开放"));
  assert.equal(e.bind({ id: "x", name, type: "visit" }, "北京").closure_verified, false);
  await assert.rejects(e.observeClosure("北京", name, "工具回显周一闭馆" as never), /结构化/);
  await e.observeClosure("北京", name + " 周一闭馆", source("其他博物馆", "没有闭馆信息"));
  assert.equal(e.hasVerifiedClosure("北京", name + " 周一闭馆"), false);
  await e.observeClosure("北京", name, source(name + "参观说明", "每周一闭馆"));
  const bound = e.bind({ id: "x", name, type: "visit" }, "北京");
  assert.deepEqual(bound.closed_on, ["Monday"]); assert.equal(bound.closure_policy_version, CLOSURE_POLICY_VERSION);
  await e.observeClosure("北京", name, source(name, "另有游玩时长参考"));
  assert.deepEqual(e.bind(bound, "北京").closed_on, ["Monday"], "无新规则的查询不抹去有效依据");
});

test("旧闭馆缓存跨重启失效，旧行程的无休标记不能严格通过", async (t) => {
  const root = await temp(t); await mkdir(join(root, ".minicode"));
  await writeFile(join(root, ".minicode/travel-evidence.json"), JSON.stringify({ closures: [{ city: "北京", name: "故宫博物院", closed_on: [], verified: true, observed_at: Date.now() }] }));
  const e = new TravelEvidenceStore(root); await e.load(); assert.equal(e.hasVerifiedClosure("北京", "故宫博物院"), false);
  const p = plan(), item = { ...p.days[0]!.items[0]!, name: "故宫博物院", closure_verified: true, closed_on: [] };
  const q = validateItinerary({ ...p, constraints: { require_place_evidence: true }, days: [{ items: [item] }] });
  assert.ok(q.issues.some((i) => i.code === "unverified-closure"));
  assert.equal(e.bind(item, "北京").closure_verified, false);
});

test("原生口碑工具只观察抓取结果，规范化 place 和 aspect 阻止查询回显自证", async () => {
  let requests = 0;
  const fetchFn: typeof fetch = async () => { requests++; return new Response('<html>' + [1, 2, 3].map((n) => `<li class="b_algo"><h2><a>中国国家博物馆服务${n}</a></h2><p>馆藏介绍，没有闭馆规则</p></li>`).join('') + '</html>'); };
  const registry = new ToolRegistry().register(createReviewsTool(fetchFn));
  const ctx = { workspace: tmpdir(), destination: "北京", queryAttempts: new Map<string, number>(), queryStats: { executed: 0, cacheHits: 0, blocked: 0 } };
  await registry.execute("get_place_reviews", JSON.stringify({ place: "中国国家博物馆 开放时间 周一闭馆", aspect: "闭馆时间" }), ctx);
  const before = requests;
  const cached = await registry.execute("get_place_reviews", JSON.stringify({ place: "中国国家博物馆", city: "北京", aspect: "开放时间", ignored: "extra" }), ctx);
  assert.equal(requests, before); assert.equal(registry.evidence.hasVerifiedClosure("北京", "中国国家博物馆"), false);
  assert.match(cached, /未联网|复用缓存/);
  assert.match(cached, /未找到/);
  assert.doesNotMatch(registry.evidence.queryContext(["中国国家博物馆"]), /周一闭馆/);
  assert.match(await registry.execute("get_place_reviews", JSON.stringify({ place: "中国国家博物馆", aspect: "闭馆时间", refresh: true }), ctx), /本次未执行/);
  assert.deepEqual(ctx.queryStats, { executed: 1, cacheHits: 1, blocked: 1 });
});

test("负查询状态持久化、缓存命中不刷新时间，明确刷新有同任务上限", async (t) => {
  const root = await temp(t); let executions = 0;
  const tool = { name: "get_place_reviews", description: "test", parameters: {}, execute: async () => { executions++; return "没有搜到相关评价内容"; } };
  let r = new ToolRegistry(root).register(tool);
  await r.execute(tool.name, '{"place":"故宫","aspect":"闭馆时间","city":"北京"}');
  r = new ToolRegistry(root).register(tool);
  const ctx = { workspace: root, queryAttempts: new Map<string, number>() };
  assert.match(await r.execute(tool.name, '{"place":"故宫","aspect":"开放时间","city":"北京"}', ctx), /复用已查状态/);
  assert.equal(executions, 1);
  await r.execute(tool.name, '{"place":"故宫","aspect":"开放时间","city":"北京","refresh":true}', ctx);
  assert.equal(executions, 2);
  assert.match(await r.execute(tool.name, '{"place":"故宫","aspect":"开放时间","city":"北京","refresh":true}', ctx), /本次未执行/);
  assert.equal(executions, 2);
  assert.match(r.evidence.queryContext(["故宫"]), /已查询但未找到/);
});

test("负查询缓存 30 分钟失效，读索引和缓存复用均不延长有效期", async (t) => {
  let now = 1_000_000, executions = 0; t.mock.method(Date, "now", () => now);
  const r = new ToolRegistry().register({ name: "get_place_reviews", description: "test", parameters: {}, execute: async () => { executions++; return "没有搜到相关评价内容"; } });
  const args = '{"place":"故宫","city":"北京","aspect":"闭馆时间"}';
  await r.execute("get_place_reviews", args);
  now += 30 * 60_000 - 1;
  assert.match(await r.execute("get_place_reviews", args), /复用已查状态|没有搜到/);
  assert.match(r.evidence.queryContext(["故宫"]), /已查询但未找到/);
  assert.equal(executions, 1);
  now++;
  assert.equal(r.evidence.queryContext(["故宫"]), "");
  await r.execute("get_place_reviews", args);
  assert.equal(executions, 2);
});

test("已核验实体的明确别名共享闭馆记录，歧义泛称不猜是哪一个实体", async () => {
  const e = new TravelEvidenceStore();
  await e.observePlaces("search_attractions", "北京", "1. 故宫博物院 | 坐标 39.9000,116.4000\n2. 八达岭长城 | 坐标 40.0000,116.0000\n3. 慕田峪长城 | 坐标 40.1000,116.1000", "amap");
  assert.equal(e.canonicalPlaceName("故宫", "北京"), "故宫博物院");
  assert.equal(e.canonicalPlaceName("长城", "北京"), "长城");
  assert.equal(e.canonicalPlaceName("故宫", "杭州"), "故宫");
});

test("交付进展只由有效日期、严格问题下降或日内通过推进，相同问题重保存不算进展", () => {
  const p = plan(), b = budget();
  const initial = updateTravelStateFromBrief(undefined, { title: p.title, destination: "北京", startDate: "2026-11-03", endDate: "2026-11-03" });
  assert.ok(recordDeliveryProgress(initial, b));
  const report = validateItinerary(p);
  const saved = updateTravelStateFromSnapshot(initial, { itinerary: p, report, file: "plans/test.json" });
  assert.ok(recordDeliveryProgress(saved, b));
  for (let n = 1; n <= 9; n++) assert.equal(recordDeliveryProgress({ ...saved, itinerary: { ...saved.itinerary!, revision: n } }, b), false);
  assert.equal(b.deliveryStagnantRounds, 9);
  assert.equal(recordDeliveryProgress({ ...saved, itinerary: { ...saved.itinerary!, daySummaries: [...saved.itinerary!.daySummaries!, { day: 2, date: "2026-11-04", itemCount: 1, strictPass: true }] } }, b), false, "范围外通过日不算交付进展");
  const worse = { ...saved, itinerary: { ...saved.itinerary!, issueCount: { P0: 0, P1: 2, P2: 0 } } };
  assert.equal(recordDeliveryProgress(worse, b), false);
  assert.equal(recordDeliveryProgress({ ...worse, itinerary: { ...worse.itinerary, daySummaries: [...saved.itinerary!.daySummaries!, { day: 2, date: "2026-11-04", itemCount: 1, strictPass: true }] } }, b), false, "范围外通过日不能抵消硬问题变差");
});

test("实际 Agent 链：无关新候选不能刷新停滞；自动续跑复用计数，新任务另起预算", async (t) => {
  const root = await temp(t), r = new ToolRegistry(root);
  r.register({ name: "search_attractions", alwaysActive: true, description: "test", parameters: {}, execute: async (args) => `高德数据\n1. 无关${args.location} | 坐标 39.9000,116.4000` });
  let requests = 0;
  const provider: ChatProvider = { name: "endless", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => {
    requests++; return { type: "tool_calls", toolCalls: [{ id: `c${requests}`, name: "search_attractions", arguments: JSON.stringify({ location: `变化${requests}` }) }] };
  } };
  const s = new Session(); s.setTravelMode(true); s.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京三日游", destination: "北京", mustVisit: ["故宫"] }));
  const agent = new ChatAgent(s, provider, r, root), b = budget();
  assert.match(await agent.run("规划", { cumulativeBudget: b, maxToolRounds: 100 }), /无实际进展|累计预算/);
  assert.ok(requests <= 13); assert.equal(b.stagnantRounds, 12);
  const before = requests; await agent.run("自动续跑", { cumulativeBudget: b, maxToolRounds: 100 }); assert.equal(requests, before);
  await agent.run("新的任务", { cumulativeBudget: budget(), maxToolRounds: 1 }); assert.ok(requests > before);
});

test("实际 Agent 链：即使持续增加目标地点证据，也不能无限刷新交付停滞额度", async (t) => {
  const root = await temp(t), r = new ToolRegistry(root);
  let number = 0;
  r.register({ name: "search_attractions", alwaysActive: true, description: "test", parameters: {}, execute: async () => `高德数据\n1. 故宫 | 坐标 ${(39 + (++number) / 10000).toFixed(4)},116.4000` });
  let requests = 0;
  const provider: ChatProvider = { name: "novel-data", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => ({ type: "tool_calls", toolCalls: [{ id: `c${++requests}`, name: "search_attractions", arguments: JSON.stringify({ location: `故宫${requests}` }) }] }) };
  const s = new Session(); s.setTravelMode(true); s.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京三日游", destination: "北京", mustVisit: ["故宫"] }));
  const b = budget();
  assert.match(await new ChatAgent(s, provider, r, root).run("规划", { cumulativeBudget: b, maxToolRounds: 100 }), /连续 20 轮/);
  assert.equal(requests, 20); assert.equal(b.deliveryStagnantRounds, 20);
});

test("实际 Agent 链：旧工具消息移出后查询结论仍在，暂停取证同时约束工具定义与执行", async (t) => {
  const root = await temp(t), r = new ToolRegistry(root);
  let executions = 0, requests = 0, sawIndex = false, sawPaused = false;
  r.register({ name: "get_place_reviews", alwaysActive: true, description: "test", parameters: {}, execute: async () => { executions++; return "没有搜到相关评价内容"; } });
  const provider: ChatProvider = { name: "repeat-query", chat: async () => "结束", chatWithTools: async (history, tools): Promise<LLMResult> => {
    requests++;
    if (requests >= 2) {
      sawIndex ||= history.some((m) => m.content.includes("已查事项索引") && m.content.includes("已查询但未找到"));
      assert.equal(history.some((m) => m.toolCallId === "c1"), false);
    }
    if (requests >= 2) { assert.equal(tools.some((tool) => tool.name === "get_place_reviews"), false); sawPaused = true; }
    return { type: "tool_calls", toolCalls: [{ id: `c${requests}`, name: "get_place_reviews", arguments: JSON.stringify({ place: "故宫", aspect: requests === 1 ? "开放时间" : "口碑" }) }] };
  } };
  const s = new Session(); s.setTravelMode(true); s.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京三日游", destination: "北京", mustVisit: ["故宫"] }));
  const b = budget(); recordDeliveryProgress(s.travelState, b); b.deliveryStagnantRounds = 7;
  await new ChatAgent(s, provider, r, root).run("规划", { cumulativeBudget: b, maxToolRounds: 100,
    onCheckpoint: () => { if (s.history.some((m) => m.toolCallId === "c1")) s.replaceHistory(s.history.filter((m) => m.toolCallId !== "c1" && !m.toolCalls?.some((c) => c.id === "c1")), 0); },
  });
  assert.ok(sawIndex); assert.ok(sawPaused); assert.equal(executions, 1); assert.ok(requests <= 4);
});

test("收敛限制保留新的必要规则查询与用户严格餐饮，不通过停用硬约束工具凑停止条件", () => {
  assert.equal(isDeferredEvidenceCall("get_place_reviews", '{"aspect":"闭馆时间"}', false), false);
  assert.equal(isDeferredEvidenceCall("get_place_reviews", '{"aspect":"开放时间"}', false), false);
  assert.equal(isDeferredEvidenceCall("get_place_reviews", '{"aspect":"游玩时长"}', false), false);
  assert.equal(isDeferredEvidenceCall("get_place_reviews", '{"aspect":"口碑"}', false), true);
  assert.equal(isDeferredEvidenceCall("search_restaurants", '{}', true), false);
  const tools = [{ name: "search_restaurants", description: "餐厅", parameters: {} }];
  assert.equal(focusedEvidenceDefinitions(tools, true).length, 1);
  assert.equal(focusedEvidenceDefinitions(tools, false).length, 0);
  const p = { ...plan(), constraints: { recommendation_mode: "strict" as const } }, session = new Session();
  session.setTravelState(updateTravelStateFromSnapshot(undefined, { itinerary: p, report: validateItinerary(p), file: "plans/test.json" }));
  assert.equal(Session.fromData(session.toData()).travelState!.itinerary!.recommendationMode, "strict");
});
