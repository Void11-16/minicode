import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PhotoCache } from "../src/web/photo-cache.ts";

test("PhotoCache: 存取照片并落盘复用", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "mc-photo-cache-")), "photo-cache.json");
  const cache = new PhotoCache(file);
  await cache.load();
  cache.set("西湖|30.250,120.150", ["https://img.example/xihu.jpg"]);
  await cache.persist();

  const reloaded = new PhotoCache(file);
  await reloaded.load();
  assert.deepEqual(reloaded.get("西湖|30.250,120.150"), ["https://img.example/xihu.jpg"]);
});

test("PhotoCache: 载入时丢弃旧版本条目（换了照片匹配逻辑后不复用错图）", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "mc-photo-cache-")), "photo-cache.json");
  // 旧版本写入的键没有版本前缀；改过匹配逻辑后必须失效，否则会继续贴错图
  await writeFile(
    file,
    JSON.stringify({ "西湖|30.250,120.150": { photos: ["https://img.example/legacy.jpg"], savedAt: Date.now() } }),
    "utf8",
  );
  const cache = new PhotoCache(file);
  await cache.load();

  assert.equal(cache.get("西湖|30.250,120.150"), undefined);
});
