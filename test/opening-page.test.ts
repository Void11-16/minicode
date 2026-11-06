import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { officialOpeningSource } from "../src/tools/official-opening.ts";
import { openingPageSnippet, isSearchChallenge } from "../src/tools/opening-page.ts";
import { extractOpeningFacts, openingHoursFor, lastAdmissionFor, OPENING_POLICY_VERSION, validOpeningFact, type OpeningSource } from "../src/tools/opening-facts.ts";
import { TravelEvidenceStore, evidenceId } from "../src/tools/travel-evidence.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { ToolDiagnostics } from "../src/core/tool-diagnostics.ts";
import { queryKeyArgs } from "../src/tools/travel-query.ts";
import { CLOSURE_POLICY_VERSION } from "../src/tools/closure-policy.ts";

const name = "故宫博物院", city = "北京";
const snapshot = () => readFile(new URL("./fixtures/palace-visit-20261103.html", import.meta.url), "utf8");
const source = (snippet: string, title = name): OpeningSource => ({ title, snippet, kind: "official", content_kind: "page", url: "https://www.dpm.org.cn/Visit.html" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "opening-page-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root);
  await evidence.observePlaces("search_attractions", city, `${name} | 坐标 39.9163,116.3972`, "amap");
  return { root, evidence, ctx: { workspace: root, evidence }, save: createSaveItineraryTool(root) };
}

test("真实官网DOM中的重复导航不占正文额度，保留旺淡季表格及独立闭馆规则", async () => {
  const html = await snapshot(), result = await officialOpeningSource(name, city, (async () => new Response(html)) as typeof fetch);
  assert.ok(result); assert.ok(result.snippet.length <= 4000);
  assert.match(result.snippet, /每年4月1日至10月31日/); assert.match(result.snippet, /每年11月1日至来年3月31日/);
  assert.match(result.snippet, /开放入馆时间：\s*8:30/); assert.match(result.snippet, /闭馆时间：\s*16:30/);
  assert.doesNotMatch(result.snippet, /我要留言|English|数字文物库/);
  const facts = extractOpeningFacts(city, name, [result], ["hours", "closure", "last_admission", "notices"]);
  assert.equal(facts.find((f) => f.field === "hours")!.status, "verified");
  assert.equal(facts.find((f) => f.field === "notices")!.status, "not_found", "武英殿公告不能关闭整个故宫");
  assert.deepEqual(facts.find((f) => f.field === "closure")!.value, { closed_on: ["Monday"], holiday_exception: true });
});

test("按真实时刻表选择跨年季节和入馆截止，不采用内部场馆的16:10/15:40", async () => {
  const result = await officialOpeningSource(name, city, (async () => new Response(await snapshot())) as typeof fetch);
  const facts = extractOpeningFacts(city, name, [result!], ["hours", "last_admission"]), hours = facts.find((f) => f.field === "hours"), admission = facts.find((f) => f.field === "last_admission");
  for (const [day, closes, last] of [["2026-03-31", "16:30", "15:30"], ["2026-04-01", "17:00", "16:00"], ["2026-10-31", "17:00", "16:00"], ["2026-11-01", "16:30", "15:30"], ["2027-01-05", "16:30", "15:30"], ["2028-02-29", "16:30", "15:30"]]) {
    const selected = openingHoursFor(hours, day, admission)!;
    assert.equal(selected.opens, "08:30"); assert.equal(selected.closes, closes, day); assert.equal(selected.last_admission, last, day);
  }
  assert.equal(openingHoursFor(hours), undefined); assert.equal(lastAdmissionFor(admission), undefined);
  assert.equal(openingHoursFor(hours, "2027-02-29"), undefined);
});

test("真实Registry查询一次即完成，保存/重新加载保留季节规则并实际校验最后入场", async (t) => {
  const f = await fixture(t); let requests = 0;
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async (input) => { requests++; assert.match(String(input), /dpm.org.cn/); return new Response(await snapshot()); }) as typeof fetch)).register(f.save);
  const output = await registry.execute("get_place_reviews", JSON.stringify({ city, place: name, aspect: "开放时间" }), f.ctx);
  assert.equal(requests, 1); assert.match(output, /start_month_day/);
  await registry.execute("save_itinerary", JSON.stringify({ title: "官网时刻表", constraints: { destination: city }, days: [{ date: "2026-11-04", items: [{ id: "palace", name, type: "visit", time: "10:00", end_time: "12:00" }] }] }), f.ctx);
  const plan = parseItinerary(JSON.parse(await readFile(join(f.root, "plans/官网时刻表.json"), "utf8"))), item = plan.days[0]!.items[0]!;
  assert.equal(item.opening_hours!.closes, "16:30"); assert.equal(item.opening_hours!.last_admission, "15:30"); assert.equal(item.opening_evidence_ids!.length, 3);
  assert.equal(item.closed_dates, undefined); assert.match(await readFile(join(f.root, "plans/官网时刻表.md"), "utf8"), /最后入场15:30/);
  const fresh = new TravelEvidenceStore(f.root); await fresh.load();
  const late = fresh.bind({ ...item, time: "15:45", end_time: "16:00" }, city, "2026-11-04");
  assert.ok(validateItinerary({ ...plan, days: [{ date: "2026-11-04", items: [late] }] }).issues.some((i) => i.code === "outside-opening-hours"));
  assert.equal(fresh.bind(item, city, "2027-04-01").opening_hours!.closes, "17:00");
});

