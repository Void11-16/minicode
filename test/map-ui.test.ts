import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, Script } from "node:vm";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
const functions = html.slice(html.indexOf("      function cancelRouteRequests()"), html.indexOf("      const markerById"));
const routeFunctions = html.slice(html.indexOf("      async function ensureRouteDay("), html.indexOf("      const QUALITY_LABELS"));
const loadFunction = html.slice(html.indexOf("      async function loadItinerary(title)"), html.indexOf("      async function loadPlanList()"));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const a = { id: "a", name: "甲", type: "visit", location: { latitude: 30, longitude: 120 } };
const b = { id: "b", name: "乙", type: "visit", location: { latitude: 30.01, longitude: 120.01 } };
const plan = { title: "计划", routeVersion: "v1", days: [{ items: [a, b] }, { items: [a, b] }] };
const leg = { status: "ready", mode: "walking", from: { id: "a", ...a.location }, to: { id: "b", ...b.location }, points: [[30, 120], [30.01, 120.01]] };
function payload(day = 1) { return { available: true, version: "v1", days: [{ day, legs: [structuredClone(leg)] }] }; }
function response(body: unknown) { return { ok: true, status: 200, json: async () => body }; }
function harness() {
  const context = createContext({
    AbortController, DOMException, API_BASE: "", currentItinerary: structuredClone(plan), currentPlanTitle: "计划",
    currentRoutes: { days: [] }, currentDay: -1, routeGeneration: 1,
    routeRequests: new Map(), routeControllers: new Map(), loadedRouteDays: new Set(), routeStates: new Map(),
    planController: null, mapListController: null,
    renderMapSide() {}, renderDay() {}, renderDayTabs() {}, closeItemEditor() {}, cancelRouteRequests() {}, renderPlanMeta() {}, mapToast() {},
    useDisplayCoordinates(value: unknown) { return value; },
    apiFetch: async () => response(payload()),
    $: () => ({ classList: { remove() {} } }),
  });
  new Script(functions + routeFunctions).runInContext(context);
  return context;
}

test("地图脚本语法可执行，包含 Leaflet 的完整页面没有语法错误", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).filter((s) => s.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new Script(source));
});

test("前端同时检查版本和每段端点，拒绝数量相同但属于旧景点的路线", async () => {
  for (const mismatch of ["version", "endpoint"]) {
    const ctx = harness();
    const body = payload();
    if (mismatch === "version") body.version = "old";
    else body.days[0]!.legs[0]!.to.id = "old-poi";
    ctx.apiFetch = async () => response(body);
    assert.equal(await ctx.ensureRouteDay("计划", 1, 1), false);
    assert.equal(ctx.currentRoutes.days.length, 0);
    assert.equal(ctx.routeStates.get(1), "error");
    assert.equal(ctx.loadedRouteDays.has(1), false);
  }
});

test("切换日期会取消预取，当前日立即请求；旧响应即使返回也不能写入", async () => {
  const ctx = harness();
  const background = deferred<ReturnType<typeof response>>();
  let backgroundSignal: AbortSignal | undefined;
  const calls: string[] = [];
  ctx.apiFetch = async (url: string, init: { signal: AbortSignal }) => {
    calls.push(url);
    if (url.includes("day=2")) { backgroundSignal = init.signal; return background.promise; }
    return response(payload());
  };
  const old = ctx.ensureRouteDay("计划", 2, 1);
  ctx.prioritizeRouteDay(1);
  await ctx.routeRequests.get("1:1");
  assert.equal(backgroundSignal?.aborted, true);
  assert.equal(ctx.currentRoutes.days[0].day, 1);
  background.resolve(response(payload(2)));
  assert.equal(await old, false);
  assert.equal(ctx.currentRoutes.days[1], undefined);
  assert.equal(calls.length, 2);
});

test("关闭地图中断列表、计划和路线请求并使旧 generation 失效", async () => {
  const ctx = harness();
  const pending = deferred<ReturnType<typeof response>>();
  ctx.apiFetch = async () => pending.promise;
  const route = ctx.ensureRouteDay("计划", 1, 1);
  const requestController = ctx.routeControllers.get("1:1");
  ctx.planController = new AbortController(); ctx.mapListController = new AbortController();
  new Script(html.slice(html.indexOf("      function closeMap()"), html.indexOf("      function resetMapForAccountChange()"))).runInContext(ctx);
  ctx.closeMap();
  assert.equal(requestController.signal.aborted, true);
  assert.equal(ctx.planController.signal.aborted, true); assert.equal(ctx.mapListController.signal.aborted, true);
  assert.equal(ctx.routeGeneration, 2);
  pending.resolve(response(payload())); await route;
  assert.equal(ctx.currentRoutes.days.length, 0);
});

test("快速切换计划时，较慢的计划响应不会覆盖最后选择", async () => {
  const ctx = harness();
  ctx.ensureRouteDay = async () => false;
  new Script(loadFunction).runInContext(ctx);
  const oldResponse = deferred<ReturnType<typeof response>>();
  let previousSignal: AbortSignal | undefined;
  ctx.apiFetch = async (url: string, init: { signal: AbortSignal }) => {
    if (url.endsWith("/old")) { previousSignal = init.signal; return oldResponse.promise; }
    return response({ ...plan, title: "new" });
  };
  const old = ctx.loadItinerary("old");
  await ctx.loadItinerary("new");
  oldResponse.resolve(response({ ...plan, title: "old" })); await old;
  assert.equal(previousSignal?.aborted, true);
  assert.equal(ctx.currentItinerary.title, "new"); assert.equal(ctx.currentPlanTitle, "new");
});

test("重试只请求并替换失败路段，已经成功的路线保留", async () => {
  const ctx = harness();
  const previous = structuredClone(leg);
  const c = { id: "c", type: "visit", name: "丙", location: { latitude: 30.02, longitude: 120.02 } };
  ctx.currentItinerary.days[0].items.push(c);
  const second = { ...structuredClone(leg), from: { id: "b", ...b.location }, to: { id: "c", ...c.location } };
  ctx.currentRoutes.days[0] = { day: 1, legs: [previous, { ...second, status: "quota" }] };
  ctx.loadedRouteDays.add(1);
  ctx.apiFetch = async (url: string) => {
    assert.match(url, /retry_legs=1$/);
    return response({ ...payload(), days: [{ day: 1, legs: [{ ...leg, status: "unchanged" }, second] }] });
  };
  assert.equal(await ctx.ensureRouteDay("计划", 1, 1, true), true);
  assert.equal(ctx.currentRoutes.days[0].legs[0], previous);
  assert.equal(ctx.currentRoutes.days[0].legs[1].status, "ready");
});
