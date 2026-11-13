import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FrozenWorldRuntime, checkWorldItinerary, loadExternalWorld, parseExternalWorld, worldSuite } from "../src/eval/external-world.ts";
import { resumeLiveSuite, runNewLiveSuite } from "../src/eval/live.ts";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { composeSystemPrompt } from "../src/agent/prompt.ts";
import { externalEnvironment } from "../src/core/external-environment.ts";
import { cancellableFetch } from "../src/tools/travel-request.ts";
import { geocodeLocation } from "../src/tools/geocoding.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";

const worldPath = resolve("eval/worlds/xian-3d.json");
async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minicode-world-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("固定世界验证来源、日期、别名和 OD，拒绝坏场景", async () => {
  const { world } = await loadExternalWorld(worldPath);
  assert.equal(world.provenance.kind, "synthetic");
  for (const edit of [
    (w: typeof world) => { (w as { now: string }).now = "2026-11-06"; },
    (w: typeof world) => { (w.places[1] as { aliases: readonly string[] }).aliases = [w.places[0]!.name]; },
    (w: typeof world) => { (w.routes[0] as { to: string }).to = "不存在"; },
    (w: typeof world) => { (w.routes[0] as { driving_minutes: number }).driving_minutes = -1; },
  ]) { const copy = structuredClone(world); edit(copy); assert.throws(() => parseExternalWorld(copy), /外部世界数据无效/); }
});

test("语义匹配支持不同搜索词、半径和分页；未知查询与已知为空分开", async () => {
  const { world } = await loadExternalWorld(worldPath); const runtime = new FrozenWorldRuntime(world);
  const query = (keywords: string) => runtime.fetch(`https://restapi.amap.com/v3/place/text?city=西安&keywords=${encodeURIComponent(keywords)}&key=secret`).then((r) => r.json());
  assert.equal((await query("兵马俑")).pois[0].name, "秦始皇帝陵博物院");
  assert.equal((await query("西安市秦始皇帝陵博物院")).pois[0].name, "秦始皇帝陵博物院");
  assert.deepEqual((await query("场景不存在的景点")).pois, []);
  await assert.rejects(query("快照外的新地点"), /WORLD_UNCOVERED/);
  assert.equal(runtime.report().uncovered.length, 1);
  assert.equal(runtime.requests[2]!.outcome, "known_empty");
  assert.ok(runtime.requests.every((r) => !r.request.includes("secret")));
  const around = await runtime.fetch("https://restapi.amap.com/v3/place/text?keywords=旅游景点&location=108.9465,34.2600&radius=1000&offset=1&page=2").then((r) => r.json());
  assert.equal(around.pois.length, 1);
});

test("真实 Registry 运行筛选、官网导航提取、天气和路线，不替换工具结果", async (t) => {
  const root = await temp(t); const { world } = await loadExternalWorld(worldPath); const runtime = new FrozenWorldRuntime(world);
  const registry = createDefaultRegistry({ writeRoot: root, workspace: root, allowCommands: false });
  const execute = (name: string, args: object) => registry.execute(name, JSON.stringify(args), { workspace: root, travelMode: true, destination: "西安", queryAttempts: new Map() });
  await runtime.run(async () => {
    const attractions = await execute("search_attractions", { city: "西安", location: "西安", radius_km: 50, limit: 30 });
    assert.match(attractions, /秦始皇帝陵博物院/); assert.match(attractions, /大雁塔/);
    const forecast = await execute("get_weather", { location: "西安", start_date: "2026-11-09", end_date: "2026-11-11" });
    assert.match(forecast, /7~18°C/); assert.doesNotMatch(forecast, /超出预报范围|无法获取/);
    const reviews = await execute("get_place_visit_info", { place: "陕西历史博物馆", city: "西安", fields: ["hours", "closure"] });
    assert.match(reviews, /09:00/); assert.match(reviews, /周一/);
    assert.ok(runtime.requests.some((r) => r.service === "page" && r.request.endsWith("shaanxi-history/guide.html")), reviews);
    const routes = await execute("plan_day_routes", { city: "西安", stops: ["西安场景酒店钟楼店", "兵马俑"], mode: "driving" });
    assert.match(routes, /分钟/); assert.doesNotMatch(routes, /直线估算/);
    assert.match(composeSystemPrompt({ travelMode: true, workspace: root }), /2026.*11.*06/);
  });
  assert.deepEqual(runtime.report().uncovered, []);
  assert.equal(externalEnvironment(), undefined);
  const evidence = JSON.parse(await readFile(join(root, ".minicode/travel-evidence.json"), "utf8"));
  assert.ok(JSON.stringify(evidence).includes("09:00"));
});