test("其他场馆的table/th/td标签布局也能提取，不绑定故宫名称和具体时刻", () => {
  const html = '<nav>开放时间 开放时间 开放时间 开放时间</nav><main><h2>某市博物馆参观时间</h2><h3>每年5月1日至9月30日</h3><table><tr><th>开馆时间</th><td>9:15</td><th>闭馆时间</th><td>18:45</td></tr><tr><th>截止检票时间</th><td>18:00</td></tr></table><h3>每年10月1日至次年4月30日</h3><table><tr><td>开馆时间</td><td>10:00</td><td>闭馆时间</td><td>17:15</td></tr><tr><td>停止入馆时间</td><td>16:45</td></tr></table></main>';
  const snippet = openingPageSnippet(html)!;
  const facts = extractOpeningFacts("某市", "某市博物馆", [source(snippet, "某市博物馆")], ["hours", "last_admission"]);
  const hours = facts.find((f) => f.field === "hours"), admission = facts.find((f) => f.field === "last_admission");
  assert.equal(openingHoursFor(hours, "2026-08-05", admission)!.closes, "18:45");
  assert.equal(openingHoursFor(hours, "2026-12-05", admission)!.last_admission, "16:45");
});

test("子区域停业、署名和主景区停业分开；子区域的日起关闭保留为有起点的范围", () => {
  const notice = source("根据古建修缮计划，武英殿将于2026年10月19日起停止开放，特此公告。故宫博物院");
  const parent = extractOpeningFacts(city, name, [notice], ["notices"]);
  assert.equal(parent.find((f) => f.field === "notices")!.status, "not_found");
  const child = extractOpeningFacts(city, "武英殿", [notice], ["notices"]);
  assert.deepEqual(child.find((f) => f.field === "notices")!.value, { closed_dates: [], closed_ranges: [{ start: "2026-10-19" }] });
  const full = extractOpeningFacts(city, name, [source("故宫博物院将于2026-11-05临时闭馆")], ["notices"]);
  assert.equal(full[0]!.status, "verified"); assert.deepEqual(full[0]!.value, { closed_dates: ["2026-11-05"], closed_ranges: [] });
  assert.equal(extractOpeningFacts(city, name, [source("2026-11-05部分展厅临时关闭")], ["notices"])[0]!.status, "not_found");
});

test("日期限定的最后入场只用于当天，不退化为无条件时刻", () => {
  const fact = extractOpeningFacts(city, name, [source("2026-11-05最后入场16:30")], ["last_admission"])[0]!;
  assert.equal(fact.status, "verified"); assert.equal(lastAdmissionFor(fact, "2026-11-05"), "16:30");
  assert.equal(lastAdmissionFor(fact, "2026-11-06"), undefined); assert.equal(lastAdmissionFor(fact), undefined);
});

