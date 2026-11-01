import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseItinerary, type Itinerary, type ItineraryDay, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { validateItinerary, totalCostPerPerson } from "../src/tools/itinerary-validator.ts";
import { recommendationCoverage } from "../src/tools/recommendation-policy.ts";
import { timelineGaps } from "../src/tools/itinerary-timeline.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { baselineFromResults, diffBaselines } from "../src/eval/baseline.ts";
import { createSaveItineraryTool, createValidateItineraryTool } from "../src/tools/itinerary.ts";
import { Session } from "../src/core/session.ts";
import { updateTravelStateFromSnapshot } from "../src/core/travel-state.ts";

const point = { latitude: 30, longitude: 120, crs: "wgs84" as const };
function item(id: string, name: string, type: ItineraryItem["type"], time: string, end: string): ItineraryItem {
  return { id, name, type, time, end_time: end, source: "manual", confidence: "high", ...(type === "visit" || type === "accommodation" ? { location: point, evidence_id: `e-${id}`, evidence_verified: true } : {}), ...(type === "visit" ? { opening_hours: { opens: "08:00", closes: "20:00" } } : {}) };
}
function day(n: number): ItineraryDay {
  return { date: `2026-11-${String(n).padStart(2, "0")}`, items: [
    item(`v${n}`, `景点${n}`, "visit", "10:00", "12:00"), item(`r${n}`, "午餐休整", "rest", "12:00", "13:00"),
    item(`b${n}`, `另一景点${n}`, "visit", "13:00", "15:00"), item(`f${n}`, "休息", "rest", "15:00", "18:00"),
    item(`h${n}`, "同一家酒店", "accommodation", "18:00", "19:00"),
  ] };
}
function plan(n = 1): Itinerary {
  return parseItinerary({ title: `测试${n}日游`, constraints: { expected_days: n, day_start: "10:00", day_end: "18:00", require_accommodation: true, require_place_evidence: true }, days: Array.from({ length: n }, (_, i) => day(i + 1)) });
}
function meal(id: string, name: string, verified = true, price?: number): ItineraryItem {
  return { id, name, type: "meal", subtype: "lunch", location: point, source: "amap", confidence: "high", evidence_id: `e-${name}`, evidence_verified: verified, rating: 4.5, ...(price === undefined ? {} : { cost_per_person: price }) };
}
function withMeals(p: Itinerary, meals: ItineraryItem[]): Itinerary { return parseItinerary({ ...p, days: [{ ...p.days[0], items: [...p.days[0]!.items, ...meals] }] }); }

test("默认餐饮质量与未知价格只作建议，不改变行程通过、状态或分数", () => {
  const original = plan();
  const lacking = withMeals(original, [meal("m", "未核实餐厅", false)]);
  const clean = validateItinerary(original), report = validateItinerary(lacking);
  assert.equal(report.status, "ok"); assert.equal(report.score, clean.score); assert.equal(report.score, 100);
  assert.deepEqual(report.issue_count, { P0: 0, P1: 0, P2: 0 });
  assert.ok(report.meal_notes.some((i) => i.code === "unverified-place-evidence"));
  assert.ok(report.meal_notes.some((i) => i.code === "recommendation-evidence-coverage"));
  assert.equal(computeItineraryMetrics(lacking, { expectedDays: 1 }).status, "ok");
});

test("餐饮严格策略、数量和证据率可配置；off 不产生餐饮质量建议", () => {
  const original = withMeals(plan(), [meal("a", "餐厅A", true, 30), meal("b", "餐厅B", true, 90)]);
  const strict = parseItinerary({ ...original, constraints: { ...original.constraints, recommendation_mode: "strict", meal_candidates_target: 4, meal_evidence_target: 0.9 } });
  assert.ok(validateItinerary(strict).issues.some((i) => i.code === "recommendation-slot-coverage"));
  const off = parseItinerary({ ...strict, constraints: { ...strict.constraints, recommendation_mode: "off" } });
  assert.equal(validateItinerary(off).status, "ok"); assert.deepEqual(validateItinerary(off).meal_notes, []);
  const both = withMeals(plan(), [{ ...meal("a", "餐厅A", true, 30) }, { ...meal("b", "餐厅B", true, 90) }, { ...meal("c", "餐厅C", true, 40), subtype: "dinner" }, { ...meal("d", "餐厅D", true, 60), subtype: "dinner" }]);
  assert.equal(validateItinerary({ ...both, constraints: { ...both.constraints, recommendation_mode: "strict", meal_candidates_target: 2 } }).status, "ok");
});

