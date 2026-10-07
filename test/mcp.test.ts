import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { handleMcpMessage } from "../src/mcp/server.ts";

const SERVER = { name: "minicode", version: "0.1.0" };

function result(response: Record<string, unknown> | null): Record<string, unknown> {
  assert.notEqual(response, null);
  assert.equal(response!.jsonrpc, "2.0");
  assert.ok("result" in response!);
  return response!.result as Record<string, unknown>;
}

test("initialize 协商协议版本并声明 tools 能力", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    createDefaultRegistry(),
    SERVER,
  );
  const init = result(response);
  assert.equal(init.protocolVersion, "2025-03-26");
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.deepEqual(init.serverInfo, SERVER);

  // 未知版本回退到最新已知版本，而不是原样透传
  const unknown = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    createDefaultRegistry(),
    SERVER,
  );
  assert.equal(result(unknown).protocolVersion, "2025-06-18");
});

test("ping 返回空对象", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 3, method: "ping" },
    createDefaultRegistry(),
    SERVER,
  );
  assert.deepEqual(result(response), {});
});

test("tools/list 暴露全部工具与 JSON Schema", async () => {
  const registry = createDefaultRegistry();
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    registry,
    SERVER,
  );
  const tools = result(response).tools as Array<{
    name: string;
    description: string;
    inputSchema: { required?: string[] };
  }>;
  assert.equal(tools.length, registry.size);
  const distance = tools.find((tool) => tool.name === "calculate_distance");
  assert.notEqual(distance, undefined);
  assert.deepEqual(distance!.inputSchema.required, ["from_lat", "from_lon", "to_lat", "to_lon"]);
});

test("tools/call 执行真实工具（本地计算，无网络）", async () => {
  const response = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "calculate_distance",
        arguments: { from_lat: 39.9, from_lon: 116.4, to_lat: 31.2, to_lon: 121.5 },
      },
    },
    createDefaultRegistry(),
    SERVER,
  );
  const call = result(response);
  assert.equal(call.isError, false);
  assert.match((call.content as Array<{ text: string }>)[0].text, /公里/);
});

test("工具执行失败返回 isError，让模型看到错误", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "calculate_distance", arguments: {} } },
    createDefaultRegistry(),
    SERVER,
  );
  const call = result(response);
  assert.equal(call.isError, true);
  assert.match((call.content as Array<{ text: string }>)[0].text, /非法参数/);
});

test("未知工具是协议错误，不是 isError", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    createDefaultRegistry(),
    SERVER,
  );
  assert.notEqual(response, null);
  const error = (response as { error?: { code: number; message: string } }).error;
  assert.equal(error?.code, -32602);
  assert.match(error?.message ?? "", /工具不存在/);
});

test("通知与非对象消息不产生响应", async () => {
  const registry = createDefaultRegistry();
  assert.equal(
    await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, registry, SERVER),
    null,
  );
  assert.equal(await handleMcpMessage("不是对象", registry, SERVER), null);
  assert.equal(await handleMcpMessage([1, 2, 3], registry, SERVER), null);
});

test("createDefaultRegistry 支持自定义 write_document 根目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-mcp-"));
  const registry = createDefaultRegistry({ writeRoot: root });
  const tool = registry.get("write_document");
  assert.notEqual(tool, undefined);
  const output = await tool!.execute({ path: "trip.md", content: "# 行程" });
  assert.match(output, new RegExp(root));
});
