import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { assessToolBudget } from "../src/runtime/tool-budget.ts";
import { AmapClient, AmapServiceError } from "../src/tools/amap.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { convertPoint } from "../src/tools/coordinates.ts";
import { geocodeInCity, poiCityVerdict } from "../src/tools/geocoding.ts";
import { createSaveItineraryTool, createValidateItineraryTool, renderMarkdown } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { totalCostPerPerson, validateItinerary } from "../src/tools/itinerary-validator.ts";
import { commitPlanFiles, planFileFor } from "../src/tools/plan-files.ts";
import { recommendationCoverage } from "../src/tools/recommendation-policy.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { fetchOsrmRoute } from "../src/tools/route.ts";
import { overpassQuery } from "../src/tools/overpass.ts";
import { ToolRegistry, type ItinerarySnapshot } from "../src/tools/tool.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { applyPlanEdit } from "../src/web/plan-edit.ts";
import { resolvePlanCoordinates, unresolvedCoordinateCount } from "../src/web/plan-coords.ts";
import { startWebServer } from "../src/web/server.ts";

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minicode-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const day = (date = "2026-11-01", name = "景点") => ({ date, items: [{ id: name, name, type: "visit", time: "10:00", end_time: "11:00" }] });
const response = (body: object) => new Response(JSON.stringify({ status: "1", infocode: "10000", ...body }));
const readPlan = async (root: string, title: string) => parseItinerary(JSON.parse(await readFile(planFileFor(root, "plans", title, "json"), "utf8")));

test("Web 替换清除原地点证据、评分、费用；版本、Markdown、报告和快照一致", async (t) => {
  const root = await temp(t);
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_restaurants", "北京", "高德数据\n1. 原餐厅 | 评分 4.9 | 人均 ¥88 | 坐标 39.9000,116.4000");
  await createSaveItineraryTool(root).execute({ title: "编辑证据", days: [{ items: [{ id: "meal", name: "原餐厅", type: "meal" }] }] });
  assert.equal((await readPlan(root, "编辑证据")).days[0].items[0].evidence_verified, true);
  let snapshot: ItinerarySnapshot | undefined;
  const result = await applyPlanEdit(root, { title: "编辑证据", day: 1, item_id: "meal", op: "replace", expected_revision: 1, replacement: { name: "新餐厅", latitude: 39.91, longitude: 116.41 } }, { workspace: root, onItinerary: (value) => { snapshot = value; } });
  const plan = await readPlan(root, "编辑证据");
  const item = plan.days[0].items[0];
  assert.equal(result.revision, 2);
  assert.deepEqual(plan, snapshot!.itinerary);
  assert.equal(item.evidence_verified, false);
  for (const key of ["evidence_id", "rating", "cost_per_person", "evidence_observed_at", "opening_hours"]) assert.equal(item[key as keyof ItineraryItem], undefined, key);
  assert.equal(await readFile(join(root, "plans/编辑证据.md"), "utf8"), renderMarkdown(plan));
  const report = JSON.parse(await readFile(join(root, "plans/编辑证据.quality.json"), "utf8"));
  assert.deepEqual(report, snapshot!.report);
  await assert.rejects(() => applyPlanEdit(root, { title: "编辑证据", day: 1, item_id: "meal", op: "remove", expected_revision: 1 }), /版本冲突/);
  assert.equal((await readPlan(root, "编辑证据")).revision, 2);
});

test("Web 编辑同样执行 P0 校验，拒绝删除最后条目且保留原文件", async (t) => {
  const root = await temp(t);
  await createSaveItineraryTool(root).execute({ title: "拒绝空日", days: [day()] });
  const before = await readFile(join(root, "plans/拒绝空日.json"), "utf8");
  await assert.rejects(() => applyPlanEdit(root, { title: "拒绝空日", day: 1, item_id: "景点", op: "remove" }), /非空数组/);
  assert.equal(await readFile(join(root, "plans/拒绝空日.json"), "utf8"), before);
});