test("日期或星期独立表头约束后续标签行，未知日期不能回退成全年规则", () => {
  for (const [heading, day, outside] of [["2026-11-04至2026-11-06", "2026-11-05", "2026-11-07"], ["周二至周日", "2026-11-04", "2026-11-02"]]) {
    const facts = extractOpeningFacts(city, name, [source(`${heading}\n开馆时间09:00\n停止入馆时间16:00\n闭馆时间17:00`)], ["hours", "last_admission"]);
    const hours = facts.find((f) => f.field === "hours"), admission = facts.find((f) => f.field === "last_admission");
    assert.equal(openingHoursFor(hours, day, admission)!.last_admission, "16:00");
    assert.equal(openingHoursFor(hours, outside, admission), undefined); assert.equal(lastAdmissionFor(admission, outside), undefined);
  }
  const invalid = extractOpeningFacts(city, name, [source("每年4月31日至10月31日\n开馆时间09:00\n闭馆时间17:00")], ["hours"]);
  assert.equal(invalid[0]!.status, "needs_confirmation");
});

test("未知季节或无效范围仍待确认；不能把交通通行时间作为景区开放时间", () => {
  for (const snippet of ["淡季 开放入馆时间：08:30；闭馆时间：16:30", "旺季13.1-14.31 08:30-17:00"]) {
    assert.equal(extractOpeningFacts(city, name, [source(snippet)], ["hours"])[0]!.status, "needs_confirmation");
  }
  const fact = extractOpeningFacts(city, name, [source("从天安门经端门到午门路线：通行时间周二至周日08:00-16:00")], ["hours"])[0]!;
  assert.equal(fact.status, "not_found");
});

test("HTTP200验证码单列服务错误，不写30分钟无依据缓存，恢复后可在原预算内重试", async (t) => {
  const f = await fixture(t), diagnostics = new ToolDiagnostics(); let requests = 0, blocked = true;
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async () => {
    requests++;
    return new Response(blocked ? '<title>访问异常页面</title><div>请完成验证</div>' : await snapshot());
  }) as typeof fetch));
  const args = { city, place: name, aspect: "开放时间" }, ctx = { ...f.ctx, queryAttempts: new Map<string, number>() };
  const output = await diagnostics.run({ id: "challenge", name: "get_place_reviews", arguments: JSON.stringify(args) }, 1, async () => ({ output: await registry.execute("get_place_reviews", JSON.stringify(args), ctx) }));
  assert.match(output.output, /搜索失败/); assert.equal(requests, 4);
  assert.equal(diagnostics.records[0]!.query_status, "failed"); assert.equal(diagnostics.records[0]!.provider_errors.filter((r) => r.code === "CAPTCHA").length, 4);
  assert.equal(f.evidence.openingFactsFor(city, name).hours, undefined); assert.deepEqual(f.evidence.pendingReviewPlaces([name], city, ctx.queryAttempts), [name]);
  blocked = false;
  await registry.execute("get_place_reviews", JSON.stringify(args), ctx);
  assert.equal(requests, 5); assert.equal(f.evidence.openingFactsFor(city, name).hours!.status, "verified");
});

test("含验证码字样的正常信息页不误拒绝，跳转到验证域名仍识别", () => {
  assert.equal(isSearchChallenge('<title>参观说明</title><p>购票时输入验证码，开馆09:00闭馆17:00</p>'), false);
  assert.equal(isSearchChallenge('<title>访问异常页面</title>'), true);
  assert.equal(isSearchChallenge('<html></html>', "https://qcaptcha.so.com/check"), true);
});

test("部分字段未找到不把其余已提取字段误报成服务失败", async (t) => {
  const f = await fixture(t), diagnostics = new ToolDiagnostics();
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async (input) => new Response(String(input).includes("dpm.org.cn") ? await snapshot() : "没有相关结果")) as typeof fetch));
  const args = { city, place: name, aspect: "开放时间", fields: ["hours", "notices"] };
  await diagnostics.run({ id: "partial", name: "get_place_reviews", arguments: JSON.stringify(args) }, 1, async () => ({ output: await registry.execute("get_place_reviews", JSON.stringify(args), f.ctx) }));
  assert.equal(diagnostics.records[0]!.query_status, "returned");
  assert.deepEqual(diagnostics.records[0]!.opening_fields!.extracted, ["hours"]);
});

