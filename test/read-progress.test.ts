import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadFileTool } from "../src/tools/files.ts";
import { createSaveItineraryTool, createLoadItineraryTool } from "../src/tools/itinerary.ts";
import { compactToolResults } from "../src/agent/tool-output.ts";
import { artifactReadStatus, renderReadProgress, undoReadDelivery } from "../src/tools/read-progress.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import type { PromptMessage } from "../src/core/message.ts";

async function temp(t: TestContext) { const root = await mkdtemp(join(tmpdir(), "read-progress-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const ctxFor = (root: string) => ({ workspace: root, readVersions: new Map<string, string>() });
const days = [{ date: "2026-11-10", items: [{ id: "a", name: "甲公园", type: "visit", time: "10:00", end_time: "12:00" }, { id: "b", name: "乙公园", type: "visit", time: "13:00", end_time: "15:00" }] }, { date: "2026-11-11", items: [{ id: "c", name: "丙公园", type: "visit", time: "10:00", end_time: "12:00" }] }];

test("实际字节范围去重，改变页大小及行号/字节别名不能重发相同正文", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), reader = createReadFileTool(root);
  await writeFile(join(root, "data.txt"), "abcdefgh\nijklmnop\nqrstuvwx");
  assert.match(await reader.execute({ path: "data.txt", offset: 1, limit: 1 }, ctx), /1\tabcdefgh/);
  assert.match(await reader.execute({ path: "./data.txt", byte_offset: 0, byte_limit: 8 }, ctx), /字节页已读/);
  assert.match(await reader.execute({ path: "data.txt", offset: 1, limit: 1 }, ctx), /byte_offset=9/);
  await reader.execute({ path: "data.txt", byte_offset: 9, byte_limit: 9 }, ctx);
  const duplicate = await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 4 }, ctx);
  assert.match(duplicate, /已读/); assert.match(duplicate, /byte_offset=18/);
  assert.match(renderReadProgress(ctx.readVersions)!, /"byte_offset":18/);
});

test("完整读取不再提示从头翻页，真实文件变化允许重新读取", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), reader = createReadFileTool(root);
  await writeFile(join(root, "data.txt"), "abcdefgh");
  await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 8 }, ctx);
  assert.match(await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 4 }, ctx), /已完整读取/);
  assert.equal(artifactReadStatus(ctx.readVersions, join(root, "data.txt"))?.complete, true);
  await writeFile(join(root, "data.txt"), "UPDATED DATA");
  assert.match(await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 8 }, ctx), /UPDATED/);
});

test("UTF8误用算术游标时提供实际有效位置，按位置连续续读无丢字", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), reader = createReadFileTool(root);
  await writeFile(join(root, "data.txt"), "甲乙丙丁戊己庚辛");
  const first = await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 8 }, ctx);
  assert.match(first, /甲乙/); assert.match(first, /byte_offset=6/);
  await assert.rejects(() => reader.execute({ path: "data.txt", byte_offset: 8, byte_limit: 8 }, ctx), /byte_offset=6/);
  assert.match(await reader.execute({ path: "data.txt", byte_offset: 6, byte_limit: 8 }, ctx), /丙丁/);
});

test("显式小范围重读一次，普通对话读取仍完整返回", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), reader = createReadFileTool(root); await writeFile(join(root, "data.txt"), "abcdefgh");
  const args = { path: "data.txt", byte_offset: 0, byte_limit: 8 };
  await reader.execute(args, ctx); assert.match(await reader.execute({ ...args, reread: true }, ctx), /abcdefgh/);
  assert.doesNotMatch(await reader.execute({ ...args, reread: true }, ctx), /abcdefgh/);
  assert.match(await reader.execute(args), /abcdefgh/); assert.match(await reader.execute(args), /abcdefgh/);
});

