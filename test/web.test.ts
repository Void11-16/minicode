import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../src/web/server.ts";
import { JsonFileSessionStore } from "../src/storage/session-store.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider } from "../src/llm/provider.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

/** 可控时序 Provider：chat 挂起直到测试显式 release（验证 steer/排队/停止的并发行为） */
class ControlledProvider implements ChatProvider {
  readonly name = "controlled";
  private readonly pending: Array<(reply: string) => void> = [];
  private readonly waiters: Array<() => void> = [];

  async chat(): Promise<string> {
    for (const waiter of this.waiters.splice(0)) waiter();
    return new Promise((resolve) => this.pending.push(resolve));
  }

  waitForCall(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(reply: string): void {
    this.pending.shift()?.(reply);
  }
}

/** 脚本化工具调用 Provider：按步骤序列返回工具调用，其余轮次返回文本 */
class ToolProvider implements ChatProvider {
  readonly name = "tool-test";
  private readonly steps: Array<{ name: string; arguments: string }>;
  private calls = 0;

  constructor(steps: Array<{ name: string; arguments: string }>) {
    this.steps = steps;
  }

  async chat(): Promise<string> {
    return "unused";
  }

  async chatWithTools() {
    this.calls += 1;
    if (this.calls % 2 === 1) {
      const step = this.steps[(this.calls - 1) / 2];
      if (step !== undefined) {
        return { type: "tool_calls" as const, toolCalls: [{ id: `t${this.calls}`, name: step.name, arguments: step.arguments }] };
      }
    }
    return { type: "text" as const, content: "完成" };
  }
}

/** 逐帧读取 SSE，可在事件到达时应答（如权限确认） */
async function collectSse(
  res: Response,
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let all = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.startsWith("data:")) continue;
      all += `${frame}\n\n`;
      await onEvent?.(JSON.parse(frame.slice(5).trim()));
    }
  }
  return all;
}

async function withMockServer(): Promise<{ port: number; close: () => Promise<void>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-"));
  const running = await startWebServer({
    rootDir: root,
    port: 0,
    configOverrides: { provider: "mock" },
  });
  return { port: running.port, close: running.close, root };
}

test("web: 首页与状态接口", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /minicode · AI 助手/);
  assert.match(html, /travel-toggle/); // 旅行规划是可开关的能力，不是默认身份

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.provider, "mock");
  assert.equal(state.busy, false);
  assert.equal(state.travelMode, false, "默认是通用助手，旅行规划需显式开启");
  assert.ok(state.tools >= 17);

  await close();
});

test("web: 聊天 SSE 流式返回并持久化会话", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "你好" }),
  });
  assert.equal(res.status, 200);
  const stream = await res.text();
  // SSE 帧：最终 done 收尾；mock provider 回复带用户消息回显
  assert.match(stream, /"type":"done"/);

  const history = await (await fetch(`${base}/api/history`)).json();
  assert.ok(history.messages.some((m: { role: string; content: string }) =>
    m.role === "user" && m.content === "你好"));
  assert.ok(history.messages.some((m: { role: string; content: string }) =>
    m.role === "assistant" && m.content.includes("你好")));

  // 并发第二个请求被拒绝（单用户串行）
  const first = fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "第一条" }),
  });
  const firstBody = await first;
  assert.equal(firstBody.status, 200);
  await firstBody.text();

  await close();
});

test("web: 新会话与空消息校验", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  const empty = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "  " }),
  });
  assert.equal(empty.status, 400);

  const created = await (await fetch(`${base}/api/new`, { method: "POST" })).json();
  assert.match(created.title, /\(空会话\)|sess_/);

  await close();
});

test("web: CORS 预检与跨源头（file:// 直开页面也能连）", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  const preflight = await fetch(`${base}/api/chat`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  const state = await fetch(`${base}/api/state`, {
    headers: { Origin: "null" },
  });
  assert.equal(state.headers.get("access-control-allow-origin"), "*");

  await close();
});

