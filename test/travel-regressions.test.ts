import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatAgent, type CumulativeToolBudget } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { renderTravelState, updateTravelStateFromBrief, updateTravelStateFromSnapshot, updateTravelStateFromQuality } from "../src/core/travel-state.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import { ToolRegistry, type ItinerarySnapshot } from "../src/tools/tool.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { createSaveItineraryTool, createLoadItineraryTool, createValidateItineraryTool, renderMarkdown } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { hasRecommendationEvidence } from "../src/tools/recommendation-policy.ts";
import { assessToolBudget } from "../src/runtime/tool-budget.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { geocodeInCity } from "../src/tools/geocoding.ts";
import { AmapClient } from "../src/tools/amap.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { isRemoteDayTravel } from "../src/tools/remote-day-policy.ts";

const temp = () => mkdtemp(join(tmpdir(), "minicode-travel-regression-"));
const visit = (name: string, time = "09:00", end_time = "10:00") => ({ name, time, end_time, type: "visit", source: "amap", confidence: "high", location: { latitude: 39.9, longitude: 116.4 }, opening_hours: { opens: "08:00", closes: "22:00" } });
const codes = (raw: unknown) => validateItinerary(parseItinerary(raw)).issues.map((issue) => issue.code);
const call = (name: string, args: Record<string, unknown>, id = name): LLMResult => ({ type: "tool_calls", toolCalls: [{ name, arguments: JSON.stringify(args), id }] });
class Script implements ChatProvider {
  readonly name = "regression-script";
  requests = 0;
  constructor(script: LLMResult[]) { this.script = script; }
  private readonly script: LLMResult[];
  async chat(): Promise<string> { throw new Error("Canonical delivery must not call an extra model"); }
  async chatWithTools(): Promise<LLMResult> { const result = this.script[this.requests++]; assert.ok(result); return result; }
}

test("增量补下午保留上午、其余天；快照来自完整落盘文件", async () => {
  const root = await temp();
  const save = createSaveItineraryTool(root);
  let snapshot: ItinerarySnapshot | undefined;
  const ctx = { workspace: root, onItinerary: (value: ItinerarySnapshot) => { snapshot = value; } };
  await save.execute({ title: "合并回归", days: [{ date: "2026-11-01", items: [visit("上午")] }, { date: "2026-11-02", items: [visit("次日")] }] }, ctx);
  await save.execute({ title: "合并回归", merge: true, days: [{ date: "2026-11-01", items: [visit("下午", "14:00", "15:00")] }] }, ctx);
  assert.deepEqual(snapshot!.itinerary.days[0].items.map((item) => item.name), ["上午", "下午"]);
  assert.equal(snapshot!.itinerary.days[1].items[0].name, "次日");
  assert.equal(snapshot!.itinerary.revision, 2);
  assert.deepEqual(snapshot!.itinerary, JSON.parse(await readFile(snapshot!.file, "utf8")));
  const state = updateTravelStateFromSnapshot(undefined, snapshot!);
  assert.equal(state.itinerary!.dayCount, 2);
  assert.equal(state.itinerary!.itemCount, 3);
  let loaded: ItinerarySnapshot | undefined;
  await createLoadItineraryTool(root).execute({ title: "合并回归", day: 2, summary: true }, { workspace: root, onItinerary: (value) => { loaded = value; } });
  assert.equal(loaded!.itinerary.days.length, 2, "单日/摘要读取也应报告完整快照");
  const output = await save.execute({ title: "合并回归", merge: true, merge_mode: "replace_day", days: [{ date: "2026-11-01", items: [visit("替换")] }] }, ctx);
  assert.match(output, /原条目 3，现条目 2/);
  assert.equal(snapshot!.itinerary.days[0].items.length, 1);
});

test("预算持久化且省略预算复验不能解除超支", async () => {
  const root = await temp();
  await createSaveItineraryTool(root).execute({ title: "预算回归", budget_per_person_yuan: 50, days: [{ items: [{ ...visit("收费景点"), cost_per_person: 100 }] }] });
  await assert.rejects(() => createValidateItineraryTool(root).execute({ title: "预算回归", strict: true }), /budget-exceeded/);
  await createSaveItineraryTool(root).execute({ title: "预算回归", merge: true, days: [{ date: "2026-11-02", items: [visit("新增日")] }] });
  const saved = JSON.parse(await readFile(join(root, "plans/预算回归.json"), "utf8"));
  assert.equal(saved.budget_per_person_yuan, 50);
});

