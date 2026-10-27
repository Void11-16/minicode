import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { PromptMessage } from "../src/core/message.ts";
import type { ChatProvider, LLMResult, ToolDefinition } from "../src/llm/provider.ts";
import {
  activeToolNames,
  executeToolCatalog,
  MAX_ACTIVE_TOOLS,
  TOOL_ACTIVATE_NAME,
  TOOL_DEACTIVATE_NAME,
  TOOL_SEARCH_NAME,
} from "../src/tools/activation.ts";
import { createReadFileTool } from "../src/tools/files.ts";
import {
  createLoadItineraryTool,
  createSaveItineraryTool,
  createValidateItineraryTool,
} from "../src/tools/itinerary.ts";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { ToolRegistry, type Tool, type ToolCategory } from "../src/tools/tool.ts";

function makeTool(
  name: string,
  category: ToolCategory,
  keywords: readonly string[] = [],
): Tool {
  return {
    name,
    description: `${name} 测试工具`,
    category,
    outputKind: "place-list",
    keywords,
    parameters: { type: "object", properties: {} },
    execute: async () => `${name} 结果`,
  };
}

test("find_tools 可按关键词发现工具，activate_tools 最多激活 12 个并持久化", () => {
  const registry = new ToolRegistry();
  for (let index = 1; index <= 15; index += 1) {
    registry.register(makeTool(
      `discovery_${index}`,
      "discovery",
      index === 1 ? ["博物馆", "古迹"] : [],
    ));
  }
  const session = new Session("activation-cap");

  const found = executeToolCatalog(TOOL_SEARCH_NAME, { query: "博物馆" }, registry, session);
  assert.match(found, /discovery_1/);
  assert.match(found, /place-list/);

  const activated = executeToolCatalog(
    TOOL_ACTIVATE_NAME,
    { categories: ["discovery"], max: 30 },
    registry,
    session,
  );
  assert.equal(session.activeTools.length, MAX_ACTIVE_TOOLS);
  assert.equal(activeToolNames(registry, session).size, MAX_ACTIVE_TOOLS);
  assert.match(activated, /另有 3 个工具未激活/);
  assert.match(activated, /12\/12/);

  const removedName = session.activeTools[0];
  const deactivated = executeToolCatalog(
    TOOL_DEACTIVATE_NAME,
    { tools: [removedName, "missing"] },
    registry,
    session,
  );
  assert.equal(session.activeTools.includes(removedName), false);
  assert.equal(session.activeTools.length, MAX_ACTIVE_TOOLS - 1);
  assert.match(deactivated, new RegExp(removedName));
  assert.match(deactivated, /11\/12/);

  const restored = Session.fromData(session.toData());
  assert.deepEqual(restored.activeTools, session.activeTools);
});

test("Agent 请求先只发送工具目录，激活后下一轮才发送完整工具定义", async () => {
  const seenTools: ToolDefinition[][] = [];
  let calls = 0;
  const provider: ChatProvider = {
    name: "activation-script",
    async chat() {
      return "完成";
    },
    async chatWithTools(
      _history: readonly PromptMessage[],
      tools: readonly ToolDefinition[],
    ): Promise<LLMResult> {
      seenTools.push([...tools]);
      calls += 1;
      if (calls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [{
            id: "activate-search",
            name: TOOL_ACTIVATE_NAME,
            arguments: JSON.stringify({ tools: ["search_attractions"] }),
          }],
        };
      }
      return { type: "text", content: "已激活并继续" };
    },
  };
  const registry = new ToolRegistry()
    .register(makeTool("search_attractions", "discovery", ["景点"]))
    .register(makeTool("get_place_reviews", "discovery", ["口碑"]))
    .register(makeTool("save_itinerary", "itinerary", ["保存"]));
  const agent = new ChatAgent(new Session("activation-agent"), provider, registry);

  assert.equal(await agent.run("规划杭州三日游"), "已激活并继续");
  assert.deepEqual(
    seenTools[0].map((tool) => tool.name),
    [TOOL_SEARCH_NAME, TOOL_ACTIVATE_NAME, TOOL_DEACTIVATE_NAME],
  );
  assert.deepEqual(
    seenTools[1].map((tool) => tool.name),
    [
      TOOL_SEARCH_NAME,
      TOOL_ACTIVATE_NAME,
      TOOL_DEACTIVATE_NAME,
      "search_attractions",
    ],
  );
  assert.equal(seenTools[1].find((tool) => tool.name === "search_attractions")?.description.includes("place-list"), true);
});

test("模型直接调用未加载工具时自动激活并执行", async () => {
  const seenTools: ToolDefinition[][] = [];
  let calls = 0;
  let getWeatherCalls = 0;
  const provider: ChatProvider = {
    name: "implicit-activation",
    async chat() {
      return "完成";
    },
    async chatWithTools(
      _history: readonly PromptMessage[],
      tools: readonly ToolDefinition[],
    ): Promise<LLMResult> {
      seenTools.push([...tools]);
      calls += 1;
      if (calls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [{
            id: "weather",
            name: "get_weather",
            arguments: JSON.stringify({ location: "北京" }),
          }],
        };
      }
      return { type: "text", content: "天气已查" };
    },
  };
  const registry = new ToolRegistry().register({
    ...makeTool("get_weather", "travel-basics", ["天气"]),
    outputKind: "weather",
    execute: async () => {
      getWeatherCalls += 1;
      return "北京晴，20~28°C";
    },
  });
  const session = new Session("implicit-activation");
  const agent = new ChatAgent(session, provider, registry);

  assert.equal(await agent.run("查北京天气"), "天气已查");
  assert.equal(getWeatherCalls, 1);
  assert.deepEqual(session.activeTools, ["get_weather"]);
  assert.equal(seenTools[0].some((tool) => tool.name === "get_weather"), false);
  assert.equal(seenTools[1].some((tool) => tool.name === "get_weather"), true);
});

test("交付闭环工具常驻，不需要先激活", async () => {
  const seenTools: ToolDefinition[][] = [];
  const provider: ChatProvider = {
    name: "always-active-read-file",
    async chat() {
      return "完成";
    },
    async chatWithTools(
      _history: readonly PromptMessage[],
      tools: readonly ToolDefinition[],
    ): Promise<LLMResult> {
      seenTools.push([...tools]);
      return { type: "text", content: "已读取" };
    },
  };
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createPlanRoutesTool())
    .register(createSaveItineraryTool())
    .register(createLoadItineraryTool())
    .register(createValidateItineraryTool())
    .register(makeTool("search_attractions", "discovery", ["景点"]));
  const agent = new ChatAgent(new Session("always-active-read-file"), provider, registry);

  assert.equal(await agent.run("读取归档"), "已读取");
  assert.deepEqual(
    seenTools[0].map((tool) => tool.name),
    [
      TOOL_SEARCH_NAME,
      TOOL_ACTIVATE_NAME,
      TOOL_DEACTIVATE_NAME,
      "read_file",
      "plan_day_routes",
      "save_itinerary",
      "load_itinerary",
      "validate_itinerary",
    ],
  );
});
