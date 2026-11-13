import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSaveItineraryTool, refreshItineraryEvidence } from "../src/tools/itinerary.ts";
import { createLoadTravelBriefTool, createSaveTravelBriefTool, loadBriefForTitle } from "../src/tools/brief.ts";
import { parseItinerary, type ItineraryDay } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { activeDayTask, selectDayTask, dayTaskCallIssue } from "../src/core/day-tasks.ts";
import { updateTravelStateFromBrief, updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";

const dates = ["2026-11-10", "2026-11-11", "2026-11-12"];
const names = ["甲园", "乙园", "丙园", "丁园"];
const outline = dates.map((date, i) => ({ date, visits: [{ name: names[i] }] }));
const day = (i: number): ItineraryDay => ({ date: dates[i], items: [{ id: `v${i}`, type: "visit", name: names[i]!, time: "10:00", end_time: "18:00" }] });
const b = (): CumulativeToolBudget => ({ rounds: 0, calls: 0, tokens: 0, maxRounds: 100, maxCalls: 200, maxTokens: 2_000_000 });
const call = (name: string, args: Record<string, unknown>, id = name): LLMResult => ({ type: "tool_calls", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "planning-layers-")); t.after(() => rm(root, { recursive: true, force: true }));
  const title = "分层规划", registry = new ToolRegistry(root).register(createSaveItineraryTool(root)).register(createSaveTravelBriefTool(root));
  const evidence = registry.evidence;
  const seed = async () => evidence.observePlaces("search_attractions", "杭州", names.map((name, i) => `${name} | 坐标 ${(30.2 + i * .05).toFixed(4)},120.1000`).join("\n"), "amap");
  const info = async (name: string) => evidence.observeOpening("杭州", name, [{ title: name + "参观须知", snippet: "开放时间09:00-20:00，每周一闭园", kind: "official", url: "https://example.test/visit" }], ["hours", "closure"]);
  const file = join(root, `plans/${title}.json`), load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const constraints = { destination: "杭州", expected_days: 3, start_date: dates[0], end_date: dates[2], require_accommodation: false, require_routes: true, require_place_evidence: true, must_visit: [names[0]] };
  return { root, title, registry, evidence, seed, info, file, load, constraints, ctx: { workspace: root, evidence }, save: registry.get("save_itinerary")! };
}

test("基础层覆盖所有日期、必去与去重即可交付；无时间不冒充strict完成，未知资料保留", async (t) => {
  const f = await fixture(t); await f.seed();
  const output = await f.save.execute({ title: f.title, constraints: f.constraints, outline }, f.ctx);
  let plan = await f.load(); assert.equal(plan.days.length, 0); assert.equal(plan.planning_layers?.basic_days, 3); assert.equal(plan.planning_layers?.basic_complete, true);
  assert.equal(plan.planning_layers?.checked_days, 0); assert.equal(plan.planning_layers?.scheduled_days, 0); assert.match(output, /基础安排 3\/3/);
  const metrics = computeItineraryMetrics(plan, { expectedDays: 3, mustVisit: [names[0]!] }); assert.equal(metrics.basicDays, 3); assert.equal(metrics.days, 0); assert.ok(metrics.issueCounts.P1 > 0);
  const before = await readFile(f.file, "utf8");
  await assert.rejects(() => f.save.execute({ title: f.title, outline: [{ date: dates[0], visits: [{ name: names[0] }] }, { date: dates[1], visits: [{ name: names[0] }] }, outline[2]] }, f.ctx), /visit-allocation-conflict/);
  assert.equal(await readFile(f.file, "utf8"), before);
  await f.evidence.observeOpening("杭州", names[0]!, [], ["hours", "closure"]);
  plan = refreshItineraryEvidence(plan, f.evidence);
  assert.equal(plan.planning_layers?.checked_days, 1);
  assert.ok(plan.planning_layers!.days[0]!.visits[0]!.pending.length > 0, "已查无依据仍须显示待确认");
  assert.equal(plan.planning_layers?.basic_days, 3); assert.equal(plan.days.length, 0);
});