test("复制餐厅不能虚增候选数量或证据率，评测与校验完全同口径", () => {
  const p = withMeals(plan(), [meal("a", "A", true, 30), meal("b", "B", true, 30), meal("c", "C", false, 30), ...Array.from({ length: 4 }, (_, i) => meal(`copy${i}`, "A", true, 30))]);
  const coverage = recommendationCoverage(p), metric = computeItineraryMetrics(p, { expectedDays: 1 });
  assert.equal(coverage.slots[0]!.count, 3); assert.equal(metric.mealCandidates, 3);
  assert.equal(metric.mealEvidenceRate, 2 / 3); assert.equal(metric.mealEvidenceRate, coverage.evidenceRate);
  const copied = withMeals(plan(), Array.from({ length: 4 }, (_, i) => meal(`m${i}`, "同一家", true, 30)));
  assert.equal(computeItineraryMetrics(copied, { expectedDays: 1 }).mealSlotsOk, 0);
});

test("餐饮预算也按相同去重候选均价计算，同餐复制条目不改变预算", () => {
  const p = withMeals(plan(), [meal("a", "A", true, 30), meal("b", "B", true, 90), ...Array.from({ length: 4 }, (_, i) => meal(`m${i}`, "A", true, 30))]);
  assert.equal(totalCostPerPerson(p), 60); assert.equal(computeItineraryMetrics(p, { expectedDays: 1 }).costPerPerson, 60);
});

test("餐厅候选不能填补实际时间空档；加入真实休整块后才消除", () => {
  const p = parseItinerary({ title: "空档", days: [{ items: [item("a", "景点A", "visit", "10:00", "12:00"), { ...meal("m", "候选", true, 30), time: "12:30", end_time: "13:00" }, item("b", "景点B", "visit", "16:00", "17:00")] }] });
  assert.equal(validateItinerary(p).issues.filter((i) => i.code === "timeline-gap").length, 1);
  assert.equal(computeItineraryMetrics(p, { expectedDays: 1 }).maxGapMinutes, 240);
  const fixed = parseItinerary({ ...p, days: [{ items: [p.days[0]!.items[0], item("r", "用餐及自由活动", "rest", "12:00", "16:00"), ...p.days[0]!.items.slice(1)] }] });
  assert.equal(validateItinerary(fixed).issues.filter((i) => i.code === "timeline-gap").length, 0);
  assert.equal(computeItineraryMetrics(fixed, { expectedDays: 1 }).maxGapMinutes, 0);
});

test("空档计算使用时间块并集，嵌套区间和无时长备注都不能制造或遮蔽空档", () => {
  const d = { items: [item("a", "长活动", "free_time", "10:00", "18:00"), item("b", "嵌套块", "rest", "11:00", "12:00"), { id: "note", name: "提醒", type: "note" as const, time: "18:30" }, item("c", "活动C", "visit", "20:00", "21:00")] };
  assert.deepEqual(timelineGaps(d).map((g) => g.minutes), [120]);
});

