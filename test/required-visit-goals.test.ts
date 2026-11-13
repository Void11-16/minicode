import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoadItineraryTool, createSaveItineraryTool, itineraryWithBriefRequirements } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { requiredVisitGoals, requiredVisitIssues } from "../src/tools/required-visits.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { groupScenicAttractions } from "../src/tools/scenic-area.ts";
import { updateTravelStateFromSnapshot, renderTravelState } from "../src/core/travel-state.ts";
import { checkRequirements } from "../src/eval/requirements.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { Session } from "../src/core/session.ts";
import { planningGuidance } from "../src/agent/travel-progress.ts";

const area = "杭州西湖风景名胜区", tower = "雷峰塔", garden = "郭庄", museum = "测试博物馆", exhibit = "测试博物馆-展厅";
const date = "2026-11-14", next = "2026-11-15";
const visit = (id: string, name: string, time = "10:00", end_time = "12:00"): ItineraryItem => ({ id, type: "visit", name, time, end_time });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "required-goals-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root), title = "必去目标管理";
  await evidence.observePlaces("search_attractions", "杭州", [area, tower, garden, museum, exhibit].map((name, i) => `${name} | 坐标 ${(30.22 + i * .001).toFixed(4)},120.1400 | 开放时间 09:00-18:00`).join("\n"), "amap", [
    { parent: area, children: [tower, garden], relation: "geographic_area" },
    { parent: museum, children: [exhibit], relation: "scenic_child" },
  ]);
  const ctx = { workspace: root, evidence }, save = createSaveItineraryTool(root);
  const load = async () => parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8")));
  return { root, evidence, title, ctx, save, load };
}

test("必去目标识别、预留、保存、移动、删除逐次重算，稳定ID跨Session保留，粗排不算完成", async (t) => {
  const f = await fixture(t), constraints = { destination: "杭州", must_visit: [exhibit] };
  await f.save.execute({ title: f.title, constraints, outline: [{ date, visits: [] }] }, f.ctx);
  const initial = (await f.load()).required_visit_goals![0]!;
  assert.equal(initial.status, "identified");
  await f.save.execute({ title: f.title, outline: [{ date, visits: [{ name: museum }] }] }, f.ctx);
  let plan = await f.load(), goal = plan.required_visit_goals![0]!;
  assert.equal(goal.id, initial.id); assert.equal(goal.status, "reserved"); assert.equal(goal.covered_by, museum);
  assert.match(requiredVisitIssues(plan)[0]!.message, /仅在.*预留/);
  const before = await readFile(join(f.root, `plans/${f.title}.json`), "utf8");
  await assert.rejects(() => f.save.execute({ title: f.title, strict: true, outline: plan.outline }, f.ctx), /missing-required-visit/);
  assert.equal(await readFile(join(f.root, `plans/${f.title}.json`), "utf8"), before);
  const reservedState = updateTravelStateFromSnapshot(undefined, { itinerary: plan, report: validateItinerary(plan), file: "unused" });
  assert.match(planningGuidance({ ...reservedState, brief: { title: f.title, destination: "杭州", mustVisit: [exhibit], avoid: [] } })!, /必去目标兜底/);
  await f.save.execute({ title: f.title, days: [{ date, items: [visit("main", museum)] }] }, f.ctx);
  plan = await f.load(); goal = plan.required_visit_goals![0]!;
  assert.equal(goal.status, "scheduled"); assert.equal(goal.relation, "scenic_child"); assert.equal(goal.identity_verified, true);
  assert.equal(requiredVisitIssues(plan).length, 0);
  await f.save.execute({ title: f.title, edits: [{ op: "move", date, to_date: next, item_id: "main" }] }, f.ctx);
  plan = await f.load(); goal = plan.required_visit_goals![0]!;
  assert.equal(goal.date, next); assert.equal(goal.item_id, "main"); assert.equal(goal.id, initial.id);
  const session = new Session(); session.setTravelState(updateTravelStateFromSnapshot(undefined, { itinerary: plan, report: validateItinerary(plan), file: "unused" }));
  const restored = Session.fromData(session.toData()).travelState!;
  assert.deepEqual(restored.itinerary?.requiredVisits, plan.required_visit_goals);
  assert.match(renderTravelState(restored)!, /主子景点/);
  const overview = await createLoadItineraryTool(f.root).execute({ title: f.title }, f.ctx);
  assert.match(overview, /必去目标.*已安排/s);
  await f.save.execute({ title: f.title, edits: [{ op: "remove", date: next, item_id: "main" }] }, f.ctx);
  plan = await f.load(); assert.equal(plan.required_visit_goals![0]!.status, "identified");
  assert.equal(requiredVisitIssues(plan).length, 1);
});

