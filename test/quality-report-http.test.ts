import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { qualitySourceSignature, validateItinerary } from "../src/tools/itinerary-validator.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";

test("Web 列表不展示旧公式或旧行程内容对应的评分；重算只调用本地规则", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-quality-report-"));
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "plans/评分.json"), JSON.stringify({ title: "评分", days: [{ items: [{ id: "v", type: "visit", name: "公园", time: "10:00", end_time: "11:00", location: { latitude: 30, longitude: 120, crs: "wgs84" }, source: "manual", confidence: "high", opening_hours: { opens: "08:00", closes: "20:00" } }] }] }));
  const server = await startWebServer({ rootDir: root, auth: false, port: 0, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  for (const score_version of [undefined, "opportunity-v1", "opportunity-v2"]) {
    await writeFile(join(root, "plans/评分.quality.json"), JSON.stringify({ status: "invalid", score: 0, score_version, source_signature: "older-plan" }));
    const data = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
    assert.equal(data.plans[0].quality.score, 100); assert.equal(data.plans[0].quality.status, "ok");
  }
  const planPath = join(root, "plans/评分.json");
  const changed = JSON.parse(await readFile(planPath, "utf8"));
  changed.days[0].items[0].opening_hours.opens = "12:00";
  await writeFile(planPath, JSON.stringify(changed));
  const refreshed = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(refreshed.plans[0].quality.status, "needs_revision");
  assert.ok(refreshed.plans[0].quality.score < 100);
  await writeFile(join(root, "plans/旧行程.json"), JSON.stringify({ title: "旧行程", days: [{ items: [{ type: "obsolete" }] }] }));
  const legacy = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(legacy.plans.length, 2);
  assert.equal(legacy.plans.find((plan: { file: string }) => plan.file === "旧行程.json").quality, null);
  // 只改需求单也必须使内存质量缓存失效，旧 JSON 不含 must_visit 不能漏验收。
  changed.days[0].items[0].opening_hours.opens = "08:00";
  await writeFile(planPath, JSON.stringify(changed));
  await createSaveTravelBriefTool(root).execute({ title: "评分", destination: "杭州", mustVisit: ["灵隐寺"] });
  const required = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(required.plans.find((p: { file: string }) => p.file === "评分.json").quality.status, "needs_revision");
  await createSaveTravelBriefTool(root).execute({ title: "评分", destination: "杭州", mustVisit: ["公园"] });
  const satisfied = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(satisfied.plans.find((p: { file: string }) => p.file === "评分.json").quality.status, "ok");
});

