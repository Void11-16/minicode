import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { updateTravelStateFromBrief, updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";
import { activeDayTask, blockDayTask, selectDayTask, extendDayTaskAttempts, recordDayTaskRound, dayTaskScope, localDayEditScope, DAY_TASK_ROUNDS, DAY_TASK_CALLS } from "../src/core/day-tasks.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryDay } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";

const dates = ["2026-11-10", "2026-11-11", "2026-11-12"];
const names = ["甲公园", "乙公园", "丙公园"];
const day = (i: number): ItineraryDay => ({ date: dates[i], items: [{ id: `v${i}`, name: names[i]!, type: "visit", time: "10:00", end_time: "18:00", note: i === 0 ? "固定旧日说明" : undefined }] });
const budget = (): CumulativeToolBudget => ({ rounds: 0, calls: 0, tokens: 0, maxRounds: 100, maxCalls: 200, maxTokens: 1_000_000 });
async function fixture(t: TestContext, saved = [day(0)], count = 3) {
  const root = await mkdtemp(join(tmpdir(), "minicode-day-tasks-")); t.after(() => rm(root, { recursive: true, force: true }));
  const title = "独立日期任务", registry = new ToolRegistry(root).register(createSaveItineraryTool(root));
  await registry.evidence.observePlaces("search_attractions", "北京", names.map((name, i) => `${name} | 坐标 ${(39.9 + i * .001).toFixed(4)},116.4000 | 开放时间 09:00-20:00`).join("\n"), "amap");
  for (const name of names) await registry.evidence.observeOpening("北京", name, [{ title: name + "参观须知", snippet: "开放时间09:00-20:00，每周一闭馆", kind: "official", url: "https://example.test/visit" }], ["hours", "closure"]);
  await registry.get("save_itinerary")!.execute({ title, constraints: { expected_days: count, destination: "北京" }, outline: dates.slice(0, count).map((date, i) => ({ date, visits: [{ name: names[i] }] })), days: saved });
  const file = join(root, `plans/${title}.json`), load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const plan = await load(), session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title, destination: "北京", startDate: dates[0], durationDays: count, requireAccommodation: false, mustVisit: [names[2]], notes: "全部活动在09:00到19:00之间" }), { itinerary: plan, report: validateItinerary(plan), file }));
  return { root, title, registry, file, load, session, plan };
}
const toolCall = (id: string, args: Record<string, unknown>): LLMResult => ({ type: "tool_calls", toolCalls: [{ id, name: "save_itinerary", arguments: JSON.stringify(args) }] });

const addToSecondDay = "第二天的行程太少了，帮我追加可以去的地方";

test("局部追加只保存第二天，保护原游览时长，回复保存的增量", async (t) => {
  const second = { ...day(1), items: [{ ...day(1).items[0]!, end_time: "13:00", planned_duration_min: 180, time_locked: true }] };
  const f = await fixture(t, [day(0), second]);
  assert.equal(localDayEditScope(f.session.travelState, addToSecondDay)?.date, dates[1]);
  assert.equal(localDayEditScope(f.session.travelState, "第二天加一个景点，不要缩短原景点")?.edit, "append_visit");
  assert.equal(localDayEditScope(f.session.travelState, "继续补齐缺失日期"), undefined);
  await f.registry.evidence.observePlaces("search_attractions", "北京", "丁公园 | 坐标 39.9015,116.4000", "amap");
  const calls: string[] = [];
  const provider: ChatProvider = { name: "local-edit", chat: async () => { throw new Error("无须模型收尾"); }, chatWithTools: async (history, tools) => {
    const n = calls.push("model");
    assert.ok(history.some((message) => message.content.includes(`仅修改「${f.title}」的 ${dates[1]}`)));
    const schema = tools.find((tool) => tool.name === "save_itinerary")?.parameters as { properties?: { schedule?: { properties: { date: { enum: unknown } } } } } | undefined;
    assert.deepEqual(schema?.properties?.schedule?.properties.date.enum, [dates[1]]);
    if (n === 1) return toolCall("wrong-day", { title: f.title, days: [day(2)] });
    if (n === 2) return toolCall("shrink", { title: f.title, schedule: { date: dates[1], start: "10:00", visits: [{ name: names[1], duration_min: 75 }, { name: "丁公园", duration_min: 30 }] } });
    if (n === 3) return toolCall("append", { title: f.title, schedule: { date: dates[1], start: "10:00", visits: [{ name: names[1] }, { name: "丁公园", duration_min: 30 }] } });
    throw new Error("保存后不应再请求模型");
  } };
  const agent = new ChatAgent(f.session, provider, f.registry, f.root);
  const reply = await agent.run(addToSecondDay, { cumulativeBudget: budget(), maxToolRounds: 10 });
  const saved = await f.load();
  assert.equal(saved.revision, (f.plan.revision ?? 0) + 1);
  assert.deepEqual(saved.days[0], f.plan.days[0]);
  assert.equal(saved.days.length, 2, "第三天继续待补");
  const old = saved.days[1]?.items.find((item) => item.name === names[1]);
  assert.equal(old?.planned_duration_min, 180);
  assert.equal(old?.time, "10:00");
  assert.equal(old?.time_locked, true);
  assert.equal(calls.length, 3);
  assert.match(reply, /修改第 2 天/);
  assert.match(reply, /新增 丁公园/);
  assert.doesNotMatch(reply, /各日期已按独立额度尝试/);
  assert.ok(agent.history.some((message) => message.role === "tool" && message.content.includes("DAY_TASK_FROZEN")));
  assert.ok(agent.history.some((message) => message.role === "tool" && /180 分钟改为 75 分钟/.test(message.content)));
});

