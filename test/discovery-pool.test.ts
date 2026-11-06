import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { createFoodTool } from "../src/tools/food.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import type { AmapPoi } from "../src/tools/amap.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { TravelEvidenceStore, evidenceId } from "../src/tools/travel-evidence.ts";
import { DiscoveryPoolStore, discoveryCenterName, type DiscoveryPool } from "../src/tools/discovery-pool.ts";
import { QUERY_TTL_MS, queryKeyArgs } from "../src/tools/travel-query.ts";
import { ToolDiagnostics } from "../src/core/tool-diagnostics.ts";

const geo = { name: "大雁塔", latitude: 34.26, longitude: 108.94, crs: "gcj02" as const, country: "中国", admin1: "陕西省" };
const poi = (id: string, rating: string, cost: string, latitude = 34.26, cuisine = "陕西菜"): AmapPoi => ({
  id, name: `候选${id}`, cityname: "西安市", location: `108.94,${latitude}`, type: `餐饮服务;中餐厅;${cuisine}`, biz_ext: { rating, cost },
});
const sample = [poi("甲", "4.9", "150"), poi("乙", "4.7", "70", 34.261, "面馆"), poi("丙", "4.6", "40", 34.262, "火锅"), poi("丁", "4.4", "30", 34.28, "西餐"), poi("远", "4.8", "80", 34.40)];
const pool = (overrides: Partial<DiscoveryPool> = {}): DiscoveryPool => ({ tool: "search_attractions", city: "西安", center: "大雁塔", geo, keyword: "", radius_km: 5, pois: sample, observed_at: Date.now(), ...overrides });

function install(t: TestContext, options: { museumFails?: boolean } = {}) {
  const requests: { keyword: string; radius: number }[] = [];
  let http = 0;
  setAmapKey("pool-test", async (input) => {
    http++;
    const url = new URL(String(input));
    const keyword = url.searchParams.get("keywords") ?? "";
    const radius = Number(url.searchParams.get("radius"));
    const reply = (body: object) => new Response(JSON.stringify({ status: "1", infocode: "10000", ...body }));
    if (url.pathname.includes("geocode")) return reply({ geocodes: [{ formatted_address: "陕西省西安市", province: "陕西省", city: "西安市", location: "108.94,34.26" }] });
    if (!radius) return reply({ pois: [{ ...sample[0], id: "center", name: keyword, location: "108.94,34.26" }] });
    requests.push({ keyword, radius });
    if (keyword.includes("博物馆")) {
      if (options.museumFails) throw new Error("quota exceeded");
      return reply({ pois: [] });
    }
    return reply({ pois: sample });
  });
  t.after(() => setAmapKey(undefined));
  return { requests, http: () => http };
}

const ctx = () => ({ workspace: process.cwd(), queryAttempts: new Map<string, number>(), queryStats: { executed: 0, cacheHits: 0, blocked: 0 } });
const attractionArgs = { city: "西安", location: "大雁塔", radius_km: 5, limit: 1 };

test("候选池只在同城、同关键词、完整包含范围及30分钟内复用，城市前缀不误改实体", () => {
  const store = new DiscoveryPoolStore();
  store.merge([pool(), pool({ city: "北京", center: "异地中心", radius_km: 10 })]);
  assert.ok(store.find("search_attractions", "西安市", "西安 大雁塔", "", 4));
  assert.equal(store.find("search_attractions", "西安", "大雁塔", "", 6), undefined);
  assert.equal(store.find("search_attractions", "广州", "大雁塔", "", 1), undefined);
  assert.equal(store.find("search_attractions", "西安", "大雁塔", "火锅", 1), undefined);
  assert.ok(store.find("search_attractions", "西安", "邻近中心", "", 4, { ...geo, latitude: 34.265 }));
  assert.equal(store.find("search_attractions", "西安", "邻近中心", "", 5, { ...geo, latitude: 34.265 }), undefined, "相交但未包含不能复用");
  assert.equal(discoveryCenterName("西安城墙", "西安"), "西安城墙");
  assert.equal(discoveryCenterName("  西安市   大雁塔  ", "西安"), "大雁塔");
  store.merge([pool({ radius_km: 2, observed_at: Date.now() })]);
  assert.match(store.context(["大雁塔"])[0], /5km/, "提示保留最大的仍有效范围");
  const expired = new DiscoveryPoolStore();
  expired.merge([pool({ observed_at: Date.now() - QUERY_TTL_MS }), pool({ observed_at: Date.now() + 10000 }), { bad: true }]);
  assert.equal(expired.snapshot().length, 0);
});