test("web: 旅行规划模式开关（切换重建运行时，会话保留）", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  try {
    const chat = (message: string) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }).then((res) => res.text());

    // 开启
    const on = await (await fetch(`${base}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ travel: true }),
    })).json();
    assert.equal(on.travelMode, true);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).travelMode, true);

    // 开启状态下对话正常，历史保留；切回通用后历史仍在
    await chat("模式切换前的消息");
    const off = await (await fetch(`${base}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ travel: false }),
    })).json();
    assert.equal(off.travelMode, false);
    const history = await (await fetch(`${base}/api/history`)).json();
    assert.ok(history.messages.some((m: { content: string }) => m.content === "模式切换前的消息"));
    await chat("通用模式下也能正常对话");

    // 非法参数
    const bad = await fetch(`${base}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ travel: "yes" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test("web: 工作区接口（校验目录/切换/状态同步/恢复默认）", async () => {
  const { port, close, root } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 默认工作区 = 服务装配根
    assert.equal((await (await fetch(`${base}/api/state`)).json()).workspace, root);

    // 切到真实目录
    const target = await mkdtemp(join(tmpdir(), "minicode-web-ws-"));
    const switched = await (await fetch(`${base}/api/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    })).json();
    assert.equal(switched.workspace, target);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).workspace, target);

    // 不存在的目录被拒绝
    const missing = await fetch(`${base}/api/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(target, "no-such-dir") }),
    });
    assert.equal(missing.status, 400);

    // 文件路径（非目录）被拒绝
    const file = join(target, "afile.txt");
    await writeFile(file, "x", "utf8");
    const notDir = await fetch(`${base}/api/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file }),
    });
    assert.equal(notDir.status, 400);

    // 空路径 = 恢复默认
    const reset = await (await fetch(`${base}/api/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "" }),
    })).json();
    assert.equal(reset.workspace, root);
  } finally {
    await close();
  }
});

test("web: 多模型配置 CRUD 与按会话选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-models-"));
  // 无任何 Key → 旧配置回退为 Mock（全程离线），profile 全部通过 API 创建
  const running = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "auto" } });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    const post = (url: string, body: unknown) =>
      fetch(`${base}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const chat = (message: string) =>
      post("/api/chat", { message }).then((res) => res.text());

    // 初始无配置
    assert.equal((await (await fetch(`${base}/api/models`)).json()).profiles.length, 0);

    // 创建 Mock profile（首个自动成为默认，会话用它离线对话）
    const saved = await (await post("/api/models", { name: "测试 Mock", provider: "mock" })).json();
    assert.equal(saved.profiles.length, 1);
    assert.equal(saved.defaultProfile, saved.profiles[0].id);

    // 再创建 Ollama（OpenAI 兼容）
    const ollamaSaved = await (await post("/api/models", {
      name: "本地 Ollama",
      provider: "openai",
      apiKey: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b",
    })).json();
    const ollama = ollamaSaved.profiles.find((p: { name: string }) => p.name === "本地 Ollama");

    // 会话 A（默认 Mock）对话并选择 Ollama
    await chat("会话A的消息");
    const selected = await (await post("/api/models/select", { id: ollama.id })).json();
    assert.equal(selected.current, ollama.id);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).modelProfile, ollama.id);

    // 新会话 B 回到默认 Mock
    await post("/api/new", {});
    assert.equal((await (await fetch(`${base}/api/state`)).json()).modelProfile, saved.defaultProfile);

    // 恢复会话 A：仍记得自己选了 Ollama（按会话记忆模型）
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    const sessionA = sessions.sessions.find((s: { current: boolean }) => !s.current);
    const resumed = await (await post("/api/resume", { id: sessionA.id })).json();
    assert.ok(resumed.messages.some((m: { content: string }) => m.content === "会话A的消息"));
    assert.equal((await (await fetch(`${base}/api/state`)).json()).modelProfile, ollama.id);

    // 正在使用的模型不能删
    assert.equal((await post("/api/models/delete", { id: ollama.id })).status, 400);

    // 更新：Key 留空保留旧值
    const updated = await (await post("/api/models", {
      id: ollama.id,
      name: "本地 Ollama 改名",
      provider: "openai",
      model: "qwen2.5:14b",
    })).json();
    const renamed = updated.profiles.find((p: { id: string }) => p.id === ollama.id);
    assert.equal(renamed.name, "本地 Ollama 改名");
    assert.equal(renamed.model, "qwen2.5:14b");
    assert.equal(renamed.apiKey, "****"); // 旧 Key（ollama）被保留并打码

    // 非 mock 新建缺 Key 被拒
    assert.equal((await post("/api/models", { name: "缺Key", provider: "deepseek" })).status, 400);

    // 删除未使用的模型
    const deleted = await (await post("/api/models/delete", { id: saved.profiles[0].id })).json();
    assert.equal(deleted.deleted, true);
  } finally {
    await running.close();
  }
});

