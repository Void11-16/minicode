import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmapClient } from "../src/tools/amap.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { PlanRouteService, type MapPlan } from "../src/web/plan-routes.ts";
import { RouteCache, ROUTE_SHAPE_TTL_MS, ROUTE_METRICS_TTL_MS } from "../src/web/route-cache.ts";
import { convertPoint } from "../src/tools/coordinates.ts";
import { resolvePlanCoordinates, selectCalibrationPoi } from "../src/web/plan-coords.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

const from = { latitude: 30, longitude: 120, crs: "gcj02" as const };
const to = { latitude: 30.004, longitude: 120.005, crs: "gcj02" as const };
const shape = { distanceM: 1100, durationSec: 601, points: [[30, 120], [30.004, 120.005]] as [number, number][] };
const signal = () => new AbortController().signal;
function plan(mode?: string, id?: string): MapPlan {
  return { constraints: { destination: "杭州" }, days: [{ items: [
    { id: "a", type: "visit", name: "起点", location: from },
    ...(mode === undefined ? [] : [{ type: "transport", name: "通勤", from: "起点", to: "终点", transport_mode: mode, route_evidence_id: id }]),
    { id: "b", type: "visit", name: "终点", location: to },
  ] }] };
}
function response(data: unknown) { return new Response(JSON.stringify({ status: "1", infocode: "10000", ...data as object })); }
function road() { return response({ route: { paths: [{ distance: "1100", duration: "601", steps: [{ polyline: "120,30;120.005,30.004" }] }] } }); }
function transit() { return response({ route: { transits: [
  { duration: "", segments: [] },
  { distance: "2200", duration: "900", walking_distance: "150", segments: [
    { walking: { distance: "150", steps: [{ polyline: "120,30;120.001,30.001" }] }, bus: { buslines: [
      { name: "地铁1号线", polyline: "120.001,30.001;120.005,30.004" },
      { name: "互斥方案", polyline: "121,31;122,32" },
    ] } },
  ] },
] } }); }
async function setup(t: { after: (fn: () => Promise<void>) => void }, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "minicode-map-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new RouteCache(join(root, "routes.json"), now);
  return { root, cache, service: new PlanRouteService(cache), evidence: new TravelEvidenceStore() };
}

test("地图遵循 transport 的公交/出租车/骑行方式，公交拆分步行与乘车且不拼接备选线路", async (t) => {
  const { service, evidence } = await setup(t);
  const paths: string[] = [];
  const client = new AmapClient({ apiKey: "k", fetchFn: async (url) => {
    paths.push(new URL(String(url)).pathname);
    if (paths.at(-1)?.includes("transit")) return transit();
    if (paths.at(-1)?.includes("bicycling")) {
      const body = await road().json();
      return new Response(JSON.stringify({ errcode: 0, errmsg: "OK", data: body.route }));
    }
    return road();
  } });
  const bus = (await service.day(plan("transit"), 1, client, evidence, signal())).legs[0]!;
  assert.equal(bus.mode, "transit"); assert.equal(bus.durationSec, 900);
  assert.deepEqual(bus.parts?.map((part) => part.mode), ["walking", "transit"]);
  assert.equal(bus.points?.length, 4);
  assert.equal(bus.distanceM, 2200);
  assert.equal((await service.day(plan("taxi"), 1, client, evidence, signal())).legs[0]!.mode, "taxi");
  assert.equal((await service.day(plan("cycling"), 1, client, evidence, signal())).legs[0]!.status, "ready");
  assert.deepEqual(paths, ["/v3/direction/transit/integrated", "/v3/direction/driving", "/v4/direction/bicycling"]);
});

