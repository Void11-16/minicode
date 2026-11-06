import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseItinerary, type Itinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { itemEndMinutes } from "../src/tools/itinerary-timeline.ts";
import { dayBoundarySeverity, activeDurationSeverity } from "../src/tools/timing-policy.ts";
import { opportunityScore } from "../src/tools/itinerary-assessment.ts";
import { totalCostPerPerson, validateItinerary } from "../src/tools/itinerary-validator.ts";
import { normalizeStayReferences } from "../src/tools/stay-policy.ts";
import { CLOSURE_POLICY_VERSION, extractClosure } from "../src/tools/closure-policy.ts";
import { officialOpeningSource } from "../src/tools/official-opening.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "travel-grading-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const stay = (id: string, name = "甲酒店", time = "18:00"): ItineraryItem => ({ id, type: "accommodation", name, time });
const visit: ItineraryItem = { id: "v", type: "visit", name: "甲博物馆", time: "10:00", end_time: "17:30", evidence_verified: true };
const plan = (items: readonly ItineraryItem[], constraints: Itinerary["constraints"] = {}): Itinerary => ({ title: "行程", days: [{ date: "2026-11-03", items }], constraints });

test("酒店到达/离开为时间点，18点锚点覆盖日末，不虚构时长或遮掩空日", () => {
  assert.equal(itemEndMinutes(stay("h")), 1080);
  assert.equal(itemEndMinutes({ ...stay("h"), end_time: "18:20" }), 1100);
  const report = validateItinerary(plan([visit, stay("h")], { day_end: "18:00" }));
  assert.equal(report.issues.some((i) => ["incomplete-day-end", "missing-duration"].includes(i.code)), false);
  assert.ok(validateItinerary(plan([stay("h")])).issues.some((i) => i.level === "P1"));
  const conflict = validateItinerary(plan([visit, { id: "r", name: "休息", type: "rest", time: "11:00", end_time: "12:00" }]));
  assert.ok(conflict.issues.some((i) => i.level === "P0"));
});

test("1分钟路线差采用绝对与相对双容差，短途大比例及显式严格仍P1", () => {
  const level = (duration: number, actual: number, constraints: Itinerary["constraints"] = {}) => validateItinerary(plan([
    visit, { id: "r", name: "交通", type: "transport", time: "18:00", planned_duration_min: duration, route_duration_min: actual, route_verified: true },
  ], constraints)).issues.find((i) => i.code === "route-duration-too-short")?.level;
  assert.equal(level(20, 21), "P2"); assert.equal(level(45, 46), "P2");
  assert.equal(level(1, 2), "P1"); assert.equal(level(50, 60), "P1");
  assert.equal(level(20, 21, { route_tolerance_min: 0 }), "P1");
  assert.equal(level(20, 21, { route_tolerance_ratio: 0 }), "P1");
  for (const bad of [-1, NaN, 16]) assert.throws(() => parseItinerary({ ...plan([visit]), constraints: { route_tolerance_min: bad } }));
});

test("日程参考边界允许30分钟浮动，中等缺口只提醒，明显缺失仍要求修订", () => {
  const endIssue = (time: string) => validateItinerary(plan([{ ...visit, end_time: "15:00" }, stay("h", "甲酒店", time)], { day_start: "10:00", day_end: "18:00" })).issues.find((i) => i.code === "incomplete-day-end");
  assert.equal(endIssue("17:40"), undefined); assert.equal(endIssue("17:30"), undefined);
  assert.equal(endIssue("17:29")?.level, "P2"); assert.equal(endIssue("16:45")?.level, "P2");
  assert.equal(endIssue("16:00")?.level, "P2"); assert.equal(endIssue("15:59")?.level, "P1");
  assert.equal(dayBoundarySeverity(-20, 480), undefined);
  const late = validateItinerary(plan([{ ...visit, time: "10:20" }], { day_start: "10:00" }));
  assert.equal(late.issues.some((i) => i.code === "incomplete-day-start"), false);
  const later = validateItinerary(plan([{ ...visit, time: "10:31" }], { day_start: "10:00", day_end: "18:00" }));
  assert.equal(later.issues.find((i) => i.code === "incomplete-day-start")?.level, "P2");
});

