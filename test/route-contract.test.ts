import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { parseItinerary, type Itinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { alignRouteContext } from "../src/tools/itinerary-route-context.ts";
import { queryKeyArgs } from "../src/tools/travel-query.ts";
import { routeModes } from "../src/tools/route-request.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { structuredToolPreview } from "../src/agent/tool-preview.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "route-contract-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const visit = (id: string, name: string, time: string, end_time: string): ItineraryItem => ({ id, name, type: "visit", time, end_time });
async function facts(root?: string) {
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", "北京", "1. 甲 | 坐标 39.9000,116.4000\n2. 乙 | 坐标 39.9100,116.4100\n3. 丙 | 坐标 39.9200,116.4200", "amap");
  const route = async (from: string, to: string, mode = "walking", estimated = false) => (await evidence.observeRoutes([{ city: "北京", from, to, mode, duration_min: 20, distance_km: 1.5, estimated,
    from_point: evidence.point(from, "北京")!, to_point: evidence.point(to, "北京")! }]))[0]!;
  return { evidence, route };
}

test("引用ID回填事实和基础耗时，不重复抄写；显式时间安排与缓冲保留", async () => {
  const { evidence, route } = await facts(); const r = await route("甲", "乙");
  const base: ItineraryItem = { id: "r", type: "transport", name: "交通", time: "11:00", route_evidence_id: r.id };
  const item = evidence.bind(base, "北京");
  assert.equal(item.from, "甲"); assert.equal(item.to, "乙"); assert.equal(item.transport_mode, "walking");
  assert.equal(item.planned_duration_min, 20); assert.equal(item.route_duration_min, 20); assert.equal(item.route_verified, true);
  assert.equal(item.distance_km, 1.5); assert.equal(base.from, undefined);
  const buffer = evidence.bind({ ...base, planned_duration_min: 30, end_time: "11:30", distance_km: 999 }, "北京");
  assert.equal(buffer.planned_duration_min, 30); assert.equal(buffer.end_time, "11:30"); assert.equal(buffer.route_duration_min, 20); assert.equal(buffer.distance_km, 1.5);
});

test("步行意图与驾车证据冲突时不覆盖，明确列差异及walking重查参数", async () => {
  const { evidence, route } = await facts(); const r = await route("甲", "乙", "driving");
  const item = evidence.bind({ id: "r", type: "transport", name: "交通", route_evidence_id: r.id, transport_mode: "walking" }, "北京");
  assert.equal(item.transport_mode, "walking"); assert.equal(item.route_verified, false);
  assert.match(item.route_binding_error!, /walking.*driving/); assert.match(item.route_binding_error!, /"mode":"walking"/);
  const named = evidence.bind({ id: "r", type: "transport", name: "步行返回", route_evidence_id: r.id }, "北京");
  assert.equal(named.route_verified, false);
  const wrong = evidence.bind({ id: "r", type: "transport", name: "交通", route_evidence_id: r.id, from: "丙", to: "乙" }, "北京");
  assert.match(wrong.route_binding_error!, /起点填写「丙」，证据为「甲」/);
  assert.equal(evidence.bind({ id: "r", type: "transport", name: "交通", route_evidence_id: r.id }, "杭州").route_verified, false);
});

test("坐标变化及估算ID不抬高为已核验；无效标记每次重新绑定", async () => {
  const { evidence, route } = await facts(); const r = await route("甲", "乙");
  await evidence.observePlaces("search_attractions", "北京", "1. 乙 | 坐标 39.9300,116.4300", "amap");
  assert.match(evidence.bind({ id: "r", name: "交通", type: "transport", route_evidence_id: r.id }, "北京").route_binding_error!, /坐标已变化/);
  const estimated = await route("甲", "乙", "walking", true);
  assert.equal(evidence.bind({ id: "r", name: "交通", type: "transport", route_evidence_id: estimated.id }, "北京").route_verified, false);
  const valid = await route("甲", "乙");
  assert.equal(evidence.bind({ id: "r", name: "交通", type: "transport", route_evidence_id: valid.id, route_binding_error: "过时错误" }, "北京").route_binding_error, undefined);
});

test("同端点只有其他方式证据时，反馈列出现有方式而不是笼统缺证据", async () => {
  const { evidence, route } = await facts(); await route("甲", "乙", "transit");
  const item = evidence.bind({ id: "r", name: "步行", type: "transport", from: "甲", to: "乙", transport_mode: "walking" }, "北京");
  const p: Itinerary = { title: "反馈", constraints: { require_routes: true, destination: "北京" }, days: [{ items: [item] }] };
  const report = validateItinerary(p), issue = report.issues.find((i) => i.code === "unverified-route")!;
  assert.match(issue.message, /walking.*transit/); assert.match(issue.message, /"stops":\["甲","乙"\],"mode":"walking"/);
});

test("混合路线逐段查正确方式，等价模式复用缓存，改变真实方式才重查", async (t) => {
  const root = await temp(t), { evidence } = await facts(root); const requests: string[] = [];
  setAmapKey("test-key", (async (input) => {
    const url = String(input); requests.push(url);
    if (url.includes("transit")) return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ duration: "1200", walking_distance: "0", segments: [] }] } }));
    assert.match(url, /direction\/walking/);
    const parsed = new URL(url);
    return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "1500", duration: "1200", steps: [{ polyline: `${parsed.searchParams.get("origin")};${parsed.searchParams.get("destination")}` }] }] } }));
  }) as typeof fetch); t.after(() => setAmapKey(undefined));
  const tool = createPlanRoutesTool(), ctx = { workspace: root, evidence };
  const args = { city: "北京", stops: ["甲", "乙", "丙"], mode: "transit", leg_modes: ["transit", "walking"] };
  const output = await tool.execute(args, ctx);
  assert.equal(requests.length, 2); assert.match(output, /甲 → 乙: 公交/); assert.match(output, /乙 → 丙: 步行/);
  assert.equal(evidence.bind({ id: "r", name: "交通", type: "transport", from: "乙", to: "丙", transport_mode: "walking" }, "北京").route_verified, true);
  await tool.execute(args, ctx); assert.equal(requests.length, 2);
  await tool.execute({ ...args, leg_modes: ["walking", "walking"] }, ctx); assert.equal(requests.length, 3);
  assert.deepEqual(queryKeyArgs("plan_day_routes", { ...args, mode: "auto", leg_modes: undefined }), queryKeyArgs("plan_day_routes", { ...args, leg_modes: ["transit", "transit"] }));
  assert.notDeepEqual(queryKeyArgs("plan_day_routes", args), queryKeyArgs("plan_day_routes", { ...args, leg_modes: ["walking", "transit"] }));
  for (const leg_modes of [["walking"], ["walking", "flying"], "walking"]) assert.throws(() => routeModes({ mode: "transit", leg_modes }, 2), /leg_modes/);
  assert.ok((tool.parameters.required as string[]).includes("mode"));
});

