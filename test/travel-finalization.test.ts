import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatAgent, type CumulativeToolBudget } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import type { PromptMessage } from "../src/core/message.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { createSaveItineraryTool, createLoadItineraryTool, renderMarkdown } from "../src/tools/itinerary.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { validateItinerary } from "../src/tools/itinerary-validator.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { routeModes } from "../src/tools/route-request.ts";

const title = "路线收尾回归", date = "2026-11-10";
const call = (name: string, args: Record<string, unknown>, id = name): LLMResult => ({ type: "tool_calls", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const text: LLMResult = { type: "text", content: "模型提前声称已完成" };
const draft = (withTransport = false) => call("save_itinerary", { title, constraints: { destination: "北京", require_routes: true }, days: [{ date, items: [
  { id: "a", type: "visit", name: "甲景点", time: "10:00", end_time: "11:00" },
  ...(withTransport ? [{ id: "r", type: "transport", name: "交通", from: "甲景点", to: "乙景点", transport_mode: "driving", time: "11:00", end_time: "11:20" }] : []),
  { id: "b", type: "visit", name: "乙景点", time: withTransport ? "11:20" : "11:00", end_time: "13:00" },
] }] });

class Script implements ChatProvider {
  readonly name = "finalization-test";
  readonly histories: PromptMessage[][] = [];
  private index = 0;
  private readonly script: LLMResult[];
  constructor(script: LLMResult[]) { this.script = script; }
  async chat(): Promise<string> { throw new Error("不应额外调用收尾模型"); }
  async chatWithTools(history: readonly PromptMessage[]): Promise<LLMResult> {
    this.histories.push([...history]);
    const result = this.script[this.index++]; assert.ok(result, "不应越过脚本继续空转"); return result;
  }
}

async function fixture(t: TestContext, script: LLMResult[], mode = "driving", duration = 9, routine = false) {
  const root = await mkdtemp(join(tmpdir(), "minicode-finalization-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry(root).register(createSaveItineraryTool(root)).register(createLoadItineraryTool(root));
  await registry.evidence.observePlaces("search_attractions", "北京", "1. 甲景点 | 坐标 39.9000,116.4000\n2. 乙景点 | 坐标 39.9125,116.4000", "amap");
  let queries = 0;
  if (!routine) registry.register({ name: "plan_day_routes", description: "查路线", parameters: {}, execute: async () => {
    queries++;
    const [route] = await registry.evidence.observeRoutes([{ city: "北京", from: "甲景点", to: "乙景点", mode, request_mode: mode,
      duration_min: duration, distance_km: 1.8, estimated: false, from_point: registry.evidence.point("甲景点", "北京")!, to_point: registry.evidence.point("乙景点", "北京")! }]);
    return `已核验路线${route.id}；尚未修改行程，请repair_routes保存`;
  } });
  const provider = new Script(script), session = new Session(), agent = new ChatAgent(session, provider, registry, root);
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxRounds: 30, maxCalls: 50 };
  const load = async () => parseItinerary(JSON.parse(await readFile(join(root, `plans/${title}.json`), "utf8")));
  return { root, registry, provider, session, agent, budget, load, queries: () => queries };
}

test("补查真实路线后模型直接收尾，程序自动保存再交付同一版本", async (t) => {
  const f = await fixture(t, [draft(), call("plan_day_routes", {}), text, text]);
  let streamed = "";
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget, onTextDelta: (value) => { streamed += value; } });
  const saved = await f.load(), route = saved.days[0].items.find((item) => item.type === "transport")!;
  assert.equal(f.queries(), 1); assert.equal(f.budget.calls, 3); assert.equal(saved.revision, 2);
  assert.equal(route.route_verified, true); assert.equal(route.transport_mode, "driving"); assert.equal(route.end_time, "11:09");
  assert.equal(saved.days[0].items.find((item) => item.id === "b")!.time, "11:09");
  assert.equal(validateItinerary(saved).issue_count.P1, 0);
  assert.match(reply, /strict 通过/); assert.doesNotMatch(reply, /模型提前/); assert.equal(streamed, reply);
  assert.equal(await readFile(join(f.root, `plans/${title}.md`), "utf8"), renderMarkdown(saved));
  assert.equal(f.session.travelState!.itinerary!.revision, saved.revision);
  assert.ok(f.agent.history.some((message) => message.toolCalls?.some((tool) => tool.id.startsWith("finalize-route-"))));
});

test("仍缺路线时拒绝提前文字交付，允许模型继续补查并修复", async (t) => {
  const f = await fixture(t, [draft(), text, call("plan_day_routes", {}), text, text]);
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget });
  assert.ok(f.provider.histories[2].some((message) => message.content?.includes("交付检查未通过")));
  assert.match(reply, /strict 通过/); assert.equal((await f.load()).revision, 2);
  assert.equal(f.agent.history.some((message) => message.content === text.content), false);
});

test("反复文字收尾没有实际进展时有界停止，保留未通过版本", async (t) => {
  const f = await fixture(t, [draft(), text, text, text]);
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget });
  assert.equal(f.provider.histories.length, 4); assert.equal(f.budget.calls, 1);
  assert.match(reply, /停止空转/); assert.match(reply, /strict 未通过/); assert.equal((await f.load()).revision, 1);
});