test("损坏的已有行程不允许增量保存静默覆盖", async () => {
  const root = await temp();
  await mkdir(join(root, "plans"));
  const file = join(root, "plans/损坏.json");
  await writeFile(file, "broken-json");
  await assert.rejects(() => createSaveItineraryTool(root).execute({ title: "损坏", merge: true, days: [{ items: [visit("新景点")] }] }));
  assert.equal(await readFile(file, "utf8"), "broken-json");
});

test("工具城市从需求上下文贯通、查询按规范参数缓存且跨城市隔离", async () => {
  const registry = new ToolRegistry();
  const observed: Record<string, unknown>[] = [];
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async (args) => {
    observed.push(args);
    return "高德数据\n1. 景点甲 | 评分 4.8 | 坐标 39.1234,116.1234";
  } });
  const ctx = { workspace: await temp(), destination: "北京" };
  const first = await registry.execute("search_attractions", '{"location":"天坛公园","city":"广州"}', ctx);
  const second = await registry.execute("search_attractions", '{"city":"北京","location":"天坛公园"}', ctx);
  assert.equal(first, second);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].city, "北京");
  await registry.execute("search_attractions", '{"location":"天坛公园"}', { ...ctx, destination: "广州" });
  assert.equal(observed.length, 2);
  assert.match(first, /evidence_id/);
});

test("失败结果不进入成功缓存", async () => {
  const registry = new ToolRegistry();
  let count = 0;
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { count++; return "未找到地点"; } });
  await registry.execute("search_attractions", "{}");
  await registry.execute("search_attractions", "{}");
  assert.equal(count, 2);
});

test("地点坐标/评分/价格由可信工具回填，ID 不能绑定异地或别的名称", async () => {
  const root = await temp();
  const store = new TravelEvidenceStore(root);
  await store.observePlaces("search_restaurants", "北京", "高德数据\n1. 餐厅甲 综合 8.8 | 评分 4.8 | 人均 ¥68 | 坐标 39.1234,116.1234");
  const item: ItineraryItem = { id: "m", name: "餐厅甲", type: "meal", rating: 1, cost_per_person: 1, location: { latitude: 1, longitude: 1 } };
  const bound = store.bind(item, "北京");
  assert.equal(bound.rating, 4.8);
  assert.equal(bound.cost_per_person, 68);
  assert.deepEqual([bound.location!.latitude, bound.location!.longitude], [39.1234, 116.1234]);
  assert.ok(hasRecommendationEvidence(bound));
  assert.equal(store.bind({ ...item, evidence_id: bound.evidence_id }, "广州").evidence_verified, undefined);
  assert.equal(store.bind({ ...item, name: "别家店", evidence_id: bound.evidence_id }, "北京").evidence_verified, undefined);
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  assert.equal(restored.bind(item, "北京").evidence_id, bound.evidence_id);
  assert.match(restored.summary("北京"), /餐厅甲/);
});

test("OSM 无序号坐标也能形成来源证据，未知价格不能用模型数值冒充工具证据", async () => {
  const store = new TravelEvidenceStore();
  await store.observePlaces("search_attractions", "北京", "景点甲 | 公园 | 坐标 39.1234,116.1234");
  const bound = store.bind({ id: "m", name: "景点甲", type: "meal", rating: 4.9, cost_per_person: 99 }, "北京");
  assert.equal(bound.source, "osm");
  assert.equal(bound.rating, undefined);
  assert.equal(hasRecommendationEvidence(bound), false);
  await store.observePlaces("search_restaurants", "北京", "高德数据\n1. 有评分无价格餐厅 | 评分 4.9 | 坐标 39.1234,116.1234");
  const noPrice = store.bind({ id: "fake-price", name: "有评分无价格餐厅", type: "meal", cost_per_person: 99 }, "北京");
  assert.equal(noPrice.rating, 4.9);
  assert.equal(noPrice.cost_per_person, undefined);
  assert.equal(hasRecommendationEvidence(noPrice), false);
});