test("冻结门槛按日内验收：首次保存含P1只算草稿，可修复本日，其他日期逐字段保持", async (t) => {
  const f = await fixture(t); await f.seed(); for (const name of names) await f.info(name);
  const allocations = [{ date: dates[0], visits: [{ name: names[0] }, { name: names[1] }] }, { date: dates[1], visits: [{ name: names[2] }] }];
  await f.save.execute({ title: f.title, constraints: { ...f.constraints, expected_days: 2, end_date: dates[1] }, outline: allocations, days: [ { date: dates[0], items: [ { ...day(0).items[0], end_time: "12:00" }, { ...day(1).items[0], id: "second", time: "13:00" } ] }, { ...day(2), date: dates[1] } ] }, f.ctx);
  let plan = await f.load(); assert.equal(plan.planning_layers!.days[0]!.schedule, "draft"); assert.equal(plan.planning_layers!.days[1]!.schedule, "ready");
  const fixed = plan.days[1];
  await f.evidence.observeRoutes([{ city: "杭州", from: names[0]!, to: names[1]!, mode: "driving", duration_min: 20, distance_km: 5.5, estimated: false, from_point: f.evidence.point(names[0]!, "杭州"), to_point: f.evidence.point(names[1]!, "杭州") }]);
  await f.save.execute({ title: f.title, repair_routes: [dates[0]] }, { ...f.ctx, dayPlanningScope: { title: f.title, date: dates[0]!, layer: "schedule", locked_dates: [dates[1]!] } });
  plan = await f.load(); assert.equal(plan.planning_layers!.days[0]!.schedule, "ready"); assert.deepEqual(plan.days[1], fixed);
});

test("更换粗排让本日待重排，已有详细日程保留到替代通过", async (t) => {
  const f = await fixture(t); await f.seed(); for (const name of names) await f.info(name);
  await f.save.execute({ title: f.title, constraints: f.constraints, outline, days: [day(0), day(1), day(2)] }, f.ctx);
  const before = await f.load(); assert.equal(before.planning_layers?.ready_days, 3);
  await f.save.execute({ title: f.title, outline: [{ date: dates[0], visits: [{ name: names[3] }] }] }, { ...f.ctx, dayPlanningScope: { title: f.title, date: dates[0]!, layer: "feasibility", locked_dates: dates.slice(1) } });
  const after = await f.load(); assert.equal(after.outline?.length, 3); assert.equal(after.planning_layers!.days[0]!.schedule, "draft");
  assert.deepEqual(after.days, before.days); assert.equal(after.planning_layers?.ready_days, 2);
  assert.equal(after.planning_layers?.basic_complete, false, "变更不能悄悄清除必去要求");
});

test("真实Agent先落盘完整基础安排和时间线，再逐日核验；旧阶段过程不进入新层上下文", async (t) => {
  const f = await fixture(t), session = new Session(); session.setTravelMode(true);
  const phaseOrder: string[] = [];
  f.registry.register({ name: "search_attractions", alwaysActive: true, description: "test POI", parameters: { type: "object" }, execute: async () => { await f.seed(); return "旧阶段搜索过程-不应跨层携带"; } });
  f.registry.register({ name: "get_place_visit_info", alwaysActive: true, description: "test info", parameters: { type: "object" }, execute: async (args) => {
    const plan = await f.load(); assert.equal(plan.planning_layers?.basic_days, 3); assert.equal(plan.days.length, 3, "查开放前已保存所有日期的时间线");
    await f.info(String(args.place)); return "开放资料已记录";
  } });
  const provider: ChatProvider = { name: "layered-flow", chat: async () => { throw new Error("不需要额外收尾"); }, chatWithTools: async (history, tools) => {
    if (!session.travelState?.brief) return call("save_travel_brief", { title: f.title, destination: "杭州", startDate: dates[0], endDate: dates[2], durationDays: 3, mustVisit: [names[0]], requireAccommodation: false, requirements: { daily_window: { start: "10:00", end: "12:00" } } });
    if (!f.evidence.point(names[0]!, "杭州")) return call("search_attractions", { city: "杭州", location: "杭州" });
    if (!session.travelState.itinerary?.planningLayers?.basic_complete) { phaseOrder.push("basic"); assert.ok(!tools.some((tool) => tool.name === "get_place_visit_info")); return call("save_itinerary", { title: f.title, outline }); }
    const task = activeDayTask(session.travelState)!; assert.ok(task);
    phaseOrder.push(task.layer!); assert.ok(!history.some((message) => message.content.includes("旧阶段搜索过程-不应跨层携带")));
    if (task.layer === "feasibility") return call("get_place_visit_info", { place: names[dates.indexOf(task.date)], fields: ["hours", "closure"] }, `info-${task.date}`);
    return call("save_itinerary", { title: f.title, schedule: { date: task.date, mode: "walking" } }, `save-${task.date}`);
  } };
  const budget = b(); const reply = await new ChatAgent(session, provider, f.registry, f.root).run("规划杭州三天，甲园必去，活动在10:00到12:00之间", { cumulativeBudget: budget, maxToolRounds: 30 });
  assert.deepEqual(phaseOrder, ["basic", "schedule", "schedule", "schedule", "feasibility", "feasibility", "feasibility"]);
  const final = refreshItineraryEvidence(await f.load(), f.evidence); assert.equal(final.planning_layers?.basic_days, 3); assert.equal(final.planning_layers?.checked_days, 3); assert.equal(final.planning_layers?.ready_days, 3);
  assert.equal(validateItinerary(final).issue_count.P1, 0); assert.match(reply, /strict 通过/);
  assert.ok(session.travelState!.itinerary!.dayTasks!.filter((task) => task.layer === "schedule").every((task) => task.calls > 0), "最终保存也计入该层调用数");
  const restored = Session.fromData(session.toData()); assert.deepEqual(restored.travelState?.itinerary?.planningLayers, session.travelState?.itinerary?.planningLayers);
});

