import { assessToolBudget } from "../src/runtime/tool-budget.ts";
import { updateTravelStateFromBrief } from "../src/core/travel-state.ts";
import { essentialReviewDefinitions, focusedEvidenceDefinitions } from "../src/agent/travel-progress.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../src/tools/tool.ts";
import { queryKeyArgs } from "../src/tools/travel-query.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { createSaveItineraryTool, createLoadItineraryTool } from "../src/tools/itinerary.ts";
import { createReadFileTool } from "../src/tools/files.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";

async function temp(t: { after: (fn: () => Promise<void>) => void }) { const root = await mkdtemp(join(tmpdir(), "travel-eff-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const args = { city: "北京", location: "天坛" };

test("省略/显式默认值、忽略参数、路线auto/transit共用查询键，真实范围与方式变化不合并", () => {
  assert.deepEqual(queryKeyArgs("search_attractions", args), queryKeyArgs("search_attractions", { ...args, radius_km: 10, limit: 10, unused: "不参与工具实现" }));
  assert.notDeepEqual(queryKeyArgs("search_attractions", args), queryKeyArgs("search_attractions", { ...args, radius_km: 20 }));
  assert.deepEqual(queryKeyArgs("plan_day_routes", { city: "北京", stops: ["甲", "乙"] }), queryKeyArgs("plan_day_routes", { city: "北京", stops: [" 甲 ", "乙"], mode: "transit" }));
  assert.notDeepEqual(queryKeyArgs("plan_day_routes", { stops: ["甲", "乙"] }), queryKeyArgs("plan_day_routes", { stops: ["乙", "甲"] }));
  assert.notDeepEqual(queryKeyArgs("search_restaurants", { city: "甲" }), queryKeyArgs("search_restaurants", { city: "甲", min_rating: 4.2 }));
  assert.deepEqual(queryKeyArgs("get_place_reviews", { place: "故宫博物院闭馆时间", city: "北京", aspect: "闭馆日" }), queryKeyArgs("get_place_reviews", { place: "故宫博物院", city: "北京", aspect: "开放时间" }));
});

test("并发相同查询只执行一次；不同取消信号独立，失败后清理在途记录", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root);
  let executed = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { executed++; await gate; return "景点候选甲"; } });
  const one = registry.execute("search_attractions", JSON.stringify(args));
  const two = registry.execute("search_attractions", JSON.stringify({ ...args, limit: 10, radius_km: 10 }));
  release(); assert.equal(await one, await two); assert.equal(executed, 1);
  let releaseMore!: () => void; const otherGate = new Promise<void>((resolve) => { releaseMore = resolve; });
  const different = new ToolRegistry(root);
  different.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { executed++; await otherGate; throw new Error("网络暂时失败"); } });
  const a = different.execute("search_attractions", JSON.stringify(args), { workspace: root, signal: new AbortController().signal });
  const b = different.execute("search_attractions", JSON.stringify(args), { workspace: root, signal: new AbortController().signal });
  releaseMore(); await assert.rejects(a); await assert.rejects(b); assert.equal(executed, 3);
  await assert.rejects(() => different.execute("search_attractions", JSON.stringify(args))); assert.equal(executed, 4);
});

test("广告与空摘要不凑停止条件；百度缺摘要不串到下一条结果，关键闭馆事实齐备即停", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root); let requests = 0;
  registry.register(createReviewsTool((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("dpm.org.cn")) return new Response("无可用规则");
    requests++;
    if (url.includes("bing.com")) return new Response('<li class="b_algo"><h2><a>故宫博物院</a></h2><p>淘宝放心购，大牌汇聚，在线下单，退换无忧</p></li>' + Array.from({ length: 3 }, (_, i) => `<li class="b_algo"><h2><a>故宫博物院链接${i}</a></h2></li>`).join(""));
    assert.match(url, /baidu.com/);
    return new Response('<h3><a>故宫博物院空标题</a></h3><h3><a href="https://example.com/visit">故宫博物院参观须知</a></h3><div class="c-abstract">故宫博物院09:00-17:00。故宫博物院每周一闭馆。故宫博物院建议游玩4小时。</div>');
  }) as typeof fetch));
  const output = await registry.execute("get_place_reviews", JSON.stringify({ place: "故宫博物院", city: "北京", aspect: "开放时间" }));
  assert.equal(requests, 2); assert.doesNotMatch(output, /淘宝|空标题|链接[012]/); assert.match(output, /Monday/);
  assert.ok(registry.evidence.hasVerifiedClosure("北京", "故宫博物院"));
  const reused = await registry.execute("get_place_reviews", JSON.stringify({ place: "故宫博物院", city: "北京", aspect: "游玩时长" }));
  assert.equal(requests, 2); assert.match(reused, /复用.*游玩时长/);
});

