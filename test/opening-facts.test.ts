import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractOpeningFacts, openingHoursFor, type OpeningSource } from "../src/tools/opening-facts.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { createReviewsTool, type ReviewSearchProvider } from "../src/tools/reviews.ts";
import { createSaveItineraryTool, renderMarkdown } from "../src/tools/itinerary.ts";
import { parseItinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { ToolDiagnostics } from "../src/core/tool-diagnostics.ts";
import { summarizeToolDiagnostics } from "../src/eval/tool-diagnostics.ts";

const name = "江西省博物馆", city = "南昌";
const source = (snippet: string, extra: Partial<OpeningSource> = {}): OpeningSource => ({ title: `${name}参观说明`, snippet, url: "https://museum.example/visit", kind: "official", content_kind: "page", ...extra });
const item = (): ItineraryItem => ({ id: "museum", name, type: "visit", time: "10:00", end_time: "12:00" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "opening-facts-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", city, `${name} | 坐标 28.7059,115.8818`, "amap");
  return { root, evidence, ctx: { workspace: root, evidence }, save: createSaveItineraryTool(root) };
}

test("开放、闭馆、最后入场和临时公告分别入库，并按星期/日期选择时段", () => {
  const facts = extractOpeningFacts(city, name, [source("周二至周日09:00-17:00；周一闭馆，国家法定节假日除外；16:30停止入馆；2026-11-05临时闭馆")], ["hours", "closure", "last_admission", "notices"]);
  assert.ok(facts.every((f) => f.status === "verified"));
  const hours = facts.find((f) => f.field === "hours"), closure = facts.find((f) => f.field === "closure");
  assert.equal(openingHoursFor(hours, "2026-11-04", facts.find((f) => f.field === "last_admission"))!.last_admission, "16:30");
  assert.equal(openingHoursFor(hours, "2026-11-02"), undefined);
  assert.deepEqual(closure!.value, { closed_on: ["Monday"], holiday_exception: true });
  assert.ok(facts.every((f) => f.sources[0]?.url === "https://museum.example/visit" && f.sources[0].quote.includes("09:00-17:00")));
});

test("全天开放与表演场次分开，24:00只允许作为开放结束，不作为行程时刻", async (t) => {
  const f = await fixture(t), fountain = "秋水广场音乐喷泉";
  await f.evidence.observePlaces("search_attractions", city, `${fountain} | 开放时间 24小时营业 | 坐标 28.6826,115.8627`, "amap");
  await f.evidence.observeOpening(city, fountain, [source("场地24小时开放；喷泉表演时间19:30-19:45、20:30-20:45", { title: fountain })], ["hours", "sessions"]);
  const bound = f.evidence.bind({ ...item(), name: fountain, time: "22:00", end_time: "23:30" }, city, "2026-11-04");
  assert.equal(bound.opening_hours!.closes, "24:00"); assert.deepEqual(bound.opening_sessions, [{ starts: "19:30", ends: "19:45" }, { starts: "20:30", ends: "20:45" }]);
  const plan = parseItinerary({ title: "全天开放", days: [{ date: "2026-11-04", items: [bound] }] });
  assert.equal(validateItinerary(plan).issues.some((i) => i.code === "outside-opening-hours"), false);
  assert.match(renderMarkdown(plan), /开放 全天/); assert.match(renderMarkdown(plan), /表演场次 19:30-19:45/);
  assert.throws(() => parseItinerary({ title: "错误时刻", days: [{ items: [{ ...item(), time: "24:00" }] }] }), /HH:MM/);
});

test("含糊时段待确认，同级来源按更早闭园选择，来源级别优先", () => {
  for (const text of ["夏季09:00-18:00，冬季09:00-17:00", "2026年冬季09:00-17:00", "09:00-17:00 08:30-20:00"]) {
    const hours = extractOpeningFacts(city, name, [source(text)], ["hours"]).find((f) => f.field === "hours")!;
    assert.equal(hours.status, "needs_confirmation", text); assert.equal(openingHoursFor(hours), undefined);
  }
  const earlierUrl = "https://museum.example/other";
  const selected = extractOpeningFacts(city, name, [source("09:00-18:00"), source("10:00-17:00", { url: earlierUrl })], ["hours"])[0]!;
  assert.equal(openingHoursFor(selected)?.opens, "10:00");
  assert.equal(openingHoursFor(selected)?.closes, "17:00");
  assert.equal(selected.sources[0]?.url, earlierUrl);
  const preferred = extractOpeningFacts(city, name, [source("09:00-18:00"), source("09:00-17:00", { kind: "platform", url: "https://platform.example/page" })], ["hours"]);
  assert.equal(openingHoursFor(preferred[0])!.closes, "18:00");
});

test("日期适用的两条时段重叠时保存较早闭园，并按跨午夜的实际时刻比较", () => {
  const [overlap] = extractOpeningFacts(city, name, [source("每天开放时间10:00-21:30。周六至周日10:00-22:00")], ["hours"]);
  assert.equal(openingHoursFor(overlap, "2026-11-07")?.closes, "21:30");
  const [overnight] = extractOpeningFacts(city, name, [source("20:00-02:00"), source("20:00-23:00", { url: "https://museum.example/other" })], ["hours"]);
  assert.equal(openingHoursFor(overnight)?.closes, "23:00");
});

test("带完整日期的时段只用于适用日期，不能覆盖成全年规则", () => {
  const facts = extractOpeningFacts(city, name, [source("2026-11-04至2026-11-06开放时间10:00-18:00")], ["hours"]);
  assert.equal(openingHoursFor(facts[0], "2026-11-05")!.opens, "10:00");
  assert.equal(openingHoursFor(facts[0], "2026-11-07"), undefined);
});

test("否定、历史与条件化入场时间不冒充通用规则；工作日和周末枚举分别适用", () => {
  for (const snippet of ["此前09:00-17:00开放", "不是09:00-17:00开放", "夏季16:30停止入馆", "09:00-17:00开放，法定节假日除外", "最后入场16:30，法定节假日除外"]) {
    const facts = extractOpeningFacts(city, name, [source(snippet)], ["hours", "last_admission"]);
    assert.equal(facts.some((f) => f.status === "verified"), false, snippet);
  }
  const facts = extractOpeningFacts(city, name, [source("工作日09:00-17:00；周六、周日10:00-18:00")], ["hours"]);
  assert.equal(openingHoursFor(facts[0], "2026-11-04")!.opens, "09:00");
  assert.equal(openingHoursFor(facts[0], "2026-11-08")!.opens, "10:00");
  const discontinuous = extractOpeningFacts(city, name, [source("2026-11-04、2026-11-06开放09:00-17:00")], ["hours"]);
  assert.equal(discontinuous[0]!.status, "needs_confirmation");
});

test("简称统一到已选POI，网页事实保存后不被缺字段的高德结果清空", async (t) => {
  const f = await fixture(t); let queries = 0;
  const provider: ReviewSearchProvider = { name: "fixture", search: async (query) => { queries++; assert.match(query, /江西省博物馆/); return [source("09:00-17:00；周一闭馆；16:30停止入馆")]; } };
  const tool = createReviewsTool((async () => { throw new Error("不应追加网络请求"); }) as typeof fetch, provider);
  await tool.execute({ place: "江西博物馆", city, aspect: "开放时间" }, f.ctx);
  await f.evidence.observePlaces("search_attractions", city, `${name} | 坐标 28.7059,115.8818 | 评分 4.9`, "amap");
  await f.save.execute({ title: "网页回填", constraints: { destination: city }, days: [{ date: "2026-11-04", items: [item()] }] }, f.ctx);
  const plan = parseItinerary(JSON.parse(await readFile(join(f.root, "plans/网页回填.json"), "utf8"))), bound = plan.days[0]!.items[0]!;
  assert.equal(queries, 1); assert.equal(bound.opening_hours!.closes, "17:00"); assert.equal(bound.opening_hours!.last_admission, "16:30");
  assert.equal(bound.closure_verified, true); assert.deepEqual(bound.closed_on, ["Monday"]); assert.equal(bound.opening_evidence_ids!.length, 3);
  assert.match(await readFile(join(f.root, "plans/网页回填.md"), "utf8"), /最后入场16:30/);
  const reloaded = new TravelEvidenceStore(f.root); await reloaded.load(); assert.equal(reloaded.bind(item(), city, "2026-11-04").opening_hours!.closes, "17:00");
});

test("闭馆已知仍能补开放时段；普通公园的全天信息无需额外网页查询", async (t) => {
  const f = await fixture(t);
  await f.evidence.observeClosure(city, name, [{ title: name, snippet: "每周一闭馆" }]);
  assert.deepEqual(f.evidence.pendingReviewPlaces([name], city), [name]);
  let queryText = "";
  const provider: ReviewSearchProvider = { name: "fixture", search: async (query) => { queryText = query; return [source("09:00-17:00")]; } };
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => { throw new Error("不应额外查询"); }) as typeof fetch, provider));
  await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间" }), f.ctx);
  assert.doesNotMatch(queryText, /每周 闭馆/);
  await f.evidence.observePlaces("search_attractions", city, "八一广场 | 开放时间 24小时营业 | 坐标 28.6739,115.9045", "amap");
  assert.deepEqual(f.evidence.pendingReviewPlaces(["八一广场"], city), []);
});

