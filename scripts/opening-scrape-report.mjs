#!/usr/bin/env node
/**
 * 开放时间抓取复盘：对固定地点集合分别跑“拦截 fake-IP”和“允许 fake-IP”两种模式，
 * 输出 JSON/Markdown 报告到 eval/out/opening-scrape/<timestamp>/。
 *
 *   node scripts/opening-scrape-report.mjs
 *   node scripts/opening-scrape-report.mjs --limit 1 --modes allow
 *   默认允许 fake-IP；--modes blocked 会显式设置 MINICODE_ALLOW_FAKE_IP=0。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDefaultRegistry } from "../src/tools/all.ts";
import { ToolDiagnostics } from "../src/core/tool-diagnostics.ts";

const root = resolve(import.meta.dirname, "..");
const outRoot = join(root, "eval", "out", "opening-scrape");

const allPlaces = [
  ["故宫博物院", "北京"],
  ["中国国家博物馆", "北京"],
  ["呼和浩特博物院", "呼和浩特"],
  ["内蒙古博物院", "呼和浩特"],
  ["滕王阁", "南昌"],
  ["南昌八一起义纪念馆", "南昌"],
  ["象鼻山景区", "桂林"],
  ["冰心故居", "福州"],
];

const args = process.argv.slice(2);
const limit = numberArg("--limit", allPlaces.length);
const modes = stringArg("--modes", "blocked,allow").split(",").filter((value) => value === "blocked" || value === "allow");
const delayMs = numberArg("--delay", 2000);
const places = allPlaces.slice(0, Math.max(1, Math.min(allPlaces.length, limit)));

function numberArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}
function stringArg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(place, city) {
  const workspace = join(outRoot, `.workspace-${process.pid}-${stamp()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const registry = createDefaultRegistry({ writeRoot: workspace, workspace, allowCommands: false });
  const diagnostics = new ToolDiagnostics();
  const input = JSON.stringify({ place, city, fields: ["hours", "closure", "last_admission"] });
  const started = Date.now();
  let output = "";
  let error = "";
  try {
    const result = await diagnostics.run({ id: `probe-${place}`, name: "get_place_visit_info", arguments: input }, 1, () =>
      registry.executeDetailed("get_place_visit_info", input, {
        workspace,
        travelMode: true,
        destination: city,
        queryAttempts: new Map(),
        signal: AbortSignal.timeout(45_000),
      })
    );
    output = result.output;
    error = result.error ?? "";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const record = diagnostics.records.at(-1);
  const lines = output.split("\n");
  await rm(workspace, { recursive: true, force: true });
  return {
    place,
    city,
    elapsed_ms: Date.now() - started,
    error,
    extracted: record?.opening_fields?.extracted ?? [],
    body_sources: record?.opening_fields?.body_sources ?? 0,
    requests: record?.place_lookup?.requests ?? 0,
    page_errors: record?.page_errors ?? [],
    evidence: lines.filter((line) => /^(开放时段|每周闭馆|最后入场)：/.test(line)).slice(0, 4),
    blocked: lines.filter((line) => /查询受阻|搜索失败|未找到可引用/.test(line)).slice(0, 2),
    sources: lines.filter((line) => line.startsWith("   来源 http")).slice(0, 5),
  };
}

async function runMode(mode) {
  process.env.MINICODE_ALLOW_FAKE_IP = mode === "allow" ? "1" : "0";
  const results = [];
  console.log(`\n[${new Date().toLocaleString()}] mode=${mode} places=${places.length}`);
  for (const [place, city] of places) {
    const result = await probe(place, city);
    results.push({ mode, ...result });
    console.log(`${mode} ${place}: fields=${result.extracted.length}/3 body=${result.body_sources} requests=${result.requests} errors=${result.page_errors.map((error) => error.code).join(",") || "-"}`);
    await sleep(delayMs);
  }
  return results;
}

function summaryRows(results) {
  return results.map((result) => ({
    mode: result.mode,
    place: result.place,
    city: result.city,
    fields: `${result.extracted.length}/3`,
    body_sources: result.body_sources,
    requests: result.requests,
    page_errors: result.page_errors.map((error) => error.code).join(", ") || "-",
    evidence: result.evidence.join(" ").slice(0, 300) || "-",
    blocked: result.blocked.join(" ").slice(0, 300) || "-",
  }));
}

function renderMarkdown(results, generatedAt) {
  const lines = [
    `# 开放时间抓取复盘`,
    "",
    `- 生成: ${generatedAt}`,
    `- 地点数: ${places.length}`,
    `- 模式: ${modes.join(", ")}`,
    "",
    "| 模式 | 地点 | 字段 | body_sources | 请求 | page_errors |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...summaryRows(results).map((row) => `| ${row.mode} | ${row.place}（${row.city}） | ${row.fields} | ${row.body_sources} | ${row.requests} | ${row.page_errors} |`),
    "",
    "## 字段证据",
    "",
    ...results.map((result) => `### ${result.mode} · ${result.place}\n\n${result.evidence.map((line) => `- ${line}`).join("\n") || "- 无"}\n\n${result.blocked.length ? `受阻：${result.blocked.join("；")}\n` : ""}`),
    "",
  ];
  return lines.join("\n");
}

const generatedAt = new Date().toISOString();
const results = [];
for (const mode of modes) {
  results.push(...await runMode(mode));
  if (mode !== modes.at(-1)) await sleep(delayMs * 5);
}
const directory = join(outRoot, stamp());
await mkdir(directory, { recursive: true });
const report = { generated_at: generatedAt, places, modes, results };
await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(join(directory, "report.md"), `${renderMarkdown(results, generatedAt)}\n`, "utf8");
console.log(`\n报告: ${directory}/report.md`);