test("驾车降级明示替代候选，短摘要保留警告，引用时仍尊重原公交意图", async (t) => {
  const root = await temp(t), { evidence } = await facts(root);
  setAmapKey("test-key", (async () => new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [] } }))) as typeof fetch); t.after(() => setAmapKey(undefined));
  const request = (async () => new Response(JSON.stringify({ code: "Ok", routes: [{ duration: 300, distance: 1000, geometry: { type: "LineString", coordinates: [[116.4, 39.9], [116.41, 39.91]] } }] }))) as typeof fetch;
  const tool = createPlanRoutesTool(request), output = await tool.execute({ city: "北京", stops: ["甲", "乙"], mode: "transit" }, { workspace: root, evidence });
  assert.match(output, /驾车替代候选/);
  const r = evidence.bind({ id: "r", name: "交通", type: "transport", from: "甲", to: "乙", transport_mode: "driving" }, "北京");
  assert.equal(r.route_verified, true);
  const rejected = evidence.bind({ ...r, transport_mode: "transit" }, "北京"); assert.equal(rejected.route_verified, false);
  assert.match(rejected.route_binding_error!, /transit.*driving/);
  const preview = structuredToolPreview("route", output, 3000);
  assert.match(preview!, /驾车替代候选/);
});

test("新增中间景点只失效受影响路段，指出旧端点和应查的新端点", () => {
  const route: ItineraryItem = { id: "r", name: "交通", type: "transport", from: "甲", to: "丙", transport_mode: "walking", route_verified: true, time: "12:00", end_time: "12:20" };
  const untouched: ItineraryItem = { ...route, id: "r0", from: "起点", to: "甲", time: "08:00", end_time: "08:20" };
  const day = { items: [visit("s", "起点", "07:30", "08:00"), untouched, visit("a", "甲", "09:00", "10:00"), visit("b", "乙", "11:00", "12:00"), route, visit("c", "丙", "12:30", "14:00")] };
  const aligned = alignRouteContext(day, "北京");
  assert.equal(aligned.items[1].route_verified, true); assert.equal(aligned.items[4].route_verified, false);
  assert.match(aligned.items[4].route_binding_error!, /仍为「甲 → 丙」.*应为「乙 → 丙」/);
  assert.match(aligned.items[4].route_binding_error!, /"stops":\["乙","丙"\],"mode":"walking"/);
  assert.equal(route.route_verified, true);
  const report = validateItinerary({ title: "衔接", constraints: { destination: "北京", require_routes: true }, days: [day] });
  assert.ok(report.issues.some((i) => (i.code === "unverified-route" || i.related_codes?.includes("unverified-route")) && i.message.includes("乙 → 丙")));
  assert.ok(report.issues.some((i) => i.message.includes('"stops":["甲","乙"]')));
});

