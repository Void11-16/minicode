import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyItemEdits } from "../src/tools/itinerary-planning.ts";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { ToolValidationError, toolErrorOutput } from "../src/core/tool-error.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { ChatAgent, type AgentEvent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import type { CumulativeToolBudget } from "../src/core/execution-budget.ts";
import { handleMcpMessage } from "../src/mcp/server.ts";
import { toolErrorCategory, ToolDiagnostics } from "../src/core/tool-diagnostics.ts";
import { compactToolResults } from "../src/agent/tool-output.ts";

const date = "2026-11-06";
const plan = () => parseItinerary({ title: "局部编辑校验", days: [{ date, items: [
  { id: "park", name: "赣江市民公园", type: "visit", time: "10:00", end_time: "12:00" },
  { id: "route", name: "公园至喷泉", type: "transport", from: "赣江市民公园", to: "秋水广场", time: "12:15", end_time: "12:30" },
  { id: "fountain", name: "秋水广场", type: "visit", time: "13:00", end_time: "15:00" },
  { id: "hotel", name: "测试酒店", type: "accommodation", time: "17:00" },
] }] });
const edit = (overrides: object = {}) => ({ op: "replace", date, item_id: "park", item: { name: "赣江市民公园" }, ...overrides });
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "edit-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("局部编辑各类失败有独立错误码和参数路径，缺名不掩盖ID/类型冲突", async (t) => {
  const cases: { name: string; raw: unknown; code: string; path: string }[] = [
    { name: "edits非数组", raw: {}, code: "ITINERARY_EDITS_INVALID", path: "edits" },
    { name: "批次过长", raw: Array(31).fill(edit()), code: "ITINERARY_EDITS_INVALID", path: "edits" },
    ...[null, [], "错误条目"].map((value) => ({ name: `编辑项${JSON.stringify(value)}`, raw: [value], code: "ITINERARY_EDIT_INVALID", path: "edits[0]" })),
    { name: "操作不支持", raw: [edit({ op: "add" })], code: "ITINERARY_EDIT_OP_INVALID", path: "edits[0].op" },
    { name: "无效日历日期", raw: [edit({ date: "2026-02-30" })], code: "ITINERARY_EDIT_DATE_INVALID", path: "edits[0].date" },
    { name: "缺少ID", raw: [edit({ item_id: "" })], code: "ITINERARY_EDIT_ITEM_ID_REQUIRED", path: "edits[0].item_id" },
    { name: "日期未保存", raw: [edit({ date: "2026-11-07" })], code: "ITINERARY_EDIT_DAY_NOT_FOUND", path: "edits[0].date" },
    { name: "ID不存在", raw: [edit({ item_id: "guessed" })], code: "ITINERARY_EDIT_ITEM_NOT_FOUND", path: "edits[0].item_id" },
    ...[undefined, null, []].map((value) => ({ name: `item无效${JSON.stringify(value)}`, raw: [edit({ item: value })], code: "ITINERARY_EDIT_ITEM_REQUIRED", path: "edits[0].item" })),
    { name: "只改时间未带名称", raw: [edit({ item: { end_time: "12:05" } })], code: "ITINERARY_EDIT_NAME_REQUIRED", path: "edits[0].item.name" },
    ...[" ", 123].map((name) => ({ name: `名称无效${JSON.stringify(name)}`, raw: [edit({ item: { name } })], code: "ITINERARY_EDIT_NAME_INVALID", path: "edits[0].item.name" })),
    { name: "尝试修改ID", raw: [edit({ item: { name: "赣江市民公园", id: "new-id" } })], code: "ITINERARY_EDIT_ID_IMMUTABLE", path: "edits[0].item.id" },
    { name: "景点改交通", raw: [edit({ item: { name: "交通", type: "transport" } })], code: "ITINERARY_EDIT_TYPE_IMMUTABLE", path: "edits[0].item.type" },
    { name: "无效目标日期", raw: [edit({ op: "move", to_date: "2026-02-30", item: undefined })], code: "ITINERARY_EDIT_TARGET_DATE_INVALID", path: "edits[0].to_date" },
    { name: "移动时item为空值", raw: [edit({ op: "move", to_date: "2026-11-07", item: null })], code: "ITINERARY_EDIT_ITEM_INVALID", path: "edits[0].item" },
    { name: "移动中修改名称", raw: [edit({ op: "move", to_date: "2026-11-07" })], code: "ITINERARY_EDIT_MOVE_FIELDS_INVALID", path: "edits[0].item" },
  ];
  for (const c of cases) await t.test(c.name, () => {
    const original = plan(), snapshot = JSON.stringify(original);
    assert.throws(() => applyItemEdits(original, c.raw), (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.equal(error.code, c.code);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0].path, c.path);
      assert.ok(error.issues[0].hint);
      assert.equal(toolErrorCategory(error), "validation");
      return true;
    });
    assert.equal(JSON.stringify(original), snapshot);
  });
  assert.throws(() => applyItemEdits(plan(), [edit({ item: { id: "new", type: "transport" } })]), (error) => {
    assert.ok(error instanceof ToolValidationError);
    assert.equal(error.code, "TOOL_VALIDATION_FAILED");
    assert.deepEqual(error.issues.map((i) => i.code), ["ITINERARY_EDIT_NAME_REQUIRED", "ITINERARY_EDIT_ID_IMMUTABLE", "ITINERARY_EDIT_TYPE_IMMUTABLE"]);
    const type = error.issues[2];
    assert.equal(type.expected, "visit"); assert.equal(type.actual, "transport");
    assert.equal(type.date, date); assert.equal(type.item_id, "park"); assert.equal(type.item_name, "赣江市民公园");
    return true;
  });
});

