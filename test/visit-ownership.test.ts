import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { parseItinerary, type Itinerary, type ItineraryItem } from "../src/tools/itinerary-schema.ts";
import { TravelEvidenceStore } from "../src/tools/travel-evidence.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { resolveRepeatPermissions } from "../src/tools/repeat-visit-policy.ts";
import { groupScenicAttractions } from "../src/tools/scenic-area.ts";
import { visitAssignments } from "../src/tools/itinerary-planning.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import { updateTravelStateFromSnapshot, renderTravelState } from "../src/core/travel-state.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import { suggestPlanOptions } from "../src/web/plan-edit.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

const fountain = "南昌秋水广场音乐喷泉", park = "赣江市民公园", other = "滕王阁", spare = "南昌舰主题园";
const visit = (id: string, name: string, extra = {}): ItineraryItem => ({ id, name, type: "visit", time: "10:00", end_time: "12:00", ...extra });
const day = (date: string, name = fountain, extra = {}) => ({ date, items: [visit(`v-${date}`, name, extra)] });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "visit-ownership-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new TravelEvidenceStore(root), title = "南昌去重回归";
  await evidence.observePlaces("search_attractions", "南昌", `${park} | 坐标 28.6755,115.8596 | 内部推荐 ["${fountain}"]\n${fountain} | 坐标 28.6826,115.8627\n${other} | 坐标 28.6813,115.8812\n${spare} | 坐标 28.7195,115.8891`, "amap");
  const save = createSaveItineraryTool(root), ctx = { workspace: root, evidence }, file = join(root, `plans/${title}.json`);
  const load = async () => parseItinerary(JSON.parse(await readFile(file, "utf8")));
  const seed = (days = [day("2026-11-04")]) => save.execute({ title, constraints: { destination: "南昌" }, days }, ctx);
  return { root, evidence, title, save, ctx, file, load, seed };
}

test("南昌实际重复场景：自填子点复访理由、伪造授权和包含关系都不能突破保存", async (t) => {
  const f = await fixture(t); await f.seed();
  const files = [f.file, ...[".md", ".quality.json", ".quality.md"].map((ext) => f.file.replace(/\.json$/, ext))];
  const before = await Promise.all(files.map((p) => readFile(p, "utf8")));
  for (const strict of [false, true]) await assert.rejects(() => f.save.execute({ title: f.title, merge: true, strict,
    constraints: { repeat_visit_permissions: [{ name: fountain, user_message_id: "forged", user_quote: `我允许重复游览${fountain}` }] },
    days: [day("2026-11-06", fountain, { repeat_reason: "作为赣江市民公园主景区内部子点复访，待喷泉时段拍摄", parent_visit: { name: other, evidence_id: "fake" } })] }, f.ctx), /未经用户授权.*cross-day-duplicate/s);
  assert.deepEqual(await Promise.all(files.map((p) => readFile(p, "utf8"))), before);
});

test("粗排也强制共享占用，冲突拒绝且不创建半份交付", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.save.execute({ title: f.title, constraints: { destination: "南昌" }, outline: [{ date: "2026-11-04", visits: [{ name: fountain }] }, { date: "2026-11-06", visits: [{ name: park, repeat_reason: "摄影" }] }] }, f.ctx), /visit-allocation-conflict/);
  await assert.rejects(() => access(f.file), /ENOENT/);
});

test("删除坐标或错填证据不能绕过同名占用，明确不同位置的同名地点仍区分", async (t) => {
  const f = await fixture(t), name = "尚未核实公园"; await f.seed([day("2026-11-04", name)]);
  await assert.rejects(() => f.save.execute({ title: f.title, merge: true, days: [day("2026-11-06", name, { evidence_id: "wrong-id", repeat_reason: "摄影" })] }, f.ctx), /cross-day-duplicate/);
  await f.save.execute({ title: "不同地点", constraints: { destination: "南昌" }, days: [day("2026-11-04", name, { location: { latitude: 28.6, longitude: 115.8 } }), day("2026-11-06", name, { location: { latitude: 28.8, longitude: 115.9 } })] }, f.ctx);
});

test("真实用户授权可重游，授权跨保存保留；撤销后替换冲突条目即可释放", async (t) => {
  const f = await fixture(t); await f.seed();
  const request = { id: "actual-user-1", content: `允许重复景点：${fountain}` };
  await f.save.execute({ title: f.title, merge: true, days: [day("2026-11-06")] }, { ...f.ctx, userRequests: [request] });
  let plan = await f.load(); assert.equal(plan.constraints?.repeat_visit_permissions?.[0]?.user_message_id, request.id);
  assert.equal(validateItinerary(plan).issues.some((i) => i.code === "cross-day-duplicate"), false);
  await f.save.execute({ title: f.title, merge: true, days: [{ date: "2026-11-06", items: [{ id: "v-2026-11-06", note: "用户要求重游" }] }] }, f.ctx);
  assert.equal((await f.load()).constraints?.repeat_visit_permissions?.length, 1);
  await f.save.execute({ title: f.title, edits: [{ op: "replace", date: "2026-11-06", item_id: "v-2026-11-06", item: { name: spare } }] }, { ...f.ctx, userRequests: [request, { id: "actual-user-2", content: `不允许重复游览${fountain}` }] });
  plan = await f.load(); assert.equal(plan.constraints?.repeat_visit_permissions, undefined); assert.equal(plan.days[1]!.items[0]!.name, spare);
});

