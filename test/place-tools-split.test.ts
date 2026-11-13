import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVisitInfoTool } from "../src/tools/place-visit-info.ts";
import { createReviewsTool, hasReviewAnswer } from "../src/tools/reviews.ts";
import { PlaceSourceClient, type PlaceSearchProvider } from "../src/tools/place-sources.ts";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { ToolDiagnostics } from "../src/core/tool-diagnostics.ts";
import { normalizeVisitInfoArgs } from "../src/tools/travel-query.ts";
import { queryKeyArgs } from "../src/tools/travel-query.ts";
import { TravelEvidenceStore, evidenceId } from "../src/tools/travel-evidence.ts";
import type { OpeningSource } from "../src/tools/opening-facts.ts";

const place = "测试公园", city = "南昌";
const source = (snippet: string): OpeningSource => ({ title: `${place}参观指南`, snippet, url: "https://example.org/visit", engine: "fixture" });
const emptyFetch: typeof fetch = async () => new Response("没有相关结果");

test("默认目录暴露两个职责分开的工具；错误入口在联网前给出具体纠正信息", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "place-split-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  const visit = registry.definitions().find((tool) => tool.name === "get_place_visit_info")!;
  const reviews = registry.definitions().find((tool) => tool.name === "get_place_reviews")!;
  assert.ok(visit); assert.ok(reviews); assert.equal(registry.size, 25);
  assert.equal((visit.parameters.properties as Record<string, unknown>).aspect, undefined);
  assert.equal((reviews.parameters.properties as Record<string, unknown>).fields, undefined);
  assert.deepEqual(((reviews.parameters.properties as Record<string, { enum?: string[] }>).aspect!).enum, ["口碑", "人均价格", "招牌菜", "排队"]);
  let requests = 0;
  const isolated = new ToolRegistry(root).register(createReviewsTool(async () => { requests++; return new Response(""); })).register(createVisitInfoTool(emptyFetch));
  await assert.rejects(() => isolated.execute("get_place_reviews", JSON.stringify({ place, aspect: "开放时间" })), { code: "PLACE_REVIEWS_WRONG_TOOL" });
  await assert.rejects(() => isolated.execute("get_place_reviews", JSON.stringify({ place, fields: ["hours"] })), { code: "PLACE_REVIEWS_WRONG_TOOL" });
  await assert.rejects(() => isolated.execute("get_place_visit_info", JSON.stringify({ place, aspect: "口碑" })), { code: "VISIT_INFO_USE_FIELDS" });
  await assert.rejects(() => isolated.execute("get_place_visit_info", JSON.stringify({ place, fields: [] })), { code: "VISIT_INFO_FIELDS_INVALID" });
  await assert.rejects(() => isolated.execute("get_place_visit_info", JSON.stringify({ place, visit_date: "2026-02-30" })), { code: "VISIT_INFO_DATE_INVALID" });
  assert.equal(requests, 0);
});

test("参观默认字段按类型选择；字段次序和重复不改变语义", () => {
  assert.deepEqual(normalizeVisitInfoArgs({ place }).fields, ["hours"]);
  assert.deepEqual(queryKeyArgs("get_place_visit_info", { place, city: " 南昌 " }), queryKeyArgs("get_place_visit_info", { place, city }));
  assert.deepEqual(queryKeyArgs("get_place_reviews", { place, city: " 南昌 " }), queryKeyArgs("get_place_reviews", { place, city }));
  assert.deepEqual(normalizeVisitInfoArgs({ place: "测试博物馆" }).fields, ["closure", "hours"]);
  assert.deepEqual(normalizeVisitInfoArgs({ place: "测试音乐喷泉" }).fields, ["hours", "sessions"]);
  assert.deepEqual(normalizeVisitInfoArgs({ place, fields: ["hours", "closure", "hours"] }).fields, ["closure", "hours"]);
});

test("参观一次查齐请求字段并顺带提取时长，不为可选时长追加来源请求", async () => {
  let requests = 0;
  const provider: PlaceSearchProvider = { name: "fixture", search: async () => { requests++; return [source("每天09:00-17:00；周一闭馆；16:30停止入园；建议游玩2小时")]; } };
  const tool = createVisitInfoTool(async () => { throw new Error("不应继续读取页面或搜索引擎"); }, provider);
  const output = await tool.execute({ place, city, fields: ["hours", "closure"] });
  assert.equal(requests, 1); assert.match(output, /hours: verified/); assert.match(output, /closure: verified/);
  assert.match(output, /last_admission: verified/); assert.match(output, /游玩时长参考/);
});

