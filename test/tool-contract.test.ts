import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/tool.ts";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { createVisitInfoTool } from "../src/tools/place-visit-info.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";
import { ToolValidationError } from "../src/core/tool-error.ts";
import { executionStateOf } from "../src/core/execution-state.ts";
import { handleMcpMessage } from "../src/mcp/server.ts";
import { Session } from "../src/core/session.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import type { ChatProvider } from "../src/llm/provider.ts";
import { executeToolCatalog } from "../src/tools/activation.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "tool-contract-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("统一schema在副作用、恢复和查询扣额之前拒绝嵌套类型/枚举/范围/缺参/未知键", async (t) => {
  const root = await temp(t); let executed = 0;
  const registry = new ToolRegistry(root).register({ name: "write", effect: "managed_write", description: "test", parameters: { type: "object", additionalProperties: false, required: ["rows"], properties: { rows: { type: "array", minItems: 1, items: { type: "object", required: ["count", "mode"], properties: { count: { type: "integer", minimum: 1 }, mode: { enum: ["walking", "driving"] } } } } } }, execute: async () => { executed++; return "written"; } });
  for (const args of [{}, { rows: [] }, { rows: [{ count: "2", mode: "walking" }] }, { rows: [{ count: 0, mode: "flying" }] }, { rows: [{ count: 1, mode: "walking" }], typo: true }]) {
    await assert.rejects(() => registry.executeDetailed("write", JSON.stringify(args)), (error: unknown) => {
      assert.ok(error instanceof ToolValidationError); assert.ok(error.issues.every((issue) => issue.path.startsWith("/")));
      assert.equal(executionStateOf(error)?.effect_status, "not_committed"); assert.equal(executionStateOf(error)?.recovery_action, "fix_arguments"); return true;
    });
  }
  assert.equal(executed, 0); assert.deepEqual(await readdir(root), []);
  await registry.execute("write", '{"rows":[{"count":2,"mode":"walking"}]}'); assert.equal(executed, 1);
});

test("损坏JSON及根数组不猜测修复，不把输入错误标为提交未知", async (t) => {
  const root = await temp(t); const registry = new ToolRegistry(root).register(createSaveTravelBriefTool(root));
  for (const input of ['{"title":"x"', '[]', 'null', '"{}"']) await assert.rejects(() => registry.executeDetailed("save_travel_brief", input), (error: unknown) => { assert.ok(error instanceof ToolValidationError); assert.equal(executionStateOf(error)?.effect_status, "not_committed"); return true; });
  assert.deepEqual(await readdir(root), []);
});

test("明确参观参数别名归一化后共享缓存；冲突地点拒绝，不跨工具猜含义", async (t) => {
  const root = await temp(t); let calls = 0; let effective: Record<string, unknown> = {};
  const registry = new ToolRegistry(root).register({ ...createVisitInfoTool(), execute: async (args) => { calls++; effective = args; return "参观资料暂无可信时段"; } });
  const changes: string[] = [];
  await registry.execute("get_place_visit_info", JSON.stringify({ name: "故宫", fields: ["opening_hours", "closed_on", "duration"] }), { workspace: root, destination: "北京", onArgumentsPrepared: (_args, corrections) => changes.push(...corrections) });
  assert.equal(effective.place, "故宫"); assert.equal(effective.city, "北京"); assert.deepEqual(effective.fields, ["closure", "hours", "visit_duration"]); assert.equal(effective.name, undefined);
  assert.ok(changes.includes("name→place")); assert.ok(changes.includes("fields.opening_hours→hours"));
  await registry.execute("get_place_visit_info", JSON.stringify({ query: "故宫", fields: ["hours", "closure", "visit_duration"] }), { workspace: root, destination: "北京" });
  assert.equal(calls, 1, "纠正前后的同一请求不应重复联网");
  await assert.rejects(() => registry.execute("get_place_visit_info", '{"place":"故宫","query":"天坛"}'), /TOOL_ARGUMENT_ALIAS_CONFLICT/); assert.equal(calls, 1);
  await assert.rejects(() => registry.execute("get_place_visit_info", '{"query":"故宫","fields":["random"]}'), /VISIT_INFO_FIELDS_INVALID/);
});

