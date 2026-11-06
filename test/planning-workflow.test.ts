import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSaveItineraryTool, createLoadItineraryTool } from "../src/tools/itinerary.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { parseItinerary, type Itinerary, type ItineraryDay } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { visitAssignments, sameVisit } from "../src/tools/itinerary-planning.ts";
import { resolveRepeatPermissions } from "../src/tools/repeat-visit-policy.ts";
import { updateTravelStateFromSnapshot, updateTravelStateFromBrief, type TravelState } from "../src/core/travel-state.ts";
import { planningProgress, planningGuidance, recoverCoverage } from "../src/agent/travel-progress.ts";
import { renderFocusedTravelState, travelFocusDay } from "../src/core/travel-context.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "planning-workflow-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const names = ["甲公园", "乙公园", "丙公园", "丁公园", "戊公园"];
const outline = names.map((name, i) => ({ date: `2026-11-${10 + i}`, visits: [{ name }] }));
const day = (index: number): ItineraryDay => ({ date: outline[index]!.date, items: [{ id: `v${index}`, name: names[index]!, type: "visit", time: "10:00", end_time: "14:00" }] });
const budget = (): CumulativeToolBudget => ({ rounds: 0, calls: 0, tokens: 0, maxRounds: 100, maxCalls: 200, maxTokens: 1_000_000 });
async function load(root: string, title: string) { return parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8"))); }

test("粗排独立保存但不算完成，零日状态跨Session持久化，全局预留可见", async (t) => {
  const root = await temp(t), title = "北京五日游"; let state: TravelState | undefined;
  state = updateTravelStateFromBrief(state, { title, destination: "北京", durationDays: 5 });
  const output = await createSaveItineraryTool(root).execute({ title, outline }, { workspace: root, onItinerary: (s) => { state = updateTravelStateFromSnapshot(state, s); } });
  const plan = await load(root, title), report = validateItinerary(plan);
  assert.equal(plan.days.length, 0); assert.equal(plan.outline?.length, 5); assert.equal(report.score, 0); assert.ok(report.issue_count.P1 > 0);
  assert.match(output, /完整性: 0\/5/); assert.equal(planningProgress(state).remaining, 5);
  const session = new Session(); session.setTravelMode(true); session.setTravelState(state!);
  const restored = Session.fromData(session.toData()).travelState!;
  assert.equal(restored.itinerary?.dayCount, 0); assert.equal(restored.itinerary?.assignments?.length, 5); assert.equal(restored.itinerary?.materializedDays, 0);
  assert.match(renderFocusedTravelState(restored, 1)!, /预留/); assert.match(planningGuidance(restored)!, /2026-11-10/);
  assert.equal(validateItinerary(parseItinerary({ title: "初稿", days: [], outline })).score, 0);
});

test("先保存第三天也按日期读取，预留不冒充完成；用户天数不受局部粗排缩短", async (t) => {
  const root = await temp(t), title = "首访计划"; let state = updateTravelStateFromBrief(undefined, { title, destination: "北京", durationDays: 5 });
  await assert.rejects(() => createSaveTravelBriefTool(root).execute({ title: "日期冲突", destination: "北京", durationDays: 5, startDate: "2026-11-10", endDate: "2026-11-12" }), /跨度不一致/);
  const ctx = { workspace: root, brief: state.brief, onItinerary: (s: Parameters<typeof updateTravelStateFromSnapshot>[1]) => { state = updateTravelStateFromSnapshot(state, s); } };
  await createSaveItineraryTool(root).execute({ title, outline }, ctx);
  await createSaveItineraryTool(root).execute({ title, merge: true, days: [day(2)] }, ctx);
  assert.equal(state.itinerary?.materializedDays, 1); assert.equal(planningProgress(state).remaining, 4); assert.equal(travelFocusDay(state, "继续"), 1);
  const output = JSON.parse(await createLoadItineraryTool(root).execute({ title, date: "2026-11-12", item_ids: ["v2"] }));
  assert.equal(output.days[0].items[0].name, "丙公园");
  assert.match(await createLoadItineraryTool(root).execute({ title, date: "2026-11-10" }), /尚未保存/);
  const plan = await load(root, title); assert.equal(plan.constraints?.expected_days, 5); assert.equal(plan.outline?.length, 5);
  assert.equal(visitAssignments(plan).filter((v) => v.status === "saved").length, 1);
  assert.equal(visitAssignments(plan).filter((v) => v.status === "reserved").length, 4);
});

test("单条替换清理旧地点事实但保留相邻交通位置和方式，释放旧占用，其他日期保持", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", "北京", names.map((name, i) => `${i + 1}. ${name} | 坐标 ${(39.9 + i * .001).toFixed(4)},116.4000`).join("\n"), "amap");
  const save = createSaveItineraryTool(root), title = "两日局部替换", ctx = { workspace: root, evidence };
  const d1: ItineraryDay = { date: "2026-11-10", items: [day(0).items[0]!, { id: "ab", type: "transport", name: "交通", from: names[0], to: names[1], time: "14:00", end_time: "14:20" }, { id: "b", type: "visit", name: names[1]!, time: "14:30", end_time: "16:00", ticket_price_per_person: 999, note: "旧地点说明" }] };
  await save.execute({ title, constraints: { destination: "北京" }, days: [d1, day(2)] }, ctx);
  const before = await load(root, title);
  await save.execute({ title, edits: [{ op: "replace", date: "2026-11-10", item_id: "b", item: { name: names[4] } }] }, ctx);
  const after = await load(root, title), changed = after.days[0]!.items.find((i) => i.id === "b")!;
  assert.equal(changed.name, names[4]); assert.equal(changed.time, "14:30"); assert.equal(changed.evidence_verified, true); assert.equal(changed.ticket_price_per_person, undefined); assert.equal(changed.note, undefined);
  const transport = after.days[0]!.items.find((i) => i.id === "ab")!;
  assert.equal(transport.to, names[4]); assert.equal(transport.time, "14:00"); assert.equal(transport.end_time, "14:20"); assert.equal(transport.route_verified, false);
  assert.deepEqual(after.days[1], before.days[1]); assert.deepEqual(after.days[0]!.items[0], before.days[0]!.items[0]);
  assert.equal(visitAssignments(after).some((v) => v.name === names[1]), false); assert.ok(visitAssignments(after).some((v) => v.name === names[4]));
});