test("Web 手输地点通过地理编码兜底时保留 GCJ02 坐标系", async (t) => {
  const root = await temp(t);
  await createSaveItineraryTool(root).execute({ title: "编辑编码坐标系", days: [day()] });
  setAmapKey("edit-geocode-crs", (async () => response({ geocodes: [{ formatted_address: "北京市编辑兜底地点", location: "116.406243,39.901404", country: "中国", province: "北京市", city: "北京市", district: "东城区" }] })) as typeof fetch);
  t.after(() => setAmapKey(undefined));
  await applyPlanEdit(root, { title: "编辑编码坐标系", day: 1, item_id: "景点", op: "replace", replacement: { name: "编辑兜底地点" } });
  const item = (await readPlan(root, "编辑编码坐标系")).days[0].items[0];
  assert.equal(item.location?.crs, "gcj02");
  assert.equal(item.location?.longitude, 116.406243);
  assert.equal(item.evidence_verified, false, "地理编码本身不能充当评分和营业信息证据");
});

test("餐饮候选按实体去重；复制已核实餐厅不能充足四个候选", () => {
  const meal = { name: "同一家", type: "meal", subtype: "lunch", evidence_id: "same", evidence_verified: true, rating: 4.8, cost_per_person: 50 };
  const plan = parseItinerary({ title: "去重", constraints: { recommendations: true, recommendation_mode: "strict", meal_candidates_target: 4 }, days: [{ items: Array.from({ length: 4 }, (_, i) => ({ ...meal, id: String(i) })) }] });
  assert.equal(recommendationCoverage(plan).slots[0].count, 1);
  assert.ok(validateItinerary(plan).issues.some((issue) => issue.code === "recommendation-slot-coverage"));
  const branches = parseItinerary({ title: "不同分店", days: [{ items: Array.from({ length: 4 }, (_, i) => ({ ...meal, evidence_id: `branch-${i}`, id: String(i) })) }] });
  assert.equal(recommendationCoverage(branches).slots[0].count, 4);
  const unverified = parseItinerary({ title: "覆盖率", days: [{ items: [...Array.from({ length: 4 }, (_, i) => ({ ...meal, id: String(i) })), { name: "待核实", type: "meal", subtype: "lunch" }] }] });
  assert.equal(recommendationCoverage(unverified).evidenceRate, 0.5);
});

