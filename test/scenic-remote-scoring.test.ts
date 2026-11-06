import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { groupScenicAttractions, scenicParentName } from "../src/tools/scenic-area.ts";
import { parseItinerary, type Itinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { createSaveItineraryTool, createLoadItineraryTool, renderMarkdown } from "../src/tools/itinerary.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { structuredToolPreview } from "../src/agent/tool-preview.ts";
import { applyPlanEdit } from "../src/web/plan-edit.ts";
import { opportunityScore } from "../src/tools/itinerary-assessment.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";

const location = { latitude: 39.916, longitude: 116.397, crs: "wgs84" as const };
const visit = (id = "v", name = "故宫博物院", time = "10:00", end_time = "12:00"): ItineraryItem => ({ id, name, type: "visit", time, end_time, location, source: "manual", confidence: "high", opening_hours: { opens: "08:00", closes: "18:00" } });
const plan = (items: readonly ItineraryItem[]): Itinerary => parseItinerary({ title: "景区测试", days: [{ date: "2026-11-03", items }] });

test("主子点搜索归并保留主 POI 坐标、评分、证据，内部推荐贯通保存/读取/Markdown/评测", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scenic-"));
  t.after(() => { setAmapKey(undefined); return rm(root, { recursive: true, force: true }); });
  const pois = [
    { id: "parent", name: "故宫博物院", location: "116.3970,39.9160", biz_ext: { rating: "4.2" } },
    { id: "child", name: "故宫博物院-大石雕", location: "116.3980,39.9170", biz_ext: { rating: "4.9" } },
    { id: "t", name: "天坛公园", location: "116.4000,39.9000", biz_ext: { rating: "4.6" } },
    { id: "q", name: "祈年殿", parent: "t", location: "116.4010,39.9010", biz_ext: { rating: "4.8" } },
  ].map((p) => ({ ...p, cityname: "北京市", type: "风景名胜" }));
  setAmapKey("test-key", (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return new Response(JSON.stringify({ status: "1", infocode: "10000", ...(url.pathname.includes("geocode")
      ? { geocodes: [{ formatted_address: "北京市东城区景区归并中心", city: "北京市", province: "北京市", location: "116.3970,39.9160" }] }
      : { pois }) }));
  }) as typeof fetch);
  const evidence = new TravelEvidenceStore(root);
  const output = await createAttractionsTool().execute({ location: "景区归并中心", city: "北京", limit: 2 }, { workspace: root, evidence });
  assert.match(output, /1\. 天坛公园/); // 按主 POI 自身评分排序，子点高分不能冒充主评分。
  assert.match(output, /2\. 故宫博物院 \|/);
  assert.doesNotMatch(output, /\d+\. 故宫博物院-大石雕/);
  assert.match(output, /内部推荐 \["祈年殿"\]/);
  const reloaded = new TravelEvidenceStore(root); await reloaded.load();
  await createSaveItineraryTool(root).execute({ title: "景区测试", days: [{ items: [visit()] }] }, { workspace: root, evidence: reloaded });
  const saved = parseItinerary(JSON.parse(await readFile(join(root, "plans/景区测试.json"), "utf8")));
  const main = saved.days[0]!.items[0]!;
  assert.deepEqual(main.recommended_spots, ["故宫博物院-大石雕"]);
  assert.equal(main.rating, 4.2);
  assert.equal(main.location!.latitude, 39.916);
  assert.equal(main.evidence_verified, true);
  assert.equal(saved.days[0]!.items.length, 1);
  assert.match(renderMarkdown(saved), /内部推荐 故宫博物院-大石雕/);
  assert.match(await createLoadItineraryTool(root).execute({ title: "景区测试", day: 1, summary: true }), /内部推荐 故宫博物院-大石雕/);
  assert.equal(computeItineraryMetrics(saved, { expectedDays: 1 }).visitsPerDay, 1);
});

test("缺少主 POI 时不虚构主景区，不把同城不同博物馆归并", () => {
  const entries = ["故宫博物院-大石雕", "首都博物馆", "中国国家博物馆"].map((name) => ({ poi: { name } }));
  assert.deepEqual(groupScenicAttractions(entries).map((g) => g.main.poi.name), entries.map((e) => e.poi.name));
  assert.equal(scenicParentName("中国国家博物馆"), undefined);
  assert.equal(scenicParentName("颐和园-佛香阁"), "颐和园");
  const childOnly = parseItinerary({ ...plan([visit("child", "故宫博物院-大石雕")]), constraints: { must_visit: ["故宫"] } });
  assert.ok(validateItinerary(childOnly).issues.some((i) => i.code === "uncertain-required-visit"));
  const grouped = parseItinerary({ ...plan([{ ...visit(), recommended_spots: ["故宫博物院-大石雕"] }]), constraints: { must_visit: ["故宫"] } });
  assert.ok(!validateItinerary(grouped).issues.some((i) => /required-visit/.test(i.code)));
});