test("节奏容差不放宽明确可用时间、空日、真实重叠与中间空档", () => {
  const window: Itinerary = { ...plan([visit, stay("h", "甲酒店", "17:20")], { day_end: "18:00" }), days: [{ date: "2026-11-03", available_end: "17:00", items: [{ ...visit, end_time: "16:00" }, stay("h", "甲酒店", "17:20")] }] };
  assert.ok(validateItinerary(window).issues.some((i) => i.code === "outside-day-window" && i.level === "P1"));
  const gap = validateItinerary(plan([{ ...visit, end_time: "12:00" }, stay("h")]));
  assert.ok(gap.issues.some((i) => i.code === "timeline-gap" && i.level === "P1"));
  assert.ok(validateItinerary(plan([stay("h")], { day_start: "10:00", day_end: "18:00" })).issues.some((i) => i.code === "no-activity" && i.level === "P1"));
});

test("10小时17分钟只作节奏提醒，20%以内不扣分；明显过长仍P1", () => {
  for (const [minutes, expected] of [[600, undefined], [601, "P2"], [617, "P2"], [720, "P2"], [721, "P1"]] as const) assert.equal(activeDurationSeverity(minutes), expected);
  const p = plan([{ ...visit, time: "08:00", end_time: "18:17" }]);
  const issue = validateItinerary(p).issues.find((i) => i.code === "day-too-long")!;
  assert.equal(issue.level, "P2"); assert.equal(issue.kind, "advice");
  const cleanScore = opportunityScore(p, []).score;
  assert.equal(opportunityScore(p, [issue]).score, cleanScore);
  assert.ok(opportunityScore(p, [{ ...issue, level: "P1", kind: "error" }]).score < cleanScore);
  for (const code of ["incomplete-day-start", "incomplete-day-end"]) assert.equal(opportunityScore(p, [{ ...issue, code }]).score, cleanScore);
});

test("未知闭馆资料不扣分不阻断，已知闭馆仍P0，明确节假日例外单列待确认", () => {
  const unknown = plan([visit], { require_place_evidence: true });
  const report = validateItinerary(unknown);
  assert.equal(report.issues.find((i) => i.code === "unverified-closure")?.level, "P2");
  assert.equal(report.daily?.[0].strict_pass, true);
  const verified = { ...visit, closed_on: ["Monday"], closure_verified: true, closure_policy_version: CLOSURE_POLICY_VERSION };
  const clean = validateItinerary(plan([verified], unknown.constraints));
  assert.equal(report.score, clean.score);
  const monday: Itinerary = { ...unknown, days: [{ date: "2026-11-02", items: [verified] }] };
  assert.ok(validateItinerary(monday).issues.some((i) => i.code === "closed-on-date" && i.level === "P0"));
  const exception = validateItinerary({ ...monday, days: [{ ...monday.days[0], items: [{ ...verified, closure_holiday_exception: true }] }] });
  assert.ok(exception.issues.some((i) => i.code === "closure-exception-check" && i.kind === "pending" && i.level === "P1"));
  assert.equal(exception.score, clean.score);
});

test("闭馆规则保留法定假日例外；历史/否定/其他例外不能冒充核验", () => {
  for (const snippet of ["除法定节假日外，故宫博物院全年实行周一全天闭馆的措施。", "故宫博物院每周一例行闭馆，国家法定节假日除外"]) {
    assert.deepEqual(extractClosure("故宫博物院", [{ title: "故宫博物院", snippet }]), { verified: true, mentioned: true, holiday_exception: true, closed_on: ["Monday"] });
  }
  for (const snippet of ["故宫博物院此前每周一闭馆", "故宫博物院不是每周一闭馆", "故宫博物院每周一闭馆，暑期除外"]) assert.equal(extractClosure("故宫博物院", [{ title: "故宫博物院", snippet }]).verified, false);
});

