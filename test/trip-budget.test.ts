import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBudget } from "../src/core/execution-budget.ts";
import { selectDayTask } from "../src/core/day-tasks.ts";
import { derivePlanningLayers } from "../src/core/planning-layers.ts";
import { Session } from "../src/core/session.ts";
import { updateTravelStateFromSnapshot, type TravelState } from "../src/core/travel-state.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { briefBudgetPlan, createSaveTravelBriefTool, type TravelBrief } from "../src/tools/brief.ts";
import { createFoodTool } from "../src/tools/food.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { createStayTool } from "../src/tools/stay.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { assessToolBudget } from "../src/runtime/tool-budget.ts";

const dates = ["2026-11-13", "2026-11-14", "2026-11-15"];
const title = "单人杭州三日游";
const brief: TravelBrief = { title, destination: "杭州", durationDays: 3, startDate: dates[0], endDate: dates[2], travelers: 1, budgetTotalYuan: 1500 };

test("需求单先分配预算，酒店、餐饮和景点查询继承相应的人均或每房额度", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "trip-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let saved: TravelBrief | undefined;
  const saveBrief = createSaveTravelBriefTool(root);
  const output = await saveBrief.execute({ ...brief, budgetOverrunRatio: 0 }, {
    workspace: root, userRequests: [{ id: "initial", content: "我一个人去杭州三天，总预算1500元。" }], onBrief: (value) => { saved = value; },
  });
  assert.ok(saved);
  assert.match(output, /住宿 ¥600.*通勤 ¥225.*餐饮 ¥450.*景点 ¥225/);
  assert.match(output, /可接受上限 ¥1800/);
  const registry = new ToolRegistry(root);
  const inputs: Record<string, unknown>[] = [];
  for (const tool of [createStayTool(), createFoodTool(), createAttractionsTool()]) {
    registry.register({ ...tool, usesDiscoveryPool: false, async execute(args) { inputs.push(args); return "测试候选"; } });
  }
  const context = { workspace: root, destination: "杭州", brief: { ...saved, mustVisit: [], avoid: [] } };
  await registry.execute("search_stays", '{"city":"杭州"}', context);
  await registry.execute("search_restaurants", '{"city":"杭州","max_cost":100}', context);
  await registry.execute("search_attractions", '{"location":"杭州","city":"杭州"}', context);
  assert.deepEqual(inputs.map((args) => args.max_room_price ?? args.max_cost ?? args.max_visit_cost), [300, 75, 75]);
  assert.equal(briefBudgetPlan({ ...brief, budgetTotalYuan: 4500, travelers: 3, roomCount: 2 })?.roomPerNight, 450);
  const economy = briefBudgetPlan({ ...brief, budgetTotalYuan: 600 });
  assert.equal(economy?.economy, true);
  assert.equal(economy?.roomPerNight, 90);
  const economyContext = { ...context, travelMode: true, brief: { ...context.brief, budgetTotalYuan: 600 } };
  await registry.execute("search_stays", '{"city":"杭州"}', economyContext);
  await registry.execute("search_attractions", '{"location":"杭州","city":"杭州"}', economyContext);
  assert.deepEqual([inputs[3]?.economy, inputs[3]?.max_room_price, inputs[4]?.min_rating], [true, 90, 0]);
  assert.match(await saveBrief.execute({ ...brief }, {
    workspace: root, userRequests: [{ id: "hard-cap", content: "我一个人去杭州三天，预算不超过1500元。" }],
  }), /可接受上限 ¥1500/);
});

test("预算包含未知价格的准备金，1800元可以接受，超出一分钱进入修订", () => {
  const unpriced = parseItinerary({ title, travelers: 1, budget_per_person_yuan: 1500, constraints: { expected_days: 3 },
    days: dates.map((date) => ({ date, items: [{ type: "visit", name: date, time: "10:00", end_time: "12:00" }] })) });
  assert.deepEqual([validateItinerary(unpriced).budget?.recorded, validateItinerary(unpriced).budget?.projected], [0, 1500]);
  const priced = parseItinerary({ ...unpriced, days: dates.map((date, index) => ({ date, items: [
    { type: "accommodation", name: "甲酒店", stay_nights: 0, room_price_per_night: 300 },
    { type: "accommodation", name: "甲酒店", stay_nights: index < 2 ? 1 : 0, room_price_per_night: 300 },
    { type: "visit", name: date, ticket_price_per_person: 150 },
    { type: "transport", name: "通勤", cost_per_person: 100 },
    { type: "meal", name: "午餐甲", subtype: "lunch", cost_per_person: 70 },
    { type: "meal", name: "午餐乙", subtype: "lunch", cost_per_person: 80 },
    { type: "meal", name: "晚餐", subtype: "dinner", cost_per_person: 75 },
  ] })) });
  const report = validateItinerary(priced);
  assert.deepEqual([report.budget?.recorded, report.budget?.estimated, report.budget?.status], [1800, 0, "within_tolerance"]);
  assert.equal(report.issues.some((issue) => issue.code === "budget-exceeded"), false);
  const costlier = { ...priced, days: priced.days.map((day, index) => index > 0 ? day : { ...day, items: day.items.map((item) => item.type === "visit" ? { ...item, ticket_price_per_person: 150.01 } : item) }) };
  assert.equal(validateItinerary(costlier).issues.some((issue) => issue.code === "budget-exceeded"), true);
  assert.equal(validateItinerary({ ...priced, budget_overrun_ratio: 0 }).budget?.status, "over_limit");
});