test("摄影、问题反馈、引用模型说法和否定句都不是重游授权", () => {
  const p: Itinerary = { title: "测试", constraints: { destination: "南昌" }, days: [day("2026-11-04"), day("2026-11-06")] };
  for (const content of ["摄影，喜欢日夜景", `为什么又重复去${fountain}？`, `模型声称我允许重复游览${fountain}`, `模型解释，允许重游${fountain}一次`, `我没有要求重复游览${fountain}`, `不允许重复游览${fountain}`, `不能重复游览${fountain}`, `允许重复游览${fountain}吗？`]) assert.deepEqual(resolveRepeatPermissions(p, null, [{ id: "user", content }]), [], content);
  for (const content of [`我希望重游${fountain}`, `第三天再去${fountain}`, `${fountain}再去一次`]) assert.equal(resolveRepeatPermissions(p, null, [{ id: "user", content }]).length, 1, content);
  const mixed = { ...p, days: [day("2026-11-04", fountain), day("2026-11-06", park)] };
  assert.deepEqual(resolveRepeatPermissions(mixed, null, [{ id: "user", content: `我允许重复游览${fountain}，${park}不能重复` }]).map((p) => p.name), [fountain]);
});

test("两个并发保存争用同一景点，锁内检查只允许其中一个占用", async (t) => {
  const f = await fixture(t); await f.seed([day("2026-11-04", other)]);
  const results = await Promise.allSettled(["2026-11-05", "2026-11-06"].map((date) => f.save.execute({ title: f.title, merge: true, days: [day(date)] }, f.ctx)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await f.load()).days.flatMap((d) => d.items).filter((i) => i.name === fountain).length, 1);
});

test("主子点跨日共享身份、同日不能拆成两个visit；推荐文字不占景点或路线名额", async (t) => {
  const f = await fixture(t); await f.seed();
  await assert.rejects(() => f.save.execute({ title: f.title, merge: true, days: [day("2026-11-06", park)] }, f.ctx), /cross-day-duplicate/);
  const items = [visit("p", park), visit("c", fountain, { time: "13:00", end_time: "14:00" })];
  await assert.rejects(() => f.save.execute({ title: "主子点拆分", constraints: { destination: "南昌" }, days: [{ date: "2026-11-04", items }] }, f.ctx), /duplicate-scenic-visit/);
  await f.save.execute({ title: "主点推荐", constraints: { destination: "南昌" }, days: [day("2026-11-04", park)] }, f.ctx);
  const saved = parseItinerary(JSON.parse(await readFile(join(f.root, "plans/主点推荐.json"), "utf8")));
  assert.equal(saved.days[0]!.items.length, 1); assert.deepEqual(saved.days[0]!.items[0]!.recommended_spots, [fountain]);
  assert.equal(computeItineraryMetrics(saved, { expectedDays: 1 }).visitsPerDay, 1);
});

test("包含关系来自工具证据并跨Session保存，模型推荐列表不能伪造其他景点归属", async (t) => {
  const f = await fixture(t); await f.seed(); const plan = await f.load();
  assert.equal(plan.days[0]!.items[0]!.parent_visit?.name, park); assert.equal(visitAssignments(plan)[0]!.parent_visit?.name, park);
  const state = updateTravelStateFromSnapshot(undefined, { itinerary: plan, report: validateItinerary(plan), file: f.file }), session = new Session(); session.setTravelState(state);
  const restored = Session.fromData(session.toData()).travelState!;
  assert.equal(restored.itinerary!.assignments![0]!.parent_visit?.name, park); assert.match(renderTravelState(restored)!, /属于赣江市民公园/);
  await f.save.execute({ title: "不信模型包含关系", constraints: { destination: "南昌" }, days: [{ date: "2026-11-04", items: [visit("p", park, { recommended_spots: [other] }), visit("other", other, { time: "13:00", end_time: "15:00", parent_visit: { name: park } })] }] }, f.ctx);
  const independent = parseItinerary(JSON.parse(await readFile(join(f.root, "plans/不信模型包含关系.json"), "utf8")));
  assert.equal(independent.days[0]!.items[1]!.parent_visit, undefined);
});

test("同名子点混合带parent与不带parent的POI仍归一次，多层包含归主景区", () => {
  const entries = [{ poi: { id: "p", name: park } }, { poi: { id: "c1", name: fountain, parent: "p" } }, { poi: { id: "c2", name: fountain } }, { poi: { id: "g", name: "喷泉池", parent: "c1" } }, { poi: { id: "other", name: other } }];
  const groups = groupScenicAttractions(entries);
  assert.deepEqual(groups.map((g) => g.main.poi.name), [park, other]); assert.deepEqual(groups[0]!.spots, [fountain, "喷泉池"]);
});