test("MCP 无 Agent 上下文保存，也继承同标题需求的日期、预算和交付约束", async () => {
  const root = await temp();
  await createSaveTravelBriefTool(root).execute({ title: "MCP三日游", destination: "北京", startDate: "2026-11-01", endDate: "2026-11-03", budgetTotalYuan: 6000, travelers: 2 });
  await createSaveItineraryTool(root).execute({ title: "MCP三日游", days: [{ date: "2026-11-01", items: [visit("下午", "14:00", "15:00")] }] });
  const itinerary = parseItinerary(JSON.parse(await readFile(join(root, "plans/MCP三日游.json"), "utf8")));
  assert.equal(itinerary.budget_per_person_yuan, 3000);
  assert.equal(itinerary.constraints!.expected_days, 3);
  assert.equal(itinerary.constraints!.require_routes, true);
  assert.deepEqual(computeItineraryMetrics(itinerary, { expectedDays: 3 }).issueCounts, validateItinerary(itinerary).issue_count);
  await assert.rejects(() => createValidateItineraryTool(root).execute({ title: itinerary.title, strict: true }), /missing-requested-date/);
});

test("城市核验不接受行政区缺失；搜索强制城市并实际过滤越界半径和异地候选", async () => {
  await assert.rejects(() => createAttractionsTool().execute({ location: "天坛公园" }), /必须提供目标 city/);
  const response = (body: unknown) => new Response(JSON.stringify({ infocode: "10000", ...(body as object) }));
  const fallback = (async () => response({ features: [] })) as typeof fetch;
  setAmapKey("test-key", (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("geocode")) return response({ status: "1", geocodes: [] });
    if (url.pathname.includes("place/text")) return response({ status: "1", pois: [{ id: "unknown", name: "城市字段缺失的同名公园", location: "113.2,23.4" }] });
    return response({ status: "1", pois: [] });
  }) as typeof fetch);
  try {
    assert.equal(await geocodeInCity("城市字段缺失的同名公园", "北京", fallback), null);
    setAmapKey("test-key", (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("geocode")) return response({ status: "1", geocodes: [{ formatted_address: "北京市西城区", province: "北京市", city: "北京市", location: "116.4,39.9" }] });
      return response({ status: "1", pois: [
        { id: "near", name: "市内近处公园", cityname: "北京市", location: "116.41,39.91" },
        { id: "far", name: "超半径公园", cityname: "北京市", location: "116.8,40.1" },
        { id: "other", name: "异地同名公园", cityname: "广州市", location: "116.42,39.92" },
      ] });
    }) as typeof fetch);
    const output = await createAttractionsTool(fallback).execute({ location: "北京市西城区", city: "北京", radius_km: 10 });
    assert.match(output, /市内近处公园/);
    assert.doesNotMatch(output, /超半径公园|异地同名公园/);
  } finally { setAmapKey(undefined); }
});

test("步行路线复用已核验坐标，返回真实 walking 证据；失败估算不冒充核验", async () => {
  const evidence = new TravelEvidenceStore();
  await evidence.observePlaces("search_attractions", "北京", "高德数据\n1. 步行起点 | 坐标 39.9000,116.4000\n2. 步行终点 | 坐标 39.9100,116.4100");
  const requests: string[] = [];
  setAmapKey("test-key", (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "1800", duration: "1800", steps: [{ polyline: "116.4,39.9;116.41,39.91" }] }] } }));
  }) as typeof fetch);
  const unavailable = (async () => { throw new Error("offline"); }) as typeof fetch;
  const ctx = { workspace: await temp(), evidence };
  try {
    const output = await createPlanRoutesTool(unavailable).execute({ city: "北京", mode: "walking", stops: ["步行起点", "步行终点"] }, ctx);
    assert.match(output, /步行约 30 分钟/);
    assert.ok(requests.every((url) => url.includes("direction/walking")));
    assert.equal(evidence.bind({ id: "r", type: "transport", name: "步行", from: "步行起点", to: "步行终点", transport_mode: "walking" }, "北京").route_verified, true);
    setAmapKey(undefined);
    const estimated = await createPlanRoutesTool(unavailable).execute({ city: "北京", mode: "walking", stops: ["步行终点", "步行起点"] }, ctx);
    assert.match(estimated, /估算/);
    assert.equal(evidence.bind({ id: "r2", type: "transport", name: "步行", from: "步行终点", to: "步行起点", transport_mode: "walking" }, "北京").route_verified, false);
  } finally { setAmapKey(undefined); }
});

