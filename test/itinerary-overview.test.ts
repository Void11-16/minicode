import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoadItineraryTool, createSaveItineraryTool, updateSavedItinerary } from "../src/tools/itinerary.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { parseItinerary, type Itinerary } from "../src/tools/itinerary-schema.ts";
import { renderItineraryOverview } from "../src/tools/itinerary-overview.ts";
import { compactToolResults } from "../src/agent/tool-output.ts";
import { undoReadDelivery, renderReadProgress } from "../src/tools/read-progress.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { updateTravelStateFromBrief } from "../src/core/travel-state.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "itinerary-overview-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const date = (n: number) => new Date(Date.parse("2026-11-10") + n * 86400000).toISOString().slice(0, 10);
const days = (n: number) => Array.from({ length: n }, (_, i) => ({ date: date(i), theme: `区域${i}`, items: [{ id: `v${i}`, type: "visit", name: `景点${i}`, time: "10:00", end_time: "12:00", note: `完整备注${i}` }] }));
const readPlan = async (root: string, title: string): Promise<Itinerary> => JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8"));

test("默认全局读取覆盖全部天，第一天大量餐厅不挤掉后续日期；原始文件不变", async (t) => {
  const root = await temp(t), title = "五日覆盖", save = createSaveItineraryTool(root), load = createLoadItineraryTool(root);
  const plan = days(5) as { date: string; theme: string; items: Record<string, unknown>[] }[];
  plan[0].items.push(...Array.from({ length: 70 }, (_, i) => ({ id: `meal${i}`, type: "meal", name: `餐厅${i}`, subtype: "lunch", note: "无关的长介绍".repeat(100) })));
  await save.execute({ title, days: plan });
  const before = await readFile(join(root, `plans/${title}.json`), "utf8");
  const output = await load.execute({ title });
  assert.match(output, /^【行程全局概览】/);
  for (let i = 0; i < 5; i++) assert.match(output, new RegExp(`Day ${i + 1} · ${date(i)}.*景点${i}`));
  assert.match(output, /有效安排5\/5天/); assert.match(output, /餐候70/);
  assert.doesNotMatch(output, /无关的长介绍/); assert.ok(output.length < 3000);
  const [result] = await compactToolResults([{ callId: "overview", toolName: "load_itinerary", output, outputKind: "itinerary" }], { workspace: root, sessionId: "test" });
  assert.equal(result.truncated, false);
  assert.match(result.text, /Day 5/);
  const ctx = { workspace: root, readVersions: new Map<string, string>(), readCallId: "retry-global" };
  const repeated = await load.execute({ title }, ctx);
  const [tiny] = await compactToolResults([{ callId: "retry-global", toolName: "load_itinerary", output: repeated, outputKind: "itinerary" }], { workspace: root, sessionId: "test", maxChars: 300, batchMaxChars: 300 });
  assert.match(tiny.text, /未完整交付/);
  undoReadDelivery(ctx.readVersions, "retry-global");
  assert.match(await load.execute({ title }, ctx), /reread=true/);
  assert.match(await load.execute({ title, reread: true }, { ...ctx, readCallId: "retry-alone" }), /Day 5/);
  assert.equal(await readFile(join(root, `plans/${title}.json`), "utf8"), before);
  const explicit = JSON.parse(await load.execute({ title, summary: false }));
  assert.equal(explicit.days[0].items.length, 71); assert.equal(explicit.days.length, 5);
});

test("概览显示尚未保存的需求日期和粗排，骨架不能算完成；读索引统一默认与summary=true", async (t) => {
  const root = await temp(t), title = "待补齐行程", save = createSaveItineraryTool(root), load = createLoadItineraryTool(root);
  await createSaveTravelBriefTool(root).execute({ title, destination: "北京", startDate: date(0), endDate: date(4), durationDays: 5 });
  await save.execute({ title, outline: [{ date: date(0), visits: [{ name: "景点0" }] }, { date: date(2), visits: [{ name: "预留公园" }] }], days: [days(1)[0]] });
  const ctx = { workspace: root, readVersions: new Map<string, string>(), readCallId: "global" };
  const output = await load.execute({ title }, ctx);
  assert.match(output, /有效安排1\/5天/);
  assert.match(output, new RegExp(`${date(1)} 未保存`));
  assert.match(output, new RegExp(`${date(2)} 仅粗排`));
  assert.match(output, new RegExp(`${date(4)} 未保存`));
  assert.match(await load.execute({ title, summary: true }, ctx), /该范围已读取/);
  const skeleton = parseItinerary({ title: "三日游", days: [{ date: date(0), items: [{ id: "rest", type: "rest", name: "休息", time: "10:00", end_time: "18:00" }] }] });
  assert.match(renderItineraryOverview(skeleton)!, /有效安排0\/3天/);
  assert.match(renderItineraryOverview(skeleton)!, /已保存骨架/);
});