test("拆分休息、自由活动、备注以及附加其坐标不能增加评分分母或提高分数", () => {
  const first = { ...visit(), opening_hours: undefined };
  const rest: ItineraryItem = { id: "r", name: "午间休息", type: "rest", time: "12:00", end_time: "13:00", source: "manual", confidence: "high" };
  const tail = visit("v2", "景山公园", "13:00", "15:00");
  const baseline = validateItinerary(plan([first, rest, tail]));
  const padded = validateItinerary(plan([first, ...Array.from({ length: 60 }, (_, i): ItineraryItem => ({ ...rest,
    id: `pad-${i}`, type: (["rest", "free_time", "note"] as const)[i % 3]!, location,
    time: `12:${String(i).padStart(2, "0")}`, end_time: i === 59 ? "13:00" : `12:${String(i + 1).padStart(2, "0")}` })), tail]));
  assert.deepEqual(padded.scoring, baseline.scoring);
  assert.equal(padded.score, baseline.score);
  const conflict = validateItinerary(plan([visit(), { ...rest, time: "11:30" }]));
  assert.ok(conflict.issues.some((i) => i.code === "time-overlap" && i.level === "P0"));
});

test("旧行程拆开的主子点不增加主目的地/评分机会；跨天安排同主景区会提示关联日期", () => {
  const base = plan([visit()]);
  const split = plan([visit(), visit("child", "故宫博物院-大石雕", "12:00", "12:30")]);
  const checked = (p: Itinerary) => Object.values(opportunityScore(p, []).dimensions).map((d) => d.checked);
  assert.deepEqual(checked(split), checked(base));
  assert.equal(computeItineraryMetrics(split, { expectedDays: 1 }).visitsPerDay, 1);
  const repeated = parseItinerary({ title: "复游", days: [...base.days, { date: "2026-11-04", items: [visit("child", "故宫博物院-大石雕")] }] });
  const issue = validateItinerary(repeated, { changed_days: [2] }).issues.find((i) => i.code === "cross-day-duplicate");
  assert.deepEqual(issue?.related_days, [1, 2]); assert.equal(issue?.day, 2);
});

function remote(minutes = 180): Itinerary {
  const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return parseItinerary({ title: "长城远郊日", constraints: { day_start: "10:00", day_end: "18:00", must_visit: ["长城"] }, days: [{ date: "2026-11-03", items: [
    { id: "out", name: "市区到长城", type: "transport", time: "07:00", end_time: clock(420 + minutes), from: "市区", to: "八达岭长城", distance_km: 65, source: "manual", confidence: "high" },
    { ...visit("wall", "八达岭长城", clock(420 + minutes), clock(540 + minutes)), location: { ...location, latitude: 40.359, longitude: 116.02 } },
    { id: "return", name: "长城回市区", type: "transport", time: clock(540 + minutes), end_time: clock(540 + 2 * minutes), from: "八达岭长城", to: "市区", planned_duration_min: minutes, distance_km: 65, source: "manual", confidence: "high" },
  ] }] });
}

test("远郊长通勤默认单段240分钟、支持配置；end_time实际时长和已知短距离正确分流", () => {
  const report = validateItinerary(remote());
  assert.deepEqual(report.issues.filter((i) => i.code === "long-transport").map((i) => i.level), ["P2", "P2"]);
  assert.equal(report.issue_count.P1, 0);
  assert.ok(!report.issues.some((i) => i.code === "incomplete-day-end"), "完成远郊往返后不需要凑到18点");
  const limit = (p: Itinerary, value: number) => parseItinerary({ ...p, constraints: { ...p.constraints, remote_leg_limit_min: value } });
  assert.ok(validateItinerary(limit(remote(), 150)).issues.some((i) => i.code === "long-transport" && i.level === "P1"));
  assert.ok(!validateItinerary(remote(240)).issues.some((i) => i.code === "long-transport" && i.level === "P1"));
  assert.ok(validateItinerary(remote(241)).issues.some((i) => i.code === "long-transport" && i.level === "P1"));
  const city = parseItinerary({ ...remote(), days: remote().days.map((day) => ({ ...day, items: day.items.map((item) => item.type === "transport" ? { ...item, distance_km: 5 } : item) })) });
  assert.ok(validateItinerary(limit(city, 480)).issues.some((i) => i.code === "long-transport" && i.level === "P1"));
  for (const value of [0, 59, 481, NaN, Infinity, "240"]) assert.throws(() => parseItinerary({ ...remote(), constraints: { remote_leg_limit_min: value } }));
});

