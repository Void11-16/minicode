import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { structuredToolPreview } from "../src/agent/tool-preview.ts";
import { TRAVEL_SYSTEM_PROMPT } from "../src/agent/prompt.ts";

const date = "2026-11-10", nextDate = "2026-11-11";
const visit = (id: string, name: string, time: string, end_time: string): ItineraryItem => ({ id, name, type: "visit", time, end_time });
const rest = (id: string, time: string, end_time: string): ItineraryItem => ({ id, type: "rest", name: "午餐休整", time, end_time });
const transport = (id: string, from: string, to: string, time: string, end_time: string): ItineraryItem => ({ id, type: "transport", name: `${from} → ${to}`, from, to, time, end_time, transport_mode: "transit" });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "route-repair-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root), title = "局部路线修复", save = createSaveItineraryTool(root), ctx = { workspace: root, evidence };
  await evidence.observePlaces("search_attractions", "北京", "1. 甲公园 | 坐标 39.9000,116.4000 | 开放时间 06:00-23:00\n2. 乙公园 | 坐标 39.9200,116.4200 | 开放时间 06:00-23:00\n3. 丙公园 | 坐标 39.9400,116.4400 | 开放时间 06:00-23:00\n4. 丁公园 | 坐标 39.9600,116.4600 | 开放时间 06:00-23:00", "amap");
  await evidence.observePlaces("search_stays", "北京", "1. 甲酒店 | 坐标 39.8800,116.3800 | 参考价 ¥400", "amap");
  const route = async (from: string, to: string, duration_min = 30, mode = "transit", extra = {}) => (await evidence.observeRoutes([{ city: "北京", from, to, duration_min, mode, request_mode: mode, distance_km: 3, estimated: false,
    from_point: evidence.point(from, "北京")!, to_point: evidence.point(to, "北京")!, ...extra }]))[0]!;
  const file = join(root, `plans/${title}.json`), load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const initial = async (items: ItineraryItem[], dayExtra = {}) => save.execute({ title, constraints: { destination: "北京", require_routes: true }, days: [{ date, ...dayExtra, items }, { date: nextDate, items: [visit("other", "丁公园", "10:00", "13:00")] }] }, ctx);
  const repair = () => save.execute({ title, repair_routes: [date] }, ctx);
  return { root, evidence, title, save, ctx, route, file, load, initial, repair };
}

test("同地点补证据保留交通ID、已核验路线、价格和备注，不制造新的缺段", async (t) => {
  const f = await fixture(t), r = await f.route("甲公园", "乙公园");
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), { ...transport("ab", "甲公园", "乙公园", "11:00", "11:40"), route_evidence_id: r.id }, { ...visit("b", "乙公园", "12:00", "14:00"), ticket_price_per_person: 60, note: "保留说明" }]);
  const before = await f.load(), place = f.evidence.bind(visit("b", "乙公园", "12:00", "14:00"), "北京");
  await f.save.execute({ title: f.title, edits: [{ op: "replace", date, item_id: "b", item: { name: "乙公园", evidence_id: place.evidence_id } }] }, f.ctx);
  const after = await f.load();
  assert.deepEqual(after.days[0], before.days[0]); assert.deepEqual(after.days[1], before.days[1]);
  assert.equal(after.days[0]!.items.find((i) => i.id === "b")!.ticket_price_per_person, 60);
});

test("真正换点保留交通位置，复用新端点路线并顺延，其他日期和游览时长保持", async (t) => {
  const f = await fixture(t); const old = await f.route("甲公园", "乙公园", 20);
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), { ...transport("ab", "甲公园", "乙公园", "11:00", "11:20"), route_evidence_id: old.id }, { ...visit("b", "乙公园", "11:30", "13:30"), ticket_price_per_person: 999, note: "旧说明" }]);
  const before = await f.load(), fresh = await f.route("甲公园", "丙公园", 60);
  await f.save.execute({ title: f.title, edits: [{ op: "replace", date, item_id: "b", item: { name: "丙公园" } }] }, f.ctx);
  const after = await f.load(), r = after.days[0]!.items.find((i) => i.id === "ab")!, b = after.days[0]!.items.find((i) => i.id === "b")!;
  assert.equal(r.id, "ab"); assert.equal(r.transport_mode, "transit"); assert.equal(r.route_evidence_id, fresh.id); assert.equal(r.end_time, "12:00"); assert.equal(r.route_verified, true);
  assert.equal(b.time, "12:00"); assert.equal(b.end_time, "14:00"); assert.equal(b.ticket_price_per_person, undefined); assert.equal(b.note, undefined);
  assert.deepEqual(after.days[1], before.days[1]); assert.equal(validateItinerary(after).issue_count.P0, 0);
});