test("已识别地点的开放资料由宿主补查，日期任务共享完整需求版本", async (t) => {
  const f = await fixture(t);
  const session = new Session();
  session.setTravelMode(true);
  await f.seed();
  await f.info(names[0]!);
  f.registry.register(createLoadTravelBriefTool(f.root));
  const queried: string[] = [];
  f.registry.register({
    name: "get_place_visit_info", supportsRoutineVisitInfo: true, alwaysActive: true, description: "本地开放资料",
    parameters: { type: "object" },
    async execute(args) {
      assert.deepEqual(args.fields, ["hours"]);
      assert.equal(activeDayTask(session.travelState)?.layer, "feasibility");
      queried.push(String(args.place));
      await f.info(String(args.place));
      return "开放资料已记录";
    },
  });
  const requirements = { max_visits_per_day: 1, daily_window: { start: "10:00", end: "18:00" } };
  const request = {
    title: f.title, destination: "杭州", startDate: dates[0], endDate: dates[2],
    roomCount: 2, travelers: 3, travelerProfiles: ["同行人甲"], requireAccommodation: false,
    requirements, notes: "摄影优先",
  };
  const stays = names.map((name) => `${name}宾馆`);
  await f.evidence.observePlaces("search_stays", "杭州", stays.map((name, i) =>
    `${name} | 坐标 ${(30.2 + i * .05).toFixed(4)},120.1000`).join("\n"), "amap");
  const scheduled: string[] = [];
  const provider: ChatProvider = {
    name: "host-visit-checks",
    chat: async () => "unused",
    async chatWithTools(history, tools) {
      if (!session.travelState?.brief) return call("save_travel_brief", request);
      const brief = session.travelState.brief;
      assert.ok(brief.requirementVersion);
      assert.ok(!tools.some((tool) => tool.name === "load_travel_brief"));
      const context = history.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      for (const value of [brief.requirementVersion, "房数 2", "同行人甲", "摄影优先", "max_visits_per_day"]) assert.ok(context.includes(value), value);
      if (!session.travelState.itinerary?.planningLayers) return call("save_itinerary", { title: f.title, outline });
      const task = activeDayTask(session.travelState);
      assert.equal(task?.layer, "schedule", "已识别景点核验无需让模型中转");
      assert.equal(task.requirement_version, brief.requirementVersion);
      scheduled.push(task.date);
      const index = dates.indexOf(task.date);
      const date = day(index);
      return call("save_itinerary", { title: f.title, days: [{ ...date, items: [
        ...date.items, { type: "accommodation", name: stays[index], time: "18:00", room_count: 2 },
      ] }] });
    },
  };
  await new ChatAgent(session, provider, f.registry, f.root).run("规划杭州三天，活动在10:00至18:00", { cumulativeBudget: b(), maxToolRounds: 20 });
  assert.deepEqual(queried, [names[1], names[2]]);
  assert.deepEqual(scheduled, dates);
  const restored = Session.fromData(session.toData()).travelState!;
  const brief = await loadBriefForTitle(f.root, f.title);
  assert.equal(restored.brief?.requirementVersion, brief?.requirementVersion);
  assert.deepEqual(restored.brief?.requirements, requirements);
  assert.ok(restored.itinerary?.dayTasks?.every((task) => task.requirement_version === brief?.requirementVersion));
  assert.equal((await f.load()).planning_layers?.ready_days, 3);
});

