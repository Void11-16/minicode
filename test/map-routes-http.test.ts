import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function itinerary() { return { title: "地图验证", revision: 1, days: [{ items: [
  { id: "a", type: "visit", name: "地点甲", location: { latitude: 30, longitude: 120, source: "amap-resolved" } },
  { id: "b", type: "visit", name: "地点乙", location: { latitude: 30.005, longitude: 120.005, source: "amap-resolved" } },
  { id: "c", type: "visit", name: "地点丙", location: { latitude: 30.008, longitude: 120.008, source: "amap-resolved" } },
] }] }; }
function road(url: string | URL | Request) {
  const parsed = new URL(String(url));
  return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "800", duration: "600", steps: [{ polyline: `${parsed.searchParams.get("origin")};${parsed.searchParams.get("destination")}` }] }] } }));
}
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "minicode-map-http-"));
  await mkdir(join(root, "plans"));
  const file = join(root, "plans/地图验证.json");
  await writeFile(file, JSON.stringify(itinerary()));
  const server = await startWebServer({ rootDir: root, port: 0, auth: false, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); setAmapKey(undefined); await rm(root, { recursive: true, force: true }); });
  return { root, file, base: `http://127.0.0.1:${server.port}/api/plans/${encodeURIComponent("地图验证")}` };
}

test("HTTP 路线绑定文件版本，计算前及计算后都拒绝旧快照", async (t) => {
  const { base, file } = await setup(t);
  const saved = await (await fetch(base)).json();
  const waiting = deferred<void>(), finish = deferred<Response>();
  let calls = 0;
  setAmapKey("k", async (url) => {
    calls++;
    if (calls === 1) { waiting.resolve(); return finish.promise; }
    return road(url);
  });
  const mismatch = await fetch(`${base}/routes?day=1&version=old`);
  assert.equal(mismatch.status, 409); assert.equal(calls, 0);
  const pending = fetch(`${base}/routes?day=1&version=${saved.routeVersion}`);
  await waiting.promise;
  const edited = itinerary(); edited.revision = 2; edited.days[0]!.items[1]!.location.latitude = 30.006;
  await writeFile(file, JSON.stringify(edited));
  finish.resolve(road("https://example.com/?origin=120,30&destination=120.005,30.005"));
  assert.equal((await pending).status, 409);
  assert.equal((await (await fetch(base)).json()).revision, 2);
});

test("HTTP 连接取消传到高德，停止后续路段且不污染缓存", async (t) => {
  const { base, root } = await setup(t);
  const started = deferred<void>(), stopped = deferred<void>();
  let calls = 0;
  setAmapKey("k", async (_, init) => {
    calls++; started.resolve();
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { stopped.resolve(); reject(init.signal!.reason); }, { once: true }));
  });
  const controller = new AbortController();
  const pending = fetch(`${base}/routes?day=1`, { signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await stopped.promise;
  assert.equal(calls, 1);
  await assert.rejects(readFile(join(root, ".minicode/route-cache.json")), { code: "ENOENT" });
});

test("失败重试复用已成功路段，仅失败路段再次查询；无 Key 有明确状态", async (t) => {
  const { base } = await setup(t);
  const noKey = await (await fetch(`${base}/routes?day=1`)).json();
  assert.equal(noKey.days[0].legs[0].status, "no_key");
  let calls = 0;
  setAmapKey("k", async (url) => {
    calls++;
    return calls === 1 ? road(url) : new Response(JSON.stringify({ status: "0", infocode: "10003" }));
  });
  const first = await (await fetch(`${base}/routes?day=1`)).json();
  assert.deepEqual(first.days[0].legs.map((leg: { status: string }) => leg.status), ["ready", "quota"]);
  let retries = 0;
  setAmapKey("new-key", async (url) => { retries++; return road(url); });
  const onlyFailed = await (await fetch(`${base}/routes?day=1&retry_legs=1`)).json();
  assert.deepEqual(onlyFailed.days[0].legs.map((leg: { status: string }) => leg.status), ["unchanged", "ready"]);
  const next = await (await fetch(`${base}/routes?day=1`)).json();
  assert.deepEqual(next.days[0].legs.map((leg: { status: string }) => leg.status), ["ready", "ready"]);
  assert.equal(retries, 1);
});

test("损坏文件返回 500，缺失文件返回 404，无效日期返回 400", async (t) => {
  const { base, file } = await setup(t);
  assert.equal((await fetch(`${base}/routes?day=0`)).status, 400);
  assert.equal((await fetch(`${base}/routes?day=2`)).status, 404);
  assert.equal((await fetch(`${base}/routes?day=1&retry_legs=2`)).status, 400);
  await writeFile(file, "{broken");
  assert.equal((await fetch(`${base}/routes?day=1`)).status, 500);
  await rm(file);
  assert.equal((await fetch(`${base}/routes?day=1`)).status, 404);
});

test("坐标校准属于可取消的路线请求；只读取行程不会启动后台查询", async (t) => {
  const { base, file } = await setup(t);
  const p = itinerary();
  for (const item of p.days[0]!.items) item.location.source = "model";
  const withCity = { ...p, constraints: { destination: "杭州" } };
  await writeFile(file, JSON.stringify(withCity));
  const started = deferred<void>(), stopped = deferred<void>();
  let calls = 0;
  setAmapKey("k", async (url, init) => {
    assert.equal(new URL(String(url)).searchParams.get("city"), "杭州");
    calls++; started.resolve();
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { stopped.resolve(); reject(init.signal!.reason); }, { once: true }));
  });
  const data = await (await fetch(base)).json();
  assert.equal(data.coordinateCalibration, "pending"); assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = fetch(`${base}/routes?day=1&version=${data.routeVersion}`, { signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); await stopped.promise;
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), withCity);
  assert.equal(calls, 1);
});