test("追加放不下时保留原文件并把实际取舍交给用户", async (t) => {
  const f = await fixture(t, [day(0), day(1)]);
  const before = await readFile(f.file, "utf8");
  let calls = 0;
  const provider: ChatProvider = { name: "edit-tradeoff", chat: async () => "unused", chatWithTools: async () => ++calls === 1
    ? toolCall("shorten", { title: f.title, schedule: { date: dates[1], visits: [{ name: names[1], duration_min: 75 }, { name: "丁公园" }] } })
    : { type: "text", content: "我已经保存" } };
  const reply = await new ChatAgent(f.session, provider, f.registry, f.root).run(addToSecondDay);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.match(reply, /尚未写入新的修改/);
  assert.match(reply, /480 分钟改为 75 分钟/);
  assert.match(reply, /哪项安排可以调整/);
  assert.doesNotMatch(reply, /我已经保存/);
});

test("单日队列先遍历未尝试日期，再重试失败日期；各日轮次独立，Session恢复且不刷新硬预算", async (t) => {
  const f = await fixture(t), b = budget(); b.rounds = 20; b.calls = 50; b.tokens = 5000;
  let { state, task } = selectDayTask(f.session.travelState!, b);
  assert.equal(task?.date, dates[1]);
  state = recordDayTaskRound(state, task!.date, 3, "当天失败");
  state = blockDayTask(state, task!.date, "局部冲突");
  ({ state, task } = selectDayTask(state, b)); assert.equal(task?.date, dates[2]); assert.equal(task?.attempt_rounds, 0);
  state = blockDayTask(state, task!.date, "缺少证据");
  ({ state, task } = selectDayTask(state, b)); assert.equal(task?.date, dates[1]); assert.equal(task?.attempts, 2); assert.equal(task?.rounds, 1);
  state = blockDayTask(state, task!.date, "仍冲突");
  ({ state, task } = selectDayTask(state, b)); assert.equal(task?.date, dates[2]); assert.equal(task?.attempts, 2);
  state = blockDayTask(state, task!.date, "仍缺证据");
  ({ state, task } = selectDayTask(state, b)); assert.equal(task, undefined);
  f.session.setTravelState(state); const restored = Session.fromData(f.session.toData()).travelState!;
  assert.deepEqual(restored.itinerary?.dayTasks, state.itinerary?.dayTasks);
  assert.equal(b.rounds, 20); assert.equal(b.calls, 50); assert.equal(b.tokens, 5000);
  extendDayTaskAttempts(restored, b);
  const retried = selectDayTask(restored, b);
  assert.equal(retried.task?.date, dates[1]);
  assert.equal(retried.task?.attempts, 3);
  assert.equal(retried.task?.attempt_rounds, 0);
  assert.equal(retried.state.itinerary?.dayTasks?.find((task) => task.date === dates[0])?.status, "saved");
  assert.deepEqual([b.rounds, b.calls, b.tokens], [20, 50, 5000]);
});