test("跨日移动原子释放原日期并保留ID，删除可释放到候选，不全局排除", async (t) => {
  const root = await temp(t), title = "五日移动", save = createSaveItineraryTool(root);
  await save.execute({ title, outline, days: [day(0), day(1), day(2)] });
  await save.execute({ title, edits: [{ op: "move", date: "2026-11-10", item_id: "v0", to_date: "2026-11-11", item: { time: "14:30", end_time: "16:30" } }] });
  let plan = await load(root, title), entries = visitAssignments(plan).filter((v) => v.name === names[0]);
  assert.equal(entries.length, 1); assert.equal(entries[0]!.date, "2026-11-11"); assert.equal(entries[0]!.item_id, "v0");
  assert.equal(plan.outline?.find((d) => d.date === "2026-11-10")?.visits.length, 0);
  await save.execute({ title, edits: [{ op: "remove", date: "2026-11-11", item_id: "v0" }] });
  plan = await load(root, title); assert.equal(visitAssignments(plan).some((v) => v.name === names[0]), false); assert.equal(plan.excluded_visits?.length ?? 0, 0);
});

test("失败编辑和真实时间冲突都回滚整次修改，不损坏原文件", async (t) => {
  const root = await temp(t), title = "两日原子编辑", save = createSaveItineraryTool(root); await save.execute({ title, days: [day(0), day(1)] });
  const file = join(root, `plans/${title}.json`), before = await readFile(file, "utf8");
  await assert.rejects(() => save.execute({ title, edits: [{ op: "remove", date: day(0).date, item_id: "v0" }, { op: "move", date: day(1).date, item_id: "missing", to_date: day(0).date }] }), /不存在/);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(() => save.execute({ title, edits: [{ op: "move", date: day(0).date, item_id: "v0", to_date: day(1).date }] }), /时间重叠|时间线倒序/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("预留冲突、明确排除与粗排日期越界仍拦截，重游说明须有真实用户授权", () => {
  assert.equal(sameVisit({ name: "公园", location: { latitude: 39, longitude: 116 } }, { name: "公园-大门", location: { latitude: 40, longitude: 116 } }, "北京"), false);
  const base: Itinerary = { title: "两日粗排", days: [], outline: [{ date: "2026-11-10", visits: [{ name: "故宫" }] }, { date: "2026-11-11", visits: [{ name: "故宫博物院" }] }] };
  assert.ok(validateItinerary(base).issues.some((i) => i.code === "visit-allocation-conflict"));
  const real: Itinerary = { ...base, days: [{ date: "2026-11-10", items: [{ ...day(0).items[0]!, name: "故宫博物院" }] }, { date: "2026-11-11", items: [{ ...day(1).items[0]!, name: "故宫博物院", repeat_reason: "用户明确要求跨日深度游览" }] }], outline: [{ date: "2026-11-10", visits: [{ name: "故宫博物院" }] }, { date: "2026-11-11", visits: [{ name: "故宫博物院", repeat_reason: "用户明确要求跨日深度游览" }] }] };
  assert.equal(validateItinerary(real).issues.some((i) => i.code === "cross-day-duplicate"), true);
  const authorized = { ...real, constraints: { repeat_visit_permissions: resolveRepeatPermissions(real, null, [{ id: "user-repeat", content: "我希望重游故宫博物院" }]) } };
  assert.equal(validateItinerary(authorized).issues.some((i) => ["cross-day-duplicate", "visit-allocation-conflict"].includes(i.code)), false);
  assert.ok(validateItinerary({ ...real, excluded_visits: [{ name: "故宫", reason: "用户明确排除" }] }).issues.some((i) => i.code === "excluded-visit-assigned"));
  assert.ok(validateItinerary({ ...base, constraints: { start_date: "2026-11-11", end_date: "2026-11-12" } }).issues.some((i) => i.code === "outline-date-outside-request"));
  assert.throws(() => parseItinerary({ ...base, outline: [{ date: "2026-02-30", visits: [] }] }), /有效/);
});

test("骨架与纯休息不提升有效日期，定向恢复每个阶段一次且不重置任何硬预算", () => {
  const p = parseItinerary({ title: "五日游", days: [], outline });
  const state = updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title: p.title, destination: "北京", durationDays: 5 }), { itinerary: p, report: validateItinerary(p), file: "plan" });
  const b = budget(); b.rounds = 10; b.calls = 63; b.tokens = 1000; b.readVersions = new Map([["known", "read"]]); b.queryAttempts = new Map([["known", 2]]); b.blockedKind = "no_progress"; b.blockedReason = "停滞";
  assert.match(recoverCoverage(state, b)!, /定向恢复/); assert.equal(b.calls, 63); assert.equal(b.rounds, 10); assert.equal(b.tokens, 1000); assert.equal(b.readVersions.get("known"), "read"); assert.equal(b.queryAttempts.get("known"), 2);
  assert.equal(recoverCoverage(state, b), undefined); assert.equal(b.coverageRecoveries?.size, 1);
  const shifted = { ...state, itinerary: { ...state.itinerary!, outline: outline.map((slot, i) => ({ ...slot, date: `2026-11-${11 + i}` })) } };
  assert.equal(recoverCoverage(shifted, b), undefined, "只改粗排日期不能获得新的恢复额度");
  const hard = { ...budget(), calls: 200 }; assert.equal(recoverCoverage(state, hard), undefined);
  const dependency = { ...budget(), blockedKind: "dependency" as const, blockedReason: "日配额" }; assert.equal(recoverCoverage(state, dependency), undefined);
  const rest: Itinerary = { ...p, days: [{ date: outline[0]!.date, items: [{ id: "rest", name: "休息", type: "rest", time: "10:00", end_time: "18:00" }] }] };
  const restState = updateTravelStateFromSnapshot(state, { itinerary: rest, report: validateItinerary(rest), file: "plan" });
  assert.equal(planningProgress(restState).count, 0); assert.equal(planningProgress(restState).remaining, 5);
});