test("景点从展示前的原始池扩展数量/筛评分/缩圈，城市前缀不重查，局部失败警告保留", async (t) => {
  const mock = install(t, { museumFails: true });
  const registry = new ToolRegistry().register(createAttractionsTool());
  const context = ctx();
  const first = await registry.execute("search_attractions", JSON.stringify(attractionArgs), context);
  assert.match(first, /1\. 候选甲/);
  assert.doesNotMatch(first, /候选乙/);
  const http = mock.http();
  const projected = await registry.execute("search_attractions", JSON.stringify({ ...attractionArgs, location: "西安 大雁塔", radius_km: 1, limit: 10 }), context);
  assert.match(projected, /候选乙.*evidence_id|候选乙:/s);
  assert.doesNotMatch(projected, /候选丁|候选远/);
  assert.match(projected, /博物馆\/纪念馆搜索失败/);
  const filtered = await registry.execute("search_attractions", JSON.stringify({ ...attractionArgs, min_rating: 4.8, limit: 10 }), context);
  assert.doesNotMatch(filtered, /候选乙/);
  assert.equal(mock.http(), http);
  assert.deepEqual(context.queryStats, { executed: 1, cacheHits: 2, blocked: 0 });
  assert.equal(mock.requests.length, 2);
});

test("餐厅改预算/评分/排除菜系/数量后从原始池重排；新菜系联网且同中心共享两次预算", async (t) => {
  const mock = install(t);
  const registry = new ToolRegistry().register(createFoodTool());
  const context = ctx();
  const args = { city: "大雁塔", region: "西安", radius_km: 3, limit: 1 };
  await registry.execute("search_restaurants", JSON.stringify(args), context);
  const http = mock.http();
  const filtered = await registry.execute("search_restaurants", JSON.stringify({ ...args, radius_km: 1, limit: 10, max_cost: 80, min_rating: 4.5, avoid_cuisines: "火锅" }), context);
  assert.match(filtered, /候选乙.*人均 ¥70/);
  assert.doesNotMatch(filtered, /候选甲|候选丙|候选丁/);
  assert.equal(mock.http(), http);
  await registry.execute("search_restaurants", JSON.stringify({ ...args, cuisine: "火锅" }), context);
  assert.equal(mock.requests.length, 2, "改上游关键词需要真正补查");
  const blocked = await registry.execute("search_restaurants", JSON.stringify({ ...args, radius_km: 6, max_cost: 100, limit: 9 }), context);
  assert.match(blocked, /同一中心已联网搜索两次/);
  assert.equal(mock.requests.length, 2);
  const local = await registry.execute("search_restaurants", JSON.stringify({ ...args, limit: 9, max_cost: 90 }), context);
  assert.match(local, /候选乙/);
  assert.deepEqual(context.queryStats, { executed: 2, cacheHits: 2, blocked: 1 });
});

test("餐厅扩圈补查一次，后续缩圈复用；改limit与refresh不能重置联网预算", async (t) => {
  const mock = install(t);
  const registry = new ToolRegistry().register(createFoodTool());
  const context = ctx();
  const args = { city: "大雁塔", region: "西安", radius_km: 3 };
  await registry.execute("search_restaurants", JSON.stringify(args), context);
  await registry.execute("search_restaurants", JSON.stringify({ ...args, radius_km: 6 }), context);
  const result = await registry.execute("search_restaurants", JSON.stringify({ ...args, radius_km: 4, limit: 12 }), context);
  assert.match(result, /覆盖半径 6 公里/);
  assert.equal(mock.requests.length, 2);
  const denied = await registry.execute("search_restaurants", JSON.stringify({ ...args, refresh: true, limit: 11 }), context);
  assert.match(denied, /同一中心已联网搜索两次/);
  assert.equal(mock.requests.length, 2);
});

test("同中心不同投影并发时等待原始采集再重筛，统计按缓存命中记录", async (t) => {
  const mock = install(t);
  const registry = new ToolRegistry().register(createAttractionsTool());
  const context = ctx();
  const diagnostics = new ToolDiagnostics();
  const calls = [attractionArgs, { ...attractionArgs, limit: 8, radius_km: 4 }, { ...attractionArgs, limit: 9, radius_km: 3 }];
  const results = await Promise.all(calls.map((args, i) => {
    const call = { id: String(i), name: "search_attractions", arguments: JSON.stringify(args) };
    return diagnostics.run(call, 1, async () => ({ output: await registry.execute(call.name, call.arguments, context) }));
  }));
  assert.match(results[1].output, /候选乙/);
  assert.match(results[2].output, /候选乙/);
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(diagnostics.records.map((r) => r.execution), ["executed", "cache_hit", "cache_hit"]);
  assert.deepEqual(context.queryStats, { executed: 1, cacheHits: 2, blocked: 0 });
});