test("并行世界隔离地理编码缓存，供应商故障可以按固定序号注入", async () => {
  const { world } = await loadExternalWorld(worldPath);
  const changed = structuredClone(world); (changed.city as { location: string }).location = "108.9,34.2";
  const a = new FrozenWorldRuntime(world), b = new FrozenWorldRuntime(changed);
  const [ga, gb] = await Promise.all([a.run(() => geocodeLocation("西安")), b.run(() => geocodeLocation("西安"))]);
  assert.notEqual(ga?.latitude, gb?.latitude);
  const faulty = new FrozenWorldRuntime({ ...world, faults: [{ service: "amap", occurrence: 1, status: 200, amap_code: "10021" }] });
  const url = "https://restapi.amap.com/v3/geocode/geo?address=西安";
  assert.equal((await (await faulty.fetch(url)).json()).infocode, "10021");
  assert.equal((await (await faulty.fetch(url)).json()).infocode, "10000");
});

test("工具即使吞掉异常，快照缺口仍留在报告；取消不发请求", async () => {
  const { world } = await loadExternalWorld(worldPath); const runtime = new FrozenWorldRuntime(world);
  let escaped = false;
  await runtime.run(async () => {
    const request = cancellableFetch(async () => { escaped = true; return new Response("外网"); });
    await assert.rejects(request("https://uncovered.example/data"), /WORLD_UNCOVERED/);
    await assert.rejects(request("https://uncovered.example/data", { signal: AbortSignal.abort() }));
  });
  assert.equal(escaped, false); assert.equal(runtime.report().uncovered.length, 1);
});

test("固定故障走真实降级链；历史场景时间下缓存仍可复用", async (t) => {
  const root = await temp(t); const { world } = await loadExternalWorld(worldPath);
  const runtime = new FrozenWorldRuntime({ ...world, now: "2020-01-01T09:00:00+08:00", faults: [{ service: "amap", occurrence: 1, status: 200, amap_code: "10003" }] });
  await runtime.run(async () => {
    const registry = createDefaultRegistry({ writeRoot: root });
    const output = await registry.execute("search_attractions", JSON.stringify({ city: "西安", location: "西安", radius_km: 50 }), { workspace: root, travelMode: true });
    assert.match(output, /大雁塔/);
    assert.ok(runtime.requests.some((r) => r.service === "geocode"));
    assert.ok(runtime.requests.some((r) => r.service === "overpass"));
    const evidence = new TravelEvidenceStore(root); evidence.cache("test", "场景缓存");
    assert.equal(evidence.cached("test"), "场景缓存");
  });
  assert.deepEqual(runtime.report().uncovered, []);
});

test("独立事实检查识别模型伪造的开放时间与漏日期", async () => {
  const { world } = await loadExternalWorld(worldPath);
  const itinerary = parseItinerary({ title: "测试", days: [{ date: "2026-11-09", items: [{ id: "v", name: "陕历博", type: "visit", time: "08:00", end_time: "18:00", opening_hours: { opens: "00:00", closes: "23:59" } }] }] });
  const codes = checkWorldItinerary(world, itinerary).map((c) => c.code);
  assert.ok(codes.includes("world-closed-day")); assert.ok(codes.includes("world-outside-hours")); assert.equal(codes.filter((c) => c === "world-missing-date").length, 2);
});