test("保存层锁定旧日：整份覆盖、改名另存、旧日编辑和移动不能绕过，真实重复仍拒绝", async (t) => {
  const f = await fixture(t), save = f.registry.get("save_itinerary")!, before = await readFile(f.file, "utf8");
  const scope = { title: f.title, date: dates[1]!, locked_dates: [dates[0]!] }, ctx = { workspace: f.root, dayPlanningScope: scope };
  for (const args of [
    { title: f.title, merge: false, days: [day(1)] },
    { title: "模型另存新标题", days: [day(1)] },
    { title: f.title, days: [{ ...day(0), items: [{ ...day(0).items[0], note: "试图改旧日" }] }] },
    { title: f.title, edits: [{ op: "move", date: dates[0], to_date: dates[1], item_id: "v0" }] },
  ]) await assert.rejects(() => save.execute(args, ctx), /DAY_TASK_FROZEN/);
  assert.equal(await readFile(f.file, "utf8"), before);
  await assert.rejects(() => save.execute({ title: f.title, days: [{ ...day(1), items: [{ ...day(1).items[0], name: names[0] }] }] }, ctx), /duplicate|重复/);
  await save.execute({ title: f.title, days: [day(1)] }, ctx);
  assert.deepEqual((await f.load()).days[0], f.plan.days[0]);
});

test("补天时旧日证据发生更新也不重写旧日，最后保存仍保留完整质量验收", async (t) => {
  const f = await fixture(t), save = f.registry.get("save_itinerary")!;
  await f.registry.evidence.observePlaces("search_attractions", "北京", `${names[0]} | 坐标 39.9100,116.4100 | 评分 4.9`, "amap");
  const state = selectDayTask(f.session.travelState!, budget()).state;
  await save.execute({ title: f.title, days: [day(1)] }, { workspace: f.root, evidence: f.registry.evidence, dayPlanningScope: dayTaskScope(state, dates[1]) });
  assert.deepEqual((await f.load()).days[0], f.plan.days[0]);
  assert.ok(validateItinerary(await f.load()).issues.some((i) => i.code === "title-day-mismatch"));
});

test("非配合模型先改旧日、再反复提交错误：其他日期仍保存，失败草稿和独立重试保留", async (t) => {
  const f = await fixture(t), b = budget(), seen: string[] = [];
  const provider: ChatProvider = { name: "adversarial-dates", chat: async () => { throw new Error("不额外文字收尾"); }, chatWithTools: async (history, tools) => {
    const task = activeDayTask(f.session.travelState)!; seen.push(task.date);
    assert.ok(history.some((m) => m.content.includes("09:00到19:00")), "用户硬要求始终保留");
    const definition = tools.find((tool) => tool.name === "save_itinerary")!;
    assert.ok((definition.parameters.properties as Record<string, unknown>).edits, "时间层允许修复本日草稿");
    if (task.date === dates[1]) {
      if (task.attempts === 1 && task.attempt_rounds === 0) return toolCall("edit-old", { title: f.title, days: [{ ...day(0), items: [{ ...day(0).items[0], note: "不能改动旧日" }] }] });
      return toolCall(`invalid-${task.attempts}-${task.attempt_rounds}`, { title: f.title, days: [{ date: dates[1], items: [{ ...day(1).items[0], time: "16:00", end_time: "10:00" }] }] });
    }
    assert.ok(!history.some((m) => m.toolCalls?.some((call) => call.id === "edit-old")), "旧日工具过程不进入下一日期上下文");
    assert.ok(history.some((m) => m.content.includes("甲公园")), "保留共享景点占用");
    assert.ok(history.some((m) => m.content.includes("相邻日期衔接")), "保留旧日终点");
    return toolCall("save-third", { title: f.title, days: [day(2)] });
  } };
  const reply = await new ChatAgent(f.session, provider, f.registry, f.root).run("继续补齐全部日期", { cumulativeBudget: b, maxToolRounds: 40 });
  const plan = await f.load(); assert.deepEqual(plan.days[0], f.plan.days[0]); assert.ok(plan.days.some((d) => d.date === dates[2])); assert.ok(!plan.days.some((d) => d.date === dates[1]));
  const tasks = f.session.travelState!.itinerary!.dayTasks!;
  const failed = tasks.find((task) => task.date === dates[1] && task.layer === "schedule")!;
  assert.equal(failed.status, "blocked"); assert.equal(failed.attempts, 2); assert.ok(failed.failures > 0); assert.ok(failed.draft_path);
  const draft = JSON.parse(await readFile(failed.draft_path!, "utf8")); assert.equal(draft.status, "rejected"); assert.equal(draft.task_date, dates[1]);
  assert.ok(seen.indexOf(dates[2]!) < seen.lastIndexOf(dates[1]!)); assert.ok(b.rounds < 40);
  assert.match(reply, /未通过|尚未完成/); assert.match(reply, /2026-11-11/);
});