test("已知短距离的市内慢速通勤不误判远郊；未知距离保留时长兜底", () => {
  assert.equal(isRemoteDayTravel([{ distance_km: 4, planned_duration_min: 95 }, { distance_km: 5, planned_duration_min: 65 }]), false);
  assert.equal(isRemoteDayTravel([{ planned_duration_min: 95 }]), true);
  assert.equal(isRemoteDayTravel([{ distance_km: 45, planned_duration_min: 60 }]), true);
});

test("路线耗时/方式/端点绑定；41 分钟不能排成 30 分钟", async () => {
  const store = new TravelEvidenceStore();
  const [route] = await store.observeRoutes([{ city: "北京", from: "天坛", to: "前门", mode: "transit", duration_min: 41, distance_km: 3, estimated: false }]);
  const item: ItineraryItem = { id: "r", name: "天坛到前门", type: "transport", from: "天坛", to: "前门", transport_mode: "transit", time: "12:00", end_time: "12:30" };
  const bound = store.bind(item, "北京");
  assert.equal(bound.route_duration_min, 41);
  assert.equal(bound.route_verified, true);
  const itinerary = parseItinerary({ title: "路线回归", constraints: { require_routes: true }, days: [{ items: [bound] }] });
  assert.ok(validateItinerary(itinerary).issues.some((issue) => issue.code === "route-duration-too-short"));
  assert.equal(store.bind({ ...item, to: "别处", route_evidence_id: route.id }, "北京").route_verified, false);
  assert.equal(store.bind({ ...item, transport_mode: "walking" }, "北京").route_verified, false);
  await store.observeRoutes([{ city: "北京", from: "天坛", to: "前门", mode: "walking", duration_min: 45, distance_km: 3, estimated: true }]);
  assert.equal(store.bind({ ...item, transport_mode: "walking" }, "北京").route_verified, false);
});

for (const [label, time, duration, hours, expected] of [
  ["跨闭馆", "15:00", 240, { opens: "09:00", closes: "17:00" }, true],
  ["恰好闭馆离开", "15:00", 120, { opens: "09:00", closes: "17:00" }, false],
  ["闭馆后开始", "17:00", 30, { opens: "09:00", closes: "17:00" }, true],
  ["跨午夜合法", "23:00", 120, { opens: "20:00", closes: "02:00" }, false],
  ["跨午夜超时", "23:00", 240, { opens: "20:00", closes: "02:00" }, true],
  ["最后入场", "16:30", 20, { opens: "09:00", closes: "17:00", last_admission: "16:00" }, true],
] as const) test(`开放时间覆盖完整停留：${label}`, () => {
  const issues = codes({ title: "开放回归", days: [{ items: [{ name: "景点", type: "visit", time, planned_duration_min: duration, opening_hours: hours }] }] });
  assert.equal(issues.includes("outside-opening-hours"), expected);
});

test("周一博物馆省略闭馆元数据必须标未核实，已知闭馆仍拒绝", () => {
  const raw = { title: "闭馆回归", constraints: { require_place_evidence: true }, days: [{ date: "2026-11-02", items: [visit("市博物馆")] }] };
  assert.ok(codes(raw).includes("unverified-closure"));
  assert.ok(codes({ ...raw, days: [{ ...raw.days[0], items: [{ ...raw.days[0].items[0], closed_on: ["Monday"] }] }] }).includes("closed-on-date"));
});