test("预算补充任务只修改缺候选的日期，保存已查餐厅后重算估算与记录金额", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "trip-budget-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = createSaveItineraryTool(root);
  const registry = new ToolRegistry(root);
  const first = dates[0]!;
  const restaurant = "测试食堂";
  await registry.evidence.observePlaces("search_restaurants", "杭州", `1. ${restaurant} | 评分 4.5 | 人均 ¥50 | 坐标 30.2500,120.1600`, "amap");
  const initial = parseItinerary({ title, travelers: 1, budget_per_person_yuan: 1500, constraints: { expected_days: 3, destination: "杭州" },
    days: dates.map((date) => ({ date, items: [{ id: date, type: "visit", name: date, time: "10:00", end_time: "13:00" }] })) });
  const initialReport = validateItinerary(initial);
  const state: TravelState = updateTravelStateFromSnapshot({ brief: { ...brief, mustVisit: [], avoid: [] }, places: [], updatedAt: 0 }, { file: "", itinerary: { ...initial, planning_layers: derivePlanningLayers(initial, initialReport,
    (visit) => ({ name: visit.name, identity_verified: true, checked: true, pending: [], conflicts: [], evidence_ids: [] })) }, report: initialReport });
  const ready = { ...state, itinerary: { ...state.itinerary!, dayTasks: state.itinerary!.dayTasks?.map((task) => task.layer === "budget" ? task : { ...task, status: "saved" as const }) } };
  // The report still drives readiness. Budget work must be available when regular scheduling is done.
  const reconciled = { ...ready, itinerary: { ...ready.itinerary, planningLayers: { ...ready.itinerary.planningLayers!, days: ready.itinerary.planningLayers!.days.map((day) => ({ ...day, schedule: "ready" as const })) } } };
  const session = new Session();
  const selected = selectDayTask(reconciled, createExecutionBudget(session));
  assert.equal(selected.task?.layer, "budget");
  assert.equal(selected.task?.date, first);
  const context = { workspace: root, evidence: registry.evidence };
  await save.execute({ ...initial, merge: false }, context);
  const file = join(root, "plans", title + ".json");
  const before = parseItinerary(JSON.parse(await readFile(file, "utf8")));
  session.setTravelState(selected.state);
  session.add("assistant", "", { toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify({ title }) }] });
  session.add("tool", `${file}（结构化数据）`, { toolCallId: "save", toolName: "save_itinerary" });
  const assessment = await assessToolBudget({ session, rootDir: root, initialLimit: 20, currentLimit: 20, ceiling: 30, extensionStep: 5 });
  assert.equal(assessment.quality.strict_pass, true);
  assert.equal(assessment.repair.canImprove, true);
  assert.ok(assessment.repair.items.some((item) => item.code === "budget-selection-pending" && item.day === 1));
  await save.execute({ title, days: [{ date: first, items: [{ type: "meal", subtype: "lunch", name: restaurant }] }] }, {
    ...context, dayPlanningScope: { title, date: first, layer: "budget", day_number: 1, locked_dates: dates.slice(1) },
  });
  const after = parseItinerary(JSON.parse(await readFile(file, "utf8")));
  assert.deepEqual(after.days.slice(1), before.days.slice(1));
  const meal = after.days[0]?.items.find((item: ItineraryItem) => item.type === "meal");
  assert.equal(meal?.cost_per_person, 50);
  const budget = validateItinerary(after).budget!;
  assert.equal(budget.recorded, 50);
  assert.equal(budget.days[0]?.gaps.includes("补午餐候选"), false);
  assert.equal(budget.days[0]?.gaps.includes("补晚餐候选"), true);
});