test("缺失、冲突逐字段记账，切换fields也不能突破单实体两次预算", async (t) => {
  const f = await fixture(t); let requests = 0;
  const provider: ReviewSearchProvider = { name: "fixture", search: async () => { requests++; return [source("周一闭馆")]; } };
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => { requests++; return new Response(""); }) as typeof fetch, provider));
  const ctx = { ...f.ctx, queryAttempts: new Map<string, number>() };
  await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间" }), ctx);
  assert.equal(requests, 4); assert.equal(f.evidence.openingFactsFor(city, name).closure!.status, "verified"); assert.equal(f.evidence.openingFactsFor(city, name).hours!.status, "not_found");
  await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间", fields: ["hours"] }), ctx); assert.equal(requests, 4);
  const blocked = await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间", fields: ["sessions"], refresh: true }), ctx);
  assert.match(blocked, /本次未执行/); assert.equal(requests, 4);
});

test("地图缺字段或季节条件不明确，仍允许对普通已选景点补查网页一次", async (t) => {
  const f = await fixture(t);
  await f.evidence.observePlaces("search_attractions", city, "普通公园 | 开放时间 详见现场公告 | 坐标 28.6800,115.9000\n季节公园 | 开放时间 夏季09:00-20:00 | 坐标 28.6900,115.9000", "amap");
  assert.deepEqual(f.evidence.pendingReviewPlaces(["普通公园", "季节公园"], city), ["普通公园", "季节公园"]);
  let searches = 0;
  const provider: ReviewSearchProvider = { name: "fixture", search: async () => { searches++; return [source("季节公园09:00-18:00", { title: "季节公园参观指南" })]; } };
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => { throw new Error("不应补发请求"); }) as typeof fetch, provider));
  await registry.execute("get_place_reviews", JSON.stringify({ city, place: "季节公园", aspect: "开放时间" }), f.ctx);
  assert.equal(searches, 1); assert.equal(f.evidence.bind({ ...item(), name: "季节公园" }, city).opening_hours!.closes, "18:00");
  assert.deepEqual(f.evidence.pendingReviewPlaces(["季节公园"], city), []);
});