test("核验任务拒绝超出声明范围的全局参数，整份行程与预算保持原样", async (t) => {
  const f = await fixture(t);
  await f.registry.get("save_travel_brief")!.execute({ title: f.title, destination: "杭州", budgetTotalYuan: 1000, travelers: 2 });
  await f.save.execute({ title: f.title, outline }, f.ctx);
  const before = await readFile(f.file, "utf8");
  await assert.rejects(() => f.save.execute({ title: f.title, outline: [outline[0]], budget_per_person_yuan: 1500 }, {
    ...f.ctx, dayPlanningScope: { title: f.title, layer: "feasibility", date: dates[0]!, locked_dates: dates.slice(1) },
  }), /DAY_TASK_FROZEN.*budget_per_person_yuan/);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.equal((await f.load()).budget_per_person_yuan, 500);
});

test("生产粗排检查禁去和上限，只有第二天落盘时仍使用第二天时间窗", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.registry.get("save_travel_brief")!.execute({
    title: f.title, destination: "杭州", startDate: dates[0], endDate: dates[2], requireAccommodation: false,
    requirements: { forbidden_visits: [names[3]], max_visits_per_day: 1, day_windows: [{ day: 2, start: "12:00", end: "18:00" }] },
  });
  const overpacked = [{ ...outline[0], visits: [{ name: names[0] }, { name: names[3] }] }, ...outline.slice(1)];
  await f.save.execute({ title: f.title, outline: overpacked }, f.ctx);
  const draft = await f.load();
  assert.equal(draft.planning_layers?.basic_days, 2);
  const roughIssues = validateItinerary(draft).issues;
  assert.ok(roughIssues.some((issue) => issue.code === "forbidden-visit" && issue.date === dates[0]));
  assert.ok(roughIssues.some((issue) => issue.code === "daily-visit-limit" && issue.date === dates[0]));
  await f.save.execute({ title: f.title, outline, days: [day(1)] }, f.ctx);
  const partial = await f.load();
  assert.equal(partial.days.length, 1);
  assert.equal(partial.planning_layers?.basic_days, 3);
  const windowIssue = validateItinerary(partial).issues.find((issue) => issue.code === "activity-window");
  assert.equal(windowIssue?.day, 1, "问题定位到现有条目索引");
  assert.match(windowIssue!.message, /第 2 天活动限 12:00—18:00/);
  assert.equal(partial.planning_layers?.days[1]?.schedule, "draft");
});

test("高层无法推进时仍交付全部基础安排，各层独立耗尽而不伪造已核验/已细排", async (t) => {
  const f = await fixture(t); await f.seed(); await f.save.execute({ title: f.title, constraints: f.constraints, outline }, f.ctx);
  const plan = await f.load(), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title: f.title, destination: "杭州", startDate: dates[0], endDate: dates[2], durationDays: 3, requireAccommodation: false, mustVisit: [names[0]] }), { itinerary: plan, report: validateItinerary(plan), file: f.file }));
  const seen: string[] = [];
  const provider: ChatProvider = { name: "cannot-progress", chat: async () => "unused", chatWithTools: async () => { const task = activeDayTask(session.travelState)!; seen.push(task.layer!); return { type: "text", content: "所有核验已完成" }; } };
  const budget = b(); const reply = await new ChatAgent(session, provider, f.registry, f.root).run("继续完善所有层级", { cumulativeBudget: budget, maxToolRounds: 30 });
  assert.equal(seen.filter((layer) => layer === "feasibility").length, 6); assert.equal(seen.filter((layer) => layer === "schedule").length, 6);
  assert.equal((await f.load()).outline?.length, 3); assert.equal((await f.load()).days.length, 0); assert.match(reply, /基础安排 3\/3/); assert.match(reply, /strict 未通过/);
  assert.ok(!reply.includes("所有核验已完成")); assert.equal(budget.calls, 0);
  const noMore = selectDayTask(session.travelState!, budget); assert.equal(noMore.task, undefined);
});