test("真实Agent从软停滞续接按缺失日期保存，共享原预算，不再困在第一天", async (t) => {
  const root = await temp(t), title = "北京五日游", save = createSaveItineraryTool(root);
  await save.execute({ title, outline, days: [day(0)] }); const plan = await load(root, title);
  const state = updateTravelStateFromSnapshot(updateTravelStateFromBrief(undefined, { title, destination: "北京", durationDays: 5 }), { itinerary: plan, report: validateItinerary(plan), file: "plan" });
  const session = new Session(); session.setTravelMode(true); session.setTravelState(state);
  const b = budget(); b.rounds = 10; b.calls = 63; b.tokens = 1234; b.stagnantRounds = 12; b.blockedKind = "no_progress"; b.blockedReason = "局部循环";
  let requests = 0, sawRecovery = false;
  const provider: ChatProvider = { name: "planning-recovery", chat: async () => "完成", chatWithTools: async (history): Promise<LLMResult> => {
    requests++; sawRecovery ||= history.some((m) => m.role === "system" && m.content.includes("定向恢复"));
    const progress = planningProgress(session.travelState);
    if (progress.remaining === 0) return { type: "text", content: "已补齐，保留质量待修项" };
    const index = outline.findIndex((slot) => slot.date === progress.missing[0]); assert.ok(index > 0);
    return { type: "tool_calls", toolCalls: [{ id: `save-${index}`, name: "save_itinerary", arguments: JSON.stringify({ title, merge: true, days: [day(index)] }) }] };
  } };
  await new ChatAgent(session, provider, new ToolRegistry(root).register(save), root).run("评测自动续跑：补齐缺失日期", { cumulativeBudget: b, maxToolRounds: 10 });
  assert.ok(sawRecovery); assert.equal((await load(root, title)).days.length, 5); assert.equal(planningProgress(session.travelState).remaining, 0);
  assert.equal(b.calls, 67); assert.equal(b.rounds, 14); assert.ok(b.tokens >= 1234); assert.equal(requests, 5);
});