test("规划工具保存同一方案几何；地图复用证据并区分规划耗时，不重复请求供应商", async (t) => {
  const { service, evidence } = await setup(t);
  await evidence.observePlaces("search_attractions", "杭州", "1. 起点 | 坐标 30.0000,120.0000\n2. 终点 | 坐标 30.0040,120.0050", "amap");
  let count = 0;
  setAmapKey("k", async () => { count++; return transit(); });
  t.after(async () => { setAmapKey(undefined); });
  const output = await createPlanRoutesTool().execute({ stops: ["起点", "终点"], city: "杭州" }, { workspace: "/tmp", evidence });
  assert.match(String(output), /公交\/地铁约 15 分钟/);
  const id = String(output).match(/终点: ([a-f0-9]+) \/ 15分钟/)?.[1];
  assert.ok(id);
  const day = await service.day(plan("transit", id), 1, undefined, evidence, signal());
  assert.equal(day.legs[0]!.source, "evidence");
  assert.equal(day.legs[0]!.plannedDurationSec, 900);
  assert.equal(day.legs[0]!.durationSec, undefined);
  assert.equal(day.legs[0]!.parts?.length, 2);
  assert.equal(count, 1);
  const edited = plan("transit", id);
  edited.days![0]!.items![2]!.location = { ...to, latitude: 30.007 };
  assert.equal((await service.day(edited, 1, undefined, evidence, signal())).legs[0]!.status, "no_key", "端点已改动，旧证据失效");
});

test("几何 30 天与耗时 30 分钟独立过期，运行中的缓存、重启及原子落盘一致", async (t) => {
  let now = Date.now();
  const { root, cache, service, evidence } = await setup(t, () => now);
  let calls = 0;
  const client = new AmapClient({ apiKey: "k", fetchFn: async () => { calls++; return road(); } });
  await service.day(plan("walking"), 1, client, evidence, signal());
  now += ROUTE_METRICS_TTL_MS;
  const stale = (await service.day(plan("walking"), 1, client, evidence, signal())).legs[0]!;
  assert.equal(stale.status, "ready"); assert.equal(stale.durationSec, undefined); assert.equal(stale.metricsFresh, false);
  assert.equal(calls, 1);
  await cache.persist();
  const restored = new RouteCache(join(root, "routes.json"), () => now);
  await restored.load();
  assert.equal((await new PlanRouteService(restored).day(plan("walking"), 1, undefined, evidence, signal())).legs[0]!.status, "ready");
  now += ROUTE_SHAPE_TTL_MS - ROUTE_METRICS_TTL_MS;
  assert.equal((await service.day(plan("walking"), 1, undefined, evidence, signal())).legs[0]!.status, "no_key");
  await cache.persist();
  assert.deepEqual(JSON.parse(await readFile(join(root, "routes.json"), "utf8")), {});
});

test("缓存读写隔离引用，拒绝非法坐标和非有限数", async (t) => {
  const { cache } = await setup(t);
  const value = structuredClone(shape);
  cache.set("a", value); value.points[0]![0] = 60;
  assert.equal(cache.get("a")!.points[0]![0], 30);
  const returned = cache.get("a")!;
  (returned.points as unknown as number[][])[0]![0] = 70;
  assert.equal(cache.get("a")!.points[0]![0], 30);
  cache.set("bad", { ...shape, durationSec: NaN }); assert.equal(cache.get("bad"), undefined);
  cache.set("bad", { ...shape, points: [[91, 120], [30, 120]] }); assert.equal(cache.get("bad"), undefined);
});

test("合并请求：取消一个消费者不影响另一个；全部取消才中断上游", async (t) => {
  const { service, evidence } = await setup(t);
  let calls = 0;
  let upstream: AbortSignal | null | undefined;
  let finish: (res: Response) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const client = new AmapClient({ apiKey: "k", fetchFn: async (_, init) => {
    calls++; upstream = init?.signal; started();
    return new Promise<Response>((resolve, reject) => { finish = resolve; init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }); });
  } });
  const a = new AbortController(), b = new AbortController();
  const first = service.day(plan("walking"), 1, client, evidence, a.signal);
  const second = service.day(plan("walking"), 1, client, evidence, b.signal);
  await ready;
  a.abort(); await assert.rejects(first, { name: "AbortError" });
  assert.equal(upstream?.aborted, false);
  finish(road()); assert.equal((await second).legs[0]!.status, "ready"); assert.equal(calls, 1);

  const next = plan("walking"); next.days![0]!.items![2]!.location = { ...to, latitude: 30.009 };
  let startLast: () => void = () => {};
  const lastReady = new Promise<void>((resolve) => { startLast = resolve; });
  const lastClient = new AmapClient({ apiKey: "k", fetchFn: async (_, init) => {
    upstream = init?.signal; startLast();
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  } });
  const c = new AbortController();
  const last = service.day(next, 1, lastClient, evidence, c.signal);
  await lastReady; c.abort(); await assert.rejects(last, { name: "AbortError" });
  assert.equal(upstream?.aborted, true);
});