test("福州真实失败参数作为契约回归：写入前输入错误可修正，不归为副作用未知", async (t) => {
  const f = await fixture(t), session = new Session(); session.setTravelMode(true); let requests = 0, queries = 0;
  f.registry.register({ name: "search_stays", alwaysActive: true, description: "local query", parameters: { type: "object" }, execute: async () => { queries++; return "未找到房价，待确认"; } });
  const provider: ChatProvider = { name: "invalid-brief-recovery", chat: async () => "unused", chatWithTools: async (history) => {
    requests++;
    if (requests === 1) return { type: "tool_calls", toolCalls: [{ id: "bad-brief", name: "save_travel_brief", arguments: JSON.stringify({ title: f.title, destination: "福州", durationDays: 1, avoid: '鼓山' }) }, { id: "query", name: "search_stays", arguments: "{}" }] };
    if (requests === 2) { assert.ok(history.some((message) => message.content.includes("TOOL_ARGUMENT_SCHEMA_INVALID"))); return call("save_travel_brief", { title: f.title, destination: "福州", durationDays: 1, avoid: ["鼓山"] }, "fixed-brief"); }
    return { type: "text", content: "需求已修正，行程仍待生成" };
  } };
  await new ChatAgent(session, provider, f.registry, f.root).run("记录福州一日游需求，不去鼓山", { maxToolRounds: 5 });
  assert.equal(queries, 1); assert.equal(requests, 3); assert.deepEqual(session.travelState?.brief?.avoid, ["鼓山"]);
  const failed = session.history.find((message) => message.toolName === "save_travel_brief" && message.content.includes("TOOL_ARGUMENT_SCHEMA_INVALID"));
  assert.equal(failed?.toolExecution?.effect_status, "not_committed");
});

test("酒店内早餐早于出发窗口不误报，真实交通越界仍保留P1", () => {
  const raw = { title: "出发时窗", constraints: { require_accommodation: false }, days: [{ date: dates[0], available_start: "09:00", available_end: "18:30", items: [{ id: "breakfast", type: "accommodation", name: "酒店", activity: "酒店早餐，09:00出发", time: "08:30", end_time: "09:00" }, { ...day(0).items[0], time: "09:30", end_time: "18:00" }] }] };
  assert.ok(!validateItinerary(parseItinerary(raw)).issues.some((issue) => issue.code === "outside-day-window"));
  raw.days[0]!.items.push({ id: "trip", type: "transport", name: "前往公园", time: "08:50", end_time: "09:20" } as typeof raw.days[number]["items"][number]);
  assert.ok(validateItinerary(parseItinerary(raw)).issues.some((issue) => issue.code === "outside-day-window" && issue.item_id === "trip"));
  const arrival = parseItinerary({ ...raw, days: [{ ...raw.days[0], day_type: "arrival" }] });
  assert.ok(validateItinerary(arrival).issues.some((issue) => issue.code === "outside-day-window" && issue.item_id === "breakfast"), "抵达前不能安排酒店内活动");
});

test("占位名称和模型自填完成状态不能冒充有内容的基础安排", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.save.execute({ title: f.title, constraints: { ...f.constraints, must_visit: [] }, outline: dates.map((date) => ({ date, visits: [{ name: "待安排景点" }] })) }, f.ctx), /visit-allocation-conflict/);
  const distinct = ["待定", "自由活动", "景点一"];
  await f.save.execute({ title: f.title, constraints: { ...f.constraints, must_visit: [] }, planning_layers: { version: "layers-v1", expected_days: 3, basic_days: 3, basic_complete: true, checked_days: 3, scheduled_days: 3, ready_days: 3, missing_required: [], days: [] }, outline: dates.map((date, i) => ({ date, visits: [{ name: distinct[i] }] })) }, f.ctx);
  const plan = await f.load(); assert.equal(plan.planning_layers?.basic_days, 0); assert.equal(plan.planning_layers?.basic_complete, false);
});

