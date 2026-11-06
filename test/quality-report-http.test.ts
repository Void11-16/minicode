import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.ts";
import { createSaveTravelBriefTool } from "../src/tools/brief.ts";

test("Web 列表不展示旧公式或旧行程内容对应的评分；重算只调用本地规则", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "minicode-quality-report-"));
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "plans/评分.json"), JSON.stringify({ title: "评分", days: [{ items: [{ id: "v", type: "visit", name: "公园", time: "10:00", end_time: "11:00", location: { latitude: 30, longitude: 120, crs: "wgs84" }, source: "manual", confidence: "high", opening_hours: { opens: "08:00", closes: "20:00" } }] }] }));
  const server = await startWebServer({ rootDir: root, auth: false, port: 0, configOverrides: { provider: "mock", amapApiKey: undefined } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  for (const score_version of [undefined, "opportunity-v1", "opportunity-v2"]) {
    await writeFile(join(root, "plans/评分.quality.json"), JSON.stringify({ status: "invalid", score: 0, score_version, source_signature: "older-plan" }));
    const data = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
    assert.equal(data.plans[0].quality.score, 100); assert.equal(data.plans[0].quality.status, "ok");
  }
  const planPath = join(root, "plans/评分.json");
  const changed = JSON.parse(await readFile(planPath, "utf8"));
  changed.days[0].items[0].opening_hours.opens = "12:00";
  await writeFile(planPath, JSON.stringify(changed));
  const refreshed = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(refreshed.plans[0].quality.status, "needs_revision");
  assert.ok(refreshed.plans[0].quality.score < 100);
  await writeFile(join(root, "plans/旧行程.json"), JSON.stringify({ title: "旧行程", days: [{ items: [{ type: "obsolete" }] }] }));
  const legacy = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(legacy.plans.length, 2);
  assert.equal(legacy.plans.find((plan: { file: string }) => plan.file === "旧行程.json").quality, null);
  // 只改需求单也必须使内存质量缓存失效，旧 JSON 不含 must_visit 不能漏验收。
  changed.days[0].items[0].opening_hours.opens = "08:00";
  await writeFile(planPath, JSON.stringify(changed));
  await createSaveTravelBriefTool(root).execute({ title: "评分", destination: "杭州", mustVisit: ["灵隐寺"] });
  const required = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(required.plans.find((p: { file: string }) => p.file === "评分.json").quality.status, "needs_revision");
  await createSaveTravelBriefTool(root).execute({ title: "评分", destination: "杭州", mustVisit: ["公园"] });
  const satisfied = await (await fetch(`http://127.0.0.1:${server.port}/api/plans`)).json();
  assert.equal(satisfied.plans.find((p: { file: string }) => p.file === "评分.json").quality.status, "ok");
});