test("官网闭馆正文带可追溯URL，剔除脚本与后续新闻；未知地点不任意抓URL", async () => {
  let count = 0;
  const request = (async () => { count++; return new Response('<script>每周二闭馆</script>开馆09:00 闭馆17:00 每周一例行闭馆，国家法定节假日除外 新闻列表无关内容'); }) as typeof fetch;
  const source = await officialOpeningSource("中国国家博物馆", "北京市", request);
  assert.match(source!.url!, /^https:\/\/www.chnmuseum.cn/);
  assert.doesNotMatch(source!.snippet, /新闻|周二/);
  assert.equal(extractClosure("中国国家博物馆", [source!]).holiday_exception, true);
  assert.equal(await officialOpeningSource("https://example.com", "北京", request), undefined);
  assert.equal(count, 1);
});

test("官网命中只用一次HTTP，规则与例外持久化；旧策略负缓存失效", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root); let count = 0;
  const tool = createReviewsTool((async () => { count++; return new Response("开放时间09:00-17:00。除法定节假日外，故宫博物院全年实行周一全天闭馆的措施。"); }) as typeof fetch);
  const output = await tool.execute({ place: "故宫博物院", city: "北京", aspect: "开放时间" }, { workspace: root, evidence });
  assert.equal(count, 1); assert.match(output, /dpm.org.cn/);
  const fresh = new TravelEvidenceStore(root); await fresh.load();
  assert.equal(fresh.bind({ ...visit, name: "故宫博物院" }, "北京").closure_holiday_exception, true);
  const record = { key: "old", tool: "get_place_reviews", city: "北京", entity: "故宫博物院", topic: "开放时间", status: "unavailable" as const, summary: "无规则", at: Date.now(), closure_policy_version: CLOSURE_POLICY_VERSION - 1 };
  await fresh.observeQuery(record); assert.equal(fresh.queryRecord("old"), undefined);
  await fresh.observeQuery({ ...record, key: "new", closure_policy_version: undefined }); assert.ok(fresh.queryRecord("new"));
});

test("官网同一周规则不重复搬运票价新闻，读取正文有硬字节上限", async () => {
  const source = await officialOpeningSource("故宫博物院", "北京", (async () => new Response("除法定节假日外，故宫博物院全年实行周一全天闭馆的措施。妇女节如遇周一闭馆，提前一天优惠。")) as typeof fetch);
  assert.doesNotMatch(source!.snippet, /妇女节|优惠/);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(512_001) + "故宫博物院每周二闭馆")); }, cancel() { cancelled = true; } });
  assert.equal(await officialOpeningSource("故宫博物院", "北京", (async () => new Response(stream)) as typeof fetch), undefined);
  assert.equal(cancelled, true);
});

test("回酒店保留真实身份、复制已验证地点引用，动作另存，费用不重复", () => {
  const hotel = { ...stay("h", "甲酒店", "09:00"), evidence_id: "a", evidence_verified: true, room_price_per_night: 600, location: { latitude: 39.9, longitude: 116.4 } };
  const original: Itinerary = { ...plan([hotel, { ...stay("back", "回到甲酒店（退房前）"), room_price_per_night: 600 }, { id: "r", name: "返回", type: "transport", from: "甲景点", to: "回到甲酒店（退房前）" }]), travelers: 2, constraints: { expected_days: 2 } };
  const normalized = normalizeStayReferences(original), back = normalized.days[0].items[1];
  assert.equal(back.name, "甲酒店"); assert.equal(back.activity, "回到酒店（退房前）");
  assert.equal(back.evidence_id, "a"); assert.equal(back.evidence_verified, true);
  assert.equal(normalized.days[0].items[2].to, "甲酒店");
  assert.equal(original.days[0].items[1].name, "回到甲酒店（退房前）");
  assert.equal(totalCostPerPerson(original), 300);
  const other = normalizeStayReferences(plan([hotel, stay("b", "乙酒店"), stay("c", "回到甲酒店")]));
  assert.equal(other.days[0].items[1].name, "乙酒店");
  const conflict = normalizeStayReferences(plan([hotel, { ...stay("b", "回到甲酒店"), evidence_id: "other", location: { latitude: 40.9, longitude: 116.4 } }]));
  assert.notEqual(conflict.days[0].items[1].evidence_verified, true);
});