test("web: 会话列表与恢复（新会话不覆盖旧会话）", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  try {
    const chat = (message: string) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }).then((res) => res.text());

    // 会话 A：一条消息并落盘
    await chat("会话A");
    // 新会话
    const created = await (await fetch(`${base}/api/new`, { method: "POST" })).json();
    assert.ok(created.id !== undefined);
    // 会话 B：也发一条，让新会话落盘
    await chat("会话B");

    // 会话列表：新旧两个会话都在磁盘上，互不覆盖
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions.currentId, created.id);
    assert.equal(sessions.sessions.length, 2, "新旧两个会话都应存在");
    const oldSession = sessions.sessions.find((s: { current: boolean }) => !s.current);
    assert.ok(oldSession !== undefined);
    assert.ok(oldSession.messageCount >= 2, "旧会话消息完整保留");

    // 恢复旧会话：历史回来了
    const resumed = await (await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: oldSession.id }),
    })).json();
    assert.ok(resumed.messages.some((m: { role: string; content: string }) => m.content === "会话A"));
    assert.doesNotMatch(JSON.stringify(resumed.messages), /会话B/);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).title, resumed.title);

    // 恢复不存在的会话
    const missing = await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "sess_not_exists" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("web: 重命名 / 删除会话（连带归档）", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 会话 A 落盘 → 新会话 B
    await (await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "旧会话" }),
    })).text();
    const created = await (await fetch(`${base}/api/new`, { method: "POST" })).json();

    // 重命名当前会话（B）
    const renamed = await (await fetch(`${base}/api/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "我的新标题" }),
    })).json();
    assert.equal(renamed.title, "我的新标题");
    assert.equal((await (await fetch(`${base}/api/state`)).json()).title, "我的新标题");

    // 空标题被拒
    const empty = await fetch(`${base}/api/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  " }),
    });
    assert.equal(empty.status, 400);

    // 不能删当前会话
    const selfDelete = await fetch(`${base}/api/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: created.id }),
    });
    assert.equal(selfDelete.status, 400);

    // 删除旧会话 A：列表里消失
    const before = await (await fetch(`${base}/api/sessions`)).json();
    const oldId = before.sessions.find((s: { current: boolean }) => !s.current).id;
    const deleted = await (await fetch(`${base}/api/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: oldId }),
    })).json();
    assert.equal(deleted.deleted, true);
    const after = await (await fetch(`${base}/api/sessions`)).json();
    assert.ok(!after.sessions.some((s: { id: string }) => s.id === oldId));
  } finally {
    await close();
  }
});

test("web: 未落盘空白草稿不再产生'打不开也删不掉'的幽灵会话", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    // 会话 A 落盘 → 新建空白草稿 B（还没发消息）
    await (await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "任务A" }),
    })).text();
    const draft = await (await fetch(`${base}/api/new`, { method: "POST" })).json();

    // 切回 A 后：空白草稿 B 未落盘，不应出现在列表里（否则点了只会"切换会话失败"）
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()).sessions;
    const sessionA = sessions.find((s: { id: string }) => s.id !== draft.id);
    await post("/api/resume", { id: sessionA.id });
    const listAway = await (await fetch(`${base}/api/sessions`)).json();
    assert.ok(
      !listAway.sessions.some((s: { id: string }) => s.id === draft.id),
      "切走后空白草稿不再展示",
    );

    // 同进程内仍可切回来（内存草稿直接恢复，而不是 404"未找到会话"）
    const back = await post("/api/resume", { id: draft.id });
    assert.equal(back.status, 200);
    assert.deepEqual((await back.json()).messages, []);

    // 切回 A 后删除草稿：未落盘没有文件可删，但注册要被清掉 —— 再恢复就是真的 404
    await post("/api/resume", { id: sessionA.id });
    const del = await (await post("/api/delete", { id: draft.id })).json();
    assert.equal(del.deleted, false, "草稿未落盘，没有文件可删");
    assert.equal((await post("/api/resume", { id: draft.id })).status, 404, "删除后草稿从内存注销");
  } finally {
    await close();
  }
});

