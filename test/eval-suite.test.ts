import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases, loadSuite } from "../src/eval/cases.ts";
import { initialToolRoundsForCase } from "../src/eval/live.ts";

async function suiteFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "minicode-eval-suite-"));
  const file = join(directory, "suite.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("评测套件: representative 固定三个代表案例并可按标签筛选", async () => {
  const suite = await loadSuite(join(import.meta.dirname, "..", "eval", "suites", "representative.json"));

  assert.equal(suite.id, "representative");
  assert.equal(suite.version, "2026.11");
  assert.deepEqual(suite.cases[0]!.must_visit, ["故宫", "国家博物馆"]);
  assert.deepEqual(suite.cases[1]!.must_visit, ["故宫", "国家博物馆", "天坛", "颐和园", "长城"]);
  assert.deepEqual(
    suite.cases.map((item) => item.id),
    ["beijing-3d-museum", "beijing-5d-first-trip", "chifeng-7d-remote"],
  );
  assert.ok(suite.cases.every((item) => item.tags?.includes("representative")));
  assert.ok(suite.cases[2].tags?.includes("remote-day"));
  assert.ok(initialToolRoundsForCase(suite.cases[2]) > initialToolRoundsForCase(suite.cases[0]));
});

test("评测套件: 新套件保留元数据、标签去重，旧数组继续兼容", async () => {
  const modern = await loadSuite(await suiteFile({
    id: "smoke",
    name: "冒烟",
    version: "v2",
    cases: [
      {
        id: "beijing-3d",
        title: "北京三日游",
        days: 3,
        tags: ["popular", "popular", "museum"],
        request: "去北京三天",
      },
      {
        id: "chifeng-7d",
        title: "赤峰七日游",
        days: 7,
        tags: ["remote-day"],
        request: "去赤峰七天",
      },
    ],
  }));
  assert.equal(modern.id, "smoke");
  assert.equal(modern.name, "冒烟");
  assert.equal(modern.version, "v2");
  assert.deepEqual(modern.cases[0].tags, ["popular", "museum"]);

  const legacyFile = await suiteFile([
    { id: "hangzhou-2d", title: "杭州两日游", days: 2, request: "周末去杭州" },
  ]);
  assert.equal((await loadCases(legacyFile))[0].id, "hangzhou-2d");
  assert.equal((await loadSuite(legacyFile)).id, "legacy");
});

test("评测套件: 拒绝非法套件 ID、重复案例 ID 和路径穿越式案例 ID", async () => {
  const unsafeRunIdFile = await suiteFile({
    id: "../escape",
    name: "非法",
    version: "1",
    cases: [{ id: "case-a", title: "案例", days: 1, request: "测试" }],
  });
  await assert.rejects(
    () => loadSuite(unsafeRunIdFile),
    /id 只能包含/,
  );

  const duplicateFile = await suiteFile([
    { id: "same-id", title: "案例一", days: 1, request: "测试" },
    { id: "same-id", title: "案例二", days: 1, request: "测试" },
  ]);
  await assert.rejects(
    () => loadSuite(duplicateFile),
    /样例 id 重复/,
  );

  const unsafeCaseIdFile = await suiteFile([
    { id: "../escape", title: "案例", days: 1, request: "测试" },
  ]);
  await assert.rejects(
    () => loadSuite(unsafeCaseIdFile),
    /id 只能包含/,
  );

  const emptyFile = await suiteFile([]);
  await assert.rejects(
    () => loadSuite(emptyFile),
    /非空样例数组/,
  );
});