test("全程同酒店为默认约束，换酒店需明确允许，不强行改写第二家名称", () => {
  const itinerary: Itinerary = { title: "酒店", constraints: { require_accommodation: true }, days: [{ items: [visit, stay("a")] }, { items: [{ ...visit, id: "v2", name: "乙公园" }, stay("b", "乙酒店")] }] };
  assert.ok(validateItinerary(itinerary).issues.some((i) => i.code === "hotel-change-not-allowed"));
  assert.equal(validateItinerary({ ...itinerary, constraints: { ...itinerary.constraints, allow_hotel_changes: true } }).issues.some((i) => i.code === "hotel-change-not-allowed"), false);
});

test("保存路径修复酒店动作名并绑定，增量换酒店提示，需求单策略不能被save覆盖", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_stays", "北京", "1. 甲酒店 | 参考价 ¥600 | 坐标 39.9000,116.4000", "amap");
  await createSaveTravelBriefTool(root).execute({ title: "酒店测试", destination: "北京" });
  const save = createSaveItineraryTool(root), ctx = { workspace: root, evidence };
  await save.execute({ title: "酒店测试", days: [{ date: "2026-11-03", items: [stay("a", "甲酒店", "09:00"), visit, stay("b", "回到甲酒店")] }] }, ctx);
  const read = async () => JSON.parse(await readFile(join(root, "plans/酒店测试.json"), "utf8"));
  let stored = await read();
  assert.equal(stored.days[0].items[2].name, "甲酒店"); assert.equal(stored.days[0].items[2].evidence_verified, true);
  assert.equal(stored.constraints.allow_hotel_changes, false); assert.equal(stored.constraints.base_stay_name, "甲酒店");
  await save.execute({ title: "酒店测试", merge: true, allow_hotel_changes: true, days: [{ date: "2026-11-04", items: [{ ...visit, name: "乙公园" }, stay("c", "乙酒店")] }] }, ctx);
  stored = await read(); assert.equal(stored.constraints.allow_hotel_changes, false);
  const report = JSON.parse(await readFile(join(root, "plans/酒店测试.quality.json"), "utf8"));
  assert.ok(report.issues.some((i: { code: string }) => i.code === "hotel-change-not-allowed"));
});

test("旧路线ID只在同真实端点/交通方式有新证据时重绑定，不借用另一酒店路线", async (t) => {
  const root = await temp(t), evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_stays", "北京", "1. 甲酒店 | 坐标 39.9000,116.4000", "amap");
  await evidence.observePlaces("search_attractions", "北京", "1. 甲景点 | 坐标 39.9100,116.4000", "amap");
  const route = { city: "北京", from: "甲酒店", to: "甲景点", mode: "transit", duration_min: 20, distance_km: 2, estimated: false, from_point: evidence.point("甲酒店", "北京")!, to_point: evidence.point("甲景点", "北京")! };
  const [valid] = await evidence.observeRoutes([route]);
  const item: ItineraryItem = { id: "r", type: "transport", name: "交通", from: "甲酒店", to: "甲景点", transport_mode: "transit", route_evidence_id: "stale" };
  assert.equal(evidence.bind(item, "北京").route_evidence_id, valid.id);
  assert.notEqual(evidence.bind({ ...item, from: "乙酒店" }, "北京").route_verified, true);
  assert.notEqual(evidence.bind({ ...item, transport_mode: "walking" }, "北京").route_verified, true);
});
