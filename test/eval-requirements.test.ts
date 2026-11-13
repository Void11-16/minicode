import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadSuite, parseEvalCase } from "../src/eval/cases.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { checkRequirements, parseRequirements, requirementFailures, type EvalRequirements } from "../src/eval/requirements.ts";
import { parseItinerary, type Itinerary } from "../src/tools/itinerary-schema.ts";

function fixture(): Itinerary {
  return parseItinerary({
    title: "苏州两日游",
    travelers: 3,
    room_count: 2,
    constraints: { destination: "苏州" },
    days: [
      { date: "2026-11-14", items: [
        { id: "v1", type: "visit", name: "拙政园", time: "10:00", end_time: "12:00" },
        { id: "m1", type: "meal", subtype: "lunch", name: "午餐", time: "12:00", end_time: "13:00" },
        { id: "s1", type: "accommodation", name: "测试酒店人民路店", location: { poi_id: "hotel-1" } },
      ] },
      { date: "2026-11-15", items: [
        { id: "v2", type: "visit", name: "苏州博物馆", time: "10:00", end_time: "12:00" },
        { id: "s2", type: "accommodation", name: "测试酒店（人民路店）", location: { poi_id: "hotel-1" } },
      ] },
    ],
  });
}

const requirements: EvalRequirements = {
  dates: ["2026-11-14", "2026-11-15"],
  forbidden_visits: ["虎丘"],
  max_visits_per_day: 2,
  daily_window: { start: "10:00", end: "18:00" },
  day_windows: [{ day: 2, start: "10:00", end: "15:00" }],
  travelers: 3,
  room_count: 2,
  fixed_stay: true,
};

test("需求验收：实际满足条件时通过，时间边界可取等号，酒店 POI 可以消除别名差异", () => {
  const checks = checkRequirements(fixture(), requirements);
  assert.ok(checks.length > 8);
  assert.deepEqual(requirementFailures({ requirementChecks: checks }), []);
});

test("需求验收：不能靠模型自填 constraints、可用时段或总人数来掩盖实际违约", () => {
  const broken = parseItinerary({
    ...fixture(), travelers: 2,
    constraints: { destination: "苏州", start_date: "2026-11-14", end_date: "2026-11-15", day_start: "10:00", day_end: "18:00" },
    days: [
      { date: "2026-11-13", available_start: "10:00", available_end: "18:00", items: [
        { id: "a", type: "visit", name: "苏州市虎丘", time: "09:00", end_time: "11:00" },
        { id: "b", type: "visit", name: "拙政园", time: "11:00", end_time: "12:00" },
        { id: "c", type: "visit", name: "苏州博物馆", time: "13:00", end_time: "16:00" },
        { id: "s", type: "accommodation", name: "酒店甲", room_count: 1 },
      ] },
      { date: "2026-11-15", items: [
        { id: "d", type: "visit", name: "平江路", time: "14:00", end_time: "16:00" },
        { id: "s2", type: "accommodation", name: "酒店乙", room_count: 2 },
      ] },
    ],
  });
  const failed = new Set(checkRequirements(broken, requirements).filter((check) => !check.passed).map((check) => check.code));
  assert.deepEqual(failed, new Set(["requested-dates", "forbidden-visit", "daily-visit-limit", "activity-window", "traveler-count", "room-count", "fixed-stay"]));
});

test("需求验收：缺少时间、缺少末日、重复日期、没有住宿均不能空通过", () => {
  const missing = parseItinerary({ ...fixture(), days: [{ date: "2026-11-14", items: [{ id: "v", type: "visit", name: "拙政园" }] }] });
  const failed = checkRequirements(missing, requirements).filter((check) => !check.passed).map((check) => check.code);
  for (const code of ["requested-dates", "activity-window", "fixed-stay", "room-count"]) assert.ok(failed.includes(code), code);
  const duplicate = { ...fixture(), days: fixture().days.map((day) => ({ ...day, date: "2026-11-14" })) };
  assert.ok(checkRequirements(duplicate, requirements).some((check) => check.code === "requested-dates" && !check.passed));
});

test("需求时间窗沿用行程时间线口径：餐厅候选不占时间，计划时长可推导结束时间", () => {
  const itinerary = parseItinerary({ title: "一日游", days: [{ items: [
    { id: "v", type: "visit", name: "天坛", time: "13:00", planned_duration_min: 120 },
    { id: "r", type: "rest", name: "用餐时间", time: "15:00", end_time: "16:00" },
    { id: "m1", type: "meal", name: "候选甲" },
    { id: "m2", type: "meal", name: "候选乙", time: "12:00", end_time: "12:30" },
  ] }] });
  const requirements = { daily_window: { start: "13:00", end: "20:00" } };
  assert.ok(checkRequirements(itinerary, requirements).every((check) => check.passed));
  const invalid = { ...itinerary, days: [{ items: [{ ...itinerary.days[0]!.items[0]!, planned_duration_min: 480 }] }] };
  assert.ok(checkRequirements(invalid, requirements).some((check) => !check.passed));
  const onlyCandidates = { ...itinerary, days: [{ items: itinerary.days[0]!.items.filter((item) => item.type === "meal") }] };
  assert.ok(checkRequirements(onlyCandidates, requirements).some((check) => !check.passed));
});

