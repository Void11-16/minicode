import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acceptCurrentOperationState, findOperation, recoverManagedOperations, runManagedOperation, runRecordedCommand } from "../src/storage/managed-operation.ts";
import { executionStateOf, type ToolExecutionState } from "../src/core/execution-state.ts";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { createSaveItineraryTool } from "../src/tools/itinerary.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { recoverInterruptedToolCalls } from "../src/agent/tool-recovery.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";
import { handleMcpMessage } from "../src/mcp/server.ts";

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minicode-operation-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const plan = { title: "操作恢复一日游", days: [{ date: "2026-11-10", items: [{ name: "测试公园", type: "visit", time: "10:00", end_time: "12:00" }] }] };

test("行程保存按操作 ID 返回回执，新的意图不被参数去重；ID不能改参数或资源", async (t) => {
  const root = await temp(t), tool = createSaveItineraryTool(root);
  const states: ToolExecutionState[] = [], ctx = { workspace: root, operationId: "save-1", onExecution: (s: ToolExecutionState) => states.push(s) };
  const first = await tool.execute(plan, ctx);
  const path = join(root, "plans", `${plan.title}.json`), before = await readFile(path, "utf8");
  assert.equal(await tool.execute(plan, ctx), first);
  assert.equal(await readFile(path, "utf8"), before); assert.equal(states.at(-1)?.replayed, true);
  await assert.rejects(tool.execute({ ...plan, title: "另一个资源" }, ctx), /operation_id/);
  await assert.rejects(tool.execute({ ...plan, notes: "更改参数" }, ctx), /operation_id/);
  await tool.execute(plan, { ...ctx, operationId: "save-2" });
  assert.ok(await findOperation(root, "save-2"));
});

test("提交前校验失败保留原文件，失败回执与版本冲突有不同恢复动作", async (t) => {
  const root = await temp(t), tool = createSaveItineraryTool(root); await tool.execute(plan);
  const path = join(root, "plans", `${plan.title}.json`), before = await readFile(path, "utf8");
  await assert.rejects(tool.execute({ ...plan, expected_revision: 999 }, { workspace: root, operationId: "stale" }), (error) => {
    assert.equal(executionStateOf(error)?.effect_status, "not_committed");
    assert.equal(executionStateOf(error)?.recovery_action, "reread"); return true;
  });
  assert.equal(await readFile(path, "utf8"), before);
});

test("主文件已提交但导出失败，恢复只重建导出，不重做业务修改", async (t) => {
  const root = await temp(t), file = join(root, "main.json"), blocker = join(root, "blocked");
  await writeFile(blocker, "不是目录"); let called = 0; let state: ToolExecutionState | undefined;
  const options = { root, file, tool: "save", request: { version: 1 }, operationId: "export-failure", onExecution: (s: ToolExecutionState) => { state = s; } };
  const action = async (commit: Parameters<Parameters<typeof runManagedOperation>[1]>[0]) => { called++; await commit.commit('{"version":1}', [{ file: join(blocker, "report.md"), content: "已保存版本1" }]); return "提交完成"; };
  await runManagedOperation(options, action);
  assert.equal(await readFile(file, "utf8"), '{"version":1}');
  assert.equal(state?.effect_status, "committed"); assert.equal(state?.exports_pending, true);
  await assert.rejects(runManagedOperation({ ...options, operationId: "blocked-new" }, action), (error) => {
    assert.equal(executionStateOf(error)?.effect_status, "not_committed");
    assert.equal(executionStateOf(error)?.blocked_by_operation_id, "export-failure"); return true;
  });
  await rm(blocker); await recoverManagedOperations(root);
  assert.equal(await readFile(join(blocker, "report.md"), "utf8"), "已保存版本1");
  await runManagedOperation(options, action); assert.equal(called, 1);
});