test("手填全年开放不能代替工具闭馆证据，只有明确提及本馆的规则才回填", async () => {
  const root = await temp();
  const registry = new ToolRegistry(root).register(createSaveItineraryTool(root));
  await registry.evidence.observePlaces("search_attractions", "北京", "高德数据\n1. 回归博物馆 | 坐标 39.9000,116.4000");
  const raw = { title: "闭馆证据回归", constraints: { destination: "北京", require_place_evidence: true }, days: [{ date: "2026-11-03", items: [{ ...visit("回归博物馆"), closed_on: [], closure_verified: true }] }] };
  await registry.execute("save_itinerary", JSON.stringify(raw));
  const read = async () => parseItinerary(JSON.parse(await readFile(join(root, "plans/闭馆证据回归.json"), "utf8")));
  assert.ok(validateItinerary(await read()).issues.some((issue) => issue.code === "unverified-closure"));
  await registry.evidence.observeClosure("北京", "回归博物馆", [{ title: "其他博物馆", snippet: "其他博物馆每周一闭馆" }]);
  assert.equal(registry.evidence.bind({ id: "p", name: "回归博物馆", type: "visit" }, "北京").closure_verified, false);
  await registry.evidence.observeClosure("北京", "回归博物馆", [{ title: "回归博物馆", snippet: "回归博物馆每周一闭馆，出行前请复核官方公告" }]);
  await registry.execute("save_itinerary", JSON.stringify(raw));
  assert.deepEqual((await read()).days[0].items[0].closed_on, ["Monday"]);
  assert.equal(validateItinerary(await read()).issues.some((issue) => issue.code === "unverified-closure"), false);
});

test("先查闭馆规则再查地点，闭馆依据仍能跨重启及重复搜索复用", async () => {
  const root = await temp();
  const store = new TravelEvidenceStore(root);
  await store.observeClosure("北京", "先查规则博物馆", [{ title: "先查规则博物馆", snippet: "先查规则博物馆每周天闭馆" }]);
  const restored = new TravelEvidenceStore(root);
  await restored.load();
  await restored.observePlaces("search_attractions", "北京", "高德数据\n1. 先查规则博物馆 | 坐标 39.9000,116.4000");
  const bound = restored.bind({ id: "p", name: "先查规则博物馆", type: "visit", closed_on: [] }, "北京");
  assert.deepEqual(bound.closed_on, ["Sunday"]);
  assert.equal(bound.closure_verified, true);
});