test("远郊/必去/热门不豁免路线耗时、可用时间、闭馆检查，休息不能填满普通日覆盖", () => {
  const p = remote();
  const invalid = parseItinerary({ ...p, days: p.days.map((day) => ({ ...day, available_end: "14:00", items: day.items.map((item) => item.type === "transport" ? { ...item, route_duration_min: 200 } : { ...item, closed_on: ["Tuesday"] }) })) });
  const codes = validateItinerary(invalid).issues.map((i) => i.code);
  for (const code of ["route-duration-too-short", "outside-day-window", "closed-on-date"]) assert.ok(codes.includes(code), code);
  const padded = parseItinerary({ ...plan([visit(), { id: "rest", name: "自由休息", type: "free_time", time: "12:00", end_time: "18:00", source: "manual", confidence: "high" }]), constraints: { day_end: "18:00" } });
  assert.ok(validateItinerary(padded).issues.some((i) => i.code === "incomplete-day-end"));
});

test("内部推荐不是独立行程项，字段有边界约束", () => {
  assert.deepEqual(parseItinerary(plan([{ ...visit(), recommended_spots: [" 大石雕 ", "大石雕"] }])).days[0]!.items[0]!.recommended_spots, ["大石雕"]);
  for (const recommended_spots of [[""], ["x".repeat(101)], Array(11).fill("点"), "大石雕"]) assert.throws(() => parseItinerary({ title: "坏字段", days: [{ items: [{ ...visit(), recommended_spots }] }] }));
  assert.throws(() => parseItinerary({ title: "坏类型", days: [{ items: [{ ...visit(), type: "rest", recommended_spots: ["大石雕"] }] }] }));
});


test("远郊配置经过真实保存/增量更新仍保留，替换主景点清除旧内部推荐", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "remote-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = createSaveItineraryTool(root);
  await save.execute({ title: "配置保存", remote_leg_limit_min: 300, days: [{ date: "2026-11-03", items: [{ ...visit(), recommended_spots: ["大石雕"] }] }] });
  await save.execute({ title: "配置保存", merge: true, days: [{ date: "2026-11-04", items: [visit("other", "景山公园")] }] });
  const read = async () => parseItinerary(JSON.parse(await readFile(join(root, "plans/配置保存.json"), "utf8")));
  assert.equal((await read()).constraints?.remote_leg_limit_min, 300);
  await applyPlanEdit(root, { title: "配置保存", day: 1, item_id: "v", op: "replace", replacement: { name: "北海公园", latitude: 39.925, longitude: 116.389 } });
  assert.equal((await read()).days[0]!.items[0]!.recommended_spots, undefined);
  await assert.rejects(() => save.execute({ title: "配置保存", remote_leg_limit_min: 999, merge: true, days: [{ date: "2026-11-04", items: [visit("other", "景山公园")] }] }));
  assert.equal((await read()).constraints?.remote_leg_limit_min, 300);
});


test("工具结果压缩仍保留主景区内部推荐和仅返回子点的归属提示", () => {
  const text = '周边景点\n1. 故宫博物院 | 博物院 | 坐标 39.9160,116.3970 | 内部推荐 ["大石雕"]\n2. 颐和园-佛香阁 | 古迹 | 坐标 39.9900,116.2700 | 所属主景区 颐和园（主 POI 未返回，选用前需核验）';
  const preview = structuredToolPreview("place-list", text, 1500)!;
  assert.match(preview, /内部推荐 \["大石雕"\]/); assert.match(preview, /主 POI 未返回/);
  const json = JSON.stringify({ title: "景区测试", days: [{ items: [{ ...visit(), recommended_spots: ["大石雕"] }] }] });
  assert.match(structuredToolPreview("itinerary", json, 1500)!, /"recommended_spots":\["大石雕"\]/);
});