test("只给文字收尾也会切换日期，两次失败后有界停止，不能冒充完整交付", async (t) => {
  const f = await fixture(t), seen: string[] = [], b = budget();
  const provider: ChatProvider = { name: "premature-final", chat: async () => "不应调用", chatWithTools: async () => { seen.push(activeDayTask(f.session.travelState)!.date); return { type: "text", content: "完整行程已完成" }; } };
  const reply = await new ChatAgent(f.session, provider, f.registry, f.root).run("补齐缺失日期", { cumulativeBudget: b, maxToolRounds: 30 });
  assert.deepEqual(seen, [dates[1], dates[2], dates[1], dates[2]]);
  assert.equal((await f.load()).days.length, 1); assert.equal(b.rounds, 4); assert.equal(b.calls, 0);
  assert.match(reply, /未完成|待处理/); assert.ok(!reply.includes("完整行程已完成"));
});

test("到达总轮次上限时，续期重新开放已耗尽的日期并落盘", async (t) => {
  const f = await fixture(t, [day(0)], 2), b = budget();
  f.session.setTravelState(updateTravelStateFromBrief(f.session.travelState, { title: f.title, destination: "北京", startDate: dates[0], durationDays: 2, requireAccommodation: false }));
  let limit = 2;
  const attempts: number[] = [];
  const provider: ChatProvider = { name: "resume-exhausted-date", chat: async () => "不应调用", chatWithTools: async () => {
    const task = activeDayTask(f.session.travelState)!;
    assert.equal(task.date, dates[1]);
    attempts.push(task.attempts);
    if (task.attempts < 3) return { type: "text", content: "暂未修复" };
    return toolCall("save-after-extension", { title: f.title, schedule: { date: dates[1], visits: [{ name: names[1], duration_min: 420 }] } });
  } };
  const reply = await new ChatAgent(f.session, provider, f.registry, f.root).run("继续补齐缺失日期", {
    cumulativeBudget: b,
    maxToolRounds: () => limit,
    onBudgetExhausted: (rounds) => {
      assert.equal(rounds, 2);
      limit += 15;
      return true;
    },
  });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(b.rounds, 3);
  const plan = await f.load();
  assert.deepEqual(plan.days[0], f.plan.days[0]);
  assert.equal(plan.days[1]?.date, dates[1]);
  assert.match(reply, /追加了 15 轮，实际使用 1 轮/);
});

test("单日软额度耗尽后切换日期，硬额度耗尽仍停止；用户指定修改可编辑已保存日期", async (t) => {
  const f = await fixture(t), b = budget();
  let selected = selectDayTask(f.session.travelState!, b), state = selected.state;
  for (let n = 0; n < DAY_TASK_ROUNDS; n++) state = recordDayTaskRound(state, dates[1]!, 1);
  f.session.setTravelState(state);
  let first = "";
  const provider: ChatProvider = { name: "day-cap", chat: async () => "unused", chatWithTools: async () => { first ||= activeDayTask(f.session.travelState)!.date; return { type: "text", content: "未保存" }; } };
  await new ChatAgent(f.session, provider, f.registry, f.root).run("继续补齐", { cumulativeBudget: b, maxToolRounds: 20 });
  assert.equal(first, dates[2]);
  const callsBefore = b.calls; b.rounds = b.maxRounds;
  const stopped = await new ChatAgent(f.session, provider, f.registry, f.root).run("继续", { cumulativeBudget: b });
  assert.match(stopped, /累计/); assert.equal(b.calls, callsBefore);
  let requests = 0;
  const editor: ChatProvider = { name: "explicit-edit", chat: async () => "unused", chatWithTools: async () => ++requests === 1 ? toolCall("authorized", { title: f.title, days: [{ ...day(0), items: [{ ...day(0).items[0], note: "用户指定修改" }] }] }) : { type: "text", content: "已修改" } };
  await new ChatAgent(f.session, editor, f.registry, f.root).run("请修改第一天的说明", { maxToolRounds: 3 });
  assert.equal((await f.load()).days[0]!.items[0]!.note, "用户指定修改");
});