test("超过缓存时限的地点和路线证据仍可使用并保留采集时间", async () => {
  const root = await temp();
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_restaurants", "北京", "高德数据\n1. 过期餐厅 | 评分 4.8 | 人均 ¥60 | 坐标 39.9000,116.4000");
  await evidence.observeRoutes([{ city: "北京", from: "甲", to: "乙", mode: "walking", duration_min: 20, distance_km: 1, estimated: false }]);
  const file = join(root, ".minicode/travel-evidence.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  for (const fact of [...saved.places, ...saved.routes]) fact.observed_at = Date.now() - 31 * 60_000;
  await writeFile(file, JSON.stringify(saved));
  const restored = new TravelEvidenceStore(root);
  await Promise.all([restored.load(), restored.load()]);
  assert.equal(restored.bind({ id: "m", name: "过期餐厅", type: "meal" }, "北京").evidence_verified, true);
  assert.equal(restored.bind({ id: "r", name: "路段", type: "transport", from: "甲", to: "乙" }, "北京").route_verified, true);
  assert.match(restored.summary("北京"), /过期餐厅/);
  assert.equal(restored.bind({ id: "m", name: "过期餐厅", type: "meal" }, "北京").evidence_observed_at, saved.places[0].observed_at);
});

test("路线证据必须排在对应停留之间，且每天均需住宿锚点", () => {
  const itinerary = parseItinerary({ title: "路线时序", constraints: { require_routes: true, require_accommodation: true }, days: [
    { items: [visit("甲", "09:00", "10:00"), { ...visit("乙", "12:00", "13:00"), location: { latitude: 39.93, longitude: 116.4 } }, { id: "r", type: "transport", name: "错位路段", from: "甲", to: "乙", route_verified: true, route_duration_min: 30, time: "07:00", end_time: "07:30" }, { type: "accommodation", name: "酒店" }] },
    { items: [visit("次日")] },
  ] });
  const report = validateItinerary(itinerary);
  assert.ok(report.issues.some((issue) => issue.code === "missing-route-leg" && issue.day === 1));
  assert.ok(report.issues.some((issue) => issue.code === "missing-accommodation" && issue.day === 2));
});

test("半日或无住宿仍阻断完整交付；无餐厅仅作建议", () => {
  const raw = { title: "完整度回归", constraints: { day_start: "10:00", day_end: "18:00", require_accommodation: true, recommendations: true }, days: [{ items: [visit("下午景点", "15:00", "16:00")] }] };
  const issues = codes(raw);
  for (const code of ["incomplete-day-start", "incomplete-day-end", "missing-accommodation"]) assert.ok(issues.includes(code), code);
  assert.equal(hasRecommendationEvidence({ id: "fake", type: "meal", name: "未知餐厅", note: "评分待核实；人均未知" }), false);
});

test("独立需求天数/日期约束阻止改短标题，strict 与评测共用分数与餐饮闸门", () => {
  const itinerary = parseItinerary({ title: "首日计划", constraints: { expected_days: 5, start_date: "2026-11-01", end_date: "2026-11-05", recommendations: true }, days: [{ date: "2026-11-01", items: [visit("景点")] }] });
  const report = validateItinerary(itinerary);
  const metrics = computeItineraryMetrics(itinerary, { expectedDays: 5 });
  assert.ok(report.score <= 20);
  assert.equal(metrics.score, report.score);
  assert.deepEqual(metrics.issueCounts, report.issue_count);
  assert.equal(report.issues.filter((issue) => issue.code === "missing-requested-date").length, 4);
  assert.ok(report.issues.some((issue) => issue.code === "title-day-mismatch"));
});

test("状态卡恢复真实需求标题，餐饮参考不是行程 P1", () => {
  let state = updateTravelStateFromBrief(undefined, { title: "北京五日游", destination: "北京" });
  const itinerary = parseItinerary({ title: "北京五日游", days: [{ items: [visit("景点")] }] });
  state = updateTravelStateFromSnapshot(state, { itinerary, file: "/tmp/plan.json", report: validateItinerary(itinerary) });
  state = updateTravelStateFromQuality(state, "## P1\n- 正式问题（real）\n## 餐饮参考（不参与评分）\n- 只是餐饮建议（meal）");
  assert.equal(state.itinerary!.issues.length, 1);
  assert.match(renderTravelState(state)!, /需求单「北京五日游」/);
});

for (const days of [3, 5]) test(`${days} 日增量流水线：最终回复、流式输出、状态、JSON/Markdown 保持同一版本`, async () => {
  const root = await temp();
  const registry = new ToolRegistry(root).register(createSaveItineraryTool(root)).register(createLoadItineraryTool(root));
  const script: LLMResult[] = Array.from({ length: days }, (_, index) => call("save_itinerary", { title: `合成${days}日游`, constraints: { recommendations: true, day_start: "09:00", day_end: "18:00" }, merge: true, days: [{ date: `2026-11-0${index + 1}`, items: [visit(`第${index + 1}天`)] }] }, `save-${index}`));
  script.push(call("load_itinerary", { title: `合成${days}日游`, day: 1, summary: true }));
  script.push({ type: "text", content: "虚构的模型总结：只有首日上午，已完美通过" });
  const provider = new Script(script);
  const session = new Session();
  const agent = new ChatAgent(session, provider, registry, root);
  let deltas = "";
  const reply = await agent.run("生成行程", { maxToolRounds: 10, onTextDelta: (value) => { deltas += value; } });
  const saved = parseItinerary(JSON.parse(await readFile(join(root, `plans/合成${days}日游.json`), "utf8")));
  assert.equal(saved.days.length, days);
  assert.equal(saved.revision, days);
  assert.equal(session.travelState!.itinerary!.dayCount, days);
  assert.equal(session.travelState!.itinerary!.itemCount, days);
  assert.equal(session.travelState!.itinerary!.revision, days);
  assert.ok(reply.includes(renderMarkdown(saved)));
  assert.doesNotMatch(reply, /虚构的模型总结/);
  assert.match(reply, /strict 未通过/);
  assert.equal(deltas, reply);
  assert.equal(await readFile(join(root, `plans/合成${days}日游.md`), "utf8"), renderMarkdown(saved));
});

test("累计调用上限在批次中生效，自动续跑不重置预算或追加收尾模型请求", async () => {
  const root = await temp();
  const registry = new ToolRegistry(root);
  let calls = 0;
  registry.register({ name: "echo", description: "test", parameters: {}, execute: async () => { calls++; return "ok"; } });
  const provider = new Script([{ type: "tool_calls", toolCalls: [1, 2, 3].map((i) => ({ id: `${i}`, name: "echo", arguments: "{}" })) }]);
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxRounds: 150, maxCalls: 2 };
  const agent = new ChatAgent(new Session(), provider, registry, root);
  await agent.run("开始", { maxToolRounds: 150, cumulativeBudget: budget });
  await agent.run("自动续跑", { maxToolRounds: 150, cumulativeBudget: budget });
  assert.equal(calls, 2);
  assert.equal(budget.calls, 2);
  assert.equal(provider.requests, 1);
  assert.equal(agent.history.filter((message) => message.role === "tool").length, 3, "未执行工具也须回填协议结果");
});