test("区域内独立地点能同日或跨日保存，主区域单向满足子必去，子点之间不能互相替代", async (t) => {
  const f = await fixture(t);
  await f.save.execute({ title: f.title, constraints: { destination: "杭州", must_visit: [garden] }, days: [{ date, items: [visit("tower", tower)] }, { date: next, items: [visit("garden", garden)] }] }, f.ctx);
  let plan = await f.load();
  assert.equal(plan.days[0]!.items[0]!.parent_visit, undefined);
  assert.equal(plan.days[0]!.items[0]!.area_group?.name, area);
  assert.equal(validateItinerary(plan).issues.some((i) => /duplicate|allocation-conflict/.test(i.code)), false);
  assert.equal(requiredVisitGoals({ ...plan, outline: undefined, days: [plan.days[0]!] })[0]!.status, "unresolved");
  await f.save.execute({ title: f.title, merge: false, constraints: { destination: "杭州", must_visit: [garden] }, outline: [{ date, visits: [{ name: area }] }], days: [{ date, items: [visit("area", area), visit("tower", tower, "13:00", "15:00")] }] }, f.ctx);
  plan = await f.load();
  assert.equal(plan.required_visit_goals![0]!.status, "scheduled");
  assert.equal(plan.required_visit_goals![0]!.covered_by, area);
  assert.equal(plan.required_visit_goals![0]!.relation, "geographic_area");
  assert.equal(requiredVisitIssues(plan).length, 0);
  const areaDay = { ...plan, days: [{ date, items: [f.evidence.bind(visit("a", area), "杭州"), f.evidence.bind(visit("t", tower, "13:00", "14:00"), "杭州"), f.evidence.bind(visit("g", garden, "15:00", "16:00"), "杭州")] }] };
  assert.equal(computeItineraryMetrics(areaDay, { expectedDays: 1 }).visitsPerDay, 1);
  assert.ok(checkRequirements(areaDay, { max_visits_per_day: 1 }).every((check) => check.passed));
});

test("模型自填台账、推荐文字和包含关系不能伪造必去满足，无有效时长也不算完成", async (t) => {
  const f = await fixture(t);
  await f.save.execute({ title: f.title, constraints: { destination: "杭州", must_visit: [garden] },
    required_visit_goals: [{ id: "forged", name: garden, status: "scheduled", identity_verified: true }],
    days: [{ date, items: [{ ...visit("museum", museum), recommended_spots: [garden], covered_visits: [{ name: garden, evidence_id: "fake", relation: "geographic_area" }] }] }],
  }, f.ctx);
  const plan = await f.load();
  assert.notEqual(plan.required_visit_goals![0]!.id, "forged");
  assert.equal(plan.required_visit_goals![0]!.status, "identified");
  assert.equal(requiredVisitIssues(plan).length, 1);
  const untimed = { ...plan, days: [{ date, items: [{ id: "garden", type: "visit" as const, name: garden }] }] };
  assert.equal(requiredVisitGoals(untimed)[0]!.status, "unresolved");
  assert.equal(requiredVisitIssues(untimed).length, 1);
  const unknown = requiredVisitGoals({ ...plan, constraints: { must_visit: ["未取证景点"] } })[0]!;
  assert.equal(unknown.status, "unresolved"); assert.equal(unknown.identity_verified, false);
});

