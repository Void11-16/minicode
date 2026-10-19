import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelProfileStore, newProfileId } from "../src/config/models.ts";
import { createProviderFromProfile } from "../src/llm/factory.ts";

async function tempModelsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-models-"));
  return join(dir, "models.json");
}

test("ModelProfileStore: 从旧单模型配置自动迁移", async () => {
  const file = await tempModelsFile();
  const store = new ModelProfileStore(file);

  const seeded = await store.loadWithSeed({
    provider: "auto",
    deepseekApiKey: "sk-old-key-123456",
    deepseekModel: "deepseek-reasoner",
  });

  assert.equal(seeded.profiles.length, 1);
  assert.equal(seeded.profiles[0].id, "deepseek");
  assert.equal(seeded.profiles[0].apiKey, "sk-old-key-123456");
  assert.equal(seeded.profiles[0].model, "deepseek-reasoner");
  assert.equal(seeded.defaultProfile, "deepseek");

  // 已落盘，二次加载不再重复迁移
  const reloaded = await store.load();
  assert.equal(reloaded.profiles.length, 1);
});

test("ModelProfileStore: 损坏文件回退为空，save/load 往返", async () => {
  const file = await tempModelsFile();
  await writeFile(file, "not json{{", "utf8");
  const store = new ModelProfileStore(file);

  assert.equal((await store.load()).profiles.length, 0);

  const profiles = [
    { id: "a", name: "DeepSeek", provider: "deepseek" as const, apiKey: "sk-a", model: "deepseek-chat" },
    { id: "b", name: "本地 Ollama", provider: "openai" as const, baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", apiKey: "ollama" },
  ];
  await store.save({ profiles, defaultProfile: "a" });
  const loaded = await store.load();
  assert.deepEqual(loaded.profiles, profiles);
  assert.equal(loaded.defaultProfile, "a");
});

test("newProfileId 不与现有 id 冲突", () => {
  const existing = [{ id: "model-1", name: "a", provider: "deepseek" as const }];
  assert.equal(newProfileId(existing), "model-2");
  assert.equal(newProfileId([]), "model-1");
});

test("createProviderFromProfile: 按类型创建对应 Provider", () => {
  const deepseek = createProviderFromProfile({ id: "d", name: "d", provider: "deepseek", apiKey: "sk-x", model: "deepseek-reasoner" });
  assert.equal(deepseek.name, "deepseek:deepseek-reasoner");

  const compat = createProviderFromProfile({
    id: "o", name: "o", provider: "openai", apiKey: "sk-y",
    baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b",
  });
  assert.equal(compat.name, "openai:qwen2.5:7b");

  const mock = createProviderFromProfile({ id: "m", name: "m", provider: "mock" });
  assert.equal(mock.name, "mock");
});