test("候选池随证据持久化，合并其他会话的新池，路线日志不淹没范围提示", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discovery-pool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = new TravelEvidenceStore(root), b = new TravelEvidenceStore(root);
  await Promise.all([a.load(), b.load()]);
  await a.observeDiscoveryPool(pool());
  await b.observeDiscoveryPool(pool({ tool: "search_restaurants", radius_km: 3 }));
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  assert.equal(restored.discoveryPools.snapshot().length, 2);
  const persisted = JSON.parse(await readFile(join(root, ".minicode/travel-evidence.json"), "utf8"));
  assert.equal(persisted.discovery_pools[0].pois.length, sample.length);
  for (let i = 0; i < 12; i++) await restored.observeQuery({ key: String(i), tool: "plan_day_routes", city: "西安", entity: "西安", topic: "plan_day_routes", status: "returned", at: Date.now() });
  const hints = restored.queryContext(["大雁塔"], 1600);
  assert.match(hints, /search_attractions.*5km\/5个原始候选/);
  assert.match(hints, /search_restaurants.*3km\/5个原始候选/);
  assert.equal(hints.split("plan_day_routes").length - 1, 2, "同一事项只保留一行工具/主题");
  assert.ok(hints.length <= 1600);
  install(t);
  const registry = new ToolRegistry(root).register(createAttractionsTool());
  const context = ctx();
  const result = await registry.execute("search_attractions", JSON.stringify({ ...attractionArgs, limit: 10 }), context);
  assert.match(result, /候选乙/);
  assert.equal(context.queryStats.executed, 0);
  assert.equal(context.queryStats.cacheHits, 1);
});

test("本地重筛不延长候选池、投影缓存及已查状态的30分钟寿命", async (t) => {
  install(t);
  const registry = new ToolRegistry().register(createAttractionsTool());
  await registry.execute("search_attractions", JSON.stringify(attractionArgs));
  const originalAt = registry.evidence.discoveryPools.snapshot()[0].observed_at;
  let now = originalAt + QUERY_TTL_MS - 1;
  const clock = t.mock.method(Date, "now", () => now);
  const args = { ...attractionArgs, radius_km: 4, limit: 9 };
  await registry.execute("search_attractions", JSON.stringify(args));
  const key = evidenceId(["search_attractions", queryKeyArgs("search_attractions", args)]);
  assert.ok(registry.evidence.cached(key));
  now = originalAt + QUERY_TTL_MS;
  assert.equal(registry.evidence.cached(key), undefined);
  assert.equal(registry.evidence.queryRecord(key), undefined);
  assert.equal(registry.evidence.discoveryPools.snapshot().length, 0);
  clock.mock.restore();
});

test("复用旧池不会覆盖较新的同地点评分", async () => {
  const evidence = new TravelEvidenceStore();
  const old = Date.now() - 1000;
  await evidence.observePlaces("search_attractions", "西安", "1. 大雁塔 | 评分 4.9 | 坐标 34.2600,108.9400", "amap");
  await evidence.observePlaces("search_attractions", "西安", "1. 大雁塔 | 评分 4.1 | 坐标 34.2600,108.9400", "amap", undefined, old);
  assert.match(evidence.summary("西安", ["大雁塔"], 1500), /4.9/);
});

test("坐标核验失败共用中心预算，换半径和数量不能无限重复联网", async () => {
  const registry = new ToolRegistry();
  let lookups = 0;
  registry.register({ name: "search_attractions", description: "test", parameters: {}, usesDiscoveryPool: true, async execute(_args, ctx) {
    lookups++;
    ctx?.beforeDiscoveryFetch?.();
    return "未找到地点";
  } });
  const context = ctx();
  await registry.execute("search_attractions", JSON.stringify(attractionArgs), context);
  await registry.execute("search_attractions", JSON.stringify({ ...attractionArgs, limit: 9 }), context);
  const blocked = await registry.execute("search_attractions", JSON.stringify({ ...attractionArgs, radius_km: 10, limit: 8 }), context);
  assert.match(blocked, /两次未能核验坐标/);
  assert.equal(lookups, 2);
  assert.deepEqual(context.queryStats, { executed: 2, cacheHits: 0, blocked: 1 });
});