test("修改第二天不使第一天失效；定点条目读取不返回其他条目且只按所选数据失效", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), save = createSaveItineraryTool(root), load = createLoadItineraryTool(root);
  await save.execute({ title: "范围", days });
  await load.execute({ title: "范围", day: 1 }, ctx);
  await save.execute({ title: "范围", merge: true, days: [{ date: "2026-11-11", items: [{ id: "c", end_time: "12:30" }] }] });
  assert.match(await load.execute({ title: "范围", day: 1 }, ctx), /该范围已读取/);
  const focused = JSON.parse(await load.execute({ title: "范围", day: 1, item_ids: ["b"] }, ctx));
  assert.deepEqual(focused.days[0].items.map((i: { id: string }) => i.id), ["b"]);
  await save.execute({ title: "范围", merge: true, days: [{ date: "2026-11-10", items: [{ id: "a", end_time: "12:10" }] }] });
  assert.match(await load.execute({ title: "范围", day: 1, item_ids: ["b"] }, ctx), /该范围已读取/);
  await save.execute({ title: "范围", merge: true, days: [{ date: "2026-11-10", items: [{ id: "b", end_time: "15:10" }] }] });
  assert.match(await load.execute({ title: "范围", day: 1, item_ids: ["b"] }, ctx), /15:10/);
  assert.match(await load.execute({ title: "范围", day: 2, summary: true }, ctx), /Day 2/);
  await load.execute({ title: "范围", day: 1, summary: true }, ctx);
  await save.execute({ title: "范围", merge: true, days: [{ date: "2026-11-11", items: [{ id: "d", name: "丁公园", type: "visit", time: "13:00", end_time: "14:00" }] }] });
  assert.match(await load.execute({ title: "范围", day: 1, summary: true }, ctx), /该范围已读取/);
  await assert.rejects(() => load.execute({ title: "范围", day: 1, item_ids: ["missing"] }, ctx), /不存在/);
});

test("结果压缩撤销已读，大范围重试转向条目读取，不生成read_file归档的归档", async (t) => {
  const root = await temp(t), ctx = ctxFor(root), reader = createReadFileTool(root), save = createSaveItineraryTool(root), load = createLoadItineraryTool(root);
  await writeFile(join(root, "data.txt"), "x".repeat(5000));
  const output = await reader.execute({ path: "data.txt", byte_offset: 0 }, { ...ctx, readCallId: "page" });
  const [compacted] = await compactToolResults([{ callId: "page", toolName: "read_file", output, outputKind: "file" }], { workspace: root, sessionId: "test", maxChars: 300 });
  assert.equal(compacted.artifactPath, undefined); assert.match(compacted.text, /未完整交付/);
  undoReadDelivery(ctx.readVersions, "page");
  assert.match(await reader.execute({ path: "data.txt", byte_offset: 0, byte_limit: 64 }, ctx), /x{64}/);
  await save.execute({ title: "范围", days });
  await load.execute({ title: "范围", day: 1 }, { ...ctx, readCallId: "whole" });
  undoReadDelivery(ctx.readVersions, "whole");
  assert.match(await load.execute({ title: "范围", day: 1 }, ctx), /未完整进入上下文/);
  assert.match(await load.execute({ title: "范围", day: 1, item_ids: ["a"] }, ctx), /甲公园/);
});

function providerFor(fn: (history: readonly PromptMessage[]) => Promise<LLMResult> | LLMResult): ChatProvider {
  return { name: "read-regression", chat: async () => "完成", chatWithTools: async (history) => fn(history) };
}