test("恢复发现主文件被其他操作更改时保持未知，不用旧导出覆盖当前数据", async (t) => {
  const root = await temp(t), file = join(root, "main.json"), blocker = join(root, "blocked"); await writeFile(blocker, "block");
  await runManagedOperation({ root, file, tool: "save", request: {}, operationId: "unknown" }, async (commit) => { await commit.commit("版本1", [{ file: join(blocker, "out"), content: "旧内容" }]); return "done"; });
  await writeFile(file, "人工更新"); await rm(blocker);
  const states = await recoverManagedOperations(root);
  assert.equal(states[0]?.effect_status, "unknown");
  await assert.rejects(readFile(join(blocker, "out")), "未知状态不能写入旧导出");
  await assert.rejects(runManagedOperation({ root, file, tool: "save", request: {}, operationId: "next" }, async (commit) => { await commit.commit("不应写入"); return "bad"; }), /需要核对/);
  assert.equal(await readFile(file, "utf8"), "人工更新");
  await assert.rejects(acceptCurrentOperationState(root, "unknown", "错误指纹"), /已变化/);
  const currentHash = createHash("sha256").update("人工更新").digest("hex");
  await acceptCurrentOperationState(root, "unknown", currentHash);
  assert.equal((await findOperation(root, "unknown"))?.state?.effect_status, "unknown");
  await runManagedOperation({ root, file, tool: "save", request: {}, operationId: "after-review" }, async (commit) => { await commit.commit("人工确认后的新版本"); return "done"; });
  assert.equal(await readFile(file, "utf8"), "人工确认后的新版本");
});