test("层级推进不会拦截用户单独核实资料的请求", async (t) => {
  const f = await fixture(t); await f.seed();
  await f.save.execute({ title: f.title, constraints: f.constraints, outline: outline.slice(0, 1) }, f.ctx);
  const plan = await f.load(), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title: f.title, destination: "杭州", durationDays: 3 }), { itinerary: plan, report: validateItinerary(plan), file: f.file }));
  let queried = 0, requests = 0;
  f.registry.register({ name: "get_place_visit_info", alwaysActive: true, description: "local info", parameters: { type: "object" }, execute: async () => { queried++; await f.info(names[0]!); return "09:00-20:00，每周一闭园"; } });
  const provider: ChatProvider = { name: "research-only", chat: async () => "unused", chatWithTools: async () => ++requests === 1 ? call("get_place_visit_info", { place: names[0], fields: ["hours", "closure"] }) : { type: "text", content: "资料查询完成" } };
  await new ChatAgent(session, provider, f.registry, f.root).run("核实甲园的开放时间", { maxToolRounds: 4 });
  assert.equal(queried, 1); assert.equal((await f.load()).outline?.length, 1); assert.equal((await f.load()).days.length, 0);
});

test("真实失败模式：必去西湖未识别不再锁死所有日期，独立失败后仍完成其他日期", async (t) => {
  const f = await fixture(t); await f.seed();
  await f.save.execute({ title: f.title, constraints: { ...f.constraints, must_visit: ["西湖"] }, outline }, f.ctx);
  const initial = await f.load(), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title: f.title, destination: "杭州", durationDays: 3, mustVisit: ["西湖"], requireAccommodation: false }), { itinerary: initial, report: validateItinerary(initial), file: f.file }));
  let searches = 0; const seen: string[] = [];
  f.registry.register({ name: "search_attractions", description: "target lookup", parameters: {}, execute: async (args) => { assert.equal(args.location, "西湖"); searches++; return "未找到地点"; } });
  f.registry.register({ name: "get_place_visit_info", description: "local info", parameters: {}, execute: async (args) => { await f.info(String(args.place)); return "已有开放与闭馆依据"; } });
  const provider: ChatProvider = { name: "missing-must", chat: async () => "unused", chatWithTools: async () => {
    const task = activeDayTask(session.travelState)!; seen.push(task.layer!);
    if (task.layer === "required") return task.attempt_rounds === 0 ? call("search_attractions", { location: "西湖" }, `target-${task.attempts}`) : { type: "text", content: "必去已经满足" };
    if (task.layer === "feasibility") return call("get_place_visit_info", { place: names[dates.indexOf(task.date)] });
    return call("save_itinerary", { title: f.title, days: [day(dates.indexOf(task.date))] });
  } };
  const budget = b(), reply = await new ChatAgent(session, provider, f.registry, f.root).run("继续完善行程", { cumulativeBudget: budget, maxToolRounds: 30 });
  assert.equal(searches, 2); assert.ok(seen.includes("feasibility")); assert.ok(seen.includes("schedule")); assert.equal((await f.load()).days.length, 3);
  assert.match(reply, /strict 未通过/); assert.ok(!reply.includes("必去已经满足"));
  assert.ok(validateItinerary(await f.load()).issues.some((issue) => issue.code === "missing-required-visit"));
  const goalTask = session.travelState!.itinerary!.dayTasks!.find((task) => task.layer === "required")!; assert.equal(goalTask.attempts, 2); assert.equal(goalTask.status, "blocked"); assert.equal(goalTask.calls, 2);
  assert.equal(selectDayTask(session.travelState!, budget).task, undefined, "同一任务自动续跑不能刷新目标额度");
  assert.deepEqual(Session.fromData(session.toData()).travelState?.itinerary?.dayTasks, session.travelState?.itinerary?.dayTasks);
});