test("无 Key、无路线、配额、Key 错误与网络失败分别报告，同点位不调用供应商", async (t) => {
  const { service, evidence } = await setup(t);
  assert.equal((await service.day(plan(), 1, undefined, evidence, signal())).legs[0]!.status, "no_key");
  for (const [code, status] of [["10003", "quota"], ["10001", "key"], ["10019", "key"]]) {
    const client = new AmapClient({ apiKey: "k", fetchFn: async () => response({ status: "0", infocode: code }) });
    assert.equal((await service.day(plan(), 1, client, evidence, signal())).legs[0]!.status, status);
  }
  const noGeometry = new AmapClient({ apiKey: "k", fetchFn: async () => response({ route: { transits: [{ duration: "900", walking_distance: "100", segments: [] }] } }) });
  assert.equal((await service.day(plan("transit"), 1, noGeometry, evidence, signal())).legs[0]!.status, "no_geometry");
  const noRoute = new AmapClient({ apiKey: "k", fetchFn: async () => response({ route: { paths: [] } }) });
  assert.equal((await service.day(plan(), 1, noRoute, evidence, signal())).legs[0]!.status, "no_route");
  const network = new AmapClient({ apiKey: "k", fetchFn: async () => { throw new Error("offline"); } });
  assert.equal((await service.day(plan(), 1, network, evidence, signal())).legs[0]!.status, "network");
  const same = plan(); same.days![0]!.items![1]!.location = from;
  assert.equal((await service.day(same, 1, network, evidence, signal())).legs[0]!.status, "same_point");
});

test("估算证据及冲突交通条目保持待确认，不误画成真实道路", async (t) => {
  const { service, evidence } = await setup(t);
  const [record] = await evidence.observeRoutes([{ city: "杭州", from: "起点", to: "终点", mode: "walking", from_point: from, to_point: to, duration_min: 10, distance_km: 1, estimated: true }]);
  const result = (await service.day(plan("walking", record!.id), 1, undefined, evidence, signal())).legs[0]!;
  assert.equal(result.status, "estimated"); assert.equal(result.points, undefined);
  const conflict = plan("transit"); conflict.days![0]!.items![1]!.to = "另一个景点";
  assert.equal((await service.day(conflict, 1, undefined, evidence, signal())).legs[0]!.status, "needs_confirmation");
});

test("坐标匹配排除外市、附属设施和同名分店歧义；已知 POI ID 优先核对", () => {
  const poi = (id: string, name: string, cityname = "杭州市", location = "120.002,30.002") => ({ id, name, cityname, location });
  const matches = [poi("wrong", "杭州博物馆", "北京市"), poi("noise", "杭州博物馆停车场"), poi("right", "杭州博物馆")];
  assert.equal(selectCalibrationPoi(matches, "杭州博物馆", from, { city: "杭州" })?.poiId, "right");
  const branches = [poi("a", "好酒店(东门店)"), poi("b", "好酒店(西门店)", "杭州市", "120.003,30.003")];
  assert.equal(selectCalibrationPoi(branches, "好酒店", from, { city: "杭州" }), null);
  assert.equal(selectCalibrationPoi(branches, "好酒店", from, { city: "杭州", poiId: "b" })?.poiId, "b");
  assert.equal(selectCalibrationPoi(matches, "杭州博物馆", from, {}), null, "没有城市或实体 ID 时保留原坐标");
});

test("坐标漂移在同一坐标系计算；取消不会继续解析或写入", async () => {
  const gcj = convertPoint({ latitude: 30, longitude: 120, crs: "wgs84" }, "gcj02");
  const input = { constraints: { destination: "杭州" }, days: [{ items: [{ name: "杭州博物馆", location: { latitude: 30, longitude: 120, source: "osm", crs: "wgs84" as const } }] }] };
  const fixed = await resolvePlanCoordinates(input, async (_, near, ctx) => {
    assert.deepEqual(near, gcj); assert.equal(ctx.city, "杭州"); return { ...gcj, longitude: gcj.longitude + 0.082, poiId: "correct" };
  }, { intervalMs: 0 });
  assert.equal(fixed.resolved, 1); assert.equal(fixed.plan.days![0]!.items![0]!.location!.poi_id, "correct");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolvePlanCoordinates(input, async () => { throw new Error("must not run"); }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(input.days[0]!.items[0]!.location.latitude, 30);
});