test("真实保存支持仅ID，增量换ID不会悄悄换方式，修订后错误清除且其余日期保持", async (t) => {
  const root = await temp(t), { evidence, route } = await facts(root);
  const walk = await route("甲", "乙"), drive = await route("甲", "乙", "driving"), save = createSaveItineraryTool(root), ctx = { workspace: root, evidence };
  const days = [{ date: "2026-11-10", items: [visit("a", "甲", "10:00", "11:00"), { id: "r", name: "交通", type: "transport", time: "11:00", route_evidence_id: walk.id }, visit("b", "乙", "11:30", "13:00")] }, { date: "2026-11-11", items: [visit("c", "丙", "10:00", "12:00")] }];
  await save.execute({ title: "ID保存", constraints: { require_routes: true, destination: "北京" }, days }, ctx);
  const file = join(root, "plans/ID保存.json"), load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const before = await load(); assert.equal(before.days[0].items[1].transport_mode, "walking");
  await save.execute({ title: "ID保存", merge: true, days: [{ date: "2026-11-10", items: [{ id: "r", route_evidence_id: drive.id }] }] }, ctx);
  const conflict = await load(); assert.equal(conflict.days[0].items[1].transport_mode, "walking"); assert.equal(conflict.days[0].items[1].route_verified, false);
  await save.execute({ title: "ID保存", merge: true, days: [{ date: "2026-11-10", items: [{ id: "r", route_evidence_id: drive.id, transport_mode: "driving" }] }] }, ctx);
  const fixed = await load(); assert.equal(fixed.days[0].items[1].route_verified, true); assert.equal(fixed.days[0].items[1].route_binding_error, undefined);
  assert.deepEqual(fixed.days[1], before.days[1]);
});

test("路线独立核验的端点进入共享坐标证据，重载后仍能绑定，真实坐标变化仍使旧路线失效", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  const [route] = await evidence.observeRoutes([{
    city: "西安", from: "大雁塔", to: "酒店", mode: "transit", duration_min: 66, distance_km: 18.1, estimated: false,
    from_point: { latitude: 34.218229, longitude: 108.964176, crs: "gcj02" },
    to_point: { latitude: 34.3439, longitude: 108.937, crs: "gcj02" },
  }]);
  const fresh = new TravelEvidenceStore(root); await fresh.load();
  const place = fresh.bind(visit("v", "大雁塔", "16:40", "17:40"), "西安");
  assert.equal(place.evidence_verified, true);
  assert.equal(place.location?.latitude, 34.218229);
  assert.equal(place.rating, undefined);
  assert.equal(place.opening_hours, undefined);
  const traffic = fresh.bind({ id: "r", name: "交通", type: "transport", route_evidence_id: route!.id }, "西安");
  assert.equal(traffic.route_verified, true);
  assert.equal(traffic.route_duration_min, 66);
  await fresh.observePlaces("search_attractions", "西安", "大雁塔 | 坐标 34.3000,108.9000", "amap");
  const stale = fresh.bind(traffic, "西安");
  assert.equal(stale.route_verified, false);
  assert.match(stale.route_binding_error!, /坐标已变化/);
  const aligned = alignRouteContext({ items: [visit("v", "大雁塔", "16:40", "17:40"), { ...stale, from: undefined, time: "20:00" }, { id: "hotel", type: "accommodation", name: "酒店", time: "22:00" }] }, "西安");
  assert.match(aligned.items[1]!.route_binding_error!, /坐标已变化/);
});

test("真实路线工具地理编码后返回端点ID，保存时无需重做景点发现", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  setAmapKey("route-points", (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("place/text")) {
      const name = url.searchParams.get("keywords")!;
      const location = name.includes("大雁塔") ? "108.964176,34.218229" : "108.937,34.3439";
      return new Response(JSON.stringify({ status: "1", infocode: "10000", pois: [{ id: name, name, location, cityname: "西安市", pname: "陕西省" }] }));
    }
    if (url.pathname.includes("transit")) return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ duration: "3960", walking_distance: "0", segments: [] }] } }));
    throw new Error("意外接口 " + url.pathname);
  }) as typeof fetch);
  t.after(() => setAmapKey(undefined));
  const out = await createPlanRoutesTool().execute({ city: "西安", stops: ["大雁塔", "酒店"], mode: "transit" }, { workspace: root, evidence });
  assert.match(out, /已核验路线端点坐标/);
  assert.ok(evidence.point("大雁塔", "西安"));
  const route = evidence.routesForItinerary("大雁塔", "酒店", "西安")[0]!;
  assert.ok(route);
  assert.equal(evidence.bind({ id: "r", type: "transport", name: "交通", route_evidence_id: route.id }, "西安").route_verified, true);
});