test("主点覆盖子目标时仍报告真实闭园、可用时窗及缺路线问题", async (t) => {
  const f = await fixture(t);
  const bound = f.evidence.bind(visit("main", museum, "17:00", "19:00"), "杭州", date);
  const plan = parseItinerary({ title: f.title, constraints: { destination: "杭州", must_visit: [exhibit], require_routes: true }, days: [{ date, available_start: "09:00", available_end: "18:00", items: [bound, { id: "route", type: "transport", name: "前往展馆", from: garden, to: museum, transport_mode: "walking", time: "16:00", end_time: "17:00" }] }] });
  assert.equal(requiredVisitIssues(plan).length, 0);
  const codes = validateItinerary(plan).issues.map((i) => i.code);
  assert.ok(codes.includes("outside-opening-hours")); assert.ok(codes.includes("outside-day-window")); assert.ok(codes.includes("unverified-route"));
});

test("区域分组保留独立子点，馆内子点归并；多层关系覆盖不丢失，歧义与循环不猜测", async (t) => {
  const f = await fixture(t);
  const groups = groupScenicAttractions([{ poi: { id: "a", name: area } }, { poi: { id: "t", name: tower, parent: "a" } }, { poi: { id: "g", name: garden, parent: "a" } }, { poi: { id: "m", name: museum } }, { poi: { id: "e", name: exhibit, parent: "m" } }]);
  assert.deepEqual(groups.map((g) => g.main.poi.name), [area, tower, garden, museum]);
  assert.deepEqual(groups[0]!.area_spots, [tower, garden]); assert.equal(groups[1]!.area_group, area);
  assert.deepEqual(groups[3]!.spots, [exhibit]);
  const typedArea = groupScenicAttractions([{ poi: { id: "area", name: "滨江旅游带", type: "地名地址信息;普通地名" } }, { poi: { name: "滨江展馆", parent: "area" } }]);
  assert.equal(typedArea.length, 2); assert.equal(typedArea[1]!.area_group, "滨江旅游带");
  await f.evidence.observePlaces("search_attractions", "杭州", `${area} | 坐标 30.2200,120.1400`, "amap", [{ parent: area, children: [], relation: "geographic_area" }]);
  assert.ok(f.evidence.coveredVisits(area, "杭州").some((v) => v.name === garden));
  await f.evidence.observePlaces("search_attractions", "杭州", `${area} | 坐标 30.2200,120.1400`, "amap", [{ parent: area, children: [museum, exhibit], relation: "geographic_area" }]);
  assert.equal(f.evidence.parentVisit(exhibit, "杭州")?.name, museum);
  assert.equal(f.evidence.areaGroup(exhibit, "杭州")?.name, area);
  assert.ok(f.evidence.coveredVisits(area, "杭州").some((v) => v.name === exhibit && v.relation === "geographic_area"));
  await f.evidence.observePlaces("search_attractions", "杭州", `${garden} | 坐标 30.2220,120.1400`, "amap", [{ parent: garden, children: [exhibit] }]);
  assert.equal(f.evidence.parentVisit(exhibit, "杭州"), undefined);
  assert.equal(f.evidence.coveredVisits(museum, "杭州").some((v) => v.name === exhibit), false);
  const loop = new TravelEvidenceStore();
  await loop.observePlaces("search_attractions", "杭州", "甲馆 | 坐标 30.1000,120.1000\n乙馆 | 坐标 30.1100,120.1100", "amap", [{ parent: "甲馆", children: ["乙馆"] }, { parent: "乙馆", children: ["甲馆"] }]);
  assert.equal(loop.coveredVisits("甲馆", "杭州").length, 0);
});

test("旧行程无需修改历史文件即可按当前证据补台账和区域关系", async (t) => {
  const f = await fixture(t);
  const old = parseItinerary({ title: f.title, constraints: { destination: "杭州", must_visit: [garden] }, days: [{ date, items: [{ ...visit("area", area), evidence_verified: true, parent_visit: { name: "旧错误归属" } }] }] });
  const refreshed = await itineraryWithBriefRequirements(f.root, old);
  assert.equal(refreshed.required_visit_goals![0]!.status, "scheduled");
  assert.equal(refreshed.required_visit_goals![0]!.relation, "geographic_area");
  assert.equal(refreshed.days[0]!.items[0]!.parent_visit, undefined);
  assert.equal(old.days[0]!.items[0]!.parent_visit?.name, "旧错误归属");
});