test("故宫规范名称修正只更新交通端点和证据，不删除交通或丢失景点说明", async (t) => {
  const f = await fixture(t);
  await f.evidence.observePlaces("search_attractions", "北京", "1. 故宫 | 坐标 39.9100,116.4100\n2. 故宫博物院 | 坐标 39.9100,116.4100", "amap");
  const old = await f.route("甲公园", "故宫", 20), corrected = await f.route("甲公园", "故宫博物院", 20);
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), { ...transport("to-palace", "甲公园", "故宫", "11:00", "11:30"), route_evidence_id: old.id }, { ...visit("palace", "故宫", "12:00", "14:00"), note: "实名预约说明" }]);
  await f.save.execute({ title: f.title, edits: [{ op: "replace", date, item_id: "palace", item: { name: "故宫博物院" } }] }, f.ctx);
  const items = (await f.load()).days[0]!.items;
  assert.equal(items.find((i) => i.id === "to-palace")!.route_evidence_id, corrected.id);
  assert.equal(items.find((i) => i.id === "to-palace")!.route_verified, true);
  assert.equal(items.find((i) => i.id === "palace")!.note, "实名预约说明");
});

test("查询后只按日期保存即可补交通，用餐不重叠，重复修复不增版本也不再联网", async (t) => {
  const f = await fixture(t); let requests = 0;
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), rest("lunch", "11:00", "12:00"), visit("b", "乙公园", "12:00", "14:00")]);
  setAmapKey("test-key", (async () => { requests++; return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ duration: "2400", walking_distance: "0", segments: [] }] } })); }) as typeof fetch);
  t.after(() => setAmapKey(undefined));
  const query = await createPlanRoutesTool().execute({ city: "北京", stops: ["甲公园", "乙公园"], mode: "transit" }, f.ctx);
  assert.equal(requests, 1); assert.match(query, /尚未修改行程.*repair_routes/);
  assert.match(structuredToolPreview("route", query, 3000)!, /repair_routes/);
  assert.equal((await f.load()).days[0]!.items.filter((i) => i.type === "transport").length, 0);
  const output = await f.repair(), after = await f.load(), items = after.days[0]!.items;
  assert.equal(requests, 1); assert.match(output, /路线修复:.*未联网/);
  assert.equal(items.find((i) => i.id === "lunch")!.end_time, "12:00");
  const leg = items.find((i) => i.type === "transport")!; assert.equal(leg.time, "12:00"); assert.equal(leg.end_time, "12:40"); assert.equal(leg.route_verified, true);
  assert.equal(items.find((i) => i.id === "b")!.time, "12:40"); assert.equal(items.find((i) => i.id === "b")!.end_time, "14:40");
  assert.equal(validateItinerary(after).issues.some((i) => ["missing-route-leg", "time-overlap", "route-duration-too-short"].includes(i.code)), false);
  const unchanged = await readFile(f.file, "utf8"); await f.repair(); assert.equal(await readFile(f.file, "utf8"), unchanged); assert.equal(requests, 1);
});

test("无晨间酒店锚点仍修复首段错误ID，保留原有缓冲并由空档吸收顺延", async (t) => {
  const f = await fixture(t); await f.initial([{ ...transport("out", "甲酒店", "甲公园", "08:00", "09:00"), route_evidence_id: "不存在的ID" }, visit("a", "甲公园", "09:00", "12:00"), rest("lunch", "12:30", "13:30"), visit("b", "乙公园", "14:30", "16:00")]);
  const outbound = await f.route("甲酒店", "甲公园", 77), between = await f.route("甲公园", "乙公园", 20);
  await f.repair(); const after = await f.load(), items = after.days[0]!.items;
  assert.equal(items.find((i) => i.id === "out")!.route_evidence_id, outbound.id);
  assert.equal(items.find((i) => i.id === "out")!.end_time, "09:17");
  assert.equal(items.find((i) => i.id === "a")!.end_time, "12:17"); assert.equal(items.find((i) => i.id === "lunch")!.time, "12:30");
  assert.equal(items.find((i) => i.id === "b")!.time, "14:30");
  assert.equal(items.some((i) => i.route_evidence_id === between.id), true); assert.equal(validateItinerary(after).issue_count.P0, 0);
});

test("固定预约、已知闭馆和可用截止会阻止自动顺延，失败保留所有交付文件", async (t) => {
  for (const constraint of ["locked", "closing", "window"] as const) {
    const f = await fixture(t);
    if (constraint === "closing") await f.evidence.observePlaces("search_attractions", "北京", "1. 乙公园 | 坐标 39.9200,116.4200 | 开放时间 06:00-14:00", "amap");
    await f.initial([visit("a", "甲公园", "10:00", "12:00"), { ...visit("b", "乙公园", "12:00", "14:00"), ...(constraint === "locked" ? { time_locked: true } : {}) }], constraint === "window" ? { available_end: "14:00" } : {});
    await f.route("甲公园", "乙公园", 40);
    const files = [f.file, f.file.replace(/\.json$/, ".md"), f.file.replace(/\.json$/, ".quality.json"), f.file.replace(/\.json$/, ".quality.md")];
    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
    await assert.rejects(f.repair, constraint === "locked" ? /固定12:00，最早12:40.*未提交/ : /未提交任何修改.*仍为版本1/);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before);
  }
});

test("跨午夜不折回当天，不能靠缩短游览塞入路线", async (t) => {
  const f = await fixture(t); await f.initial([visit("a", "甲公园", "20:00", "21:00"), visit("b", "乙公园", "21:00", "23:00")]);
  await f.route("甲公园", "乙公园", 90); const before = await readFile(f.file, "utf8");
  await assert.rejects(f.repair, /推到次日/); assert.equal(await readFile(f.file, "utf8"), before);
});