test("旧策略的无依据缓存和主子点误归属字段不复用，损坏的月日范围不加载", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opening-version-")); t.after(() => rm(root, { recursive: true, force: true }));
  const args = { city, place: name, aspect: "开放时间" }, key = evidenceId(["get_place_reviews", queryKeyArgs("get_place_reviews", args)]);
  const fact = extractOpeningFacts(city, name, [source("09:00-17:00")], ["hours"])[0]!;
  await mkdir(join(root, ".minicode"));
  await writeFile(join(root, ".minicode/travel-evidence.json"), JSON.stringify({ opening_facts: [{ ...fact, policy_version: 4 }], query_log: [{ key, tool: "get_place_reviews", city, entity: name, topic: "开放时间", status: "unavailable", at: Date.now(), closure_policy_version: CLOSURE_POLICY_VERSION, opening_policy_version: OPENING_POLICY_VERSION - 1 }] }));
  const evidence = new TravelEvidenceStore(root); await evidence.load();
  assert.equal(evidence.queryRecord(key), undefined); assert.equal(evidence.openingFactsFor(city, name).hours, undefined);
  assert.equal(validOpeningFact({ ...fact, value: [{ opens: "09:00", closes: "17:00", start_month_day: "02-30", end_month_day: "03-31" }] }), false);
});

test("普通来源单条清楚时段可回填，模糊官网摘要不否定已有值", () => {
  const facts = extractOpeningFacts("南昌", "滕王阁", [
    { title: "滕王阁景区", snippet: "滕王阁景区开放时间08:00-18:00", url: "https://example.com/visit" },
    { title: "滕王阁", snippet: "淡季开放时间09:00-17:00", url: "https://example.org/visit", kind: "official" },
  ], ["hours"]);
  assert.equal(facts[0]!.status, "verified");
  assert.equal(openingHoursFor(facts[0])!.closes, "18:00");
});

test("百度现代卡片结构中的摘要与落地页用于省博物馆别名回填", async () => {
  let requests = 0;
  const tool = createReviewsTool((async () => {
    requests++;
    return new Response(requests === 1 ? "没有结果" : '<div class="result c-container" mu="https://example.com/visit"><h3>江西博物馆参观指南</h3><!--s-data:{"summaryData":{"generalLines":[{"data":[{"text":"江西博物馆开放时间09:00-17:00，周一闭馆"}]}]}}--></div>');
  }) as typeof fetch);
  const output = await tool.execute({ city: "南昌", place: "江西省博物馆", aspect: "开放时间" });
  assert.equal(requests, 2);
  assert.match(output, /hours: verified/);
  assert.match(output, /closure: verified/);
});

test("摘要缺失时只读取相关正文，文章外的推荐时间不混入", async () => {
  let searches = 0, pages = 0;
  const tool = createReviewsTool((async (input) => {
    pages++;
    assert.equal(String(input), "https://example.com/visit");
    return new Response('<title>南昌测试公园参观指南</title><article><div><p>南昌测试公园开放时间09:00-17:00</p></div></article><aside>推荐其他景点，开放时间08:00-22:00</aside>');
  }) as typeof fetch, { name: "test", async search() { searches++; return [{ title: "南昌测试公园参观指南", snippet: "", url: "https://example.com/visit" }]; } });
  const output = await tool.execute({ city: "南昌", place: "测试公园", aspect: "开放时间" });
  assert.equal(searches, 1); assert.equal(pages, 1);
  assert.match(output, /hours: verified/); assert.match(output, /17:00/); assert.doesNotMatch(output, /22:00/);
});

test("搜索和正文共用四次请求上限，正文最多两页", async () => {
  let searches = 0, requests = 0, pages = 0;
  const tool = createReviewsTool((async (input) => {
    requests++;
    if (String(input).startsWith("https://example.com/")) pages++;
    return new Response("没有开放信息");
  }) as typeof fetch, { name: "test", async search() { searches++; return [1, 2, 3].map((id) => ({ title: `南昌测试公园参观指南${id}`, snippet: "", url: `https://example.com/${id}` })); } });
  await tool.execute({ city: "南昌", place: "测试公园", aspect: "开放时间" });
  assert.equal(searches + requests, 4); assert.equal(pages, 2);
});