test("同批返回名称、景点类型、酒店类型三个错误，前面的有效修改及所有落盘文件保持原样", async (t) => {
  const root = await temp(t), save = createSaveItineraryTool(root), initial = plan();
  await save.execute(initial as unknown as Record<string, unknown>);
  const files = ["json", "md", "quality.json", "quality.md"].map((ext) => join(root, `plans/${initial.title}.${ext}`));
  const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
  await assert.rejects(() => save.execute({ title: initial.title, edits: [
    edit({ item_id: "fountain", item: { name: "秋水广场", note: "这项有效修改也不能部分保存" } }),
    edit({ item: { end_time: "12:05" } }),
    edit({ item_id: "fountain", item: { name: "步行前往秋水广场", type: "transport" } }),
    edit({ item_id: "hotel", item: { name: "返回酒店", type: "transport" } }),
  ] }), (error) => {
    assert.ok(error instanceof ToolValidationError);
    assert.equal(error.issues.length, 3);
    assert.deepEqual(error.issues.map((i) => i.path), ["edits[1].item.name", "edits[2].item.type", "edits[3].item.type"]);
    assert.equal(error.issues[2].expected, "accommodation");
    assert.equal(error.issues[2].actual, "transport");
    return true;
  });
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before);
});

test("批次按顺序解析移动后的条目，保留原ID/type和原始对象", () => {
  const original = plan(), snapshot = JSON.stringify(original);
  const updated = applyItemEdits(original, [edit({ op: "move", to_date: "2026-11-07", item: { time: "10:00" } }), edit({ date: "2026-11-07", item: { name: "赣江市民公园", note: "移动后补说明" } })]);
  const item = updated.days.find((d) => d.date === "2026-11-07")!.items[0];
  assert.equal(item.id, "park"); assert.equal(item.type, "visit"); assert.equal(item.note, "移动后补说明");
  assert.equal(JSON.stringify(original), snapshot);
});