test("行程详情返回当前版本的具体问题，旧质量文件不能隐藏待确认；修改行程和需求单后立即重算", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-quality-detail-"));
  await mkdir(join(root, "plans"));
  const plan = { title: "详情", days: [{ date: "2026-11-14", items: [{ id: "v", type: "visit", name: "公园", time: "10:00", end_time: "11:00", location: { latitude: 30, longitude: 120, crs: "wgs84" }, source: "manual", confidence: "high" }] }] };
  const file = join(root, "plans/详情.json");
  await writeFile(file, JSON.stringify(plan));
  await writeFile(join(root, "plans/详情.quality.json"), JSON.stringify({ ...validateItinerary(parseItinerary(plan)), score: 100, status: "ok", issues: [] }));
  const server = await startWebServer({ rootDir: root, auth: false, port: 0, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const get = async () => (await fetch(`http://127.0.0.1:${server.port}/api/plans/${encodeURIComponent("详情")}`)).json();
  const pending = await get();
  assert.equal(pending.quality.status, "needs_confirmation");
  assert.equal(pending.quality.source_signature, qualitySourceSignature(parseItinerary(plan)));
  assert.ok(pending.quality.issues.some((issue: { code: string; kind: string; item_id: string; day: number }) => issue.code === "missing-opening-hours" && issue.kind === "pending" && issue.item_id === "v" && issue.day === 1));
  const closed = { ...plan, days: [{ ...plan.days[0], items: [{ ...plan.days[0]!.items[0], opening_hours: { opens: "12:00", closes: "18:00" } }] }] };
  await writeFile(file, JSON.stringify(closed));
  const conflict = await get();
  assert.ok(conflict.quality.issues.some((issue: { code: string }) => issue.code === "outside-opening-hours"));
  const fixed = { ...plan, days: [{ ...plan.days[0], items: [{ ...plan.days[0]!.items[0], opening_hours: { opens: "08:00", closes: "18:00" } }] }] };
  await writeFile(file, JSON.stringify(fixed));
  const valid = await get();
  assert.equal(valid.quality.status, "ok");
  assert.deepEqual(valid.quality.issues, []);
  await createSaveTravelBriefTool(root).execute({ title: "详情", destination: "杭州", mustVisit: ["灵隐寺"] });
  const changedBrief = await get();
  assert.ok(changedBrief.quality.issues.some((issue: { code: string }) => issue.code === "missing-required-visit"));
  await createSaveTravelBriefTool(root).execute({
    title: "详情", destination: "杭州",
    requirements: { forbidden_visits: ["公园"], daily_window: { start: "12:00", end: "18:00" } },
  });
  const hardConstraints = await get();
  assert.ok(hardConstraints.quality.issues.some((issue: { code: string; day: number }) => issue.code === "forbidden-visit" && issue.day === 1));
  assert.ok(hardConstraints.quality.issues.some((issue: { code: string; day: number }) => issue.code === "activity-window" && issue.day === 1));
  await writeFile(file, JSON.stringify({ title: "详情", days: [{ items: [{ type: "obsolete" }] }] }));
  const incompatible = await get();
  assert.equal(incompatible.quality, null);
});

test("旧行程详情按本地证据刷新区域和必去台账，保留真实开放错误且不改写历史文件", async (t) => {
  const { TravelEvidenceStore } = await import("../src/tools/travel-evidence.ts");
  const root = await mkdtemp(join(tmpdir(), "minicode-required-detail-"));
  await mkdir(join(root, "plans"));
  const area = "杭州西湖风景名胜区", child = "郭庄", evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", "杭州", `${area} | 坐标 30.2200,120.1400 | 开放时间 09:00-17:00\n${child} | 坐标 30.2300,120.1300`, "amap", [{ parent: area, children: [child], relation: "geographic_area" }]);
  const plan = { title: "区域详情", constraints: { destination: "杭州", must_visit: [child] }, days: [{ date: "2026-11-14", items: [{ id: "area", type: "visit", name: area, time: "16:00", end_time: "18:00" }, { id: "child", type: "visit", name: child, time: "10:00", end_time: "11:00", parent_visit: { name: area } }] }] };
  const raw = JSON.stringify(plan), file = join(root, "plans/区域详情.json"); await writeFile(file, raw);
  const server = await startWebServer({ rootDir: root, auth: false, port: 0, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const detail = await (await fetch(`http://127.0.0.1:${server.port}/api/plans/${encodeURIComponent("区域详情")}`)).json();
  assert.equal(detail.required_visit_goals[0].status, "scheduled");
  assert.equal(detail.days[0].items[1].parent_visit, undefined);
  assert.equal(detail.days[0].items[1].area_group.name, area);
  assert.ok(detail.quality.issues.some((i: { code: string }) => i.code === "outside-opening-hours"));
  assert.ok(!detail.quality.issues.some((i: { code: string }) => i.code === "duplicate-scenic-visit"));
  assert.equal(await readFile(file, "utf8"), raw);
});

test("基础层完整而时间未排时，详情返回每日建议和分层进度，strict问题仍存在", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-layer-detail-"));
  const { createSaveItineraryTool } = await import("../src/tools/itinerary.ts");
  await createSaveItineraryTool(root).execute({ title: "分层基础", constraints: { expected_days: 2 }, outline: [{ date: "2026-11-10", visits: [{ name: "甲园" }] }, { date: "2026-11-11", visits: [{ name: "乙园" }] }] });
  const server = await startWebServer({ rootDir: root, auth: false, port: 0, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const detail = await (await fetch(`http://127.0.0.1:${server.port}/api/plans/${encodeURIComponent("分层基础")}`)).json();
  assert.equal(detail.planning_layers.basic_days, 2); assert.equal(detail.planning_layers.basic_complete, true);
  assert.equal(detail.planning_layers.scheduled_days, 0); assert.equal(detail.planning_layers.ready_days, 0);
  assert.equal(detail.days.length, 0); assert.equal(detail.outline.length, 2); assert.ok(detail.quality.issue_count.P1 > 0);
});