test("DuckDuckGo图片挑战不能当成无结果的正常搜索", () => {
  assert.equal(isSearchChallenge('<title>DuckDuckGo</title><p>Please confirm this search was made by a human. Select all squares containing a duck.</p>'), true);
});

 test("摘要中的建馆日期不限定开放时段", () => {
  const facts = extractOpeningFacts("南昌", "江西省博物馆", [{ title: "江西省博物馆", snippet: "开放时间:9:00-17:00(周一闭馆) 服务内容:文物展览 简介:成立于1999年10月1日", url: "https://example.com/visit" }], ["hours"]);
  assert.equal(facts[0]!.status, "verified");
  assert.equal(openingHoursFor(facts[0], "2026-11-04")!.closes, "17:00");
});


test("街区全天开放不能覆盖博物馆自己的时段", () => {
  const facts = extractOpeningFacts("南昌", "万寿宫博物馆", [{ title: "万寿宫有什么好玩的", snippet: "开放时间是街区全天开放（建议游玩2 - 3小时），万寿宫博物馆08:00 - 17:30，门票免费，无需预约。", url: "https://example.com/visit" }], ["hours"]);
  assert.equal(openingHoursFor(facts[0])!.opens, "08:00");
  assert.equal(openingHoursFor(facts[0])!.closes, "17:30");
});

test("开放时间后的交通攻略不吞掉全天字段，喷泉场次不当作广场开放窗口", () => {
  const facts = extractOpeningFacts("南昌", "八一广场", [{ title: "八一广场攻略", snippet: "开放时间:全天24小时 游玩时间:建议2小时 景点地址:南昌 出行攻略:地铁1号线。音乐喷泉开放时间20:00-20:15", url: "https://example.com/visit" }], ["hours", "sessions"]);
  assert.equal(openingHoursFor(facts.find((f) => f.field === "hours"))!.closes, "24:00");
  assert.equal(facts.find((f) => f.field === "sessions")!.status, "verified");
});

test("天气条件暂停不能变成从公告日期起持续关闭", () => {
  const facts = extractOpeningFacts("南昌", "秋水广场音乐喷泉", [{ title: "秋水广场音乐喷泉", snippet: "自2023年4月1日起，秋水广场音乐喷泉开放时间调整如下：第一场19:30-19:45，若遇恶劣天气则暂停开放。", url: "https://example.com/visit" }], ["notices"]);
  assert.equal(facts.find((f) => f.field === "notices")!.status, "not_found");
});

test("厦门实测的双横线和全角冒号保留分季时段并选较早闭园", () => {
  const garden = { title: "厦门园林植物园", url: "https://www.xiamenbg.cn/Dp/time",
    snippet: "植物园开放时间 ： 5月1日-10月7日 6:30——18:00 10月8日-次年4月30日 6：30——17：30" };
  const [hours] = extractOpeningFacts("厦门", garden.title, [garden], ["hours"]);
  assert.equal(openingHoursFor(hours, "2026-10-07")?.closes, "18:00");
  assert.equal(openingHoursFor(hours, "2026-10-08")?.closes, "17:30");
  const [temple] = extractOpeningFacts("厦门", "南普陀寺", [
    { title: "南普陀寺", url: "https://example.com/visit", snippet: "每日开放时间08:00--19:00" },
    { title: "南普陀寺", url: "https://example.org/visit", snippet: "每日开放时间08:00-19:30" },
  ], ["hours"]);
  assert.equal(openingHoursFor(temple)?.closes, "19:00");
});