test("web: 重启后自动恢复最近的会话（不再从空白新会话开始）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-restore-"));
  const chat = (base: string, message: string) =>
    fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((res) => res.text());

  const first = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  const base1 = `http://127.0.0.1:${first.port}`;
  let recentId = "";
  try {
    await chat(base1, "第一个会话");
    // 让两个会话的 updatedAt 明确分先后，避免同毫秒并列导致"最近会话"不稳定
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(`${base1}/api/new`, { method: "POST" });
    await chat(base1, "第二个会话");
    recentId = (await (await fetch(`${base1}/api/sessions`)).json()).currentId;
  } finally {
    await first.close();
  }

  const second = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  const base2 = `http://127.0.0.1:${second.port}`;
  try {
    const sessions = await (await fetch(`${base2}/api/sessions`)).json();
    assert.equal(sessions.currentId, recentId, "重启后当前会话 = 最近使用的会话");
    const history = await (await fetch(`${base2}/api/history`)).json();
    assert.ok(history.messages.some((m: { content: string }) => m.content === "第二个会话"));
  } finally {
    await second.close();
  }
});

test("web: 执行中 steer 注入 + 排队，输出进入同一条流", async () => {
  const provider = new ControlledProvider();
  const root = await mkdtemp(join(tmpdir(), "minicode-web-"));
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    // 第一轮：挂起等待 release（不先读 body，保持 SSE 打开）
    const firstChat = fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "第一条" }),
    });
    await provider.waitForCall();

    // 执行中再发送 → steer，立即返回
    const steerRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "中途转向" }),
    });
    const steerData = await steerRes.json();
    assert.equal(steerData.steered, true);
    assert.match(steerData.note, /已注入当前执行轮/);

    // 显式排队一条（只允许执行中使用）
    const queueRes = await fetch(`${base}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "排队消息" }),
    });
    assert.equal((await queueRes.json()).queued, true);

    // 依次放行三轮：第一条 → 排队消息（显式 queue）→ 中途转向（steer 太晚自动续排）
    provider.release("第一轮回复");
    await provider.waitForCall();
    provider.release("第二轮回复");
    await provider.waitForCall();
    provider.release("第三轮回复");

    const stream = await (await firstChat).text();
    // 三个轮次的回复都出现在同一条 SSE 流里（waitForIdle 保持了流）
    assert.match(stream, /第一轮回复/);
    assert.match(stream, /第二轮回复/);
    assert.match(stream, /第三轮回复/);
    // 每轮一个 turn_start，卡片在前端按轮切换
    assert.equal((stream.match(/"type":"turn_start"/g) ?? []).length, 3);
    assert.match(stream, /"type":"done"/);

    // 空闲时排队被拒绝
    const idleQueue = await fetch(`${base}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    assert.equal(idleQueue.status, 400);

    // 空闲时停止返回 false
    const stop = await (await fetch(`${base}/api/stop`, { method: "POST" })).json();
    assert.equal(stop.stopped, false);
  } finally {
    await running.close();
  }
});

test("web: 多会话并行执行（Codex 式多任务）", async () => {
  const provider = new ControlledProvider();
  const root = await mkdtemp(join(tmpdir(), "minicode-web-parallel-"));
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    const chat = (message: string) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

    // 会话 A 开始执行（挂起）
    const chatA = chat("会话A任务");
    await provider.waitForCall();

    // A 执行中新建会话 B 并发消息（不被 409 拒绝，两条流并行）
    await fetch(`${base}/api/new`, { method: "POST" });
    const chatB = chat("会话B任务");
    await provider.waitForCall();

    // 两个会话同时运行：当前 B 在跑，A 在后台跑
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions.currentRunning, true, "当前会话 B 已开始执行");

    // A、B 各自放行，两条流独立完成
    provider.release("A回复");
    provider.release("B回复");
    const streamA = await (await chatA).text();
    const streamB = await (await chatB).text();
    assert.match(streamA, /A回复/);
    assert.doesNotMatch(streamA, /B回复/);
    assert.match(streamB, /B回复/);
    assert.doesNotMatch(streamB, /A回复/);
    assert.match(streamA, /"type":"done"/);
    assert.match(streamB, /"type":"done"/);

    // 两个会话都各自落盘（多任务互不干扰）
    const list = await (await fetch(`${base}/api/sessions`)).json();
    assert.ok(list.sessions.length >= 2);
    assert.ok(list.sessions.every((s: { running: boolean }) => s.running === false));

    // 恢复 A：历史完整
    const resumedA = await (await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: list.sessions.find((s: { current: boolean }) => !s.current).id }),
    })).json();
    assert.ok(resumedA.messages.some((m: { content: string }) => m.content === "会话A任务"));
  } finally {
    await running.close();
  }
});