test("搜索无有效依据时最多4次HTTP，保持未知；已有闭馆事实换aspect无需联网", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root); let requests = 0;
  const tool = createReviewsTool((async () => { requests++; return new Response('<h3><a>故宫博物院</a></h3>'); }) as typeof fetch);
  assert.match(await tool.execute({ place: "故宫博物院", city: "北京", aspect: "开放时间" }, { workspace: root, evidence }), /没有搜到/);
  assert.equal(requests, 4); assert.equal(evidence.hasVerifiedClosure("北京", "故宫博物院"), false);
  await evidence.observeClosure("北京", "故宫博物院", [{ title: "故宫博物院", snippet: "故宫博物院每周一闭馆。" }]);
  const registry = new ToolRegistry(root); registry.register(tool);
  const output = await registry.execute("get_place_reviews", JSON.stringify({ place: "故宫博物院", city: "北京", aspect: "闭馆时间" }));
  assert.equal(requests, 4); assert.match(output, /复用.*已查开放字段/); assert.match(output, /每周闭馆：沿用已有闭馆依据/); assert.match(output, /开放时段：未找到依据/);
});

test("路线ABC改BCD只查询新CD；缓存不续期，改方向/端点/方式与refresh仍重查", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root); let requests = 0;
  setAmapKey("test", (async (input: string | URL | Request) => {
    requests++; const url = String(input);
    if (url.includes("transit")) return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ duration: "900", walking_distance: "0", segments: [] }] } }));
    return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ duration: "600", distance: "1000", steps: [] }] } }));
  }) as typeof fetch); t.after(() => setAmapKey(undefined));
  await evidence.observePlaces("search_attractions", "北京", ["甲", "乙", "丙", "丁"].map((n, i) => `${i + 1}. ${n} | 坐标 ${(39.9 + i * .01).toFixed(4)},116.4000`).join("\n"), "amap");
  const tool = createPlanRoutesTool(), ctx = { workspace: root, evidence };
  await tool.execute({ stops: ["甲", "乙", "丙"], city: "北京" }, ctx); assert.equal(requests, 2);
  const first = evidence.routeForPlanning("乙", "丙", "北京", "auto", evidence.point("乙", "北京")!, evidence.point("丙", "北京")!)!;
  const output = await tool.execute({ stops: ["乙", "丙", "丁"], city: "北京" }, ctx);
  assert.equal(requests, 3); assert.match(output, /路段缓存/); assert.match(output, new RegExp(first.id));
  assert.equal(evidence.routeForPlanning("乙", "丙", "北京", "auto", evidence.point("乙", "北京")!, evidence.point("丙", "北京")!)!.observed_at, first.observed_at);
  await tool.execute({ stops: ["丙", "乙"], city: "北京" }, ctx); assert.equal(requests, 4);
  await tool.execute({ stops: ["乙", "丙"], city: "北京", mode: "walking" }, ctx); assert.equal(requests, 5);
  await tool.execute({ stops: ["乙", "丙"], city: "北京", refresh: true }, ctx); assert.equal(requests, 6);
  await evidence.observePlaces("search_attractions", "北京", "1. 乙 | 坐标 39.9150,116.4000", "amap");
  await tool.execute({ stops: ["乙", "丙"], city: "北京" }, ctx); assert.equal(requests, 7);
  const file = join(root, ".minicode/travel-evidence.json"), data = JSON.parse(await readFile(file, "utf8"));
  data.routes.forEach((r: { observed_at: number }) => { r.observed_at = Date.now() - 30 * 60_000 - 1; }); await writeFile(file, JSON.stringify(data));
  const reloaded = new TravelEvidenceStore(root); await reloaded.load();
  await tool.execute({ stops: ["乙", "丙"], city: "北京" }, { ...ctx, evidence: reloaded }); assert.equal(requests, 8);
});