test("必去独立任务定向识别主实体、预留后进入核验和细排，最终用实际游览满足", async (t) => {
  const f = await fixture(t); await f.seed(); await f.save.execute({ title: f.title, constraints: { ...f.constraints, must_visit: ["西湖"] }, outline }, f.ctx);
  const session = new Session(); session.setTravelMode(true); const initial = await f.load();
  session.setTravelState(updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title: f.title, destination: "杭州", durationDays: 3, mustVisit: ["西湖"], requireAccommodation: false }), { itinerary: initial, report: validateItinerary(initial), file: f.file }));
  let searches = 0;
  f.registry.register({ name: "search_attractions", description: "local exact POI", parameters: {}, execute: async (args) => { assert.equal(args.location, "西湖"); searches++; await f.evidence.observePlaces("search_attractions", "杭州", "杭州西湖风景名胜区 | 坐标 30.2400,120.1000", "amap"); return "杭州西湖风景名胜区"; } });
  f.registry.register({ name: "get_place_visit_info", description: "local info", parameters: {}, execute: async (args) => { await f.info(String(args.place)); return "已有依据"; } });
  const seen: string[] = [];
  const provider: ChatProvider = { name: "resolve-must", chat: async () => "unused", chatWithTools: async () => {
    const task = activeDayTask(session.travelState)!; seen.push(task.layer!);
    if (task.layer === "required") return !searches ? call("search_attractions", { location: "西湖" }) : call("save_itinerary", { title: f.title, outline: [{ date: task.date, visits: [{ name: "杭州西湖风景名胜区" }] }] });
    const plan = await f.load(), visit = plan.outline!.find((entry) => entry.date === task.date)!.visits[0]!;
    if (task.layer === "feasibility") return call("get_place_visit_info", { place: visit.name });
    return call("save_itinerary", { title: f.title, schedule: { date: task.date, visits: [{ name: visit.name, duration_min: 360 }] } });
  } };
  const reply = await new ChatAgent(session, provider, f.registry, f.root).run("继续完善行程", { cumulativeBudget: b(), maxToolRounds: 30 });
  const final = await f.load(); assert.deepEqual(seen.slice(0, 5), ["schedule", "schedule", "schedule", "required", "required"]); assert.equal(searches, 1); assert.equal(final.required_visit_goals![0]!.status, "scheduled"); assert.equal(final.required_visit_goals![0]!.identity_verified, true); assert.equal(final.days.length, 3); assert.match(reply, /strict 通过/);
  const required = session.travelState!.itinerary!.dayTasks!.find((task) => task.layer === "required")!; assert.equal(required.status, "saved"); assert.equal(required.calls, 2);
});

test("必去任务不能保存无关景点、删除另一必去或借详细days绕过；基础层只接受outline", async (t) => {
  const f = await fixture(t); await f.seed(); await f.save.execute({ title: f.title, constraints: { ...f.constraints, must_visit: [names[0], "西湖"] }, outline }, f.ctx);
  const before = await readFile(f.file, "utf8"), scoped = { ...f.ctx, dayPlanningScope: { title: f.title, date: dates[0]!, layer: "required" as const, goal_name: "西湖", locked_dates: dates.slice(1) } };
  await assert.rejects(() => f.save.execute({ title: f.title, outline: [outline[0]] }, scoped), /REQUIRED_VISIT_RESERVATION_MISSING/);
  await assert.rejects(() => f.save.execute({ title: f.title, outline: [{ date: dates[0], visits: [{ name: "西湖" }] }] }, scoped), /REQUIRED_VISIT_RESERVATION_LOST/);
  await assert.rejects(() => f.save.execute({ title: f.title, days: [day(0)] }, scoped), /当前层只修改outline/);
  await assert.rejects(() => f.save.execute({ title: f.title, days: [day(0)] }, { ...f.ctx, basicPlanning: true }), /BASIC_LAYER_OUTLINE_REQUIRED/);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.match(dayTaskCallIssue("search_attractions", { location: "杭州", city: "杭州" }, scoped.dayPlanningScope)!, /定向/);
  await f.save.execute({ title: f.title, outline: [{ date: dates[0], visits: [{ name: names[0] }, { name: "西湖" }] }] }, scoped);
  assert.equal((await f.load()).planning_layers?.basic_complete, true); assert.equal((await f.load()).days.length, 0, "预留不算已安排游览");
});