test("补查其他交通方式不能覆盖原驾车计划，明确选择步行后保存真实耗时", async (t) => {
  const selectWalking = call("save_itinerary", { title, days: [{ date, items: [{ id: "r", transport_mode: "walking" }] }] }, "select-walking");
  const f = await fixture(t, [draft(true), call("plan_day_routes", {}), text, selectWalking, text], "walking", 100);
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget });
  assert.ok(f.provider.histories[3].some((message) => message.content?.includes("交付检查未通过")));
  const route = (await f.load()).days[0].items.find((item) => item.type === "transport")!;
  assert.equal(route.transport_mode, "walking"); assert.equal(route.route_duration_min, 100); assert.equal(route.end_time, "12:40");
  assert.equal(f.queries(), 1); assert.match(reply, /strict 通过/);
});

test("累计预算用尽时不追加查询或自动保存，如实说明停止原因", async (t) => {
  const f = await fixture(t, [draft(), call("plan_day_routes", {})]);
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: { ...f.budget, maxCalls: 2 } });
  assert.equal(f.provider.histories.length, 2); assert.equal((await f.load()).revision, 1);
  assert.match(reply, /累计.*上限|累计预算/); assert.match(reply, /strict 未通过/);
});

test("新路线撞到固定预约时自动保存失败，保留原文件并停止重复提交", async (t) => {
  const locked = draft();
  assert.equal(locked.type, "tool_calls");
  const args = JSON.parse(locked.toolCalls[0].arguments); args.days[0].items[1].time_locked = true;
  const f = await fixture(t, [call("save_itinerary", args), call("plan_day_routes", {}), text, text, text, text]);
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget });
  const saved = await f.load();
  assert.equal(saved.revision, 1); assert.equal(saved.days[0].items.find((item) => item.id === "b")!.time, "11:00");
  assert.equal(f.budget.calls, 3); assert.match(reply, /strict 未通过/);
  assert.ok(f.agent.history.some((message) => message.role === "tool" && message.content.includes("固定11:00")));
});

test("只读加载和查询路线不会自动修改已保存的草稿", async (t) => {
  const f = await fixture(t, [call("load_itinerary", { title, summary: true }), call("plan_day_routes", {}), text]);
  const initial = draft(); assert.equal(initial.type, "tool_calls");
  await createSaveItineraryTool(f.root).execute(JSON.parse(initial.toolCalls[0].arguments), { workspace: f.root, evidence: f.registry.evidence });
  await f.agent.run("看看这两处的交通要多久", { maxToolRounds: 20, cumulativeBudget: f.budget });
  assert.equal((await f.load()).revision, 1); assert.equal(f.budget.calls, 2);
});

test("保存新顺序和方式后自动补查变化路段，复用不变段，最后保存核验版本", async (t) => {
  const initial = call("save_itinerary", {
    title, constraints: { destination: "北京", require_routes: true },
    schedule: { date, visits: ["甲景点", "乙景点", "丙景点"].map((name) => ({ name, duration_min: 40 })), mode: "walking" },
  });
  const replace = call("save_itinerary", {
    title, schedule: { date, visits: ["甲景点", "乙景点", "丁景点", "丙景点"].map((name) => ({ name, duration_min: 40 })),
      mode: "walking", leg_modes: ["walking", "transit", "walking"] },
  });
  const f = await fixture(t, [initial, replace, text], undefined, undefined, true);
  await f.registry.evidence.observePlaces("search_attractions", "北京", "丙景点 | 坐标 39.9200,116.4000\n丁景点 | 坐标 39.9250,116.4050", "amap");
  const queries: { stops: string[]; modes: string[] }[] = [];
  f.registry.register({ ...createPlanRoutesTool(), async execute(args, ctx) {
    const stops = args.stops as string[], city = args.city as string;
    const modes = routeModes(args, stops.length - 1);
    queries.push({ stops, modes });
    await ctx!.evidence!.observeRoutes(modes.map((mode, index) => ({ city, from: stops[index]!, to: stops[index + 1]!, mode, request_mode: mode,
      duration_min: 15, distance_km: 1, estimated: false,
      from_point: ctx!.evidence!.point(stops[index]!, city)!, to_point: ctx!.evidence!.point(stops[index + 1]!, city)!,
    })));
    return "已查路线";
  } });
  const reply = await f.agent.run("规划行程", { maxToolRounds: 20, cumulativeBudget: f.budget });
  assert.deepEqual(queries, [
    { stops: ["甲景点", "乙景点", "丙景点"], modes: ["walking", "walking"] },
    { stops: ["乙景点", "丁景点", "丙景点"], modes: ["transit", "walking"] },
  ]);
  const saved = await f.load();
  assert.equal(saved.revision, 4);
  assert.deepEqual(saved.days[0]!.items.filter((item) => item.type === "transport").map((item) => [item.from, item.to, item.transport_mode, item.route_verified]), [
    ["甲景点", "乙景点", "walking", true], ["乙景点", "丁景点", "transit", true], ["丁景点", "丙景点", "walking", true],
  ]);
  assert.match(reply, /strict 通过/);
});