test("90天概览整体降级字段仍覆盖全部日期，不足以覆盖时明确未完整交付", async (t) => {
  const root = await temp(t);
  const plan = parseItinerary({ title: "长行程", constraints: { expected_days: 90, start_date: date(0), end_date: date(89) }, days: days(90).map((day) => ({ ...day, items: day.items.map((item) => ({ ...item, name: item.name + "景区长名称".repeat(20) })) })) });
  const overview = renderItineraryOverview(plan)!;
  assert.ok(overview.length <= 2400);
  for (let i = 0; i < 90; i++) assert.ok(overview.includes(date(i)), `缺少${date(i)}`);
  const [tiny] = await compactToolResults([{ callId: "tiny", toolName: "load_itinerary", output: overview, outputKind: "itinerary" }], { workspace: root, sessionId: "test", maxChars: 400, batchMaxChars: 400 });
  assert.ok(tiny.truncated); assert.match(tiny.text, /未完整交付/); assert.doesNotMatch(tiny.text, /D1 /);
  const [raw] = await compactToolResults([{ callId: "raw", toolName: "load_itinerary", output: JSON.stringify(plan), outputKind: "itinerary" }], { workspace: root, sessionId: "test", maxChars: 500, batchMaxChars: 500 });
  assert.match(raw.text, /全局概览未完整交付/); assert.doesNotMatch(raw.text, /景区长名称/);
});

test("显式整份JSON的预览也覆盖每一天，不再先填满第一天的item", async (t) => {
  const root = await temp(t), plan = days(5) as { date: string; items: Record<string, unknown>[] }[];
  plan[0].items.push(...Array.from({ length: 50 }, (_, i) => ({ id: `meal${i}`, type: "meal", name: `餐厅${i}`, note: "长备注".repeat(100) })));
  const output = JSON.stringify({ title: "五日行程", days: plan });
  const [result] = await compactToolResults([{ callId: "full", toolName: "load_itinerary", output, outputKind: "itinerary" }], { workspace: root, sessionId: "test" });
  for (let i = 0; i < 5; i++) assert.match(result.text, new RegExp(`Day ${i + 1} · ${date(i)}`));
  assert.doesNotMatch(result.text, /餐厅49/);
  assert.equal(await readFile(join(root, result.artifactPath!), "utf8"), output);
});

test("未补齐粗排不隐去实际完成日，明确开始日期加天数能列出后续缺失日期", () => {
  const plan = parseItinerary({ title: "五日游", constraints: { expected_days: 5 }, outline: [{ date: date(0), visits: [{ name: "景点0" }] }], days: days(5) });
  assert.match(renderItineraryOverview(plan)!, /有效安排5\/5天/);
  const started = parseItinerary({ title: "五日游", constraints: { expected_days: 5, start_date: date(0) }, days: [days(1)[0]] });
  assert.match(renderItineraryOverview(started)!, new RegExp(`${date(4)} 未保存`));
});

test("按日期和ID读取完整字段；超长局部正文不再删除字段后冒充完整条目", async (t) => {
  const root = await temp(t), title = "完整字段", save = createSaveItineraryTool(root), load = createLoadItineraryTool(root);
  const plan = days(2); plan[0].items[0].note = "需要精确保留的完整备注".repeat(600);
  await save.execute({ title, days: plan });
  const ctx = { workspace: root, readVersions: new Map<string, string>(), readCallId: "focused" };
  const output = await load.execute({ title, date: date(0), item_ids: ["v0"] }, ctx);
  const value = JSON.parse(output), saved = await readPlan(root, title);
  assert.equal(value.view, "items"); assert.deepEqual(value.days[0].items[0], saved.days[0].items[0]);
  const [result] = await compactToolResults([{ callId: "focused", toolName: "load_itinerary", output, outputKind: "itinerary" }], { workspace: root, sessionId: "test" });
  assert.match(result.text, /未完整交付/); assert.match(result.text, /禁止据此整份覆盖/);
  assert.doesNotMatch(result.text, /"name":"景点0"/);
  assert.equal(await readFile(join(root, result.artifactPath!), "utf8"), output);
  undoReadDelivery(ctx.readVersions, "focused");
  assert.match(renderReadProgress(ctx.readVersions)!, /未完整交付/);
  const small = JSON.parse(await load.execute({ title, date: date(1), item_ids: ["v1"] }, ctx));
  assert.deepEqual(small.days[0].items[0], saved.days[1].items[0]);
  const directory = await load.execute({ title, date: date(1), summary: true });
  assert.match(directory, /id=v1/); assert.doesNotMatch(directory, /完整备注/);
});