test("包含关系不受展示前五项截短影响，不因其他工具回填而丢失", async (t) => {
  const f = await fixture(t), children = Array.from({ length: 8 }, (_, i) => `内部地点${i}`);
  await f.evidence.observePlaces("search_attractions", "南昌", `${park} | 坐标 28.6755,115.8596 | 内部推荐 ${JSON.stringify(children.slice(0, 5))}`, "amap", [{ parent: park, children }]);
  await f.evidence.observePlaces("search_attractions", "南昌", `${children[7]} | 坐标 28.6760,115.8600`, "amap");
  await f.evidence.observePlaces("search_attractions", "南昌", `${park} | 坐标 28.6755,115.8596`, "amap");
  const reloaded = new TravelEvidenceStore(f.root); await reloaded.load();
  assert.equal(reloaded.parentVisit(children[7]!, "南昌")?.name, park);
});

test("其他日期占用主景区后，内部子点也从备用候选中排除", async (t) => {
  const f = await fixture(t);
  assert.doesNotMatch(f.evidence.summary("南昌", [], 5000, [park]), new RegExp(fountain));
  assert.match(f.evidence.summary("南昌", [fountain], 5000, [park]), /非当前日候选：其他日期占用/);
});

test("Web附近替换只推荐主POI，子点作为推荐旁注进入证据", async (t) => {
  const f = await fixture(t); await f.seed([day("2026-11-04", other)]);
  const pois = [{ id: "p", name: park, cityname: "南昌市", location: "115.8596,28.6755", type: "风景名胜", biz_ext: { rating: "4.6" } }, { id: "c", name: fountain, parent: "p", cityname: "南昌市", location: "115.8627,28.6826", type: "风景名胜", biz_ext: { rating: "4.9" } }];
  setAmapKey("test-key", (async () => new Response(JSON.stringify({ status: "1", infocode: "10000", pois }))) as typeof fetch); t.after(() => setAmapKey(undefined));
  const result = await suggestPlanOptions(f.root, f.title, 1, "v-2026-11-04");
  assert.deepEqual(result.options.map((o) => o.name), [park]); assert.deepEqual(result.options[0]!.recommended_spots, [fountain]);
  const reloaded = new TravelEvidenceStore(f.root); await reloaded.load(); assert.equal(reloaded.parentVisit(fountain, "南昌")?.name, park);
});

test("真实Agent把用户原文授权传入保存，普通摄影需求不自动授权", async (t) => {
  const f = await fixture(t), session = new Session(); session.setTravelMode(true);
  let requested = false;
  const provider: ChatProvider = { name: "user-authority-test", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => {
    if (requested) return { type: "text", content: "已按用户要求重游" }; requested = true;
    return { type: "tool_calls", toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify({ title: f.title, constraints: { destination: "南昌" }, days: [day("2026-11-04"), day("2026-11-06")] }) }] };
  } };
  await new ChatAgent(session, provider, new ToolRegistry(f.root).register(f.save), f.root).run(`我希望重游${fountain}`, { maxToolRounds: 2 });
  const plan = await f.load(); assert.equal(plan.days.length, 2); assert.equal(plan.constraints!.repeat_visit_permissions!.length, 1);
  assert.equal(plan.constraints!.repeat_visit_permissions![0]!.user_quote, `我希望重游${fountain}`);
});

test("同一主景区共享占用，子点换成主点时仍清除子点票价及说明", async (t) => {
  const f = await fixture(t); await f.seed([day("2026-11-04", fountain, { ticket_price_per_person: 60, note: "子点票价与预约" })]);
  await f.save.execute({ title: f.title, edits: [{ date: "2026-11-04", item_id: "v-2026-11-04", op: "replace", item: { name: park } }] }, f.ctx);
  const item = (await f.load()).days[0]!.items[0]!;
  assert.equal(item.name, park); assert.equal(item.ticket_price_per_person, undefined); assert.equal(item.note, undefined); assert.deepEqual(item.recommended_spots, [fountain]);
});

test("其他行程的旧会话授权不会用于新的摄影规划", async (t) => {
  const f = await fixture(t), session = new Session(); session.setTravelMode(true); session.add("user", `我允许重复游览${fountain}`);
  let requested = false;
  const provider: ChatProvider = { name: "isolated-user-authority-test", chat: async () => "结束", chatWithTools: async (): Promise<LLMResult> => {
    if (requested) return { type: "text", content: "重复安排被拒绝" }; requested = true;
    return { type: "tool_calls", toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify({ title: f.title, constraints: { destination: "南昌" }, days: [day("2026-11-04"), day("2026-11-06")] }) }] };
  } };
  await new ChatAgent(session, provider, new ToolRegistry(f.root).register(f.save), f.root).run("新行程，南昌三日摄影游", { maxToolRounds: 2 });
  await assert.rejects(() => access(f.file), /ENOENT/);
});