test("到离日期使用可用时间与适用餐段，不能仅靠改 day_type 绕过检查", () => {
  const arrival = parseItinerary({ title: "到达一日游", constraints: { day_start: "10:00", day_end: "18:00", require_accommodation: true }, days: [{ day_type: "arrival", available_start: "20:00", items: [item("h", "酒店", "accommodation", "20:30", "21:00")] }] });
  assert.equal(validateItinerary(arrival).issue_count.P1, 0);
  assert.equal(recommendationCoverage(arrival).slots.length, 1, "20点仍在晚餐候选时段");
  const departure = parseItinerary({ title: "离开一日游", constraints: { day_start: "10:00", day_end: "18:00", require_accommodation: true }, days: [{ day_type: "departure", available_end: "10:00", items: [item("t", "返程", "transport", "08:00", "10:00")] }] });
  assert.equal(validateItinerary(departure).issue_count.P1, 0); assert.equal(recommendationCoverage(departure).slots.length, 0);
  const missingWindow = parseItinerary({ ...departure, days: [{ ...departure.days[0], available_end: undefined }] });
  assert.ok(validateItinerary(missingWindow).issues.some((i) => i.code === "missing-day-window"));
  const invalidPosition = parseItinerary({ ...plan(3), days: [{ ...day(1), day_type: "departure", available_end: "20:00" }, day(2), day(3)] });
  assert.ok(validateItinerary(invalidPosition).issues.some((i) => i.code === "invalid-day-role"));
});

test("当天已知可用时间之外的活动仍是硬错误", () => {
  const p = parseItinerary({ ...plan(), days: [{ ...day(1), available_start: "11:00" }] });
  assert.ok(validateItinerary(p).issues.some((i) => i.code === "outside-day-window" && i.level === "P1"));
});

test("同一段遗漏交通合并根因，同时保留独立检查码和具体修复证据", () => {
  const a = { ...item("a", "A", "visit", "10:00", "12:00"), location: { ...point, longitude: 120 } };
  const b = { ...item("b", "B", "visit", "12:00", "14:00"), location: { ...point, longitude: 120.1 } };
  const p = parseItinerary({ title: "路线", constraints: { require_routes: true }, days: [{ items: [a, b] }] });
  const report = validateItinerary(p), roots = report.issues.filter((i) => i.root_key?.startsWith("leg:"));
  assert.equal(roots.length, 1); assert.equal(report.issue_count.P1, 1);
  assert.ok(roots[0]!.related_codes?.includes("transfer-too-tight")); assert.ok(roots[0]!.related_codes?.includes("missing-route-leg"));
  assert.ok(roots[0]!.related_codes?.includes("spatial-gap")); assert.equal(report.scoring!.dimensions.routing.failed, 1);
});

test("已有交通块但核验证据未知标为待确认，仍不允许最终严格通过", () => {
  const p = parseItinerary({ title: "待确认", constraints: { require_routes: true }, days: [{ items: [item("a", "A", "visit", "10:00", "11:00"), { ...item("t", "A到B", "transport", "11:00", "12:00"), from: "A", to: "B", transport_mode: "driving" }, { ...item("b", "B", "visit", "12:00", "13:00"), location: { ...point, longitude: 120.1 } }] }] });
  const report = validateItinerary(p);
  assert.equal(report.status, "needs_confirmation"); assert.ok(report.issue_count.P1 > 0); assert.equal(report.daily![0]!.strict_pass, false);
});

test("相同缺陷密度的长短行程得分一致，单个缺陷的占比随检查对象数变化", () => {
  const missingOpening = (p: Itinerary, each: boolean) => parseItinerary({ ...p, days: p.days.map((d, n) => ({ ...d, items: d.items.map((i, j) => j === 0 && (each || n === 0) ? { ...i, opening_hours: undefined } : i) })) });
  const short = validateItinerary(missingOpening(plan(3), true)), long = validateItinerary(missingOpening(plan(9), true));
  assert.equal(short.score, long.score); assert.equal(short.scoring!.dimensions.evidence.failed, 3); assert.equal(long.scoring!.dimensions.evidence.failed, 9);
  assert.ok(validateItinerary(missingOpening(plan(9), false)).score >= validateItinerary(missingOpening(plan(3), false)).score);
});