const savedArgs = { title: "读取与保存", days: [{ date: "2026-11-03", items: [{ id: "v", type: "visit", name: "景点甲", time: "10:00", end_time: "12:00" }] }] };
test("原样保存不增版本、不重写产物，真实修改与缺失交付文件仍更新", async (t) => {
  const root = await temp(t), save = createSaveItineraryTool(root);
  await save.execute(savedArgs);
  const path = join(root, "plans/读取与保存.json"), before = await readFile(path, "utf8"), timestamp = (await stat(path)).mtimeMs;
  assert.match(await save.execute(savedArgs), /内容未变化/);
  assert.equal(await readFile(path, "utf8"), before); assert.equal((await stat(path)).mtimeMs, timestamp);
  await save.execute({ ...savedArgs, days: [{ ...savedArgs.days[0], items: [{ ...savedArgs.days[0]!.items[0], name: "景点乙" }] }] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, 2);
  await rm(join(root, "plans/读取与保存.md"));
  await save.execute({ ...savedArgs, days: [{ ...savedArgs.days[0], items: [{ ...savedArgs.days[0]!.items[0], name: "景点乙" }] }] });
  assert.match(await readFile(join(root, "plans/读取与保存.md"), "utf8"), /景点乙/);
});

test("同版本读取仅回传一次正文，修改内容/请求范围后可重新读取，字节页仍保留游标", async (t) => {
  const root = await temp(t), save = createSaveItineraryTool(root), load = createLoadItineraryTool(root), ctx = { workspace: root, readVersions: new Map<string, string>() };
  await save.execute(savedArgs);
  assert.match(await load.execute({ title: savedArgs.title, day: 1 }, ctx), /"name": "景点甲"/);
  assert.match(await load.execute({ title: savedArgs.title, day: 1 }, ctx), /已读取/);
  assert.match(await load.execute({ title: savedArgs.title, summary: true }, ctx), /景点甲/);
  await save.execute({ ...savedArgs, days: [{ ...savedArgs.days[0], items: [{ ...savedArgs.days[0]!.items[0], name: "景点乙" }] }] });
  assert.match(await load.execute({ title: savedArgs.title, day: 1 }, ctx), /景点乙/);
  const file = createReadFileTool(root); await writeFile(join(root, "data.txt"), "abcdefghijk");
  await file.execute({ path: "data.txt", byte_offset: 0, byte_limit: 4 }, ctx);
  const duplicate = await file.execute({ path: "data.txt", byte_offset: 0, byte_limit: 4 }, ctx);
  assert.match(duplicate, /该版本字节页已读/); assert.match(duplicate, /byte_offset=4/);
  assert.match(await file.execute({ path: "data.txt", byte_offset: 4, byte_limit: 4 }, ctx), /efgh/);
  await writeFile(join(root, "data.txt"), "updated");
  assert.match(await file.execute({ path: "data.txt", byte_offset: 0, byte_limit: 4 }, ctx), /upda/);
});

test("模型持续请求同一工具时3个空转轮后停止，自动续跑不刷新额度", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root); let executions = 0, requests = 0;
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { executions++; return "已有候选"; } });
  const provider: ChatProvider = { name: "repeat", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => ({ type: "tool_calls", toolCalls: [{ id: `r${++requests}`, name: "search_attractions", arguments: JSON.stringify({ ...args, ...(requests % 2 ? {} : { radius_km: 10, limit: 10 }) }) }] }) };
  const session = new Session(); session.setTravelMode(true);
  const budget: CumulativeToolBudget = { calls: 0, rounds: 0, tokens: 0, maxCalls: 100, maxRounds: 100 };
  const agent = new ChatAgent(session, provider, registry, root);
  await agent.run("规划", { cumulativeBudget: budget, maxToolRounds: 100 });
  assert.equal(executions, 1); assert.equal(requests, 4); assert.equal(budget.redundantRounds, 3);
  await agent.run("自动续跑", { cumulativeBudget: budget, maxToolRounds: 100 }); assert.equal(requests, 4);
});