test("Agent按保存阶段暴露参数，粗排后能逐日保存，有实际条目后能局部修订", async (t) => {
  const root = await temp(t), title = "北京五日游", session = new Session();
  session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromBrief(undefined, { title, destination: "北京", durationDays: 5 }));
  let requests = 0;
  const provider: ChatProvider = { name: "outline-stage", chat: async () => "结束", chatWithTools: async (_history, tools): Promise<LLMResult> => {
    requests++;
    const definition = tools.find((tool) => tool.name === "save_itinerary")!;
    const props = definition.parameters.properties as Record<string, unknown>;
    if (requests === 1) {
      assert.deepEqual(definition.parameters.required, ["title", "outline"]);
      assert.deepEqual(Object.keys(props).sort(), ["expected_revision", "outline", "title"]);
      return { type: "tool_calls", toolCalls: [{ id: "outline", name: "save_itinerary", arguments: JSON.stringify({ title, outline }) }] };
    }
    assert.equal((definition.parameters.required as string[]).includes("outline"), false);
    if (requests === 2) {
      assert.equal(session.travelState?.itinerary?.materializedDays, 0);
      assert.ok(props.days);
      assert.equal(props.edits, undefined);
      assert.equal(props.repair_routes, undefined);
      return { type: "tool_calls", toolCalls: [{ id: "day-one", name: "save_itinerary", arguments: JSON.stringify({ title, merge: true, days: [day(0)] }) }] };
    }
    assert.ok(props.days && props.edits && props.repair_routes, "补齐阶段也能修复阻碍下一天的已有条目");
    return { type: "text", content: "第一天已保存" };
  } };
  await new ChatAgent(session, provider, new ToolRegistry(root).register(createSaveItineraryTool(root)), root).run("先粗排再逐日保存", { maxToolRounds: 4 });
  assert.equal(requests, 3);
  assert.equal((await load(root, title)).days.length, 1);
});