test("并发增量保存保留所有日期及单调版本；校验不能覆盖新版质量报告", async (t) => {
  const root = await temp(t);
  const save = createSaveItineraryTool(root);
  await save.execute({ title: "并发保存", days: [day()] });
  await Promise.all([
    save.execute({ title: "并发保存", merge: true, days: [day("2026-11-02", "第二天")] }),
    save.execute({ title: "并发保存", merge: true, days: [day("2026-11-03", "第三天")] }),
    createValidateItineraryTool(root).execute({ title: "并发保存" }),
  ]);
  const plan = await readPlan(root, "并发保存");
  assert.equal(plan.revision, 3);
  assert.deepEqual(plan.days.map((value) => value.date), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  const report = JSON.parse(await readFile(join(root, "plans/并发保存.quality.json"), "utf8"));
  assert.deepEqual(report.issues, validateItinerary(plan).issues);
  await assert.rejects(() => save.execute({ title: "并发保存", expected_revision: 1, days: [day()] }), /版本冲突/);
});

test("两个独立 Node 进程更新同一行程也不丢失日期", async (t) => {
  const root = await temp(t);
  await createSaveItineraryTool(root).execute({ title: "跨进程", days: [day()] });
  const moduleUrl = new URL("../src/tools/itinerary.ts", import.meta.url).href;
  await Promise.all([2, 3].map((index) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {createSaveItineraryTool} from ${JSON.stringify(moduleUrl)}; await createSaveItineraryTool(${JSON.stringify(root)}).execute(${JSON.stringify({ title: "跨进程", merge: true, days: [day(`2026-11-0${index}`, `日期${index}`)] })});`])));
  const plan = await readPlan(root, "跨进程");
  assert.equal(plan.days.length, 3);
  assert.equal(plan.revision, 3);
});

test("提交文件预检失败不留下部分更新，失败后锁可再次使用", async (t) => {
  const root = await temp(t);
  const good = join(root, "readable.md"), bad = join(root, "directory");
  await writeFile(good, "old");
  await mkdir(bad);
  await assert.rejects(() => commitPlanFiles([[good, "new"], [bad, "invalid"]]));
  assert.equal(await readFile(good, "utf8"), "old");
  const save = createSaveItineraryTool(root);
  await assert.rejects(() => save.execute({ title: "锁释放", expected_revision: 4, days: [day()] }));
  await save.execute({ title: "锁释放", days: [day()] });
  assert.equal((await readPlan(root, "锁释放")).revision, 1);
});

test("同省不同市不能互认，直辖市和显式省级查询仍支持", () => {
  const poi = { id: "1", name: "公园", location: "125.3,43.9", pname: "吉林省", cityname: "长春市" };
  assert.equal(poiCityVerdict(poi, "吉林市"), "mismatch");
  assert.equal(poiCityVerdict(poi, "吉林"), "mismatch");
  assert.equal(poiCityVerdict(poi, "长春"), "match");
  assert.equal(poiCityVerdict(poi, "吉林省"), "match");
  assert.equal(poiCityVerdict({ ...poi, pname: "北京市", cityname: undefined }, "北京"), "match");
});

test("需求预算更新会重新推导人均，人数默认两人且显式预算覆盖保留", async (t) => {
  const root = await temp(t);
  const brief = createSaveTravelBriefTool(root), save = createSaveItineraryTool(root);
  const request = { title: "预算更新", destination: "北京", budgetTotalYuan: 1000 };
  await brief.execute(request);
  await save.execute({ title: request.title, days: [day()] });
  let plan = await readPlan(root, request.title);
  assert.equal(plan.travelers, 2);
  assert.equal(plan.budget_per_person_yuan, 500);
  assert.equal(plan.budget_source, "brief");
  await brief.execute({ ...request, budgetTotalYuan: 600, travelers: 3 });
  await save.execute({ title: request.title, days: [day()] }, { workspace: root, brief: { ...request, travelers: 2, mustVisit: [], avoid: [] } });
  plan = await readPlan(root, request.title);
  assert.equal(plan.budget_per_person_yuan, 200, "当前磁盘需求优先于旧会话快照");
  assert.equal(plan.travelers, 3);
  assert.equal(plan.room_count, undefined, "默认房间数随人数计算，不能固化为旧值");
  await save.execute({ title: request.title, budget_per_person_yuan: 123, days: [day()] });
  await brief.execute({ ...request, budgetTotalYuan: 2000 });
  await save.execute({ title: request.title, days: [day()] });
  plan = await readPlan(root, request.title);
  assert.equal(plan.budget_per_person_yuan, 123);
  assert.equal(plan.budget_source, "explicit");
});

test("移除需求中的预算会解除派生预算，历史显式预算仍保留", async (t) => {
  const root = await temp(t), title = "取消预算";
  const brief = createSaveTravelBriefTool(root), save = createSaveItineraryTool(root);
  await brief.execute({ title, destination: "北京", budgetTotalYuan: 100 });
  await save.execute({ title, days: [day()] });
  await brief.execute({ title, destination: "北京" });
  await save.execute({ title, days: [day()] });
  assert.equal((await readPlan(root, title)).budget_per_person_yuan, undefined);
});

test("GCJ02/WGS84 已知点、逆转换和境外点数值正确", () => {
  const wgs = { latitude: 39.9, longitude: 116.4, crs: "wgs84" as const };
  const gcj = convertPoint(wgs, "gcj02");
  assert.ok(Math.abs(gcj.latitude - 39.90140353) < 1e-7);
  assert.ok(Math.abs(gcj.longitude - 116.40624278) < 1e-7);
  const restored = convertPoint(gcj, "wgs84");
  assert.ok(Math.abs(restored.latitude - wgs.latitude) < 1e-9);
  assert.ok(Math.abs(restored.longitude - wgs.longitude) < 1e-9);
  assert.deepEqual(convertPoint({ latitude: 51.5, longitude: -0.1 }, "gcj02"), { latitude: 51.5, longitude: -0.1, crs: "gcj02" });
});

test("OSRM 请求转换高德坐标，高德请求转换 OSM 坐标", async () => {
  const wgs = { latitude: 39.9, longitude: 116.4, crs: "wgs84" as const }, gcj = convertPoint(wgs, "gcj02");
  let osrm = "";
  await fetchOsrmRoute(gcj, gcj, "driving", (async (url) => { osrm = String(url); return response({ code: "Ok", routes: [{ distance: 1000, duration: 60 }] }); }) as typeof fetch);
  const coordinates = osrm.split("/driving/")[1].split(";")[0].split(",").map(Number);
  assert.ok(Math.abs(coordinates[0] - wgs.longitude) < 1e-9);
  assert.ok(Math.abs(coordinates[1] - wgs.latitude) < 1e-9);
  let captured: URL | undefined;
  const client = new AmapClient({ apiKey: "mock", fetchFn: (async (url) => { captured = new URL(String(url)); return response({ pois: [] }); }) as typeof fetch });
  await client.poiSearch("公园", wgs, 1000);
  const actual = captured!.searchParams.get("location")!.split(",").map(Number);
  assert.ok(Math.abs(actual[0] - gcj.longitude) < 1e-6);
  assert.ok(Math.abs(actual[1] - gcj.latitude) < 1e-6);
});

test("已核实坐标不被后台校准替换，混合坐标系的同一地点不产生赶路缺口", async () => {
  const wgs = { latitude: 39.9, longitude: 116.4, crs: "wgs84" as const }, gcj = convertPoint(wgs, "gcj02");
  const plan = { days: [{ items: [{ name: "已核实", evidence_verified: true, location: { ...wgs, source: "osm" } }] }] };
  let calls = 0;
  const resolved = await resolvePlanCoordinates(plan, async () => { calls++; return gcj; }, { intervalMs: 0 });
  assert.equal(calls, 0);
  assert.equal(resolved.resolved, 0);
  assert.equal(unresolvedCoordinateCount(plan), 0);
  const itinerary = parseItinerary({ title: "同一点", days: [{ items: [
    { id: "a", name: "A", type: "visit", time: "10:00", end_time: "11:00", location: wgs },
    { id: "b", name: "B", type: "visit", time: "11:00", end_time: "12:00", location: gcj },
  ] }] });
  assert.ok(!validateItinerary(itinerary).issues.some((issue) => ["insufficient-transfer-time", "missing-transport"].includes(issue.code)));
});

test("闭馆否定、历史和冲突均不升级为证据，且撤销旧规则可跨重启", async (t) => {
  const root = await temp(t), store = new TravelEvidenceStore(root);
  const item: ItineraryItem = { id: "museum", name: "回归博物馆", type: "visit" };
  await store.observeClosure("北京", item.name, [{ title: item.name, snippet: `${item.name}每周一闭馆` }]);
  assert.deepEqual(store.bind(item, "北京").closed_on, ["Monday"]);
  for (const text of ["并非每周一闭馆", "此前每周一闭馆，现在开放", "全年无休，但每周一闭馆"]) {
    await store.observeClosure("北京", item.name, [{ title: item.name, snippet: `${item.name}${text}` }]);
    const restored = new TravelEvidenceStore(root);
    await restored.load();
    assert.equal(restored.bind(item, "北京").closure_verified, false, text);
    assert.equal(restored.bind(item, "北京").closed_on, undefined, text);
  }
});

test("分段营业时间下午可访问、午休和跨午休停留均拒绝核验", async () => {
  const store = new TravelEvidenceStore();
  await store.observePlaces("search_attractions", "北京", "高德数据\n1. 分段景点 | 坐标 39.9000,116.4000 | 开放时间 09:00-12:00;14:00-17:00");
  const item = store.bind({ id: "v", name: "分段景点", type: "visit" }, "北京");
  assert.equal(item.opening_hours?.intervals?.length, 2);
  const outside = (time: string, end_time: string) => validateItinerary(parseItinerary({ title: "营业时间", days: [{ items: [{ ...item, time, end_time }] }] })).issues.some((issue) => issue.code === "outside-opening-hours");
  assert.equal(outside("14:00", "16:00"), false);
  assert.equal(outside("12:30", "13:30"), true);
  assert.equal(outside("11:30", "14:30"), true);
  assert.equal(outside("16:00", "17:00"), false);
});

test("OSM 降级警告中出现高德不改变证据来源及坐标系", async () => {
  const store = new TravelEvidenceStore();
  await store.observePlaces("search_attractions", "北京", "景点列表\n1. 兜底公园 | 坐标 39.9000,116.4000\n⚠️ 高德数据源失败，以上为 OpenStreetMap 数据（无评分）");
  const item = store.bind({ id: "v", name: "兜底公园", type: "visit" }, "北京");
  assert.equal(item.source, "osm");
  assert.equal(item.location?.crs, "wgs84");
  assert.equal(item.rating, undefined);
});

test("真实 10003 错误保留代码并共享熔断，地理编码变体不重复消耗配额", async (t) => {
  let count = 0;
  setAmapKey("quota-review", (async () => { count++; return response({ status: "0", infocode: "10003", info: "DAILY_QUERY_OVER_LIMIT" }); }) as typeof fetch);
  t.after(() => setAmapKey(undefined));
  const fallback = (async () => response({ features: [] })) as typeof fetch;
  assert.equal(await geocodeInCity("配额回归（东门）", "北京", fallback), null);
  assert.equal(await geocodeInCity("另一个地点", "北京", fallback), null);
  assert.equal(count, 1);
  const client = new AmapClient({ apiKey: "mock", fetchFn: (async () => response({ status: "0", infocode: "10003" })) as typeof fetch });
  await assert.rejects(() => client.geocode("公园"), (error: unknown) => error instanceof AmapServiceError && error.code === "10003" && /日配额|今日/.test(error.message));
  await assert.rejects(() => client.withSignal(new AbortController().signal).geocode("另一个公园"), /10003/);
});

test("评价搜索取消终止在途请求，不启动其他搜索引擎", async () => {
  const controller = new AbortController();
  let count = 0;
  const tool = createReviewsTool((async (_input, init) => {
    count++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  }) as typeof fetch);
  await assert.rejects(() => tool.execute({ place: "回归公园", city: "北京" }, { workspace: ".", signal: controller.signal }), { name: "AbortError" });
  assert.equal(count, 1);
  await assert.rejects(() => tool.execute({ place: "回归公园" }, { workspace: ".", signal: controller.signal }), { name: "AbortError" });
  assert.equal(count, 1);
});

test("工具注册表缓存命中也响应取消", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root);
  let calls = 0;
  registry.register({ name: "search_attractions", description: "mock", parameters: {}, execute: async () => { calls++; return "高德数据\n1. 缓存公园 | 坐标 39.9000,116.4000"; } });
  const args = JSON.stringify({ location: "公园", city: "北京" });
  await registry.execute("search_attractions", args);
  const signal = AbortSignal.abort();
  await assert.rejects(() => registry.execute("search_attractions", args, { workspace: root, signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("查询缓存 30 分钟过期，但已核实事实和采集时间继续有效", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  const start = Date.now();
  t.mock.method(Date, "now", () => start);
  await evidence.observePlaces("search_stays", "北京", "高德数据\n1. 缓存酒店 | 评分 4.7 | 参考价 ¥400/房/晚起 | 坐标 39.9000,116.4000");
  evidence.cache("query", "cached");
  assert.equal(evidence.cached("query"), "cached");
  t.mock.method(Date, "now", () => start + 30 * 60_000);
  assert.equal(evidence.cached("query"), undefined);
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  const hotel = restored.bind({ id: "h", name: "缓存酒店", type: "accommodation" }, "北京");
  assert.equal(hotel.evidence_verified, true);
  assert.equal(hotel.evidence_observed_at, start);
  assert.equal(hotel.room_price_per_night, 400);
  assert.equal(hotel.cost_per_person, undefined);
  assert.match(renderMarkdown(parseItinerary({ title: "价格", days: [{ items: [hotel] }] })), /每房每晚 ¥400/);
});

test("重复保存沿用版本不构成实际进展，修改内容才改变指纹", async (t) => {
  const root = await temp(t), title = "进展回归", save = createSaveItineraryTool(root);
  const args = { title, days: [{ items: [{ id: "v", name: "缺时间", type: "visit" }] }] };
  await save.execute(args);
  const session = new Session();
  session.add("tool", `${join(root, `plans/${title}.json`)}（结构化数据）`, { toolName: "save_itinerary" });
  const options = { rootDir: root, session, initialLimit: 30, currentLimit: 30, ceiling: 150, extensionStep: 15 };
  const first = await assessToolBudget(options);
  await save.execute(args);
  const next = await assessToolBudget({ ...options, previousFingerprint: first.fingerprint });
  assert.equal(next.fingerprint, first.fingerprint);
  assert.equal(next.repair.canImprove, false);
  await save.execute({ ...args, days: [{ items: [{ id: "v", name: "改了名称", type: "visit" }] }] });
  assert.notEqual((await assessToolBudget(options)).fingerprint, first.fingerprint);
});

test("房价按房晚及人数折算，重复酒店锚点、末日、显式晚数和历史人均兼容", () => {
  const hotel = { type: "accommodation", name: "房晚酒店", room_price_per_night: 300 };
  const cost = (raw: object) => totalCostPerPerson(parseItinerary({ title: "费用", ...raw }));
  const days = [1, 2, 3].map((i) => ({ date: `2026-11-0${i}`, items: [{ ...hotel, id: `in-${i}` }, { ...hotel, id: `return-${i}` }] }));
  assert.equal(cost({ days }), 300, "两人一房、两晚合计 600 元，每人 300 元");
  assert.equal(cost({ travelers: 3, days }), 400, "三人默认两房、两晚 1200 元，每人 400 元");
  assert.equal(cost({ travelers: 4, room_count: 1, days }), 150);
  assert.equal(cost({ travelers: 2, days: [{ items: [{ ...hotel, stay_nights: 3, room_count: 2 }] }] }), 900);
  assert.equal(cost({ days: [{ items: [{ ...hotel, stay_nights: 0 }] }] }), 0);
  assert.equal(cost({ days: [{ date: "2026-11-01", items: [{ ...hotel, stay_nights: 3 }] }, { date: "2026-11-02", items: [{ ...hotel, stay_nights: 3 }] }] }), 600, "跨日重叠区间只收取四晚");
  assert.equal(cost({ days: [{ items: [{ ...hotel, stay_nights: 1_000_000 }] }] }), 150_000_000, "显式大晚数无需逐晚遍历");
  assert.equal(cost({ constraints: { end_date: "2026-11-03", expected_days: 3 }, days: [days[0]] }), 150, "分批保存首日不能误判为末日");
  assert.equal(cost({ days: [{ items: [{ name: "历史住宿", type: "accommodation", cost_per_person: 123 }] }] }), 123);
  assert.throws(() => parseItinerary({ title: "非法房数", room_count: 1.5, days }), /正整数/);
});

test("独立证据仓库并发写入不会覆盖其他会话的地点", async (t) => {
  const root = await temp(t), a = new TravelEvidenceStore(root), b = new TravelEvidenceStore(root);
  await Promise.all([a.load(), b.load()]);
  await Promise.all([
    a.observePlaces("search_attractions", "北京", "高德数据\n1. 地点甲 | 坐标 39.9000,116.4000"),
    b.observePlaces("search_attractions", "北京", "高德数据\n1. 地点乙 | 坐标 39.9100,116.4100"),
  ]);
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  assert.ok(restored.point("地点甲", "北京"));
  assert.ok(restored.point("地点乙", "北京"));
});

test("HTTP 编辑后相关会话状态、磁盘状态、地图坐标和行程版本同步", async (t) => {
  const root = await temp(t), title = "状态同步";
  let snapshot: ItinerarySnapshot | undefined;
  await createSaveItineraryTool(root).execute({ title, days: [day()] }, { workspace: root, onItinerary: (value) => { snapshot = value; } });
  const session = new Session();
  session.setTravelState(updateTravelStateFromSnapshot(undefined, snapshot!));
  const store = new JsonFileSessionStore(join(root, ".minicode/sessions"));
  await store.save(session);
  const running = await startWebServer({ rootDir: root, port: 0, auth: false, configOverrides: { provider: "mock" } });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  const result = await fetch(`${base}/api/plans/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, day: 1, item_id: "景点", op: "replace", replacement: { name: "状态新景点", latitude: 39.9, longitude: 116.4, crs: "wgs84" } }) });
  assert.equal(result.status, 200);
  assert.equal((await store.load(session.id))!.travelState!.itinerary!.revision, 2);
  const view = await (await fetch(`${base}/api/plans/${encodeURIComponent(title)}`)).json();
  assert.equal(view.revision, 2);
  assert.equal(view.days[0].items[0].location.crs, "wgs84");
  assert.equal(view.days[0].items[0].display_location.crs, "gcj02");
  assert.ok(Math.abs(view.days[0].items[0].display_location.longitude - 116.40624278) < 1e-7);
});

