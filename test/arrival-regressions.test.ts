import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { createSaveItineraryTool, itineraryWithBriefRequirements } from "../src/tools/itinerary.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { sameVisit } from "../src/tools/itinerary-planning.ts";
import { requiredVisitMatches } from "../src/tools/required-visits.ts";
import { groupScenicAttractions, scenicParentName } from "../src/tools/scenic-area.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { Session } from "../src/core/session.ts";
import { renderTravelState, updateTravelStateFromBrief } from "../src/core/travel-state.ts";

test("一日往返不凭默认策略强制住宿，显式过夜与多日需求仍保留检查，旧行程复验同口径", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arrival-stay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const brief = createSaveTravelBriefTool(root), save = createSaveItineraryTool(root);
  for (const [title, durationDays, flag, expected] of [
    ["北京一日游", 1, undefined, false], ["一日但当晚住店", 1, true, true],
    ["两日每天返家", 2, false, false], ["默认两日游", 2, undefined, true],
  ] as const) {
    await brief.execute({ title, destination: "北京", durationDays, ...(flag === undefined ? {} : { requireAccommodation: flag }) });
    await save.execute({ title, days: [{ date: "2026-11-14", available_start: "13:00", available_end: "20:00", items: [{ type: "visit", name: "天坛公园", time: "14:00", end_time: "17:00" }] }] });
    const plan = parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8")));
    assert.equal(plan.constraints?.require_accommodation, expected, title);
    assert.equal(validateItinerary(plan).issues.some((issue) => issue.code === "missing-accommodation"), expected, title);
    const reviewed = await itineraryWithBriefRequirements(root, { ...plan, constraints: { ...plan.constraints, require_accommodation: !expected } });
    assert.equal(reviewed.constraints?.require_accommodation, flag !== undefined || durationDays === 1 ? expected : !expected, title);
  }
  await assert.rejects(() => brief.execute({ title: "坏需求", destination: "北京", requireAccommodation: "false" }), /布尔/);
});

test("不住宿要求在 Session 持久化与状态卡中保留", () => {
  const state = updateTravelStateFromBrief(undefined, { title: "北京一日游", destination: "北京", durationDays: 1, requireAccommodation: false });
  const session = new Session(); session.setTravelState(state);
  const restored = Session.fromData(session.toData()).travelState;
  assert.equal(restored?.brief?.requireAccommodation, false);
  assert.match(renderTravelState(restored)!, /不要求住宿/);
});

test("片区前缀不让独立场馆跨日误撞，短名称匹配真实场馆且不能以子点替代主景区", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arrival-quzhou-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root);
  const names = ["衢州古城文化旅游区孔氏南宗家庙", "衢州古城文化旅游区水亭门历史文化街区", "衢州古城文化旅游区衢州博物馆"];
  await evidence.observePlaces("search_attractions", "衢州", names.map((name, i) => `${i + 1}. ${name} | 坐标 ${(28.96 + i * .001).toFixed(4)},118.8700`).join("\n"), "amap");
  const title = "衢州两日游";
  await createSaveTravelBriefTool(root).execute({ title, destination: "衢州", durationDays: 2, mustVisit: ["衢州孔氏南宗家庙"] });
  const save = createSaveItineraryTool(root), ctx = { workspace: root, evidence };
  const output = await save.execute({ title, outline: [
    { date: "2026-11-14", visits: [{ name: "衢州孔氏南宗家庙" }, { name: names[1] }] },
    { date: "2026-11-15", visits: [{ name: names[2] }] },
  ] }, ctx);
  assert.match(output, /已保存/);
  let plan = parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8")));
  assert.equal(plan.outline?.[0]!.visits[0]!.name, names[0]);
  assert.equal(validateItinerary(plan).issues.some((issue) => issue.code === "visit-allocation-conflict"), false);
  await save.execute({ title, days: [{ date: "2026-11-14", items: [{ type: "visit", name: names[0], time: "14:30", end_time: "16:00" }] }] }, ctx);
  plan = parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8")));
  assert.equal(validateItinerary(plan).issues.some((issue) => issue.code === "missing-required-visit"), false);
  assert.equal(sameVisit({ name: names[0]! }, { name: names[2]! }, "衢州"), false);
  assert.equal(scenicParentName(names[0]!), undefined);
  assert.equal(requiredVisitMatches("衢州孔氏南宗家庙", names[0]!, "衢州"), true);
  assert.equal(requiredVisitMatches("衢州古城文化旅游区", names[0]!, "衢州"), false);
  assert.equal(requiredVisitMatches("故宫", "故宫博物院-大石雕", "北京"), false);
  assert.equal(sameVisit({ name: "故宫博物院" }, { name: "故宫博物院-大石雕" }, "北京"), true);
  await assert.rejects(() => save.execute({ title, outline: [
    { date: "2026-11-14", visits: [{ name: names[0] }] },
    { date: "2026-11-15", visits: [{ name: names[0] }] },
  ] }, ctx), /重复占用/);
});

test("古城与街区归纳为地理区域，不夺取独立地点的游览占用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arrival-district-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const district = "衢州古城文化旅游区", temple = district + "孔氏南宗家庙", street = district + "水亭门历史文化街区", tower = district + "天王塔";
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", "衢州", [temple, street, tower, district].map((name, i) => `${i + 1}. ${name} | 坐标 ${(28.96 + i * .001).toFixed(4)},118.8700`).join("\n"), "amap", [
    { parent: district, children: [temple, street] }, { parent: street, children: [tower] },
  ]);
  assert.equal(evidence.bind({ id: "t", type: "visit", name: temple }, "衢州").parent_visit, undefined);
  assert.equal(evidence.bind({ id: "s", type: "visit", name: street }, "衢州").parent_visit, undefined);
  assert.equal(evidence.bind({ id: "r", type: "visit", name: tower }, "衢州").parent_visit, undefined);
  assert.equal(evidence.bind({ id: "r", type: "visit", name: tower }, "衢州").area_group?.name, street);
  assert.equal(evidence.bind({ id: "t", type: "visit", name: temple }, "衢州").area_group?.name, district);
  const oldParent = { name: district, evidence_id: "district-id" };
  assert.equal(sameVisit({ name: temple, evidence_id: "temple", parent_visit: oldParent }, { name: street, evidence_id: "street", parent_visit: oldParent }, "衢州"), false);
  const groups = groupScenicAttractions([{ poi: { id: "district", name: district } }, { poi: { id: "temple", name: temple, parent: "district" } }, { poi: { id: "street", name: street, parent: "district" } }, { poi: { name: tower, parent: "street" } }]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.find((group) => group.main.poi.name === street)?.spots, []);
  assert.deepEqual(groups.find((group) => group.main.poi.name === street)?.area_spots, [tower]);
});
