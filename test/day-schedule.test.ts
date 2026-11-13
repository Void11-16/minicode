import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveItineraryTool, inspectItinerary } from "../src/tools/itinerary.ts";
import { buildDaySchedule } from "../src/tools/day-schedule.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { normalizeToolArguments, validateToolArguments } from "../src/tools/tool-contract.ts";
import { activeDayTask, selectDayTask, dayTaskScope, setDayTasks } from "../src/core/day-tasks.ts";
import { updateTravelStateFromBrief, updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";
import { pendingDayRouteRequests, pendingRouteRepairs } from "../src/agent/travel-finalization.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider } from "../src/llm/provider.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";

const date = "2026-11-12", next = "2026-11-13", title = "程序排程";
async function fixture(t: TestContext, stays?: { require_accommodation: true; allow_hotel_changes?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "day-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root), save = createSaveItineraryTool(root), ctx = { workspace: root, evidence };
  await evidence.observePlaces("search_attractions", "杭州", "甲园 | 坐标 30.2000,120.1000\n乙园 | 坐标 30.2100,120.1000\n丙园 | 坐标 30.2200,120.1000", "amap");
  await save.execute({ title, constraints: { destination: "杭州", start_date: date, end_date: next, expected_days: 2, require_routes: true, ...stays },
    outline: [{ date, visits: [{ name: "甲园" }, { name: "乙园" }] }, { date: next, visits: [{ name: "丙园" }] }] }, ctx);
  const file = join(root, "plans", title + ".json"), load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const route = async (duration: number, mode = "transit") => evidence.observeRoutes([{ city: "杭州", from: "甲园", to: "乙园", duration_min: duration, mode, request_mode: mode, distance_km: 2, estimated: false,
    from_point: evidence.point("甲园", "杭州")!, to_point: evidence.point("乙园", "杭州")! }]);
  return { root, evidence, save, ctx, file, load, route };
}
test("已选的唯一酒店可补到已保存日期，保留内部交通方式和其他日程", async (t) => {
  const f = await fixture(t, { require_accommodation: true });
  const hotel = "甲酒店";
  await f.evidence.observePlaces("search_stays", "杭州", `${hotel} | 坐标 30.1900,120.1000`, "amap");
  await f.save.execute({ title, schedule: { date, mode: "transit", leg_modes: ["walking"] } }, f.ctx);
  assert.ok(!(await f.load()).days[0]!.items.some((item) => item.type === "accommodation"), "酒店搜索结果尚未选中");
  await f.save.execute({ title, schedule: { date: next, start_place: hotel, end_place: hotel } }, f.ctx);
  const before = await f.load();
  assert.ok(pendingRouteRepairs({ ...inspectItinerary(before, f.evidence), file: f.file }, f.evidence).some((repair) => repair.date === date && repair.stay));
  await f.save.execute({ title, repair_routes: [date] }, { ...f.ctx, dayPlanningScope: { title, date, layer: "schedule", locked_dates: [next] } });
  const after = await f.load();
  assert.deepEqual(after.days[1], before.days[1]);
  assert.deepEqual(after.days[0]!.items.filter((item) => item.type === "visit").map(({ id, name, planned_duration_min }) => [id, name, planned_duration_min]),
    before.days[0]!.items.filter((item) => item.type === "visit").map(({ id, name, planned_duration_min }) => [id, name, planned_duration_min]));
  assert.deepEqual(after.days[0]!.items.filter((item) => item.type === "transport").map((item) => item.transport_mode), ["transit", "walking", "transit"]);
  assert.deepEqual(after.days[0]!.items.filter((item) => item.type === "accommodation").map((item) => item.name), [hotel, hotel]);
  assert.ok(!validateItinerary(after).issues.some((issue) => issue.code === "missing-accommodation"));
  const departure = { ...before, days: [{ ...before.days[0]!, day_type: "departure" as const }, before.days[1]!] };
  assert.ok(!buildDaySchedule(departure, { date }, f.evidence).items.some((item) => item.type === "accommodation"));
});

test("末日可只退房和到站，沿用上晚酒店且不增加住宿费或凑满下午", async (t) => {
  const f = await fixture(t, { require_accommodation: true });
  const hotel = "甲酒店", station = "杭州东站";
  await f.evidence.observePlaces("search_stays", "杭州", `${hotel} | 参考价 ¥90 | 坐标 30.1900,120.1000`, "amap");
  await f.save.execute({ title, schedule: { date, start_place: hotel, end_place: hotel } }, f.ctx);
  const before = await f.load();
  const brief = updateTravelStateFromBrief(undefined, { title, destination: "杭州", startDate: date, endDate: next, durationDays: 2, requireAccommodation: true, travelers: 1, budgetTotalYuan: 400 }).brief;
  await f.evidence.observeRoutes([{ city: "杭州", from: hotel, to: station, mode: "transit", duration_min: 45, distance_km: 8, estimated: false,
    from_point: f.evidence.point(hotel, "杭州")!, to_point: { latitude: 30.289, longitude: 120.213, crs: "gcj02" } }]);
  await f.save.execute({ title, schedule: { date: next, visits: [], return_station: station } }, { ...f.ctx, brief });
  const after = await f.load(), last = after.days.at(-1)!;
  assert.deepEqual(after.days[0]!.items, before.days[0]!.items);
  assert.equal(last.day_type, "departure");
  assert.deepEqual(last.items.map((item) => [item.type, item.name, item.time, item.end_time, item.stay_nights]), [
    ["accommodation", hotel, "12:00", undefined, 0], ["transport", `${hotel} → ${station}`, "12:00", "12:45", undefined],
  ]);
  const report = validateItinerary(after);
  assert.equal(after.planning_layers?.scheduled_days, 2);
  assert.equal(report.budget?.categories.find((category) => category.label === "住宿")?.recorded, 90);
  assert.equal(report.issues.some((issue) => issue.day === 2 && issue.level === "P1"), false);
  assert.ok(validateItinerary({ ...after, days: [after.days[0]!, { ...last, available_end: "12:15" }] }).issues.some((issue) => issue.day === 2 && issue.code === "outside-day-window"));
  assert.match(last.items.at(-1)?.note ?? "", /确认班次和进站提前量/);
  assert.match(await readFile(join(f.root, "plans", title + ".md"), "utf8"), new RegExp(`${next}：仅安排返程`));
  await f.save.execute({ title, schedule: { date: next, start: "12:00", visits: [], return_station: station, available_end: "14:30" } }, { ...f.ctx, brief });
  await assert.rejects(f.save.execute({ title, schedule: { date: next, start: "14:00", visits: [], return_station: station } }, { ...f.ctx, brief }), /结束上限14:30/);
  await f.save.execute({ title, repair_routes: [next] }, { ...f.ctx, brief });
  assert.equal((await f.load()).days.at(-1)?.available_end, "14:30");
});

test("较晚选定固定酒店后，Agent可补已耗尽模型重试的住宿日", async (t) => {
  const f = await fixture(t, { require_accommodation: true, allow_hotel_changes: false });
  const hotel = "甲酒店";
  await f.evidence.observePlaces("search_stays", "杭州", `${hotel} | 坐标 30.1900,120.1000`, "amap");
  for (const name of ["甲园", "乙园", "丙园"]) await f.evidence.observeOpening("杭州", name, [], ["hours", "closure"]);
  for (const day of [date, next]) await f.save.execute({ title, schedule: { date: day } }, f.ctx);
  const session = new Session(); session.setTravelMode(true);
  const brief = updateTravelStateFromBrief(undefined, { title, destination: "杭州", startDate: date, endDate: next, durationDays: 2, requireAccommodation: true, allowHotelChanges: false, returnLastDay: false });
  session.setTravelState(updateTravelStateFromSnapshot(brief, { ...inspectItinerary(await f.load(), f.evidence), file: f.file }));
  let selected = false;
  const provider: ChatProvider = { name: "late-stay", chat: async () => "unused", async chatWithTools() {
    const task = activeDayTask(session.travelState);
    if (!selected && task?.date === next && task.layer === "schedule" && task.attempts === 2) {
      selected = true;
      return { type: "tool_calls", toolCalls: [{ id: "select-stay", name: "save_itinerary", arguments: JSON.stringify({ title, schedule: { date: next, start_place: hotel, end_place: hotel } }) }] };
    }
    return { type: "text", content: "已处理" };
  } };
  const registry = new ToolRegistry(f.root).register(f.save);
  await new ChatAgent(session, provider, registry, f.root).run("继续补齐行程", { maxToolRounds: 20 });
  const after = await f.load();
  assert.ok(selected);
  assert.ok(after.days.every((day) => day.items.some((item) => item.type === "accommodation" && item.name === hotel)));
  const first = session.travelState!.itinerary!.dayTasks!.find((task) => task.date === date && task.layer === "schedule");
  assert.equal(first?.attempts, 2);
});

test("日期模型重试耗尽后，Agent按已保存日程补查缺段并局部重算", async (t) => {
  const f = await fixture(t);
  await f.evidence.observePlaces("search_attractions", "杭州", "丁园 | 坐标 30.2300,120.1000", "amap");
  await f.route(20);
  await f.save.execute({ title, schedule: { date, mode: "transit", visits: ["甲园", "乙园", "丁园"].map((name) => ({ name, duration_min: 60 })) } }, f.ctx);
  await f.save.execute({ title, schedule: { date: next } }, f.ctx);
  const before = await f.load();
  const brief = updateTravelStateFromBrief(undefined, { title, destination: "杭州", startDate: date, endDate: next, durationDays: 2, requireAccommodation: false });
  const state = updateTravelStateFromSnapshot(brief, { ...inspectItinerary(before, f.evidence), file: f.file });
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxRounds: 10, maxCalls: 10 };
  const selected = selectDayTask(state, budget).state;
  const session = new Session(); session.setTravelMode(true);
  session.setTravelState(setDayTasks(selected, selected.itinerary!.dayTasks!.map((task) => ({ ...task, status: "blocked", attempts: 2 }))));
  const provider: ChatProvider = { name: "route-closeout", chat: async () => "unused", chatWithTools: async () => { throw new Error("收尾路线可以由程序处理"); } };
  const calls: unknown[] = [];
  const registry = new ToolRegistry(f.root).register(f.save).register({ ...createPlanRoutesTool(), async execute(args, ctx) {
    calls.push(args.stops);
    const evidence = ctx!.evidence!;
    await evidence.observeRoutes([{ city: "杭州", from: "乙园", to: "丁园", mode: "transit", duration_min: 35, distance_km: 3, estimated: false,
      from_point: evidence.point("乙园", "杭州")!, to_point: evidence.point("丁园", "杭州")! }]);
    return "已查路线";
  } });
  await new ChatAgent(session, provider, registry, f.root).run("继续完成行程", { maxToolRounds: 10, cumulativeBudget: budget });
  const after = await f.load();
  assert.deepEqual(calls, [["乙园", "丁园"]]);
  assert.equal(budget.calls, 2);
  assert.deepEqual(after.days[1], before.days[1]);
  assert.equal(after.days[0]!.items.find((item) => item.to === "丁园")?.route_duration_min, 35);
  assert.ok(after.days[0]!.items.filter((item) => item.type === "transport").every((item) => item.route_verified));
});
test("无开放/路线证据也生成完整时间线，待确认不冒充strict通过", async (t) => {
  const f = await fixture(t);
  for (const day of [date, next]) await f.save.execute({ title, schedule: { date: day } }, f.ctx);
  const plan = await f.load();
  assert.equal(plan.days.length, 2);
  assert.equal(validateItinerary(plan).issue_count.P0, 0);
  const day = plan.days[0]!, transport = day.items.find((item) => item.type === "transport")!;
  assert.equal(day.items.filter((item) => item.type === "visit").length, 2);
  assert.ok(day.items.some((item) => item.type === "rest" && item.name.includes("午餐")));
  assert.notEqual(transport.route_verified, true);
  assert.equal(transport.route_evidence_id, undefined);
  assert.ok(validateItinerary(plan).issues.some((issue) => issue.code === "unverified-route"));
  assert.ok(day.items.every((item) => item.id && item.name && item.time));
});
test("查路线后重算本日，稳定ID/游览时长/其他日期保持，不能跨方式借证据", async (t) => {
  const f = await fixture(t);
  await f.route(5, "driving");
  for (const day of [date, next]) await f.save.execute({ title, schedule: { date: day, mode: "transit" } }, f.ctx);
  const before = await f.load();
  assert.notEqual(before.days[0]!.items.find((item) => item.type === "transport")?.route_verified, true);
  assert.deepEqual(pendingDayRouteRequests(before.days[0]!, "杭州", f.evidence)[0]?.args,
    { city: "杭州", stops: ["甲园", "乙园"], mode: "transit", leg_modes: ["transit"] });
  const [route] = await f.route(60);
  assert.deepEqual(pendingDayRouteRequests(before.days[0]!, "杭州", f.evidence), []);
  await f.save.execute({ title, repair_routes: [date] }, f.ctx);
  const after = await f.load(), transport = after.days[0]!.items.find((item) => item.type === "transport")!;
  assert.equal(transport.route_evidence_id, route!.id); assert.equal(transport.route_verified, true);
  assert.equal(transport.planned_duration_min, 60);
  assert.deepEqual(after.days[1], before.days[1]);
  assert.deepEqual(after.days[0]!.items.map((item) => item.id), before.days[0]!.items.map((item) => item.id));
  assert.ok(after.days[0]!.items.filter((item) => item.type === "visit").every((item) => item.planned_duration_min === 120));
});
test("末日已知闭馆时仍进入排程任务，可原子提交同日替代并保留已保存日期", async (t) => {
  const f = await fixture(t);
  await f.save.execute({ title, schedule: { date } }, f.ctx);
  await f.evidence.observeOpening("杭州", "丙园", [{ title: "丙园闭园公告", snippet: "2026-11-13临时闭馆", kind: "official", content_kind: "page", url: "https://example.test/notice" }], ["notices"]);
  const before = await f.load(), snapshot = inspectItinerary(before, f.evidence);
  assert.equal(snapshot.itinerary.planning_layers?.days[1]?.feasibility, "conflict");
  const brief = updateTravelStateFromBrief(undefined, { title, destination: "杭州", startDate: date, endDate: next, durationDays: 2 });
  const state = updateTravelStateFromSnapshot(brief, { ...snapshot, file: f.file });
  const selected = selectDayTask(state, { rounds: 0, calls: 0, tokens: 0, maxRounds: 20, maxCalls: 40, maxTokens: 100000 });
  assert.equal(selected.task?.date, next);
  assert.equal(selected.task?.layer, "schedule");
  const ctx = { ...f.ctx, dayPlanningScope: dayTaskScope(selected.state, next) };
  await assert.rejects(() => f.save.execute({ title, schedule: { date: next } }, ctx), /已核验的闭馆/);
  assert.deepEqual(await f.load(), before);
  await f.save.execute({ title, schedule: { date: next, visits: [{ name: "丁园" }] } }, ctx);
  const after = await f.load();
  assert.deepEqual(after.days[0], before.days[0]);
  assert.equal(after.outline?.[1]?.visits[0]?.name, "丁园");
  assert.equal(after.days[1]?.items[0]?.name, "丁园");
});
test("路线超时/固定预约冲突拒绝候选，正式文件逐字保留", async (t) => {
  const f = await fixture(t);
  await f.save.execute({ title, schedule: { date, visits: [{ name: "甲园", duration_min: 120 }, { name: "乙园", at: "14:00", duration_min: 120 }] } }, f.ctx);
  const before = await readFile(f.file, "utf8");
  await f.route(180);
  await assert.rejects(() => f.save.execute({ title, repair_routes: [date] }, f.ctx), /固定14:00/);
  assert.equal(await readFile(f.file, "utf8"), before);
  await assert.rejects(() => f.save.execute({ title, schedule: { date, visits: [{ name: "甲园", duration_min: 700 }, { name: "乙园" }] } }, f.ctx), /剩余/);
  await assert.rejects(() => f.save.execute({ title, schedule: { date, visits: [{ name: "甲园" }, { name: "乙园" }, { name: "甲园" }] } }, f.ctx), /甲园.*重复选中/);
  assert.equal(await readFile(f.file, "utf8"), before);
});
test("修改粗排只标记本日草稿，不删除已交付日程，也不退回全局粗排", async (t) => {
  const f = await fixture(t);
  await f.save.execute({ title, schedule: { date } }, f.ctx);
  const before = await f.load();
  await f.save.execute({ title, outline: [{ date, visits: [{ name: "丁园" }] }] }, { ...f.ctx, dayPlanningScope: { title, date, layer: "feasibility", locked_dates: [] } });
  const after = await f.load(); assert.deepEqual(after.days, before.days);
  assert.equal(after.planning_layers?.days[0]?.schedule, "draft");
  assert.equal(after.planning_layers?.basic_days, 2);
});
test("日期独立时间窗与已知开放时间驱动排程，固定开始时刻不可顺延", async (t) => {
  const f = await fixture(t), plan = await f.load();
  await f.evidence.observeOpening("杭州", "甲园", [{ title: "甲园参观须知", snippet: "开放时间14:00-18:00", kind: "official", content_kind: "page", url: "https://example.test/hours" }], ["hours"]);
  const day = buildDaySchedule({ ...plan, constraints: { ...plan.constraints, requirements: { day_windows: [{ day: 1, start: "13:00", end: "17:00" }] } } }, { date, visits: [{ name: "甲园", duration_min: 60 }] }, f.evidence);
  assert.equal(day.items.find((item) => item.type === "visit")?.time, "14:00");
  assert.ok(day.items.every((item) => item.time! >= "13:00" && (item.end_time ?? item.time)! <= "17:00"));
  assert.throws(() => buildDaySchedule(plan, { date, visits: [{ name: "甲园", duration_min: 60, at: "10:00" }] }, f.evidence), /开放时间/);
});
test("杭州回归：休息/自由活动只有note时补展示名，景点缺名仍拒绝", () => {
  const tool = createSaveItineraryTool();
  const { args } = normalizeToolArguments("save_itinerary", { title, days: [{ date, items: [{ type: "rest", note: "午餐午休", time: "12:00", end_time: "13:00" }, { type: "free_time", note: "湖边散步", time: "13:00", end_time: "14:00" }] }] });
  validateToolArguments(tool.parameters, args);
  assert.equal(parseItinerary(args).days[0]!.items[0]!.name, "午餐午休");
  assert.throws(() => validateToolArguments(tool.parameters, normalizeToolArguments("save_itinerary", { title, days: [{ date, items: [{ type: "visit", note: "猜一个景点" }] }] }).args));
});