test("需求验收：禁止点检查父景区与内部推荐点，每日数量按主景区计数", () => {
  const itinerary = parseItinerary({ title: "北京一日游", days: [{ items: [
    { id: "a", type: "visit", name: "天坛-祈年殿", parent_visit: { name: "天坛" }, recommended_spots: ["皇穹宇"] },
    { id: "b", type: "visit", name: "天坛-回音壁", parent_visit: { name: "天坛" } },
  ] }] });
  const checks = checkRequirements(itinerary, { forbidden_visits: ["天坛", "皇穹宇"], max_visits_per_day: 1 });
  assert.equal(checks.filter((check) => check.code === "forbidden-visit" && !check.passed).length, 2);
  assert.ok(checks.find((check) => check.code === "daily-visit-limit")?.passed);
});

test("需求验收：固定酒店不能漏过夜日，也不能同名不同 POI 或条目房数覆盖全局", () => {
  const itinerary = fixture();
  const different = { ...itinerary, days: itinerary.days.map((day, i) => ({ ...day, items: day.items.map((item) => item.type === "accommodation" ? { ...item, name: "同名酒店", location: { poi_id: `branch-${i}` }, room_count: 1 } : item) })) };
  assert.ok(requirementFailures({ requirementChecks: checkRequirements(different, requirements) }).some((failure) => failure.startsWith("fixed-stay:")));
  assert.ok(requirementFailures({ requirementChecks: checkRequirements(different, requirements) }).some((failure) => failure.startsWith("room-count:")));
  const noFirstStay = { ...itinerary, days: itinerary.days.map((day, i) => ({ ...day, items: day.items.filter((item) => i !== 0 || item.type !== "accommodation") })) };
  assert.ok(checkRequirements(noFirstStay, requirements).some((check) => check.code === "fixed-stay" && !check.passed));
});

test("评测指标保留通用分数，案例验收另存检查结果，旧案例无新增要求", () => {
  const normal = computeItineraryMetrics(fixture(), { expectedDays: 2 });
  const checked = computeItineraryMetrics(fixture(), { expectedDays: 2, requirements: { travelers: 4 } });
  assert.equal(checked.score, normal.score);
  assert.equal(checked.scoreVersion, normal.scoreVersion);
  assert.equal(normal.requirementChecks, undefined);
  assert.equal(requirementFailures(checked).length, 1);
});

test("需求文件验证：拒绝未知字段、无效日期、重复日序、越界时刻与非有限预算", () => {
  for (const raw of [null, [], { travelrs: 3 }, { travelers: 0 }, { room_count: 1.5 }, { fixed_stay: "true" },
    { dates: ["2026-02-30", "2026-03-03"] }, { dates: ["2026-11-14", "2026-11-16"] },
    { daily_window: { start: "24:00", end: "25:00" } }, { daily_window: { start: "18:00", end: "10:00" } },
    { daily_window: { start: "10:00", end: "18:00", typo: 1 } },
    { day_windows: [{ day: 3, start: "10:00", end: "18:00" }] },
    { day_windows: [1, 1].map((day) => ({ day, start: "10:00", end: "18:00" })) },
    { forbidden_visits: [""] },
  ]) assert.throws(() => parseRequirements(raw, 2, "case"), /requirements/);
  for (const budget of [-1, NaN, Infinity]) assert.throws(() => parseEvalCase({ id: "case", title: "测试", days: 1, request: "测试", budget_per_person_yuan: budget }, "case"), /预算|budget/);
});

test("新增套件可加载、必去与软偏好可追踪，CLI 可零生成费用按标签查看", async () => {
  const suite = await loadSuite(resolve("eval/suites/comprehensive.json"));
  assert.equal(suite.cases.length, 12);
  assert.ok(suite.cases.every((item) => item.requirements && item.review_focus?.length && item.must_visit?.length));
  for (const tag of ["family", "senior", "accessibility", "dietary", "budget", "weather", "arrival-departure", "fixed-stay", "remote-day"]) {
    assert.ok(suite.cases.some((item) => item.tags?.includes(tag)), tag);
  }
  const output = JSON.parse(execFileSync(process.execPath, ["src/eval/main.ts", "--suite", "comprehensive", "--list", "--tag", "senior"], { cwd: resolve("."), encoding: "utf8" }));
  assert.equal(output.cases.length, 1);
  assert.equal(output.cases[0].requirements.travelers, 3);
});