test("同一任务验证码退避后，360跳转与正文仍计入同一个四次请求预算", async () => {
  const calls: string[] = [];
  const tool = createReviewsTool((async (input, init) => {
    const url = new URL(String(input)); calls.push(url.hostname);
    if (url.hostname === "www.baidu.com" || url.hostname === "html.duckduckgo.com") return new Response("<title>安全验证</title>", { status: 403 });
    if (url.hostname === "www.so.com" && url.pathname === "/link") {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://example.org/museum" } });
    }
    if (url.hostname === "example.org") {
      assert.equal(init?.redirect, "manual");
      return new Response("<title>测试公园开放时间</title><article>测试公园开放时间09:00-17:00</article>");
    }
    if (url.hostname === "www.so.com") return new Response('<li class="res-list"><h3><a href="/link?m=sample">测试公园参观指南</a></h3><p class="res-desc">开放说明详见正文。</p></li>');
    return new Response("没有相关结果");
  }) as typeof fetch);
  const ctx = { workspace: process.cwd(), queryAttempts: new Map<string, number>() };
  const args = { city: "南昌", place: "测试公园", aspect: "开放时间" };
  await tool.execute(args, ctx);
  await tool.execute(args, ctx);
  calls.length = 0;
  const output = await tool.execute(args, ctx);
  assert.deepEqual(calls, ["www.bing.com", "www.so.com", "www.so.com", "example.org"]);
  assert.match(output, /hours: verified/);
  assert.match(output, /https:\/\/example.org\/museum/);
  calls.length = 0;
  await tool.execute(args, { workspace: ctx.workspace, queryAttempts: new Map() });
  assert.ok(calls.includes("www.baidu.com"));
});

test("被拦截的部分开放查询保留已有字段，缺失字段不写负缓存", async (t) => {
  const f = await fixture(t), diagnostics = new ToolDiagnostics();
  const registry = new ToolRegistry(f.root).register(createReviewsTool((async (input) => {
    if (String(input).includes("dpm.org.cn")) return new Response(await snapshot());
    return new Response("<title>安全验证</title>");
  }) as typeof fetch));
  const args = { city, place: name, aspect: "开放时间", fields: ["hours", "notices"] };
  const run = () => registry.execute("get_place_reviews", JSON.stringify(args), f.ctx);
  const result = await diagnostics.run({ id: "partial-blocked", name: "get_place_reviews", arguments: JSON.stringify(args) }, 1, async () => ({ output: await run() }));
  assert.match(result.output, /开放信息查询受阻，待确认字段：notices/);
  assert.equal(diagnostics.records[0]!.query_status, "failed");
  assert.equal(f.evidence.openingFactsFor(city, name).hours?.status, "verified");
  assert.equal(f.evidence.openingFactsFor(city, name).notices, undefined);
});

test("景区同名的室外网球场时段不能回填到整个沙面", () => {
  const [hours] = extractOpeningFacts("广州", "沙面", [{
    title: "广州多处体育场有限开放",
    url: "https://www.gz.gov.cn/zlgz/wlzx/content/post_5697801.html",
    snippet: "广州市沙面体育俱乐部在确保安全的前提下,有限开放室外网球场,开放时间为:8:00-9:30,10:30-12:00,14:00-15:30,16:30-18:00。",
  }], ["hours"]);
  assert.equal(hours?.status, "not_found");
});

test("熊猫基地官网票务表分别回填分季闭园和最后入园", async () => {
  const place = "成都大熊猫繁育研究基地";
  const tool = createReviewsTool((async (input) => {
    assert.equal(String(input), "https://www.panda.org.cn/cn/service/ticket/");
    return new Response("<main><p>1月、2月、11月、12月入园时间:8:00-16:30;闭园时间:17:30；</p><p>3月至10月入园时间:7:30-17:00;闭园时间:18:00</p></main>");
  }) as typeof fetch);
  const output = await tool.execute({ city: "成都", place, aspect: "开放时间" });
  assert.match(output, /hours: verified .*17:30.*18:00/);
  assert.match(output, /last_admission: verified .*16:30.*17:00/);
});