test("排队中的高德请求取消后立即退出，队首释放后也不会发送该请求", { timeout: 2000 }, async () => {
  let release!: (response: Response) => void, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const client = new AmapClient({ apiKey: "mock", fetchFn: (async () => {
    calls++;
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch });
  const first = client.geocode("队首");
  await ready;
  const controller = new AbortController();
  const second = client.withSignal(controller.signal).geocode("排队取消");
  controller.abort();
  try {
    await assert.rejects(() => second, { name: "AbortError" });
    assert.equal(calls, 1);
  } finally { release(response({ geocodes: [] })); }
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("Overpass 独立调用的取消信号传入网络，不继续下一个镜像", async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(() => overpassQuery("review-cancel-query", (async (_input, init) => {
    count++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  }) as typeof fetch, controller.signal), { name: "AbortError" });
  assert.equal(count, 1);
});

test("原生景点工具经注册表降级 OSM 后保持真实来源，查询中心也转换为 WGS84", async (t) => {
  const root = await temp(t);
  const wgs = { latitude: 39.9, longitude: 116.4, crs: "wgs84" as const }, gcj = convertPoint(wgs, "gcj02");
  setAmapKey("native-fallback", (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("place/text") && url.searchParams.get("keywords") === "原生降级中心") return response({ pois: [{ id: "center", name: "原生降级中心", location: `${gcj.longitude},${gcj.latitude}`, cityname: "北京市", pname: "北京市" }] });
    return response({ status: "0", infocode: "10003" });
  }) as typeof fetch);
  t.after(() => setAmapKey(undefined));
  let query = "";
  const fetchFn = (async (_input, init) => {
    query = String(init?.body);
    return response({ elements: [{ type: "node", lat: wgs.latitude, lon: wgs.longitude, tags: { name: "原生兜底公园", leisure: "park" } }] });
  }) as typeof fetch;
  const registry = new ToolRegistry(root).register(createAttractionsTool(fetchFn));
  const evidence = new TravelEvidenceStore(root);
  const output = await registry.execute("search_attractions", JSON.stringify({ location: "原生降级中心", city: "北京", radius_km: 2 }), { workspace: root, evidence });
  assert.match(output, /高德数据源失败/);
  const center = /around:[\d.]+,([\d.]+),([\d.]+)/.exec(query)!;
  assert.ok(Math.abs(Number(center[1]) - wgs.latitude) < 1e-8);
  assert.ok(Math.abs(Number(center[2]) - wgs.longitude) < 1e-8);
  const item = evidence.bind({ id: "v", name: "原生兜底公园", type: "visit" }, "北京");
  assert.equal(item.evidence_verified, true);
  assert.equal(item.source, "osm");
  assert.equal(item.location?.crs, "wgs84");
});

test("相同地点坐标的小数位格式改变不生成新证据或重复候选", async () => {
  const store = new TravelEvidenceStore();
  await store.observePlaces("search_restaurants", "北京", "高德数据\n1. 格式餐厅 | 评分 4.7 | 人均 ¥50 | 坐标 39.9000,116.4000");
  const first = store.bind({ id: "a", name: "格式餐厅", type: "meal", subtype: "lunch" }, "北京");
  await store.observePlaces("search_restaurants", "北京", "高德数据\n1. 格式餐厅 | 评分 4.8 | 人均 ¥60 | 坐标 39.900000,116.400000");
  const second = store.bind({ id: "b", name: "格式餐厅", type: "meal", subtype: "lunch" }, "北京");
  assert.equal(first.evidence_id, second.evidence_id);
  assert.equal(second.rating, 4.8);
  const plan = parseItinerary({ title: "格式", days: [{ items: [first, { ...second, evidence_id: "historical-format-id" }] }] });
  assert.equal(recommendationCoverage(plan).slots[0].count, 1);
});

test("地点新查询改变坐标后，旧路线不通过核验；更新历史地点也按最新采集时间选择", async (t) => {
  const root = await temp(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const store = new TravelEvidenceStore(root);
  await store.observePlaces("search_attractions", "北京", "高德数据\n1. 甲 | 坐标 39.9000,116.4000\n2. 乙 | 坐标 39.9100,116.4100");
  const [route] = await store.observeRoutes([{ city: "北京", from: "甲", to: "乙", from_point: store.point("甲", "北京"), to_point: store.point("乙", "北京"), mode: "walking", duration_min: 20, distance_km: 1, estimated: false }]);
  const item: ItineraryItem = { id: "r", name: "路线", type: "transport", from: "甲", to: "乙", transport_mode: "walking", route_evidence_id: route.id };
  assert.equal(store.bind(item, "北京").route_verified, true);
  t.mock.timers.tick(1000);
  await store.observePlaces("search_attractions", "北京", "高德数据\n1. 乙 | 坐标 39.9300,116.4300");
  assert.notEqual(store.bind(item, "北京").route_verified, true);
  t.mock.timers.tick(1000);
  await store.observePlaces("search_attractions", "北京", "高德数据\n1. 乙 | 坐标 39.9100,116.4100");
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  assert.equal(restored.point("乙", "北京")?.latitude, 39.91);
  assert.equal(restored.bind({ id: "v", name: "乙", type: "visit" }, "北京").location?.latitude, 39.91);
});

for (const days of [3, 5]) test(`${days} 日分批保存：工具房价保持每房每晚，预算按实际晚数折算`, async (t) => {
  const root = await temp(t), title = `房价${days}日游`;
  await createSaveTravelBriefTool(root).execute({ title, destination: "北京", startDate: "2026-11-01", endDate: `2026-11-0${days}`, travelers: 2, budgetTotalYuan: 3000 });
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_stays", "北京", "高德数据\n1. 连住酒店 | 评分 4.7 | 参考价 ¥400/房/晚起 | 坐标 39.9000,116.4000");
  for (let i = 1; i <= days; i++) {
    await createSaveItineraryTool(root).execute({ title, merge: true, days: [{ date: `2026-11-0${i}`, items: [{ id: `hotel-${i}`, name: "连住酒店", type: "accommodation" }] }] });
    const plan = await readPlan(root, title);
    assert.equal(totalCostPerPerson(plan), Math.min(i, days - 1) * 200);
    assert.equal(plan.budget_per_person_yuan, 1500);
    assert.equal(plan.days[i - 1].items[0].room_price_per_night, 400);
    assert.equal(plan.days[i - 1].items[0].cost_per_person, undefined);
  }
});