test("真实Agent请求携带最新字节游标，换limit重复读取不会返回正文", async (t) => {
  const root = await temp(t), session = new Session(); session.setTravelMode(true);
  const tools = new ToolRegistry(root).register({ name: "big_result", description: "test", alwaysActive: true, parameters: {}, execute: async () => "甲乙丙丁".repeat(3000) }).register(createReadFileTool(root));
  let step = 0, path = "", next = 0;
  const read = (id: string, offset: number, limit: number): LLMResult => ({ type: "tool_calls", toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path, byte_offset: offset, byte_limit: limit }) }] });
  const provider = providerFor((history) => {
    step++;
    if (step === 1) return { type: "tool_calls", toolCalls: [{ id: "large", name: "big_result", arguments: "{}" }] };
    if (step === 2) { path = /artifact=([^\s]+)/.exec(history.find((m) => m.toolCallId === "large")!.content)![1]!; return read("p1", 0, 64); }
    if (step === 3) {
      next = Number(/【续读】byte_offset=(\d+)/.exec(history.find((m) => m.toolCallId === "p1")!.content)![1]); assert.ok(next > 0);
      // 模拟Epoch压缩移走归档/正文，下一轮仍须从任务读取索引获得真实游标。
      session.replaceHistory([{ id: "epoch-summary", createdAt: Date.now(), role: "assistant", content: "旧工具正文已移出，只保留规划摘要。" }], session.epoch + 1);
      return read("duplicate", 0, 60);
    }
    if (step === 4) {
      const message = history.find((m) => m.toolCallId === "duplicate")!.content;
      assert.match(message, /字节页已读/); assert.doesNotMatch(message, /甲乙丙丁/);
      assert.ok(history.some((m) => m.role === "system" && m.content.includes(`"byte_offset":${next}`)));
      return read("p2", next, 64);
    }
    assert.match(history.find((m) => m.toolCallId === "p2")!.content, new RegExp(`字节页 ${next}—`));
    return { type: "text", content: "完成" };
  });
  assert.equal(await new ChatAgent(session, provider, tools, root).run("检查归档", { maxToolRounds: 6 }), "完成");
  assert.equal(step, 5);
});

test("Agent批次压缩后原页仍可小范围读取，不形成递归归档", async (t) => {
  const root = await temp(t), session = new Session(); session.setTravelMode(true);
  await writeFile(join(root, "data.txt"), "x".repeat(5000));
  const tools = new ToolRegistry(root).register(createReadFileTool(root)); let step = 0;
  const provider = providerFor((history) => {
    step++;
    if (step === 1) return { type: "tool_calls", toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `large-${i}`, name: "read_file", arguments: JSON.stringify({ path: "data.txt", byte_offset: i * 100, byte_limit: 2000 }) })) };
    if (step === 2) { assert.match(history.find((m) => m.toolCallId === "large-0")!.content, /未完整交付/); return { type: "tool_calls", toolCalls: [{ id: "small", name: "read_file", arguments: JSON.stringify({ path: "data.txt", byte_offset: 0, byte_limit: 64 }) }] }; }
    assert.match(history.find((m) => m.toolCallId === "small")!.content, /x{64}/);
    return { type: "text", content: "完成" };
  });
  await new ChatAgent(session, provider, tools, root).run("读原始页", { maxToolRounds: 4 });
  const folders = await readdir(join(root, ".minicode"), { recursive: true }).catch(() => []);
  assert.equal(folders.some((name) => name.includes("read_file-")), false);
});

test("Agent定点读取条目不缩减完整行程状态", async (t) => {
  const root = await temp(t); await createSaveItineraryTool(root).execute({ title: "范围", days });
  const session = new Session(); session.setTravelMode(true); let step = 0;
  const provider = providerFor((history) => {
    if (++step === 1) return { type: "tool_calls", toolCalls: [{ id: "focused", name: "load_itinerary", arguments: JSON.stringify({ title: "范围", day: 1, item_ids: ["a"] }) }] };
    assert.doesNotMatch(history.find((m) => m.toolCallId === "focused")!.content, /乙公园/);
    return { type: "text", content: "完成" };
  });
  await new ChatAgent(session, provider, new ToolRegistry(root).register(createLoadItineraryTool(root)), root).run("只读条目a", { maxToolRounds: 3 });
  assert.equal(session.travelState?.itinerary?.dayCount, 2); assert.equal(session.travelState?.itinerary?.itemCount, 3);
});