test("公交只有驾车替代或估算/过时坐标时不自动采用，不掩盖缺失路线", async (t) => {
  const f = await fixture(t); await f.initial([visit("a", "甲公园", "10:00", "11:00"), visit("b", "乙公园", "12:00", "14:00")]);
  await f.route("甲公园", "乙公园", 10, "driving", { request_mode: "transit" });
  let output = await f.repair(), plan = await f.load();
  assert.match(output, /明确.*transport_mode/); assert.equal(plan.days[0]!.items.some((i) => i.type === "transport"), false);
  await f.route("甲公园", "乙公园", 30, "transit", { estimated: true });
  assert.equal(f.evidence.routesForItinerary("甲公园", "乙公园", "北京").some((r) => r.mode === "transit"), false);
  await f.route("甲公园", "乙公园", 30, "transit");
  await f.evidence.observePlaces("search_attractions", "北京", "1. 乙公园 | 坐标 39.9600,116.4600", "amap");
  output = await f.repair(); plan = await f.load();
  assert.match(output, /缺少当前端点的真实证据/); assert.equal(plan.days[0]!.items.some((i) => i.type === "transport"), false);
});

test("未选择方式的交通占位不会把回填的驾车替代误认为计划意图，多方式仍待选择", async (t) => {
  const f = await fixture(t);
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), { ...transport("ab", "甲公园", "乙公园", "11:00", "11:30"), transport_mode: undefined }, visit("b", "乙公园", "12:00", "14:00")]);
  await f.route("甲公园", "乙公园", 10, "driving", { request_mode: "transit" });
  await f.repair(); let slot = (await f.load()).days[0]!.items.find((i) => i.id === "ab")!;
  assert.equal(slot.transport_mode, undefined); assert.equal(slot.route_verified, false); assert.equal(slot.route_evidence_id, undefined);
  await f.route("甲公园", "乙公园", 20, "walking"); await f.route("甲公园", "乙公园", 30, "transit");
  await f.repair(); slot = (await f.load()).days[0]!.items.find((i) => i.id === "ab")!;
  assert.equal(slot.route_verified, false); assert.match(slot.route_binding_error!, /明确.*transport_mode/);
});

test("小数分钟向上保留交通缓冲，非法或未保存日期与版本冲突不修改文件", async (t) => {
  const f = await fixture(t);
  await f.initial([visit("a", "甲公园", "10:00", "11:00"), { ...transport("ab", "甲公园", "乙公园", "11:00", "11:30"), end_time: undefined, planned_duration_min: 30.5 }, visit("b", "乙公园", "12:00", "14:00")]);
  await f.route("甲公园", "乙公园", 20.2); await f.repair();
  const slot = (await f.load()).days[0]!.items.find((i) => i.id === "ab")!;
  assert.equal(slot.end_time, "11:31"); assert.equal(slot.planned_duration_min, 31);
  const before = await readFile(f.file, "utf8");
  for (const repair_routes of [[], ["2026-02-30"], "2026-11-10", Array(91).fill(date)]) await assert.rejects(() => f.save.execute({ title: f.title, repair_routes }, f.ctx), /repair_routes必须/);
  await assert.rejects(() => f.save.execute({ title: f.title, repair_routes: ["2026-11-15"] }, f.ctx), /尚未保存/);
  await assert.rejects(() => f.save.execute({ title: f.title, repair_routes: [date], expected_revision: 0 }, f.ctx), /版本冲突/);
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("晚间活动和晚返酒店不受默认18点参考上限限制，明确截止仍保留", async (t) => {
  const f = await fixture(t);
  await createSaveTravelBriefTool(f.root).execute({ title: f.title, destination: "北京", durationDays: 1, pace: "适中" });
  await f.save.execute({ title: f.title, days: [{ date, items: [visit("a", "甲公园", "10:00", "13:00"), rest("lunch", "13:00", "14:00"), visit("b", "乙公园", "14:00", "17:00"), rest("dinner", "17:00", "18:00"), visit("night", "丙公园", "18:00", "20:00"), { id: "hotel", name: "甲酒店", type: "accommodation", time: "20:30" }] }] }, f.ctx);
  const plan = await f.load(), report = validateItinerary(plan);
  assert.equal(plan.constraints?.day_end, "18:00"); assert.equal(plan.days[0]!.available_end, undefined);
  assert.equal(plan.days[0]!.items.find((i) => i.id === "hotel")!.time, "20:30");
  assert.equal(report.issues.some((i) => ["outside-day-window", "incomplete-day-end"].includes(i.code)), false);
  assert.ok(validateItinerary({ ...plan, days: [{ ...plan.days[0]!, available_end: "18:30" }] }).issues.some((i) => i.code === "outside-day-window"));
  assert.match(TRAVEL_SYSTEM_PROMPT, /不是活动上限或返店截止/); assert.match(TRAVEL_SYSTEM_PROMPT, /未知留空/);
});