test("web: 行程路线接口返回真实路径几何（高德方向 API；景点+住宿，餐厅排除）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-routes-"));
  await mkdir(join(root, "plans"), { recursive: true });
  await writeFile(
    join(root, "plans", "测试路线.json"),
    JSON.stringify({
      title: "测试路线",
      days: [
        {
          items: [
            { name: "酒店", type: "accommodation", location: { name: "酒店", latitude: 28.96, longitude: 118.86 } },
            { name: "A点", type: "visit", time: "09:00", location: { name: "A点", latitude: 28.962, longitude: 118.863 } },
            // 餐厅候选位于两点之间：不应出现在路线 legs 里
            { name: "中途餐厅", type: "meal", subtype: "lunch", location: { name: "中途餐厅", latitude: 28.961, longitude: 118.864 } },
            { name: "B点", type: "visit", time: "10:00", location: { name: "B点", latitude: 28.963, longitude: 118.866 } },
            { name: "回酒店休息", type: "rest", location: { name: "酒店", latitude: 28.96, longitude: 118.86 } },
            // 同一酒店点位的第二个休息块：不应重复请求路径（直连占位）
            { name: "夜宿酒店", type: "rest", location: { name: "酒店", latitude: 28.96, longitude: 118.86 } },
          ],
        },
      ],
    }),
    "utf8",
  );

  const running = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  // 服务端在请求时懒读取全局高德客户端，测试后注入假客户端即可
  const calls: string[] = [];
  setAmapKey("test-key", (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    assert.match(parsed.pathname, /\/v3\/direction\/walking/); // 各段直距 < 1.5km → 步行模式
    const origin = parsed.searchParams.get("origin") ?? "";
    const destination = parsed.searchParams.get("destination") ?? "";
    calls.push(`${origin}→${destination}`);
    return new Response(
      JSON.stringify({
        status: "1",
        infocode: "10000",
        route: {
          paths: [{
            distance: "950",
            duration: "720",
            steps: [{ polyline: `${origin};${destination}` }],
          }],
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch);

  try {
    const res = await fetch(
      `http://127.0.0.1:${running.port}/api/plans/${encodeURIComponent("测试路线")}/routes`,
    );
    const data = await res.json();
    assert.equal(data.available, true);
    assert.equal(data.days.length, 1);
    // 路线 = 酒店 → A点 → B点 → 酒店 → 酒店；餐厅不参与；同点位两条目不请求路径
    assert.deepEqual(calls, [
      "118.86,28.96→118.863,28.962",
      "118.863,28.962→118.866,28.963",
      "118.866,28.963→118.86,28.96",
    ]);
    assert.equal(data.days[0].legs.length, 4);
    assert.equal(data.days[0].legs[3].straight, true);
    const leg = data.days[0].legs[0];
    assert.equal(leg.mode, "walking");
    assert.equal(leg.distanceM, 950);
    assert.deepEqual(leg.points, [
      [28.96, 118.86],
      [28.962, 118.863],
    ]);
  } finally {
    setAmapKey(undefined);
    await running.close();
  }
});

test("web: POI 照片接口（高德 photos，服务端缓存，无 Key 时明确不可用）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-photos-"));
  const running = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  const base = `http://127.0.0.1:${running.port}`;
  let calls = 0;
  setAmapKey("test-key", (async (url: string | URL | Request) => {
    calls += 1;
    const parsed = new URL(String(url));
    assert.match(parsed.pathname, /\/v3\/place\/text/);
    assert.equal(parsed.searchParams.get("keywords"), "水亭门城墙");
    return new Response(
      JSON.stringify({
        status: "1",
        infocode: "10000",
        pois: [{
          id: "p1",
          name: "水亭门城墙",
          location: "118.8668,28.9621",
          photos: [{ url: "https://img.example/a.jpg" }],
        }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch);

  try {
    const url = `${base}/api/poi-photos?name=${encodeURIComponent("水亭门城墙")}&lat=28.962&lng=118.867`;
    const first = await (await fetch(url)).json();
    assert.deepEqual(first.photos, ["https://img.example/a.jpg"]);
    const second = await (await fetch(url)).json();
    assert.deepEqual(second.photos, ["https://img.example/a.jpg"]);
    assert.equal(calls, 1, "第二次请求应命中服务端缓存");

    // 未配置高德 Key：明确返回 available=false
    setAmapKey(undefined);
    const missing = await (await fetch(`${base}/api/poi-photos?name=x&lat=1&lng=2`)).json();
    assert.equal(missing.available, false);
  } finally {
    setAmapKey(undefined);
    await running.close();
  }
});

test("web: 照片接口并发去重（同名同坐标只请求一次上游）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-photos2-"));
  const running = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  let calls = 0;
  setAmapKey("test-key", (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(
      JSON.stringify({
        status: "1",
        infocode: "10000",
        pois: [{ id: "p", name: "测试点", location: "118.8,28.9", photos: [{ url: "https://img.example/p.jpg" }] }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch);

  try {
    const url = `http://127.0.0.1:${running.port}/api/poi-photos?name=${encodeURIComponent("测试点")}&lat=28.9&lng=118.8`;
    const [d1, d2] = await Promise.all([fetch(url).then((r) => r.json()), fetch(url).then((r) => r.json())]);
    assert.deepEqual(d1.photos, ["https://img.example/p.jpg"]);
    assert.deepEqual(d2.photos, ["https://img.example/p.jpg"]);
    assert.equal(calls, 1, "并发同名请求应合并为一次上游调用");
  } finally {
    setAmapKey(undefined);
    await running.close();
  }
});

test("web: 删除行程接口（连带 Markdown 与质量报告）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-web-plans-"));
  await mkdir(join(root, "plans"), { recursive: true });
  const writePlan = (name: string, title: string) =>
    writeFile(join(root, "plans", name), JSON.stringify({ title, days: [{ items: [{ name: "x" }] }] }), "utf8");
  await writePlan("待删除.json", "待删除");
  await writeFile(join(root, "plans", "待删除.md"), "# 待删除", "utf8");
  await writeFile(join(root, "plans", "待删除.quality.json"), "{}", "utf8");
  await writeFile(join(root, "plans", "待删除.quality.md"), "# 质量报告", "utf8");
  await writePlan("保留.json", "保留");

  const running = await startWebServer({ rootDir: root, port: 0, configOverrides: { provider: "mock" } });
  const base = `http://127.0.0.1:${running.port}`;
  const del = (body: unknown) =>
    fetch(`${base}/api/plans/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const res = await del({ title: "待删除" });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.found, true);
    assert.equal(data.deleted, 4);

    const remaining = (await readdir(join(root, "plans"))).sort();
    assert.deepEqual(remaining, ["保留.json"]);

    // 缺标题 → 400；不存在的行程 → found=false
    assert.equal((await del({})).status, 400);
    const missing = await (await del({ title: "不存在" })).json();
    assert.equal(missing.found, false);

    // 列表接口不再包含已删除项
    const list = await (await fetch(`${base}/api/plans`)).json();
    assert.ok(!list.plans.some((plan: { title: string }) => plan.title === "待删除"));
  } finally {
    await running.close();
  }
});

test("web: 审批模式——自动编辑（默认）下文件写入免确认", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-approval-"));
  const provider = new ToolProvider([{ name: "write_file", arguments: JSON.stringify({ path: "auto.txt", content: "hi" }) }]);
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    assert.equal((await (await fetch(`${base}/api/state`)).json()).approvalMode, "edits");
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "写个文件" }),
    });
    const stream = await collectSse(res);
    assert.doesNotMatch(stream, /"type":"permission"/);
    assert.match(stream, /"type":"done"/);
    assert.equal(await readFile(join(root, "auto.txt"), "utf8"), "hi");
  } finally {
    await running.close();
  }
});

test("web: 审批模式——逐条确认时文件写入需批准", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-approval-"));
  const provider = new ToolProvider([{ name: "write_file", arguments: JSON.stringify({ path: "gated.txt", content: "ok" }) }]);
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    await fetch(`${base}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ask" }),
    });
    assert.equal((await (await fetch(`${base}/api/state`)).json()).approvalMode, "ask");

    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "写个文件" }),
    });
    let sawPermission = false;
    await collectSse(res, async (event) => {
      if (event.type === "permission") {
        sawPermission = true;
        assert.equal(event.tool, "write_file");
        assert.equal(event.canAlways, true);
        await fetch(`${base}/api/permission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: event.id, allowed: true }),
        });
      }
    });

    assert.equal(sawPermission, true);
    assert.equal(await readFile(join(root, "gated.txt"), "utf8"), "ok");
  } finally {
    await running.close();
  }
});

test("web: 审批模式——信任会话下 bash 变更命令免确认", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-approval-"));
  const provider = new ToolProvider([{ name: "bash", arguments: JSON.stringify({ command: "echo trusted > t.txt" }) }]);
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    await fetch(`${base}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "trust" }),
    });
    assert.equal((await (await fetch(`${base}/api/state`)).json()).approvalMode, "trust");

    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "写文件" }),
    });
    const stream = await collectSse(res);
    assert.doesNotMatch(stream, /"type":"permission"/);
    assert.equal((await readFile(join(root, "t.txt"), "utf8")).trim(), "trusted");

    await fetch(`${base}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "edits" }),
    });
    assert.equal((await (await fetch(`${base}/api/state`)).json()).approvalMode, "edits");
  } finally {
    await running.close();
  }
});

test("web: bash 命令记忆——批准一次后同前缀命令免确认", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-approval-"));
  const provider = new ToolProvider([
    { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
    { name: "bash", arguments: JSON.stringify({ command: "npm test --silent" }) },
  ]);
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    const first = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "跑测试" }),
    });
    let commandKey = "";
    const firstStream = await collectSse(first, async (event) => {
      if (event.type === "permission") {
        commandKey = String(event.commandKey);
        await fetch(`${base}/api/permission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: event.id, allowed: "always-command" }),
        });
      }
    });
    assert.equal(commandKey, "npm test");
    assert.match(firstStream, /"type":"permission"/);

    const second = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "再跑一次" }),
    });
    const secondStream = await collectSse(second);
    assert.doesNotMatch(secondStream, /"type":"permission"/);
    assert.match(secondStream, /"type":"done"/);
  } finally {
    await running.close();
  }
});