test("已查关键事项从模型工具选项移除，仍保留新场馆查询；后端拒绝重复调用", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), session = new Session();
  session.setTravelMode(true); session.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京一日游", destination: "北京", mustVisit: ["故宫博物院", "中国国家博物馆"] }));
  let requests = 0, executions = 0;
  registry.register({ name: "get_place_reviews", alwaysActive: true, description: "test", parameters: { type: "object", properties: {} }, execute: async () => { executions++; return "没有搜到相关评价内容"; } });
  registry.register(createSaveItineraryTool(root));
  const review = (name: string, id: string) => ({ id, name: "get_place_reviews", arguments: JSON.stringify({ place: name, aspect: "开放时间" }) });
  const provider: ChatProvider = { name: "specific-facts", chat: async () => "结束", chatWithTools: async (_history, tools): Promise<LLMResult> => {
    requests++;
    const definition = tools.find((tool) => tool.name === "get_place_reviews");
    if (requests === 1) return { type: "tool_calls", toolCalls: [review("故宫博物院", "a")] };
    if (requests === 2) {
      assert.deepEqual(((definition!.parameters.properties as Record<string, { enum: string[] }>).place!).enum, ["中国国家博物馆"]);
      return { type: "tool_calls", toolCalls: [review("故宫博物院", "repeat"), review("中国国家博物馆", "b")] };
    }
    if (requests === 3) assert.equal(definition, undefined);
    else assert.deepEqual(((definition!.parameters.properties as Record<string, { enum: string[] }>).place!).enum, ["景点甲"], "实际选中普通景点的开放缺口也需要查询");
    if (requests === 3) return { type: "tool_calls", toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify({ ...savedArgs, title: "北京一日游" }) }] };
    return { type: "text", content: "完成" };
  } };
  const b: CumulativeToolBudget = { calls: 0, rounds: 0, tokens: 0, maxCalls: 30, maxRounds: 30 };
  await new ChatAgent(session, provider, registry, root).run("北京一日游", { cumulativeBudget: b, maxToolRounds: 30 });
  assert.equal(executions, 2); assert.equal(b.diagnostics!.records.filter((r) => r.tool === "get_place_reviews" && r.execution === "blocked").length, 1);
  assert.equal(JSON.parse(await readFile(join(root, "plans/北京一日游.json"), "utf8")).days.length, 1);
});

test("显式口碑需求不被默认关键资料策略误拦，收敛规则不扩大已有工具参数范围", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京一日游", destination: "北京", mustVisit: ["故宫"] }));
  let calls = 0, requests = 0;
  registry.register({ name: "get_place_reviews", alwaysActive: true, description: "test", parameters: {}, execute: async () => { calls++; return "真实口碑摘要"; } });
  const provider: ChatProvider = { name: "explicit-reviews", chat: async () => "结束", chatWithTools: async (_h, tools): Promise<LLMResult> => {
    assert.ok(tools.some((tool) => tool.name === "get_place_reviews"));
    return requests++ === 0 ? { type: "tool_calls", toolCalls: [{ id: "review", name: "get_place_reviews", arguments: JSON.stringify({ place: "故宫", aspect: "口碑" }) }] } : { type: "text", content: "已查询" };
  } };
  await new ChatAgent(session, provider, registry, root).run("专门查一下故宫口碑", { maxToolRounds: 10 }); assert.equal(calls, 1);
  const narrowed = essentialReviewDefinitions([{ name: "get_place_reviews", description: "test", parameters: {} }], ["故宫"]);
  const focused = focusedEvidenceDefinitions(narrowed, false);
  assert.deepEqual((focused[0]!.parameters.properties as Record<string, { enum: string[] }>).aspect!.enum, ["开放时间"]);
});


test("增量保存可只传稳定ID及改动字段，保留其他字段和条目；未知ID/整天替换仍要求完整内容", async (t) => {
  const root = await temp(t), save = createSaveItineraryTool(root);
  await save.execute(savedArgs);
  await save.execute({ title: savedArgs.title, merge: true, days: [{ date: "2026-11-03", items: [{ id: "v", end_time: "12:30" }] }] });
  const path = join(root, "plans/读取与保存.json"), saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.days[0].items[0].name, "景点甲"); assert.equal(saved.days[0].items[0].time, "10:00"); assert.equal(saved.days[0].items[0].end_time, "12:30");
  await assert.rejects(() => save.execute({ title: savedArgs.title, merge: true, days: [{ date: "2026-11-03", items: [{ id: "unknown", end_time: "13:00" }] }] }));
  await assert.rejects(() => save.execute({ title: savedArgs.title, merge: true, merge_mode: "replace_day", days: [{ date: "2026-11-03", items: [{ id: "v", end_time: "13:00" }] }] }));
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, saved.revision);
});


test("候选摘要按类别保留酒店与主景区，不被后来的大量餐厅挤掉，必去别名可匹配主实体", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_stays", "北京", "1. 高分酒店 | 评分 4.9 | 参考价 ¥400 | 坐标 39.9000,116.4000\n2. 备用酒店 | 评分 4.4 | 参考价 ¥300 | 坐标 39.9100,116.4100", "amap");
  await evidence.observePlaces("search_attractions", "北京", "1. 故宫博物院 | 坐标 39.9100,116.4000", "amap");
  await evidence.observePlaces("search_restaurants", "北京", Array.from({ length: 30 }, (_, i) => `${i + 1}. 餐厅${i} | 评分 4.8 | 坐标 39.9200,116.4000`).join("\n"), "amap");
  const summary = evidence.summary("北京", ["故宫"], 2000);
  assert.match(summary, /高分酒店/); assert.match(summary, /故宫博物院/);
  assert.ok((summary.match(/地点 餐厅/g) ?? []).length <= 2);
});