test("进程在主文件提交后退出，重启能核对成功，不再次执行业务", async (t) => {
  const root = await temp(t), file = join(root, "main.json");
  const modulePath = resolve("src/storage/managed-operation.ts");
  const source = `import {runManagedOperation} from ${JSON.stringify(modulePath)}; await runManagedOperation(${JSON.stringify({ root, file, tool: "save", request: {}, operationId: "crash" })},async c=>{await c.commit('saved');process.exit(17)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", source]), (e: unknown) => (e as { code: number }).code === 17);
  await recoverManagedOperations(root); assert.equal(await readFile(file, "utf8"), "saved");
  let called = false;
  await runManagedOperation({ root, file, tool: "save", request: {}, operationId: "crash" }, async () => { called = true; return "bad"; });
  assert.equal(called, false); assert.equal((await findOperation(root, "crash"))?.state?.effect_status, "committed");
});

test("提交前进程中断可确认未提交；其他会话正在执行时恢复扫描不阻塞", async (t) => {
  const root = await temp(t), file = join(root, "main.json"); await writeFile(file, "old");
  const modulePath = resolve("src/storage/managed-operation.ts");
  const options = { root, file, tool: "save", request: {}, operationId: "before-commit" };
  const source = `import {runManagedOperation} from ${JSON.stringify(modulePath)}; await runManagedOperation(${JSON.stringify(options)},async()=>process.exit(18));`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", source]));
  assert.equal((await recoverManagedOperations(root))[0]?.effect_status, "not_committed");
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { ready = r; });
  const running = runManagedOperation({ ...options, operationId: "active" }, async () => { ready(); await gate; return "unchanged"; });
  await entered; assert.deepEqual(await recoverManagedOperations(root), []); release(); await running;
});

test("失败后资源改变不能沿旧操作重试；普通编辑同 ID 不二次替换，保留文件权限", async (t) => {
  const root = await temp(t), file = join(root, "a.txt"); await writeFile(file, "aaa", { mode: 0o700 });
  const registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  const args = JSON.stringify({ path: "a.txt", old_string: "a", new_string: "aa", replace_all: true });
  await registry.executeDetailed("edit_file", args, { operationId: "edit" });
  await registry.executeDetailed("edit_file", args, { operationId: "edit" });
  assert.equal(await readFile(file, "utf8"), "aaaaaa"); assert.equal((await stat(file)).mode & 0o777, 0o700);
  const options = { root, file, tool: "write", request: {}, operationId: "failed" };
  await assert.rejects(runManagedOperation(options, async () => { throw new Error("模拟提交前异常"); }));
  await writeFile(file, "其他修改");
  await assert.rejects(runManagedOperation(options, async (commit) => { await commit.commit("bad"); return "bad"; }), /资源已变化/);
  assert.equal(await readFile(file, "utf8"), "其他修改");
});

test("Bash 非零和超时成为结构化失败，记录副作用未知，相同操作不再次追加", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  const args = JSON.stringify({ command: "printf x >> output.txt; exit 7" });
  const result = await registry.executeDetailed("bash", args, { operationId: "command" });
  assert.equal(result.executionState?.code, "BASH_EXIT_NONZERO"); assert.equal(result.executionState?.effect_status, "unknown"); assert.ok(result.error);
  await registry.executeDetailed("bash", args, { operationId: "command" });
  assert.equal(await readFile(join(root, "output.txt"), "utf8"), "x");
  const timeout = await registry.executeDetailed("bash", JSON.stringify({ command: "printf y >> timeout.txt; sleep 5", timeout_ms: 1000 }), { operationId: "timeout" });
  assert.equal(timeout.executionState?.code, "BASH_TIMEOUT"); assert.equal(await readFile(join(root, "timeout.txt"), "utf8"), "y");
});

test("Agent 遇到副作用未知会阻止同批后续写入，并把状态写入会话与诊断", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  const provider: ChatProvider = { name: "local-script", chat: async () => "不应进入模型收尾", chatWithTools: async (): Promise<LLMResult> => ({ type: "tool_calls", toolCalls: [
    { id: "cmd", name: "bash", arguments: JSON.stringify({ command: "printf x > side.txt; exit 3" }) },
    { id: "write", name: "write_file", arguments: JSON.stringify({ path: "must-not-exist.txt", content: "bad" }) },
  ] }) };
  const session = new Session(), agent = new ChatAgent(session, provider, registry, root);
  const reply = await agent.run("执行命令后写入文件");
  assert.match(reply, /副作用.*未知/); await assert.rejects(readFile(join(root, "must-not-exist.txt")));
  assert.equal(session.history.find((m) => m.toolCallId === "cmd")?.toolExecution?.effect_status, "unknown");
});

test("主文件提交成功的导出警告不会被成功分支清除或宣称完整交付", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  registry.register({ name: "test_export", alwaysActive: true, effect: "managed_write", description: "测试导出警告", parameters: { type: "object" },
    execute: async (_args, ctx) => { ctx?.onExecution?.({ operation_id: "export-test", execution_status: "succeeded", effect_status: "committed", recovery_action: "rebuild_exports", exports_pending: true }); return "主文件已保存"; },
  });
  const provider: ChatProvider = { name: "scripted", chat: async () => "不应调用", chatWithTools: async () => ({ type: "tool_calls", toolCalls: [{ id: "export", name: "test_export", arguments: "{}" }] }) };
  const agent = new ChatAgent(new Session(), provider, registry, root);
  assert.match(await agent.run("保存文件"), /导出尚未完成|重建导出/);
});

test("中断会话补齐已提交回执，重复 call ID 的其他批次不干扰核对", async (t) => {
  const root = await temp(t), commandRoot = await temp(t), session = new Session(), registry = createDefaultRegistry({ writeRoot: root, workspace: commandRoot });
  session.add("assistant", "", { toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify(plan) }] });
  session.add("tool", "旧批次", { toolCallId: "save" });
  const batch = session.add("assistant", "", { toolCalls: [{ id: "save", name: "save_itinerary", arguments: JSON.stringify(plan) }] });
  await registry.executeDetailed("save_itinerary", JSON.stringify(plan), { operationId: `${session.id}:${batch.id}:save` });
  const restored = Session.fromData(JSON.parse(JSON.stringify(session.toData())));
  await recoverInterruptedToolCalls(restored, registry, commandRoot);
  const receipts = restored.history.filter((m) => m.toolCallId === "save");
  assert.equal(receipts.length, 2); assert.equal(receipts[1]?.toolExecution?.effect_status, "committed");
  assert.equal(restored.travelState?.itinerary?.dayCount, 1);
});

test("命令进程中断留下未知回执，恢复不再次运行其副作用", async (t) => {
  const root = await temp(t), output = join(root, "once.txt"), modulePath = resolve("src/storage/managed-operation.ts");
  const options = { root, request: { command: "测试中断" }, operationId: "command-crash" };
  const source = `import{writeFile}from'node:fs/promises';import{runRecordedCommand}from ${JSON.stringify(modulePath)};await runRecordedCommand(${JSON.stringify(options)},async()=>{await writeFile(${JSON.stringify(output)},'once');process.exit(19)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", source]));
  await recoverManagedOperations(root);
  assert.equal((await findOperation(root, "command-crash"))?.state?.effect_status, "unknown");
  let executed = false;
  await assert.rejects(runRecordedCommand(options, async () => { executed = true; return "bad"; }), /不能自动重放/);
  assert.equal(executed, false); assert.equal(await readFile(output, "utf8"), "once");
});

test("MCP 尊重操作 ID 与配置工作区，命令失败以 isError 返回", async (t) => {
  const root = await temp(t), registry = createDefaultRegistry({ workspace: root, writeRoot: root });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "printf z >> mcp.txt; exit 9" }, _meta: { "minicode/operation_id": "mcp-cmd" } } };
  for (let i = 0; i < 2; i++) {
    const response = await handleMcpMessage(request, registry, { name: "test", version: "1" });
    assert.ok(response); assert.equal((response.result as { isError: boolean }).isError, true);
  }
  assert.equal(await readFile(join(root, "mcp.txt"), "utf8"), "z");
  const folders = await readdir(join(root, ".minicode", "operations")); assert.ok(folders.includes("ids"));
});