test("显式时长查询命中来源摘要即停止；口碑工具不返回时长或写开放事实", async () => {
  let requests = 0;
  const provider: PlaceSearchProvider = { name: "fixture", search: async () => { requests++; return [source("建议游玩2小时，风景值得推荐；09:00-17:00开放；周一闭馆")]; } };
  const failFetch: typeof fetch = async () => { throw new Error("不应读取第二份来源"); };
  assert.match(await createVisitInfoTool(failFetch, provider).execute({ place, city, fields: ["visit_duration"] }), /游玩时长参考/);
  const evidence = new TravelEvidenceStore();
  const output = await createReviewsTool(failFetch, provider).execute({ place, city }, { workspace: ".", evidence });
  assert.equal(requests, 2); assert.doesNotMatch(output, /⏱|开放字段证据/);
  assert.equal(evidence.hasVerifiedClosure(city, place), false); assert.ok(Object.values(evidence.openingFactsFor(city, place)).every((value) => value === undefined));
});

for (const [aspect, snippet] of [["人均价格", "人均消费约60元"], ["招牌菜", "招牌菜是糖醋鱼"], ["排队", "周末等位约30分钟"], ["口碑", "环境安静，值得推荐"]]) {
  test(`口碑问题${aspect}一个明确摘要即可停止，不再为凑三个链接搜索`, async () => {
    let requests = 0;
    const provider: PlaceSearchProvider = { name: "fixture", search: async () => { requests++; return [source(snippet!)]; } };
    const output = await createReviewsTool(async () => { requests++; throw new Error("不应追加请求"); }, provider).execute({ place, city, aspect });
    assert.equal(requests, 1); assert.match(output, /网络评价摘要/); assert.doesNotMatch(output, /未找到明确的/);
  });
}

test("仅有链接/未知排队/门票价格不代表已回答体验问题", async () => {
  assert.equal(hasReviewAnswer([source("排队情况未知")], "排队"), false);
  assert.equal(hasReviewAnswer([source("门票60元")], "人均价格"), false);
  assert.equal(hasReviewAnswer([source("招牌菜暂无资料")], "招牌菜"), false);
  const evidence = new TravelEvidenceStore(), registry = new ToolRegistry().register(createReviewsTool(emptyFetch, { name: "fixture", search: async () => [source("这是地点的介绍页面")] }));
  const output = await registry.execute("get_place_reviews", JSON.stringify({ place, city, aspect: "排队" }), { workspace: ".", evidence });
  assert.match(output, /未找到明确的排队依据/); assert.match(evidence.queryContext([place]), /已查询但未找到/);
});

test("已读正文跨两类工具复用；复用原始采集时间并标记为缓存命中", async (t) => {
  let now = 1_800_000_000_000, requests = 0; t.mock.method(Date, "now", () => now);
  const client = new PlaceSourceClient(async (input) => {
    requests++;
    if (String(input).includes("bing.com")) return new Response('<li class="b_algo"><h2><a href="https://example.org/visit">测试公园参观指南</a></h2><p>详情请见正文</p></li>');
    return new Response(`<title>测试公园</title><article><p>每天开放时间09:00-17:00。</p><p>${"园区介绍。".repeat(150)}</p><p>周末等位约30分钟。</p></article>`);
  });
  const ctx = { workspace: ".", queryAttempts: new Map<string, number>(), queryStats: { executed: 0, cacheHits: 0, blocked: 0 } };
  const registry = new ToolRegistry().register(createVisitInfoTool(undefined, undefined, client)).register(createReviewsTool(undefined, undefined, client));
  const visit = await registry.execute("get_place_visit_info", JSON.stringify({ place, city }), ctx);
  assert.equal(requests, 2); assert.match(visit, /开放时段.*closes/);
  const observedAt = now;
  now += 60_000;
  const reviews = await registry.execute("get_place_reviews", JSON.stringify({ place, city, aspect: "排队" }), ctx);
  assert.equal(requests, 2); assert.match(reviews, /周末等位约30分钟/);
  assert.deepEqual(ctx.queryStats, { executed: 1, cacheHits: 1, blocked: 0 });
  const key = evidenceId(["get_place_reviews", queryKeyArgs("get_place_reviews", { place, city, aspect: "排队" })]);
  assert.equal(registry.evidence.queryRecord(key)?.at, observedAt);
});