test("旧行程粗排不完整也按需求日期补齐，仍提供相邻已保存日期的边界", async (t) => {
  const f = await fixture(t), plan = { ...f.plan, outline: f.plan.outline!.slice(0, 1) };
  f.session.setTravelState(updateTravelStateFromSnapshot(f.session.travelState, { itinerary: plan, report: validateItinerary(plan), file: f.file }));
  let requests = 0;
  const provider: ChatProvider = { name: "legacy-partial-outline", chat: async () => "unused", chatWithTools: async (history) => {
    requests++; const task = activeDayTask(f.session.travelState)!;
    assert.ok(task);
    if (requests === 1) assert.ok(history.some((m) => m.content.includes("相邻日期衔接：2026-11-10")));
    const i = dates.indexOf(task.date);
    return toolCall(`legacy-${i}`, { title: f.title, days: [day(i)] });
  } };
  await new ChatAgent(f.session, provider, f.registry, f.root).run("继续补齐缺失日期", { cumulativeBudget: budget(), maxToolRounds: 10 });
  assert.equal((await f.load()).days.length, 3); assert.equal(requests, 2);
});

test("用户开始新的旅行时不会被旧行程的补天锁拦住，新行程仍按日期推进", async (t) => {
  const f = await fixture(t), before = await readFile(f.file, "utf8"), title = "上海新旅行";
  f.registry.register(createSaveTravelBriefTool(f.root));
  await f.registry.evidence.observePlaces("search_attractions", "上海", [0, 1].map((n) => `上海公园${n} | 坐标 31.2000,121.4000 | 开放时间 09:00-20:00`).join("\n"), "amap");
  for (const n of [0, 1]) await f.registry.evidence.observeOpening("上海", `上海公园${n}`, [{ title: `上海公园${n}参观`, snippet: "开放时间09:00-20:00，每周一闭馆", kind: "official", url: "https://example.test/visit" }], ["hours", "closure"]);
  let requests = 0;
  const newDates = ["2026-12-01", "2026-12-02"];
  const provider: ChatProvider = { name: "new-trip", chat: async () => "unused", chatWithTools: async (_history, tools) => {
    requests++;
    if (requests === 1) {
      assert.ok(tools.some((tool) => tool.name === "save_travel_brief"));
      return { type: "tool_calls", toolCalls: [{ id: "new-brief", name: "save_travel_brief", arguments: JSON.stringify({ title, destination: "上海", startDate: newDates[0], endDate: newDates[1], durationDays: 2, requireAccommodation: false }) }] };
    }
    if (requests === 2) return toolCall("new-outline", { title, outline: newDates.map((date, i) => ({ date, visits: [{ name: `上海公园${i}` }] })) });
    const task = activeDayTask(f.session.travelState)!; assert.ok(task); assert.ok(newDates.includes(task.date));
    return toolCall(`new-${task.date}`, { title, days: [{ date: task.date, items: [{ ...day(0).items[0], id: `v-${task.date}`, name: `上海公园${newDates.indexOf(task.date)}` }] }] });
  } };
  await new ChatAgent(f.session, provider, f.registry, f.root).run("请规划上海两日游", { cumulativeBudget: budget(), maxToolRounds: 15 });
  assert.equal(await readFile(f.file, "utf8"), before);
  const next = JSON.parse(await readFile(join(f.root, `plans/${title}.json`), "utf8")); assert.equal(next.days.length, 2); assert.equal(requests, 4);
});

test("单个超大工具批次也不能越过该日期调用额度，剩余日期继续执行", async (t) => {
  const f = await fixture(t), b = budget(); let queries = 0;
  f.registry.register({ name: "known_query", alwaysActive: true, description: "local", parameters: { type: "object" }, execute: async () => { queries++; return "已知信息"; } });
  const provider: ChatProvider = { name: "oversized-batch", chat: async () => "unused", chatWithTools: async () => {
    const task = activeDayTask(f.session.travelState)!;
    if (task.date === dates[1] && task.attempts === 1) return { type: "tool_calls", toolCalls: Array.from({ length: 30 }, (_, n) => ({ id: `query-${n}`, name: "known_query", arguments: "{}" })) };
    return toolCall(`save-${task.date}`, { title: f.title, days: [day(dates.indexOf(task.date))] });
  } };
  await new ChatAgent(f.session, provider, f.registry, f.root).run("继续补齐缺失日期", { cumulativeBudget: b, maxToolRounds: 20 });
  assert.equal(queries, DAY_TASK_CALLS); assert.equal((await f.load()).days.length, 3);
  assert.equal(f.session.travelState!.itinerary!.dayTasks!.find((task) => task.date === dates[1] && task.layer === "schedule")!.attempts, 2);
});