test("默认保存按条目增量保留其余日期；单日与整份替换必须明确表达", async (t) => {
  const root = await temp(t), title = "五日保存", save = createSaveItineraryTool(root);
  await save.execute({ title, days: days(5) });
  const before = await readPlan(root, title);
  await save.execute({ title, days: [{ date: date(0), items: [{ id: "v0", note: "只改这一项" }] }] });
  let after = await readPlan(root, title);
  assert.equal(after.days.length, 5); assert.deepEqual(after.days.slice(1), before.days.slice(1));
  assert.equal(after.days[0].items[0].name, before.days[0].items[0].name); assert.equal(after.days[0].items[0].note, "只改这一项");
  await save.execute({ title, merge_mode: "replace_day", days: [{ date: date(0), items: [{ id: "new", type: "visit", name: "新公园", time: "10:00", end_time: "12:00" }] }] });
  after = await readPlan(root, title); assert.equal(after.days[0].items.length, 1); assert.equal(after.days[0].items[0].id, "new");
  assert.deepEqual(after.days.slice(1), before.days.slice(1));
  await assert.rejects(() => save.execute({ title, merge: false, edits: [{ op: "remove", date: date(0), item_id: "new" }] }), /整份覆盖须/);
  await save.execute({ title, merge: false, days: [days(1)[0]] });
  assert.equal((await readPlan(root, title)).days.length, 1);
});

test("权威文件编辑仍能删除条目；未定日期单日按稳定ID补丁不追加重复日", async (t) => {
  const root = await temp(t), save = createSaveItineraryTool(root), title = "未定日期单日";
  await save.execute({ title, days: [{ items: [{ id: "a", type: "visit", name: "甲公园", time: "10:00", end_time: "12:00" }, { id: "b", type: "visit", name: "乙公园", time: "13:00", end_time: "15:00" }] }] });
  await save.execute({ title, days: [{ items: [{ id: "a", note: "补丁" }] }] });
  let plan = await readPlan(root, title); assert.equal(plan.days.length, 1); assert.equal(plan.days[0].items.length, 2);
  await updateSavedItinerary(root, title, async (raw) => { const value = raw as unknown as Itinerary; (value.days[0] as { items: unknown[] }).items = value.days[0].items.filter((item) => item.id !== "b"); });
  plan = await readPlan(root, title); assert.equal(plan.days[0].items.length, 1); assert.equal(plan.days[0].items[0].id, "a");
});

test("默认增量保存为同餐厅的不同餐段生成不同ID，重提同一餐段不覆盖另一个", async (t) => {
  const root = await temp(t), title = "餐段身份", save = createSaveItineraryTool(root);
  await save.execute({ title, days: [{ date: date(0), items: [{ type: "meal", name: "同一家餐厅", subtype: "lunch" }, { type: "meal", name: "同一家餐厅", subtype: "dinner" }] }] });
  const before = await readPlan(root, title);
  assert.equal(new Set(before.days[0].items.map((item) => item.id)).size, 2);
  await save.execute({ title, days: [{ date: date(0), items: [{ type: "meal", name: "同一家餐厅", subtype: "dinner", note: "只更新晚餐" }] }] });
  const after = await readPlan(root, title);
  assert.equal(after.days[0].items.length, 2);
  assert.deepEqual(after.days[0].items.find((item) => item.subtype === "lunch"), before.days[0].items.find((item) => item.subtype === "lunch"));
  assert.equal(after.days[0].items.find((item) => item.subtype === "dinner")!.id, before.days[0].items.find((item) => item.subtype === "dinner")!.id);
  assert.equal(after.days[0].items.find((item) => item.subtype === "dinner")!.note, "只更新晚餐");
});

test("真实Agent读取概览后仍持有完整多日快照，模型说完成不能掩盖缺天", async (t) => {
  const root = await temp(t), title = "北京五日游", save = createSaveItineraryTool(root);
  await save.execute({ title, days: [days(1)[0]], constraints: { expected_days: 5, start_date: date(0), end_date: date(4) } });
  const session = new Session(); session.setTravelMode(true);
  session.setTravelState(updateTravelStateFromBrief(undefined, { title, destination: "北京", durationDays: 5, startDate: date(0), endDate: date(4) }));
  let calls = 0;
  const provider: ChatProvider = { name: "coverage", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => ++calls === 1 ? { type: "tool_calls", toolCalls: [{ id: "read", name: "load_itinerary", arguments: JSON.stringify({ title }) }] } : { type: "text", content: "五天已经全部安排好了" } };
  const reply = await new ChatAgent(session, provider, new ToolRegistry(root).register(createLoadItineraryTool(root)), root).run("检查当前行程", { maxToolRounds: 3 });
  assert.equal(session.travelState?.itinerary?.expectedDays, 5);
  assert.equal(session.travelState?.itinerary?.materializedDays, 1);
  assert.equal(session.travelState?.itinerary?.complete, false);
  assert.match(reply, /有效1\/5天.*尚未完成/);
  assert.doesNotMatch(reply, /五天已经全部安排好了/);
  assert.match(session.history.find((m) => m.toolCallId === "read")!.content, new RegExp(date(4)));
});