test("堆积餐厅条目不增加评分分母，高分也不能掩盖时间冲突或已知闭馆", () => {
  const p = plan(9), broken = structuredClone(p);
  const first = broken.days[0]!.items[0]!;
  (broken.days[0]!.items as ItineraryItem[])[1] = { ...broken.days[0]!.items[1]!, time: "11:00" };
  const report = validateItinerary(broken); assert.ok(report.score > 80); assert.ok(report.issue_count.P0 > 0); assert.equal(report.status, "invalid");
  const spam = withMeals(plan(), Array.from({ length: 100 }, (_, i) => meal(`m${i}`, `餐厅${i}`, false)));
  assert.deepEqual(validateItinerary(spam).scoring!.dimensions, validateItinerary(plan()).scoring!.dimensions);
  const closed = parseItinerary({ title: "闭馆", days: [{ date: "2026-11-02", items: [{ ...first, closed_on: ["Monday"] }] }] });
  assert.ok(validateItinerary(closed).issues.some((i) => i.code === "closed-on-date" && i.level === "P0"));
});

test("跨天重复优先修本次改变日，已有日保持通过；日验收不能替代完整验收", () => {
  const p = plan(3);
  const duplicate = parseItinerary({ ...p, days: [p.days[0], p.days[1], { ...p.days[2], items: p.days[2]!.items.map((i, j) => j === 0 ? { ...i, name: p.days[0]!.items[0]!.name } : i) }] });
  const report = validateItinerary(duplicate, { changed_days: [3] });
  assert.deepEqual(report.repair_days, [3]); assert.deepEqual(report.issues.find((i) => i.code === "cross-day-duplicate")!.related_days, [1, 3]);
  assert.equal(report.daily![0]!.strict_pass, true); assert.equal(report.daily![2]!.strict_pass, false); assert.ok(report.affected_days!.includes(1));
  const partial = validateItinerary({ ...p, days: p.days.slice(0, 1) });
  assert.equal(partial.daily![0]!.strict_pass, true); assert.ok(partial.issue_count.P1 > 0); assert.ok(partial.score <= 34);
});

test("同名但明确不同地点不误报跨天重复，缺少实体依据时只标待确认", () => {
  const p = plan(2);
  const distinct = parseItinerary({ ...p, days: [p.days[0], { ...p.days[1], items: p.days[1]!.items.map((i, j) => j === 0 ? { ...i, name: p.days[0]!.items[0]!.name, location: { ...point, longitude: 120.1 } } : i) }] });
  assert.equal(validateItinerary(distinct).issues.some((i) => i.code === "cross-day-duplicate"), false);
  const unknown = parseItinerary({ title: "同名", days: [1, 2].map((n) => ({ items: [{ id: `v${n}`, type: "visit", name: "同名景点", time: "10:00", end_time: "11:00" }] })) });
  assert.equal(validateItinerary(unknown).issues.find((i) => i.code === "cross-day-duplicate")!.kind, "pending");
});

test("跨天住宿/出发衔接明显可疑时立即提示关联日期，不要求重排全部行程", () => {
  const p = parseItinerary({ title: "跨天", days: [
    { date: "2026-11-01", items: [{ ...item("h", "晚间住处", "accommodation", "22:00", "23:00"), location: point }] },
    { date: "2026-11-02", items: [{ ...item("v", "次日远处景点", "visit", "06:00", "08:00"), location: { ...point, longitude: 130 } }] },
  ] });
  const issue = validateItinerary(p, { changed_days: [2] }).issues.find((i) => i.code === "overnight-transfer-unverified")!;
  assert.ok(issue); assert.deepEqual(issue.related_days, [1, 2]); assert.equal(issue.day, 2); assert.equal(issue.kind, "pending");
});

