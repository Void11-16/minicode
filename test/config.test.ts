import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, maskSecret } from "../src/config/config.ts";
import { createProvider } from "../src/llm/factory.ts";
import { handleCommand } from "../src/cli/commands.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { CliApp } from "../src/cli/app.ts";
import { Session } from "../src/core/session.ts";

async function tempConfigFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-cfg-"));
  return join(dir, "config.json");
}

test("ConfigStore set/clear 往返", async () => {
  const store = new ConfigStore(await tempConfigFile());

  const saved = await store.set("deepseek_api_key", "sk-test-1234567890");
  assert.equal(saved.deepseekApiKey, "sk-test-1234567890");
  assert.equal(saved.provider, "auto");
  const withResume = await store.set("resume_max_tokens", "5000");
  assert.equal(withResume.resumeMaxTokens, "5000");

  // 别名 + 磁盘持久化
  const store2 = new ConfigStore((store as unknown as { file: string }).file);
  const saved2 = await store2.set("ds_model", "deepseek-reasoner");
  assert.equal(saved2.deepseekModel, "deepseek-reasoner");
  assert.equal(saved2.deepseekApiKey, "sk-test-1234567890");

  const cleared = await store2.clear("deepseek_api_key");
  assert.equal(cleared.deepseekApiKey, undefined);
});

test("ConfigStore 拒绝未知键与非法 provider", async () => {
  const store = new ConfigStore(await tempConfigFile());
  await assert.rejects(() => store.set("no_such_key", "x"), /未知配置项/);
  await assert.rejects(() => store.set("provider", "gpt"), /provider 只能是/);
});

test("taste_preferences 别名与持久化往返", async () => {
  const store = new ConfigStore(await tempConfigFile());

  const saved = await store.set("taste_preferences", "不吃辣、人均100以内、想尝试本地特色");
  assert.equal(saved.tastePreferences, "不吃辣、人均100以内、想尝试本地特色");
  assert.equal((await store.load()).tastePreferences, "不吃辣、人均100以内、想尝试本地特色");

  const aliased = await store.set("taste", "清淡口味");
  assert.equal(aliased.tastePreferences, "清淡口味");

  const cleared = await store.clear("taste_preferences");
  assert.equal(cleared.tastePreferences, undefined);
});

test("损坏的配置文件回退到默认值", async () => {
  const file = await tempConfigFile();
  await writeFile(file, "not a json{{{", "utf8");
  const config = await new ConfigStore(file).load();
  assert.equal(config.provider, "auto");
});

test("配置文件优先于环境变量", () => {
  const provider = createProvider({
    config: { deepseekApiKey: "sk-from-config" },
    env: { LLM_API_KEY: "sk-from-env", DEEPSEEK_API_KEY: "sk-from-env" },
  });
  assert.equal(provider.name, "deepseek:deepseek-chat");
});

test("provider=mock 强制使用 Mock", () => {
  const provider = createProvider({
    config: { provider: "mock", deepseekApiKey: "sk-xxx" },
    env: { DEEPSEEK_API_KEY: "sk-yyy" },
  });
  assert.equal(provider.name, "mock");
});

test("maskSecret 打码 API Key", () => {
  assert.equal(maskSecret("sk-1234567890abcdef"), "sk-1****cdef");
  assert.equal(maskSecret("short"), "****");
  assert.equal(maskSecret(undefined), undefined);
});

test("/config set 值支持空格（system_prompt 等）", async () => {
  const store = new ConfigStore(await tempConfigFile());
  let current: AppConfig = { provider: "auto" };
  const app = {
    configStore: store,
    applyConfig: (next: AppConfig) => {
      current = next;
    },
    get config() {
      return current;
    },
  } as unknown as CliApp;

  assert.equal(await handleCommand(app, "/config set system_prompt 你是一个旅行规划助手"), true);
  assert.equal(current.systemPrompt, "你是一个旅行规划助手");

  // 值两侧空白被规整，内部空格保留
  assert.equal(await handleCommand(app, "/config set system_prompt   杭州 三日游  攻略 "), true);
  assert.equal(current.systemPrompt, "杭州 三日游  攻略");
  assert.equal((await store.load()).systemPrompt, "杭州 三日游  攻略");

  // 缺值仍然走帮助，不误写空字符串
  assert.equal(await handleCommand(app, "/config set system_prompt"), true);
  assert.equal(current.systemPrompt, "杭州 三日游  攻略");
});

test("/model 与 /travel 命令：按会话切换模型与旅行模式开关", async () => {
  const session = new Session();
  session.add("user", "你好");
  const state = {
    profiles: [
      { id: "deepseek", name: "DeepSeek", provider: "deepseek" as const, model: "deepseek-chat" },
      { id: "model-2", name: "DeepSeek Reasoner", provider: "deepseek" as const, model: "deepseek-reasoner" },
    ],
    defaultProfileId: "deepseek",
    travelMode: true,
    runtime: { hasActiveTurn: () => false },
    sessionService: { persist: async () => undefined },
    switchSession: (target: typeof session) => {
      state.currentSession = target;
    },
    currentSession: session,
    currentAgent: () => ({ session: state.currentSession }),
    rebuildRuntime: () => undefined,
  };
  const app = state as unknown as CliApp;

  // /models 列表
  assert.equal(await handleCommand(app, "/models"), true);

  // /model 2 → 当前会话切到 Reasoner
  assert.equal(await handleCommand(app, "/model 2"), true);
  assert.equal(state.currentSession.modelProfile, "model-2");

  // 关键词匹配
  assert.equal(await handleCommand(app, "/model deepseek"), true);
  assert.equal(state.currentSession.modelProfile, "deepseek");

  // 不存在的模型
  assert.equal(await handleCommand(app, "/model 不存在"), true);
  assert.equal(state.currentSession.modelProfile, "deepseek");

  // /travel off → 通用助手
  assert.equal(await handleCommand(app, "/travel off"), true);
  assert.equal(state.travelMode, false);
  assert.equal(await handleCommand(app, "/travel on"), true);
  assert.equal(state.travelMode, true);

  // 用法提示
  assert.equal(await handleCommand(app, "/travel"), true);
});