test("web: /api/approval 非法参数被拒绝", async () => {
  const { port, close } = await withMockServer();
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(`${base}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test("web: 恢复会话是快速纯加载（不再在切换时触发摘要 LLM 调用）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-resume-"));
  // 预置一个"超长"会话：旧逻辑会在 /api/resume 时同步压缩（调 LLM，数秒延迟）
  const store = new JsonFileSessionStore(join(root, ".minicode", "sessions"));
  const longSession = new Session("sess_long_resume");
  for (let i = 0; i < 12; i++) {
    longSession.add("user", `问题${i} ${"细节".repeat(80)}`);
    longSession.add("assistant", `回答${i} ${"内容".repeat(80)}`);
  }
  await store.save(longSession);

  let chatCalls = 0;
  const provider: ChatProvider = {
    name: "counting",
    async chat() {
      chatCalls += 1;
      return "不应被调用";
    },
  };
  const running = await startWebServer({ rootDir: root, port: 0, providerOverride: provider });
  const base = `http://127.0.0.1:${running.port}`;

  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "sess_long_resume" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.messages.length, 24, "历史完整返回（未压缩）");
    assert.equal(chatCalls, 0, "切换不得触发任何摘要/LLM 调用");
    assert.ok(Date.now() - started < 2000, "切换应远快于 LLM 往返（<2s）");
  } finally {
    await running.close();
  }
});
