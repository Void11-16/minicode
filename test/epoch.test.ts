import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContextEpochManager,
  estimateHistoryTokens,
  estimateTokens,
  renderHistoryForSummary,
} from "../src/context/epoch.ts";
import { Session } from "../src/core/session.ts";
import type { Message } from "../src/core/message.ts";
import {
  updateTravelStateFromBrief,
  updateTravelStateFromItinerary,
} from "../src/core/travel-state.ts";

test("token 估算: 中文与英文", () => {
  assert.equal(estimateTokens("你好"), 2); // 2 字 × 0.7 → 1.4 → 2
  assert.equal(estimateTokens("hello world"), 8); // 11 字符 × 0.7 → 7.7 → 8
});

test("导出的历史 token 估算也统计 tool_calls 参数", () => {
  const argumentsJson = JSON.stringify({ title: "北京五日游", days: ["x".repeat(6000)] });
  const messages = [{
    id: "msg_tool_estimate",
    role: "assistant" as const,
    content: "",
    createdAt: Date.now(),
    toolCalls: [{ id: "call_save", name: "save_itinerary", arguments: argumentsJson }],
  }];

  assert.ok(estimateHistoryTokens(messages) > 4000);
});

function makeHistory(count: number): Session {
  const session = new Session("sess_epoch");
  for (let i = 0; i < count; i++) {
    session.add("user", `消息 ${i} ${"内容".repeat(20)}`);
    session.add("assistant", `回复 ${i} ${"内容".repeat(20)}`);
  }
  return session;
}

test("未超阈值时不压缩", async () => {
  const session = makeHistory(4); // 8 条消息，token 不多
  const summarized: Message[][] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: 100_000,
    summarize: async (_session, messages) => {
      summarized.push([...messages]);
      return "摘要";
    },
  });

  const result = await manager.maybeCompact(session);
  assert.equal(result, null);
  assert.equal(summarized.length, 0);
  assert.equal(session.epoch, 0);
});

test("超阈值时压缩: 摘要 + 保留近期 + 纪元 +1 + 持久化", async () => {
  const session = makeHistory(10); // 20 条消息
  const tokensBefore = session.estimateHistoryTokens();

  let received: readonly Message[] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: 500, // 强制触发
    keepRecent: 6,
    summarize: async (_session, messages) => {
      received = messages;
      return "这是压缩摘要：用户计划去杭州，偏好文化景点。";
    },
  });

  const info = await manager.maybeCompact(session);

  assert.ok(info !== null);
  assert.equal(info!.epoch, 1);
  assert.equal(info!.removedMessages, 14); // 20 - 6
  assert.equal(info!.tokensBefore, tokensBefore);
  assert.ok(info!.tokensAfter < tokensBefore / 2, "压缩后 token 应大幅下降");

  // 摘要器收到的是被移除的旧消息
  assert.equal(received.length, 14);

  // 新历史: 1 条 system 摘要 + 最近 6 条
  assert.equal(session.history.length, 7);
  assert.equal(session.history[0].role, "system");
  assert.match(session.history[0].content, /第 1 纪元/);
  assert.match(session.history[0].content, /杭州/);
  assert.equal(session.epoch, 1);

  // 纪元随会话持久化
  const restored = Session.fromData(session.toData());
  assert.equal(restored.epoch, 1);
});

test("摘要器收到的是被压缩的会话本身（多会话并发时不能借当前选中会话）", async () => {
  const background = makeHistory(10); // 后台被压缩的会话
  const untouched = new Session("sess_untouched");
  untouched.add("user", "别的会话消息");

  const seen: Session[] = [];
  const manager = new ContextEpochManager({
    maxPromptTokens: 500,
    keepRecent: 6,
    summarize: async (session) => {
      seen.push(session);
      return "摘要";
    },
  });

  await manager.maybeCompact(background);

  assert.equal(seen.length, 1);
  assert.equal(seen[0], background, "摘要用的必须是正在压缩的那个会话");
  assert.equal(background.epoch, 1);
  assert.equal(untouched.epoch, 0);
});

test("历史条数不足 keepRecent 时不压缩（即使 token 超限）", async () => {
  const session = new Session("sess_short");
  session.add("user", "x".repeat(10_000));

  const manager = new ContextEpochManager({
    maxPromptTokens: 100,
    keepRecent: 8,
    summarize: async () => "摘要",
  });

  assert.equal(await manager.maybeCompact(session), null);
});

test("压缩时截断超长的工具消息（否则保留的最近窗口仍超阈值，导致每轮重复压缩）", async () => {
  const session = new Session("sess_tool_trim");
  session.add("user", "查一下杭州的景点");
  session.add("assistant", "好的");
  // 最近窗口里塞入超大工具结果（模拟搜索结果每次 16KB 一条）
  for (let i = 0; i < 4; i++) {
    session.add("assistant", `第${i}轮查询`);
    session.add("tool", "搜索结果：" + "数据".repeat(8000), { toolCallId: `c${i}`, toolName: "search_attractions" });
  }

  const manager = new ContextEpochManager({
    maxPromptTokens: 100,
    keepRecent: 8,
    summarize: async () => "摘要",
  });

  assert.equal(session.history.length, 10); // 超过 keepRecent 才会触发压缩
  const info = await manager.maybeCompact(session);
  assert.ok(info !== null);

  // 保留窗口内的工具消息已被截断到上限
  const keptTools = session.history.filter((message) => message.role === "tool");
  assert.equal(keptTools.length, 4);
  for (const message of keptTools) {
    assert.match(message.content, /已截断/);
    assert.ok(message.content.length < 3200, "截断后单条应接近上限");
  }
  // 截断生效后窗口显著变小（防止下轮再触发压缩）
  assert.ok(info!.tokensAfter < info!.tokensBefore);
  assert.ok(info!.tokensAfter < info!.tokensBefore / 3, "压缩后估算应大幅低于压缩前");
});