test("候选摘要排除其他日期占用，必要事实仍明确标记且酒店可复用", async () => {
  const evidence = new TravelEvidenceStore();
  await evidence.observePlaces("search_attractions", "北京", names.map((name, i) => `${i + 1}. ${name} | 坐标 ${(39.9 + i * .001).toFixed(4)},116.4000`).join("\n"), "amap");
  await evidence.observePlaces("search_stays", "北京", "1. 同一家酒店 | 坐标 39.9000,116.4000", "amap");
  const blocked = ["甲公园", "乙公园", "丙公园", "丁公园"];
  const candidates = evidence.summary("北京", [], 5000, blocked);
  assert.doesNotMatch(candidates, /甲公园|乙公园|丙公园|丁公园/); assert.match(candidates, /戊公园/); assert.match(candidates, /同一家酒店/);
  assert.match(evidence.summary("北京", ["甲公园"], 5000, blocked), /甲公园.*非当前日候选/);
});

test("未知局部ID反馈可用ID；非地点活动可用动作名，真实地点不能用动作冒充", async (t) => {
  const root = await temp(t), title = "单日补丁", save = createSaveItineraryTool(root); await save.execute({ title, days: [day(0)] });
  await assert.rejects(() => save.execute({ title, merge: true, days: [{ date: day(0).date, items: [{ id: "guess", end_time: "14:30" }] }] }), /当前可用ID：v0\(甲公园\).*name\/type/);
  const parsed = parseItinerary({ title, days: [{ items: [{ type: "rest", activity: "午餐休整", time: "12:00", end_time: "13:00" }, { type: "transport", route_evidence_id: "route-id", time: "13:00", end_time: "13:30" }] }] });
  assert.equal(parsed.days[0]!.items[0]!.name, "午餐休整"); assert.equal(parsed.days[0]!.items[1]!.name, "交通");
  assert.throws(() => parseItinerary({ title, days: [{ items: [{ type: "visit", activity: "去故宫", time: "12:00", end_time: "13:00" }] }] }), /非空 name/);
});

test("粗排后新增交通先解析完整端点，再生成ID，不误报新增条目是未知补丁", async (t) => {
  const root = await temp(t), title = "新增交通", save = createSaveItineraryTool(root);
  await save.execute({ title, outline: [outline[0]] });
  const args = { title, merge: true, days: [{
    date: day(0).date,
    items: [
      { type: "transport", from: "酒店", to: names[0], time: "09:00", end_time: "09:40" },
      { ...day(0).items[0], id: undefined },
    ],
  }] };
  await save.execute(args);
  const first = await load(root, title);
  assert.equal(first.days[0]!.items[0]!.name, "酒店 → 甲公园");
  const id = first.days[0]!.items[0]!.id;
  assert.match(id, /^item-/);
  await save.execute(args);
  const second = await load(root, title);
  assert.equal(second.days[0]!.items.length, 2);
  assert.equal(second.days[0]!.items[0]!.id, id);
  await assert.rejects(save.execute({ title, merge: true, days: [{ date: day(0).date, items: [{ id: "not-saved", end_time: "11:00" }] }] }), /条目ID.*not-saved.*不存在/);
  await assert.rejects(save.execute({ title, merge: true, days: [{ date: day(0).date, items: [{ type: "visit", time: "11:00" }] }] }), /非空 name/);
});