async function workspace(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "minicode-acceptance-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("保存/分日验收/全体验收实际调用链保留草稿，报告和状态中的日内通过可持久化", async (t) => {
  const root = await workspace(t), save = createSaveItineraryTool(root), validate = createValidateItineraryTool(root), session = new Session();
  const p = plan(3), first = { ...p, constraints: { ...p.constraints, require_place_evidence: false }, days: p.days.slice(0, 1) };
  const text = await save.execute(first as unknown as Record<string, unknown>, { workspace: root, onItinerary: (snapshot) => session.setTravelState(updateTravelStateFromSnapshot(session.travelState, snapshot)) });
  assert.match(text, /D1 日内通过/); assert.match(text, /strict: 未通过/);
  assert.equal(session.travelState!.itinerary!.daySummaries![0]!.strictPass, true);
  assert.equal(Session.fromData(session.toData()).travelState!.itinerary!.daySummaries![0]!.strictPass, true);
  assert.match(await validate.execute({ title: p.title, scope: "day", day: 1, strict: true }), /日内验收：通过/);
  await assert.rejects(validate.execute({ title: p.title, scope: "all", strict: true }), /strict/);
  await assert.rejects(validate.execute({ title: p.title, scope: "day", day: 4 }), /有效 day/);
  await save.execute({ title: p.title, merge: true, days: p.days.slice(1) });
  assert.match(await validate.execute({ title: p.title, scope: "all", strict: true }), /状态: 通过/);
});

test("增量追加重复景点只提示修新增日，原日 JSON 不发生改变，餐饮策略跨保存保留", async (t) => {
  const root = await workspace(t), save = createSaveItineraryTool(root), p = plan(3);
  await save.execute({ title: p.title, days: p.days.slice(0, 2), recommendation_policy: { mode: "advisory", min_candidates: 3, min_evidence_rate: 0.6 } });
  const file = join(root, `plans/${p.title}.json`), before = JSON.parse(await readFile(file, "utf8"));
  const third = { ...p.days[2], items: p.days[2]!.items.map((i, j) => j === 0 ? { ...i, name: p.days[0]!.items[0]!.name } : i) };
  const result = await save.execute({ title: p.title, merge: true, days: [third] });
  assert.match(result, /局部修复日期: 3/);
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(after.days.slice(0, 2), before.days); assert.equal(after.constraints.meal_candidates_target, 3);
  const report = JSON.parse(await readFile(join(root, `plans/${p.title}.quality.json`), "utf8"));
  assert.deepEqual(report.changed_days, [3]); assert.deepEqual(report.repair_days, [3]);
  const validate = createValidateItineraryTool(root);
  assert.match(await validate.execute({ title: p.title, scope: "day", day: 1, strict: true }), /跨天关联/);
  await assert.rejects(validate.execute({ title: p.title, scope: "day", day: 3, strict: true }), /cross-day-duplicate/);
  await save.execute({ title: p.title, merge: true, merge_mode: "replace_day", days: [p.days[2]] });
  assert.match(await validate.execute({ title: p.title, strict: true }), /状态: 通过/);
  const repaired = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(repaired.days.slice(0, 2), before.days);
});

test("非法策略、日期类型、时间窗口拒绝；不能用未知模式绕过要求", async (t) => {
  const root = await workspace(t), save = createSaveItineraryTool(root);
  await assert.rejects(save.execute({ title: "策略", days: [day(1)], recommendation_policy: { mode: "unknown" } }), /recommendation_mode/);
  for (const bad of [0, -1, 2.5, 21]) await assert.rejects(save.execute({ title: "策略", days: [day(1)], recommendation_policy: { min_candidates: bad } }), /meal_candidates_target/);
  assert.throws(() => parseItinerary({ ...plan(), days: [{ ...day(1), available_start: "15:00", available_end: "10:00" }] }), /可用时段/);
});

test("新旧评分版本的基线明确不可比，不把口径调整标为质量改善", () => {
  const p = plan(), metric = computeItineraryMetrics(p, { expectedDays: 1 });
  const newer = baselineFromResults([{ id: "a", title: p.title, metrics: metric }], "test");
  const older = { ...newer, samples: newer.samples.map((s) => ({ ...s, score: 20, scoreVersion: undefined })) };
  const diff = diffBaselines(older, newer);
  assert.equal(diff.rows[0]!.verdict, "incomparable"); assert.equal(diff.improved, 0); assert.equal(diff.regressed, 0);
});