test("JSON编码的字符串数组可无损转换，真实需求、落盘与Session一致", async (t) => {
  const root = await temp(t), session = new Session(); let requests = 0;
  const registry = new ToolRegistry(root).register(createSaveTravelBriefTool(root));
  const provider: ChatProvider = { name: "brief-contract", chat: async () => "unused", chatWithTools: async () => ++requests === 1 ? { type: "tool_calls", toolCalls: [{ id: "brief", name: "save_travel_brief", arguments: JSON.stringify({ title: "福州需求", destination: "福州", durationDays: 1, mustVisit: '["烟台山"]', avoid: '["鼓山"]' }) }] } : { type: "text", content: "已记录需求" } };
  await new ChatAgent(session, provider, registry, root).run("记录福州一日游需求", { maxToolRounds: 3 });
  assert.deepEqual(session.travelState?.brief?.avoid, ["鼓山"]); assert.deepEqual(session.travelState?.brief?.mustVisit, ["烟台山"]);
  const saved = JSON.parse(await readFile(join(root, "plans/briefs/福州需求.json"), "utf8")); assert.deepEqual(saved.avoid, ["鼓山"]);
  assert.ok(session.history.some((message) => message.role === "tool" && message.content.includes("JSON字符串→字符串数组")));
});

test("MCP与Agent共用schema，返回明确路径及转换元数据，不把错误参数吞成空对象", async (t) => {
  const root = await temp(t); let calls = 0;
  const registry = new ToolRegistry(root).register({ ...createVisitInfoTool(), execute: async () => { calls++; return "资料"; } });
  const invoke = async (args: unknown) => (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_place_visit_info", arguments: args } }, registry, { name: "test", version: "1" }))!.result as Record<string, unknown>;
  const valid = await invoke({ name: "故宫", fields: ["closed_on"] }); assert.equal(valid.isError, false); assert.deepEqual((valid.structuredContent as { argument_corrections: string[] }).argument_corrections, ["name→place", "fields.closed_on→closure"]);
  const invalid = await invoke([]); assert.equal(invalid.isError, true); assert.match((invalid.content as { text: string }[])[0]!.text, /TOOL_ARGUMENT_OBJECT_REQUIRED/); assert.equal(calls, 1);
});

test("生产工具拒绝未声明字段，第三方工具可按自身schema明确保留扩展", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ writeRoot: root, workspace: root });
  await assert.rejects(() => registry.execute("search_attractions", '{"city":"杭州","location":"西湖","wrong_parameter":true}'), (error: unknown) => { assert.ok(error instanceof ToolValidationError); assert.ok(error.issues.some((issue) => issue.path === "/wrong_parameter")); return true; });
  assert.deepEqual(await readdir(root), []);
  const extension = new ToolRegistry(root).register({ name: "extension", description: "test", parameters: { type: "object", additionalProperties: true }, execute: async (args) => String(args.extra) });
  assert.equal(await extension.execute("extension", '{"extra":"kept"}'), "kept");
});

test("工具目录同样先校验，不把categories字符串或错拼键当作成功激活", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ writeRoot: root, workspace: root }), session = new Session();
  assert.throws(() => executeToolCatalog("activate_tools", { categories: "discovery" }, registry, session), ToolValidationError);
  assert.throws(() => executeToolCatalog("activate_tools", { category: "discovery" }, registry, session), ToolValidationError);
  assert.equal(session.activeTools.length, 0);
  assert.match(executeToolCatalog("activate_tools", { categories: ["discovery"] }, registry, session), /激活/); assert.ok(session.activeTools.includes("search_attractions"));
});
