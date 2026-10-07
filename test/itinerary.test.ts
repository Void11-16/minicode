import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSaveItineraryTool,
  createLoadItineraryTool,
  createListItinerariesTool,
  createValidateItineraryTool,
} from "../src/tools/itinerary.ts";

const DAYS = [
  {
    date: "10-01",
    theme: "西湖环线",
    items: [
      { time: "09:00", type: "景点", name: "灵隐寺", note: "公交约 73 分钟" },
      { time: "12:30", type: "午餐", name: "知味观", note: "人均 ¥68" },
    ],
  },
];

const COMPLETE_DAYS = [
  {
    date: "2026-10-01",
    theme: "西湖环线",
    items: [
      {
        id: "visit-1",
        time: "09:00",
        end_time: "11:30",
        type: "visit",
        name: "灵隐寺",
        location: { latitude: 30.241, longitude: 120.099, source: "amap" },
        ticket_price_per_person: 30,
        opening_hours: { opens: "06:00", closes: "20:00", source: "official" },
        source: "amap",
        confidence: "high",
      },
      {
        id: "lunch-1",
        time: "12:00",
        end_time: "13:00",
        type: "meal",
        subtype: "lunch",
        name: "知味观",
        location: { latitude: 30.24, longitude: 120.15, source: "amap" },
        cost_per_person: 68,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "high",
      },
      {
        id: "transport-1",
        time: "13:30",
        end_time: "14:00",
        type: "transport",
        name: "知味观到河坊街",
        from: "知味观",
        to: "河坊街",
        transport_mode: "transit",
        distance_km: 4.5,
        source: "amap",
        confidence: "high",
      },
      {
        id: "visit-2",
        time: "14:00",
        end_time: "16:00",
        type: "visit",
        name: "河坊街",
        location: { latitude: 30.243, longitude: 120.166, source: "amap" },
        opening_hours: { opens: "09:00", closes: "22:00", source: "official" },
        source: "amap",
        confidence: "high",
      },
      {
        id: "dinner-1",
        time: "18:00",
        end_time: "19:00",
        type: "meal",
        subtype: "dinner",
        name: "新白鹿",
        location: { latitude: 30.25, longitude: 120.16, source: "amap" },
        cost_per_person: 80,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "high",
      },
    ],
  },
];

test("save_itinerary: 保存 JSON + 渲染 Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-"));
  const save = createSaveItineraryTool(root);

  const output = await save.execute({ title: "杭州两日游", days: DAYS });

  assert.match(output, /已保存「杭州两日游」（1 天 \/ 2 项）/);
  const json = JSON.parse(await readFile(join(root, "plans", "杭州两日游.json"), "utf8"));
  assert.equal(json.title, "杭州两日游");
  assert.equal(json.days[0].items[1].name, "知味观");

  const markdown = await readFile(join(root, "plans", "杭州两日游.md"), "utf8");
  assert.match(markdown, /# 杭州两日游/);
  assert.match(markdown, /## Day 1 · 西湖环线 · \(10-01\)/);
  assert.match(markdown, /- 09:00 · 景点 · 灵隐寺 — 公交约 73 分钟/);
});

test("save/load/list 往返：增量修改的基础", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-"));
  const save = createSaveItineraryTool(root);
  const load = createLoadItineraryTool(root);
  const list = createListItinerariesTool(root);

  await save.execute({ title: "上海一日", days: [{ items: [{ name: "外滩" }] }] });

  const loaded = await load.execute({ title: "上海一日" });
  const parsed = JSON.parse(loaded as string);
  assert.equal(parsed.days[0].items[0].name, "外滩");

  // 只改一条再保存（模拟增量修改工作流）
  parsed.days[0].items.push({ time: "18:00", type: "晚餐", name: "老正兴" });
  await save.execute(parsed);
  const updated = JSON.parse(await load.execute({ title: "上海一日" }) as string);
  assert.equal(updated.days[0].items.length, 2);

  const listed = await list.execute({});
  assert.match(listed, /上海一日（1 天 \/ 2 项）/);
});

test("save_itinerary: 保存质量报告，strict 拦截 P1 问题", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-quality-"));
  const save = createSaveItineraryTool(root);
  const validate = createValidateItineraryTool(root);

  const output = await save.execute({ title: "杭州一日", days: COMPLETE_DAYS, budget_per_person_yuan: 200 });
  assert.match(output, /质量: 100 \/ 100/);
  assert.match(output, /P0 0 \/ P1 0 \/ P2 0/);
  assert.match(await readFile(join(root, "plans", "杭州一日.quality.md"), "utf8"), /状态: 通过/);
  assert.match(await validate.execute({ title: "杭州一日", strict: true, budget_per_person_yuan: 200 }), /状态: 通过/);

  await save.execute({ title: "缺晚餐", days: [{ items: [{ name: "外滩" }] }] });
  await assert.rejects(
    () => validate.execute({ title: "缺晚餐", strict: true }),
    /行程质量校验未通过（strict）[\s\S]*没有安排晚餐/,
  );
});

test("save_itinerary: 校验非法输入与标题文件名", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-"));
  const save = createSaveItineraryTool(root);

  await assert.rejects(() => save.execute({ title: "空行程", days: [] }), /非空数组/);
  await assert.rejects(
    () => save.execute({ title: "缺名称", days: [{ items: [{ time: "09:00" }] }] }),
    /非空 name/,
  );

  // 标题里的路径分隔符与特殊字符被清理，不能越出 plans 目录
  await save.execute({ title: "../escape/../../etc", days: [{ items: [{ name: "x" }] }] });
  const files = await readdir(join(root, "plans"));
  assert.ok(files.includes("escapeetc.json"));
  assert.ok(files.every((name) => !name.startsWith(".")));
});

test("load_itinerary: 不存在时提示用 list 查看", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-"));
  const load = createLoadItineraryTool(root);

  const output = await load.execute({ title: "不存在的行程" });
  assert.match(output, /未找到行程「不存在的行程」/);
  assert.match(output, /list_itineraries/);
});