test("没有链接的搜索摘要与其他场馆的规则不冒充已核实资料", () => {
  const untraceable = extractOpeningFacts(city, name, [source("09:00-17:00", { url: undefined, kind: "search" })], ["hours"]);
  assert.equal(untraceable[0]!.status, "needs_confirmation");
  const wrong = extractOpeningFacts(city, name, [source("延伸阅读：它们的开放时间类似，均周一闭馆。江西省美术馆：09:00-17:00，16:30停止入馆")], ["hours", "closure"]);
  assert.equal(wrong.some((f) => f.status === "verified"), false);
});

test("临时闭馆公告进入实际校验，失败保存保留原版本", async (t) => {
  const f = await fixture(t), title = "公告约束";
  await f.save.execute({ title, constraints: { destination: city }, days: [{ date: "2026-11-05", items: [item()] }] }, f.ctx);
  const file = join(f.root, `plans/${title}.json`), before = await readFile(file, "utf8");
  await f.evidence.observeOpening(city, name, [source("2026-11-05临时闭馆")], ["notices"]);
  await assert.rejects(() => f.save.execute({ title, merge: true, days: [{ date: "2026-11-05", items: [{ id: "museum", note: "复核" }] }] }, f.ctx), /临时闭馆公告/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("带日期的闭馆时刻不能误判全天停业，条件不适用时清除旧窗口", async (t) => {
  const f = await fixture(t);
  for (const snippet of ["2026-11-05开馆09:00闭馆17:00", "2026-11-05开放09:00-17:00，17:00闭馆"]) {
    const facts = extractOpeningFacts(city, name, [source(snippet)], ["hours", "notices"]);
    assert.equal(facts.find((r) => r.field === "notices")!.status, "not_found");
  }
  await f.evidence.observeOpening(city, name, [source("2026-11-05开放09:00-17:00")], ["hours"]);
  const bound = f.evidence.bind(item(), city, "2026-11-05"); assert.ok(bound.opening_hours);
  assert.equal(f.evidence.bind(bound, city, "2026-11-06").opening_hours, undefined);
  assert.match(f.evidence.summary(city, [name]), /开放字段.*开放时段/);
});

test("来源返回、字段提取与最终保留分开计量，HTTP成功不冒充事实成功", async (t) => {
  const f = await fixture(t), diagnostics = new ToolDiagnostics();
  const provider: ReviewSearchProvider = { name: "fixture", search: async () => [source("09:00-17:00；周一闭馆；16:30停止入馆")] };
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => new Response("")) as typeof fetch, provider)).register(f.save);
  const run = async (name: string, args: object, round: number) => diagnostics.run({ id: `call-${round}`, name, arguments: JSON.stringify(args) }, round, async () => ({ output: await registry.execute(name, JSON.stringify(args), f.ctx) }));
  await run("get_place_reviews", { place: name, city, aspect: "开放时间" }, 1);
  await run("save_itinerary", { title: "字段指标", constraints: { destination: city }, days: [{ date: "2026-11-04", items: [item()] }] }, 2);
  const plan = parseItinerary(JSON.parse(await readFile(join(f.root, "plans/字段指标.json"), "utf8"))), metrics = summarizeToolDiagnostics(diagnostics, plan).opening;
  assert.equal(metrics.source_return_rate, 1); assert.equal(metrics.page_content_return_rate, 1); assert.equal(metrics.extraction_rate, 1); assert.equal(metrics.retention_rate, 1);
  const removed = { ...plan, days: plan.days.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, opening_evidence_ids: undefined })) })) };
  assert.equal(summarizeToolDiagnostics(diagnostics, removed).opening.retention_rate, 0);
});

test("搜索HTTP200但没有相关来源，开放来源与提取均为零，未保存留存率未知", async (t) => {
  const f = await fixture(t), diagnostics = new ToolDiagnostics(); let requests = 0;
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => { requests++; return new Response("没有相关结果"); }) as typeof fetch));
  await diagnostics.run({ id: "empty-search", name: "get_place_reviews", arguments: JSON.stringify({ city, place: name, aspect: "开放时间" }) }, 1,
    async () => ({ output: await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间" }), f.ctx) }));
  const result = summarizeToolDiagnostics(diagnostics);
  assert.equal(requests, 4); assert.equal(result.http.success_rate, 1);
  assert.equal(result.opening.source_return_rate, 0); assert.equal(result.opening.page_content_return_rate, 0);
  assert.equal(result.opening.extraction_rate, 0); assert.equal(result.opening.retention_rate, null);
});