test("压缩时结构化截断超大的工具调用参数，并保留调用配对", async () => {
  const session = new Session("sess_tool_args_trim");
  session.add("user", "规划北京五日游");
  session.add("assistant", "开始保存");
  for (let i = 0; i < 3; i++) {
    session.add("user", `补充第 ${i} 天`);
  }
  session.add("assistant", "", {
    toolCalls: [{
      id: "call_save",
      name: "save_itinerary",
      arguments: JSON.stringify({ title: "北京五日游", days: ["行程数据".repeat(2500)] }),
    }],
  });
  session.add("tool", "已保存「北京五日游」", {
    toolCallId: "call_save",
    toolName: "save_itinerary",
  });
  session.add("user", "继续");
  session.add("assistant", "好的");

  const manager = new ContextEpochManager({
    maxPromptTokens: 100,
    keepRecent: 8,
    summarize: async () => "摘要",
  });
  const info = await manager.maybeCompact(session);
  assert.ok(info !== null);

  const kept = session.history.find((message) => message.toolCalls !== undefined);
  assert.ok(kept?.toolCalls !== undefined);
  assert.equal(kept.toolCalls[0].id, "call_save");
  assert.equal(kept.toolCalls[0].name, "save_itinerary");
  assert.ok(kept.toolCalls[0].arguments.length < 400, "超大参数应缩成结构化占位");
  assert.equal(JSON.parse(kept.toolCalls[0].arguments)._truncated, true);
  assert.ok(session.history.some((message) => message.toolCallId === "call_save"), "工具结果配对不能丢");
  assert.equal(
    session.toPrompt().some((message) =>
      message.toolCalls?.some((call) => call.arguments.includes("_truncated")) === true ||
      message.toolCallId === "call_save"
    ),
    false,
    "压缩占位符只用于本地审计，不能发送给模型",
  );
  assert.ok(info!.tokensAfter < info!.tokensBefore / 4, "截断参数后上下文应显著下降");
});

test("压缩边界不拆散工具调用组（保留窗口不以孤儿 tool 开头）", async () => {
  const session = new Session("sess_boundary");
  session.add("user", "帮我规划");
  session.add("assistant", "好的");
  session.add("assistant", "", { toolCalls: [{ id: "c1", name: "search", arguments: "{}" }] });
  session.add("tool", "结果1", { toolCallId: "c1", toolName: "search" });
  session.add("assistant", "", { toolCalls: [{ id: "c2", name: "search", arguments: "{}" }] });
  session.add("tool", "结果2", { toolCallId: "c2", toolName: "search" });
  session.add("user", "继续");
  session.add("assistant", "好");

  const manager = new ContextEpochManager({
    maxPromptTokens: 10,
    keepRecent: 3,
    summarize: async () => "摘要",
  });
  const info = await manager.maybeCompact(session);
  assert.ok(info !== null);
  // 边界原落在 tool(c2)（index 5），应回退到助手调用（index 4），整组保留
  assert.equal(info!.removedMessages, 4);
  const kept = session.history.slice(1); // 跳过摘要
  assert.notEqual(kept[0].role, "tool", "保留窗口不能以孤儿 tool 开头");
  assert.equal(kept[0].role, "assistant");
  assert.equal(kept[0].toolCalls?.[0].id, "c2");
  assert.equal(kept[1].role, "tool");
  assert.equal(kept[1].toolCallId, "c2");
});

test("摘要转录保留结构化状态、artifact 路径和最新约束", () => {
  const session = new Session("summary-render");
  for (let index = 0; index < 30; index += 1) {
    session.add("user", `旧消息 ${index} ${"普通内容".repeat(20)}`);
  }
  session.add("tool", [
    "大结果预览",
    `artifact=.minicode/artifacts/summary/search-${"x".repeat(120)}.txt`,
    "普通内容".repeat(400),
    "类型 博物馆 | 坐标 39.9042,116.4074",
  ].join("\n"), { toolName: "search_attractions" });
  session.add("user", "最终约束：必须保留故宫，并且不要安排长途赶路");

  const brief = updateTravelStateFromBrief(undefined, {
    title: "北京两日游",
    destination: "北京",
    pace: "轻松",
    mustVisit: ["故宫"],
    avoid: ["长途赶路"],
  });
  const state = updateTravelStateFromItinerary(brief, {
    title: "北京两日游",
    days: [{
      date: "2026-11-01",
      items: [{
        type: "visit",
        name: "故宫",
        place_type: "古迹",
        location: { latitude: 39.9163, longitude: 116.3972 },
      }],
    }],
  });

  const rendered = renderHistoryForSummary(session.history, state, 2_000);
  assert.ok(rendered.length <= 2_000);
  assert.match(rendered, /需要精确保留的结构化旅行状态/);
  assert.match(rendered, /故宫\[visit\/古迹\]/);
  assert.match(rendered, /最终约束：必须保留故宫/);
  assert.match(rendered, /artifact=\.minicode\/artifacts/);
});

test("消息极多时摘要中间层仍严格受 maxChars 硬上限约束", () => {
  const messages: Message[] = Array.from({ length: 500 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `第 ${index} 条 ${"历史内容".repeat(100)}`,
    createdAt: index,
  }));

  const rendered = renderHistoryForSummary(messages, undefined, 1_200);
  assert.ok(rendered.length <= 1_200);
  assert.match(rendered, /历史转录/);
});