test("真实Agent收到结构化错误后能修正参数；MCP保留isError和同一错误码；诊断记录类型", async (t) => {
  const root = await temp(t), registry = new ToolRegistry(root).register(createSaveItineraryTool(root)), initial = plan();
  await registry.execute("save_itinerary", JSON.stringify(initial));
  const session = new Session();
  let round = 0;
  const provider: ChatProvider = { name: "edit-validation", chat: async () => "完成", chatWithTools: async (): Promise<LLMResult> => {
    round++;
    if (round > 2) return { type: "text", content: "已修正" };
    return { type: "tool_calls", toolCalls: [{ id: `edit-${round}`, name: "save_itinerary", arguments: JSON.stringify({ title: initial.title, edits: [edit({ item: { ...(round === 2 ? { name: "赣江市民公园" } : {}), note: "按错误信息补齐名称后保存" } })] }) }] };
  } };
  const budget: CumulativeToolBudget = { rounds: 0, calls: 0, tokens: 0, maxCalls: 10, maxRounds: 10 };
  const events: AgentEvent[] = [];
  await new ChatAgent(session, provider, registry, root).run("补充公园说明", { cumulativeBudget: budget, onEvent: (event) => events.push(event) });
  const toolMessage = session.history.find((m) => m.role === "tool" && m.toolCallId === "edit-1")!.content;
  const error = JSON.parse(toolMessage.slice(toolMessage.indexOf("\n") + 1));
  assert.equal(error.error_type, "validation"); assert.equal(error.code, "ITINERARY_EDIT_NAME_REQUIRED");
  assert.equal(error.issues[0].path, "edits[0].item.name");
  const event = events.find((e) => e.type === "tool_error")!;
  assert.equal(event.error_type, "validation"); assert.equal(event.code, error.code);
  assert.equal(event.issues![0].path, error.issues[0].path);
  assert.equal(budget.diagnostics!.records[0].error, "validation");
  assert.equal(budget.diagnostics!.records[0].error_code, error.code);
  const saved = JSON.parse(await readFile(join(root, `plans/${initial.title}.json`), "utf8"));
  assert.equal(saved.days[0].items.find((i: { id: string }) => i.id === "park").note, "按错误信息补齐名称后保存");
  const response = await handleMcpMessage({ id: 1, method: "tools/call", params: { name: "save_itinerary", arguments: { title: initial.title, edits: [edit({ item: { name: "交通", type: "transport" } })] } } }, registry, { name: "test", version: "1" });
  const result = response!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const mcpError = JSON.parse(result.content[0].text);
  assert.equal(mcpError.code, "ITINERARY_EDIT_TYPE_IMMUTABLE");
  assert.equal(mcpError.issues[0].expected, "visit"); assert.equal(mcpError.issues[0].actual, "transport");
  assert.equal(toolErrorOutput(new Error("普通错误")), "工具执行失败: 普通错误");
});

test("直接抛出的校验异常同样进入诊断错误码，无需中文关键词猜测", async () => {
  const diagnostics = new ToolDiagnostics();
  await assert.rejects(() => diagnostics.run({ id: "one", name: "save_itinerary", arguments: "{}" }, 1, async () => {
    applyItemEdits(plan(), [edit({ item: { name: "交通", type: "transport" } })]);
    return { output: "不可达" };
  }), ToolValidationError);
  assert.equal(diagnostics.records[0].error, "validation");
  assert.equal(diagnostics.records[0].error_code, "ITINERARY_EDIT_TYPE_IMMUTABLE");
});

test("长错误被压缩后仍保留不同问题的code/path及预期值，完整错误归档可读", async (t) => {
  const root = await temp(t);
  let output = "";
  try { applyItemEdits(plan(), [edit({ item: { id: "new", type: "transport" } })]); }
  catch (error) { output = toolErrorOutput(error); }
  const value = JSON.parse(output);
  value.error += "冗长说明".repeat(1000);
  output = JSON.stringify(value);
  const [result] = await compactToolResults([{ callId: "errors", toolName: "save_itinerary", error: value.error, output }], { workspace: root, sessionId: "test", maxChars: 2200, batchMaxChars: 2200 });
  assert.ok(result.truncated); assert.ok(result.text.length <= 2200);
  for (const path of ["item.name", "item.id", "item.type"]) assert.ok(result.text.includes(`edits[0].${path}`));
  assert.match(result.text, /ITINERARY_EDIT_NAME_REQUIRED/);
  assert.match(result.text, /ITINERARY_EDIT_ID_IMMUTABLE/);
  assert.match(result.text, /ITINERARY_EDIT_TYPE_IMMUTABLE/);
  assert.match(result.text, /"expected":"visit","actual":"transport"/);
  assert.equal(await readFile(join(root, result.artifactPath!), "utf8"), output);
});