test("过期时段不会结束搜索，也不会压过新结果", async () => {
  const hosts: string[] = [];
  const tool = createReviewsTool((async (input) => {
    const { hostname } = new URL(String(input)); hosts.push(hostname);
    if (hostname === "test.gov.cn") return new Response("没有更多时段");
    return new Response(hostname === "www.bing.com" ? '<li class="b_algo"><h2><a href="https://test.gov.cn/old">测试公园</a></h2><p>2001年11月7日开放时间09:00-16:00</p></li>' : '<div class="result c-container" mu="https://example.org/current"><h3>测试公园参观指南</h3><!--s-data:{"summaryData":{"generalLines":[{"data":[{"text":"测试公园开放时间09:00-18:00"}]}]}}--></div>');
  }) as typeof fetch);
  const result = await tool.execute({ city: "成都", place: "测试公园", aspect: "开放时间" });
  assert.ok(hosts.includes("www.baidu.com"));
  assert.match(result, /hours: verified \[\{"opens":"09:00","closes":"18:00"\}/);
});

test("都江堰市博物馆闭馆不能回填到景区，优惠日期不限定开放时段", () => {
  const result = extractOpeningFacts("成都", "都江堰景区", [
    { title: "都江堰市常见问题", url: "https://www.djy.gov.cn/example", snippet: "一、都江堰市博物馆在哪里?都江堰市博物馆参观时间为9:00—17:00(周一闭馆)" },
    { title: "都江堰", url: "https://www.chengdu.gov.cn/example", snippet: "开放时间:8:00-17:00 门票:80元/人(自2018年10月1日起,景区对年满65周岁老年人免收)" },
  ], ["hours", "closure"]);
  assert.equal(result.find((fact) => fact.field === "closure")?.status, "not_found");
  assert.equal(openingHoursFor(result.find((fact) => fact.field === "hours"))?.closes, "17:00");
});

test("官网首页经参观指南进入开放时间，百科不抢正文预算，四次请求即完成", async () => {
  const urls: string[] = [];
  const tool = createReviewsTool((async (input) => {
    const url = String(input); urls.push(url);
    if (url.startsWith("https://www.bing.com/")) return new Response(
      '<li class="b_algo"><h2><a href="https://zh.wikipedia.org/wiki/测试公园">测试公园 - 维基百科</a></h2><p>测试公园的百科介绍。</p></li>' +
      '<li class="b_algo"><h2><a href="https://example.com/index.html%27">测试公园官网</a></h2><p>测试公园欢迎参观。</p></li>');
    if (url === "https://example.com/index.html") return new Response('<title>测试公园官网</title><nav><a href="/guide">参观指南</a><a href="https://other.example/visit">开放时间</a></nav>');
    if (url === "https://example.com/guide") return new Response('<title>参观指南</title><a href="/hours">开放时间</a><a href="/index.html">首页</a>');
    if (url === "https://example.com/hours") return new Response('<title>开放时间</title><article>每天开放时间09:00-17:00，16:30停止入园</article>');
    throw new Error("意外请求 " + url);
  }) as typeof fetch);
  const output = await tool.execute({ city: "南昌", place: "测试公园", aspect: "开放时间" });
  assert.equal(urls.length, 4);
  assert.deepEqual(urls.slice(1), ["https://example.com/index.html", "https://example.com/guide", "https://example.com/hours"]);
  assert.match(output, /hours: verified/);
  assert.match(output, /last_admission: verified/);
  assert.match(output, /https:\/\/example.com\/hours/);
});

test("兵马俑官网日期块的闭馆标签优先于未标用途区间，不把区间结束猜成最后入场", () => {
  const snippet = openingPageSnippet('<main><div>开放时间</div><div>旺季</div><div>3月16日—11月15日 闭馆时间18:30</div><div>08:30-17:00</div><div>淡季</div><div>11月16日—次年3月15日 闭馆时间18:00</div><div>08:30-16:30</div></main>')!;
  const facts = extractOpeningFacts("西安", "秦始皇帝陵博物院", [{ title: "秦始皇帝陵博物院官网", url: "https://www.bmy.com.cn/guide.html", snippet }], ["hours", "last_admission"]);
  const hours = facts.find((fact) => fact.field === "hours");
  assert.equal(openingHoursFor(hours, "2026-11-06")?.opens, "08:30");
  assert.equal(openingHoursFor(hours, "2026-11-06")?.closes, "18:30");
  assert.equal(openingHoursFor(hours, "2026-11-16")?.closes, "18:00");
  assert.equal(facts.find((fact) => fact.field === "last_admission")?.status, "not_found");
});