test("重复查询混入新搜索也会进入修订阶段，补齐有效日期后恢复正常检索", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromBrief(undefined, { title: "北京三日游", destination: "北京", mustVisit: [] }));
  let requests = 0, executions = 0;
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { executions++; return "候选"; } });
  registry.register(createSaveItineraryTool(root));
  const search = (name: string) => ({ id: `${requests}-${name}`, name: "search_attractions", arguments: JSON.stringify({ city: "北京", location: name }) });
  const provider: ChatProvider = { name: "mixed-repeat", chat: async () => "结束", chatWithTools: async (_h, tools): Promise<LLMResult> => {
    requests++;
    if (requests === 1) return { type: "tool_calls", toolCalls: [search("缓存中心")] };
    if (requests <= 7) return { type: "tool_calls", toolCalls: [search("缓存中心"), search(`新中心${requests}`)] };
    if (requests === 8) { assert.equal(tools.some((tool) => tool.name === "search_attractions"), false); return { type: "tool_calls", toolCalls: [search("本应暂缓的中心")] }; }
    if (requests === 9) return { type: "tool_calls", toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify({ ...savedArgs, title: "北京三日游" }) }] };
    if (requests === 10) { assert.equal(tools.some((tool) => tool.name === "search_attractions"), true); return { type: "tool_calls", toolCalls: [search("恢复后的中心")] }; }
    return { type: "text", content: "完成" };
  } };
  const budget: CumulativeToolBudget = { calls: 0, rounds: 0, tokens: 0, maxCalls: 100, maxRounds: 100 };
  await new ChatAgent(session, provider, registry, root).run("规划", { cumulativeBudget: budget, maxToolRounds: 100 });
  assert.equal(requests, 11); assert.equal(executions, 8);
  assert.ok(await readFile(join(root, "plans/北京三日游.json"), "utf8"));
});


test("预算续期不把已查无依据当成可反复修复；P2提示不单独驱动续期，真实新依据可重绑定", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root), session = new Session();
  await registry.evidence.observePlaces("search_attractions", "北京", "1. 单馆博物馆 | 评分 4.8 | 坐标 39.9000,116.4000 | 开放时间 09:00-18:00", "amap");
  const save = createSaveItineraryTool(root);
  const input = { title: "已查闭馆", constraints: { destination: "北京", expected_days: 1, require_place_evidence: true }, days: [{ date: "2026-11-03", items: [
    { id: "museum", name: "单馆博物馆", type: "visit", time: "10:00", end_time: "12:00" },
    { id: "rest", name: "休息", type: "rest", time: "12:00", end_time: "13:00" },
  ] }] };
  session.add("tool", await save.execute(input, { workspace: root, evidence: registry.evidence }), { toolName: "save_itinerary" });
  const options = { rootDir: root, session, initialLimit: 30, currentLimit: 30, ceiling: 150, extensionStep: 15 };
  assert.equal((await assessToolBudget(options)).repair.canImprove, false, "未知闭馆不再是需要续期的硬错误");
  registry.register({ name: "get_place_reviews", description: "test", parameters: {}, execute: async () => "没有搜到相关评价内容" });
  await registry.execute("get_place_reviews", JSON.stringify({ city: "北京", place: "单馆博物馆", aspect: "开放时间" }));
  const checked = await assessToolBudget(options);
  assert.equal(checked.repair.canImprove, false); assert.equal(checked.repair.items.find((item) => item.code === "unverified-closure")?.category, "uncertain");
  await registry.evidence.observeClosure("北京", "单馆博物馆", [{ title: "单馆博物馆", snippet: "单馆博物馆每周一闭馆。" }]);
  assert.equal((await assessToolBudget(options)).repair.items.find((item) => item.code === "unverified-closure")?.category, "edit");
  await save.execute(input, { workspace: root, evidence: registry.evidence });
  const noop = await save.execute(input, { workspace: root, evidence: registry.evidence });
  const newSession = new Session(); newSession.add("tool", noop, { toolName: "save_itinerary" });
  const after = await assessToolBudget({ ...options, session: newSession });
  assert.equal(after.quality.available, true); assert.equal(after.repair.canImprove, false);
});