test("无进展检索会恢复提示并停止；成功空结果不能重置无进展计数", async () => {
  const root = await temp();
  const registry = new ToolRegistry(root);
  registry.register({ name: "save_travel_brief", description: "test", parameters: {}, execute: async () => "已保存" });
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => "未找到地点" });
  const provider = new Script([call("save_travel_brief", { title: "北京三日游", destination: "北京" }), ...Array.from({ length: 20 }, (_, i) => call("search_attractions", { location: `变化查询${i}` }, `q${i}`))]);
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxRounds: 100, maxCalls: 300 };
  const agent = new ChatAgent(new Session(), provider, registry, root);
  // Stop without another LLM call: model cannot manufacture a saved version.
  const reply = await agent.run("规划", { maxToolRounds: 100, cumulativeBudget: budget });
  assert.ok(provider.requests <= 14);
  assert.equal(budget.stagnantRounds, 12);
  assert.match(reply, /无实际进展|累计预算/);
  const requests = provider.requests;
  await agent.run("自动恢复", { maxToolRounds: 100, cumulativeBudget: budget });
  assert.equal(provider.requests, requests);
});

test("已保存内容未变化时，理论可修复不构成再次自动续期理由", async () => {
  const root = await temp();
  const file = join(root, "plans/未完成.json");
  await createSaveItineraryTool(root).execute({ title: "未完成", days: [{ items: [{ name: "无时间景点", type: "visit" }] }] });
  const session = new Session();
  session.add("tool", `${file}（结构化数据）`, { toolName: "save_itinerary" });
  const options = { rootDir: root, session, initialLimit: 30, currentLimit: 30, ceiling: 150, extensionStep: 15 };
  const first = await assessToolBudget(options);
  assert.equal(first.repair.canImprove, true);
  const next = await assessToolBudget({ ...options, currentLimit: 45, previousFingerprint: first.fingerprint });
  assert.equal(next.repair.canImprove, false);
  assert.match(next.repair.summary, /没有变化/);
});

test("地图日配额耗尽时直接停止重复请求，并如实交付未完成状态", async () => {
  const root = await temp();
  const registry = new ToolRegistry(root);
  registry.register({ name: "save_travel_brief", description: "test", parameters: {}, execute: async () => "已保存" });
  let apiCalls = 0;
  const client = new AmapClient({ apiKey: "mock", fetchFn: (async () => {
    apiCalls++;
    return new Response(JSON.stringify({ status: "0", infocode: "10003", info: "DAILY_QUERY_OVER_LIMIT" }));
  }) as typeof fetch });
  registry.register({ name: "search_attractions", description: "test", parameters: {}, execute: async () => { await client.geocode("北京"); return "unused"; } });
  const provider = new Script([call("save_travel_brief", { title: "北京三日游", destination: "北京" }), call("search_attractions", { location: "北京", city: "北京" })]);
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxRounds: 100, maxCalls: 300 };
  const agent = new ChatAgent(new Session(), provider, registry, root);
  const reply = await agent.run("规划三日游", { maxToolRounds: 100, cumulativeBudget: budget });
  assert.equal(provider.requests, 2);
  assert.equal(apiCalls, 1);
  assert.match(reply, /日配额或密钥/);
  assert.match(reply, /未完成/);
  await agent.run("自动恢复", { maxToolRounds: 100, cumulativeBudget: budget });
  assert.equal(provider.requests, 2);
});
