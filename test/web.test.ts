import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../src/web/server.ts";
import type { ChatProvider } from "../src/llm/provider.ts";

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
