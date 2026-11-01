import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import { createReadFileTool } from "../src/tools/files.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import type { ChatProvider, LLMResult } from "../src/llm/provider.ts";

test("Agent 实际链路：大结果字段摘要进入下一请求，原文通过字节游标连续回读", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-output-chain-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = JSON.stringify({ places: [{ name: "公园😀", description: "长介绍".repeat(5000), evidence_id: "place-chain", location: { latitude: 30.12, longitude: 120.34, crs: "gcj02" } }] });
  const tools = new ToolRegistry(workspace).register({ name: "large_result", alwaysActive: true, description: "返回大量候选数据", outputKind: "place-list", parameters: { type: "object" }, execute: async () => output }).register(createReadFileTool(workspace));
  let requests = 0, artifact = "";
  const pages: string[] = [];
  const provider: ChatProvider = {
    name: "bounded-results", chat: async () => "不应使用纯聊天",
    chatWithTools: async (history): Promise<LLMResult> => {
      requests++;
      const pending = new Set<string>();
      for (const message of history) {
        for (const call of message.toolCalls ?? []) pending.add(call.id);
        if (message.role === "tool") assert.ok(pending.delete(message.toolCallId!));
      }
      assert.equal(pending.size, 0);
      if (requests === 1) return { type: "tool_calls", toolCalls: [{ id: "large", name: "large_result", arguments: "{}" }] };
      if (requests === 2) {
        const result = history.find((message) => message.toolCallId === "large")!.content;
        assert.match(result, /公园😀.*place-chain.*30\.12.*120\.34/);
        assert.doesNotMatch(result, /长介绍/); assert.ok(result.length <= 3000);
        artifact = /artifact=([^\s]+)/.exec(result)![1]!;
        return { type: "tool_calls", toolCalls: [{ id: "page1", name: "read_file", arguments: JSON.stringify({ path: artifact, byte_offset: 0, byte_limit: 97 }) }] };
      }
      const page = history.find((message) => message.toolCallId === (requests === 3 ? "page1" : "page2"))!.content;
      assert.ok(page.length < 3000); assert.doesNotMatch(page, /�/);
      pages.push(page.slice(page.indexOf("\n", page.indexOf("\n") + 1) + 1, page.lastIndexOf("\n")));
      if (requests === 3) return { type: "tool_calls", toolCalls: [{ id: "page2", name: "read_file", arguments: JSON.stringify({ path: artifact, byte_offset: Number(/【续读】byte_offset=(\d+)/.exec(page)![1]), byte_limit: 97 }) }] };
      return { type: "text", content: "完成" };
    },
  };
  assert.equal(await new ChatAgent(new Session(), provider, tools, workspace).run("检查大结果", { maxToolRounds: 4 }), "完成");
  assert.equal(requests, 4);
  assert.ok(output.startsWith(pages.join("")), "两页原文连续，没有重复或跳过内容");
});