test("完整 runner 使用真实 Agent 和本地模型接口，保存快照/请求；快照缺口独立归因且不救援", async (t) => {
  const root = await temp(t); await mkdir(join(root, ".minicode"));
  const { world } = await loadExternalWorld(worldPath); const suite = worldSuite(world);
  let requests = 0; let location = "西安"; const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body); const step = requests++;
      const tool = step === 0 ? { name: "get_weather", arguments: JSON.stringify({ location, start_date: "2026-11-09", end_date: "2026-11-11" }) }
        : { name: "save_itinerary", arguments: JSON.stringify({ title: world.eval_case.title, days: world.travel_dates.map((date, i) => ({ date, items: [{ id: `visit-${i}`, type: "visit", name: ["陕西历史博物馆", "大雁塔", "秦始皇帝陵博物院"][i], time: "10:00", end_time: "12:00" }] })) }) };
      const delta = step < 2 ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: tool }] } : { role: "assistant", content: "结束测试" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: step < 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("未监听");
  await writeFile(join(root, ".minicode/config.json"), JSON.stringify({ provider: "openai", llmApiKey: "local", llmBaseUrl: `http://127.0.0.1:${address.port}/v1`, llmModel: "world-test" }));
  const options = { rootDir: root, suitePath: worldPath, suite, cases: suite.cases, runId: "frozen-integration", caseIds: [], tags: [], worldPath };
  const manifest = await runNewLiveSuite(options); const attempt = manifest.cases[0]!.attempts[0]!;
  assert.equal(manifest.external_data?.cache, "cold"); assert.equal(attempt.telemetry.completion_retries, 0);
  assert.equal(requests, 3); assert.ok(bodies.some((b) => /2026年11月0?6日|2026\/11\/0?6|2026-11-06/.test(b)));
  const report = JSON.parse(await readFile(join(root, "eval/runs", manifest.run_id, attempt.output_dir, "external-data.json"), "utf8"));
  assert.equal(report.uncovered.length, 0); assert.ok(report.requests.some((r: { service: string }) => r.service === "weather"));
  assert.ok(report.checks.some((c: { code: string }) => c.code === "world-closed-day"));
  assert.ok(attempt.itinerary_path);
  // 模型仍保存大雁塔；新增需求必须真正进入完整 runner 的 quality_gate 和报告。
  const constrained = { ...world, eval_case: { ...world.eval_case, request: world.eval_case.request + "。不去大雁塔。", requirements: { forbidden_visits: ["大雁塔"] }, review_focus: ["住宿体验"] } };
  const constrainedPath = join(root, "constrained-world.json");
  await writeFile(constrainedPath, JSON.stringify(constrained)); requests = 0;
  const constrainedSuite = worldSuite(constrained);
  const gated = await runNewLiveSuite({ ...options, suitePath: constrainedPath, worldPath: constrainedPath, suite: constrainedSuite, cases: constrainedSuite.cases, runId: "frozen-requirements" });
  const gatedAttempt = gated.cases[0]!.attempts[0]!;
  assert.equal(gatedAttempt.status, "quality_failed");
  assert.match(gatedAttempt.failure!.reason, /forbidden-visit.*大雁塔/);
  assert.ok(gatedAttempt.metrics?.requirementChecks?.some((check) => !check.passed));
  assert.match(await readFile(join(root, "eval/runs", gated.run_id, "report.md"), "utf8"), /未通过 forbidden-visit/);
  location = "深圳"; requests = 0;
  const uncovered = await runNewLiveSuite({ ...options, runId: "frozen-uncovered" });
  assert.equal(uncovered.cases[0]!.attempts[0]!.failure?.stage, "environment");
  assert.equal(uncovered.cases[0]!.status, "evaluation_failed");
  const snapshotPath = join(root, "eval/runs", manifest.run_id, "external-world.json");
  await writeFile(snapshotPath, (await readFile(snapshotPath, "utf8")) + " ");
  await assert.rejects(resumeLiveSuite({ rootDir: root, runId: manifest.run_id }), /快照哈希不匹配/);
  const missing = structuredClone(world); (missing as { weather: typeof world.weather }).weather = missing.weather.filter((d) => d.date >= "2026-11-09");
  // 此模型下一次不调用工具；这里只确认坏快照在运行前被拒绝，不请求模型。
  (missing as { travel_dates: readonly string[] }).travel_dates = ["2026-11-06", "2026-11-10", "2026-11-11"];
  assert.throws(() => parseExternalWorld(missing), /天气覆盖不足/);
});