test("切换工具、字段与refresh也受同一地点8次来源预算限制；新任务独立", async () => {
  let requests = 0;
  const client = new PlaceSourceClient(async () => { requests++; return new Response("无结果"); });
  const ctx = { workspace: ".", queryAttempts: new Map<string, number>() };
  const diagnostics = new ToolDiagnostics();
  const visit = createVisitInfoTool(undefined, undefined, client), reviews = createReviewsTool(undefined, undefined, client);
  await diagnostics.run({ id: "visit", name: visit.name, arguments: "{}" }, 1, async () => ({ output: await visit.execute({ place, city }, ctx) }));
  assert.equal(requests, 4);
  await diagnostics.run({ id: "review", name: reviews.name, arguments: "{}" }, 2, async () => ({ output: await reviews.execute({ place, city, refresh: true }, ctx) }));
  assert.equal(requests, 8);
  const blocked = await reviews.execute({ place, city, aspect: "排队", refresh: true }, ctx);
  assert.equal(requests, 8); assert.match(blocked, /来源预算已用尽/);
  assert.deepEqual(diagnostics.records.map((record) => record.place_lookup?.entity_requests), [4, 8]);
  await visit.execute({ place, city }, { workspace: ".", queryAttempts: new Map() }); assert.equal(requests, 12);
});

test("验证码与退避不能变成已查无依据；缺口仍可在恢复后重试", async () => {
  const evidence = new TravelEvidenceStore(), client = new PlaceSourceClient(async () => new Response("<title>安全验证</title>", { status: 403 }));
  const registry = new ToolRegistry().register(createVisitInfoTool(undefined, undefined, client));
  const ctx = { workspace: ".", evidence, queryAttempts: new Map<string, number>() };
  const diagnostics = new ToolDiagnostics(), args = JSON.stringify({ place, city });
  const { output } = await diagnostics.run({ id: "blocked-search", name: "get_place_visit_info", arguments: args }, 1,
    async () => ({ output: await registry.execute("get_place_visit_info", args, ctx) }));
  assert.match(output, /搜索失败/); assert.equal(evidence.openingFactsFor(city, place).hours, undefined);
  assert.match(evidence.queryContext([place]), /服务未返回有效数据/);
  assert.deepEqual(evidence.pendingVisitInfoPlaces([place], city), [place]);
  assert.deepEqual(diagnostics.records[0]?.opening_fields, { requested: ["hours"], retrieved_sources: 0, body_sources: 0, extracted: [], evidence_ids: [] });
});


test("搜索发现的正文HTTP错误不缓存，显式重试仍访问正文", async () => {
  let officialRequests = 0;
  const tool = createVisitInfoTool(async (input) => {
    if (String(input).includes("bing.com")) return new Response('<li class="b_algo"><h2><a href="https://museum.example/visit">故宫博物院参观指南</a></h2></li>');
    if (String(input).includes("museum.example")) { officialRequests++; return new Response("服务暂时不可用", { status: 503 }); }
    return new Response("没有相关搜索结果");
  });
  const registry = new ToolRegistry().register(tool), evidence = registry.evidence;
  const ctx = { workspace: ".", queryAttempts: new Map<string, number>() }, args = { place: "故宫博物院", city: "北京" };
  assert.match(await registry.execute(tool.name, JSON.stringify(args), ctx), /搜索失败/);
  assert.equal(evidence.openingFactsFor("北京", "故宫博物院").hours, undefined);
  assert.match(await registry.execute(tool.name, JSON.stringify({ ...args, refresh: true }), ctx), /正文HTTP 503/);
  assert.equal(officialRequests, 2); assert.match(evidence.queryContext(["故宫博物院"]), /服务未返回有效数据/);
});


test("口碑只有相关链接但后续读取受阻时保持失败，不将缺少答案持久化为无依据", async () => {
  const tool = createReviewsTool(async () => new Response("<title>安全验证</title>", { status: 403 }), { name: "fixture", search: async () => [source("地点的详细介绍请见网页")] });
  const registry = new ToolRegistry().register(tool);
  const output = await registry.execute(tool.name, JSON.stringify({ place, city, aspect: "排队" }));
  assert.match(output, /评价信息查询受阻/); assert.match(registry.evidence.queryContext([place]), /服务未返回有效数据/);
  assert.doesNotMatch(registry.evidence.queryContext([place]), /已查询但未找到/);
});


test("时长参考及其缓存复用都记为返回资料，不冒充自动回填的核验规则", async () => {
  let requests = 0;
  const registry = new ToolRegistry().register(createVisitInfoTool(emptyFetch, { name: "fixture", search: async () => { requests++; return [source("建议游玩2小时")]; } }));
  const diagnostics = new ToolDiagnostics(), args = JSON.stringify({ place, city, fields: ["visit_duration"] });
  for (const id of ["first", "reused"]) await diagnostics.run({ id, name: "get_place_visit_info", arguments: args }, 1, async () => ({ output: await registry.execute("get_place_visit_info", args) }));
  assert.equal(requests, 1); assert.deepEqual(diagnostics.records.map((record) => record.execution), ["executed", "cache_hit"]);
  assert.deepEqual(diagnostics.records.map((record) => record.query_status), ["returned", "returned"]);
});
