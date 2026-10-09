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
        id: "lunch-2",
        type: "meal",
        subtype: "lunch",
        name: "绿茶餐厅",
        location: { latitude: 30.245, longitude: 120.145, source: "amap" },
        cost_per_person: 45,
        cuisine: "融合菜",
        source: "amap",
        confidence: "medium",
      },
      {
        id: "lunch-3",
        type: "meal",
        subtype: "lunch",
        name: "外婆家",
        location: { latitude: 30.25, longitude: 120.155, source: "amap" },
        cost_per_person: 60,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "medium",
      },
      {
        id: "lunch-4",
        type: "meal",
        subtype: "lunch",
        name: "楼外楼",
        location: { latitude: 30.247, longitude: 120.14, source: "amap" },
        cost_per_person: 150,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "medium",
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
        end_time: "16:30",
        type: "visit",
        name: "河坊街",
        location: { latitude: 30.243, longitude: 120.166, source: "amap" },
        opening_hours: { opens: "09:00", closes: "22:00", source: "official" },
        source: "amap",
        confidence: "high",
      },
      {
        id: "dinner-1",
        time: "17:30",
        end_time: "18:30",
        type: "meal",
        subtype: "dinner",
        name: "新白鹿",
        location: { latitude: 30.25, longitude: 120.16, source: "amap" },
        cost_per_person: 80,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "high",
      },
      {
        id: "dinner-2",
        type: "meal",
        subtype: "dinner",
        name: "弄堂里",
        location: { latitude: 30.252, longitude: 120.158, source: "amap" },
        cost_per_person: 65,
        cuisine: "杭帮菜",
        source: "amap",
        confidence: "medium",
      },
      {
        id: "dinner-3",
        type: "meal",
        subtype: "dinner",
        name: "奎元馆",
        location: { latitude: 30.248, longitude: 120.162, source: "amap" },
        cost_per_person: 55,
        cuisine: "面食",
        source: "amap",
        confidence: "medium",
      },
      {
        id: "dinner-4",
        type: "meal",
        subtype: "dinner",
        name: "西湖春天",
        location: { latitude: 30.253, longitude: 120.165, source: "amap" },
        cost_per_person: 110,
        cuisine: "粤菜",
        source: "amap",
        confidence: "medium",
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

test("save_itinerary: merge=true 按 date 合并（分天保存，其余天保留）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-merge-"));
  const save = createSaveItineraryTool(root);
  const load = createLoadItineraryTool(root);

  await save.execute({
    title: "合并测试",
    days: [
      { date: "2026-10-10", items: [{ type: "visit", name: "旧A" }] },
      { date: "2026-10-11", items: [{ type: "visit", name: "旧B" }] },
    ],
  });

  // 只更新第 2 天：第 1 天保持原样
  const output = await save.execute({
    title: "合并测试",
    merge: true,
    days: [{ date: "2026-10-11", items: [{ type: "visit", name: "新B" }] }],
  });
  assert.match(output, /合并保存/);
  const merged = JSON.parse(await load.execute({ title: "合并测试" }) as string);
  assert.equal(merged.days.length, 2);
  assert.equal(merged.days[0].items[0].name, "旧A");
  assert.equal(merged.days[1].items[0].name, "新B");

  // date 不存在 → 追加为新的一天
  await save.execute({
    title: "合并测试",
    merge: true,
    days: [{ date: "2026-10-12", items: [{ type: "visit", name: "新C" }] }],
  });
  const appended = JSON.parse(await load.execute({ title: "合并测试" }) as string);
  assert.equal(appended.days.length, 3);
  assert.equal(appended.days[2].items[0].name, "新C");

  // merge 但文件不存在 → 等价全新保存
  await save.execute({
    title: "全新合并",
    merge: true,
    days: [{ date: "2026-10-10", items: [{ type: "visit", name: "X" }] }],
  });
  const fresh = JSON.parse(await load.execute({ title: "全新合并" }) as string);
  assert.equal(fresh.days.length, 1);
  assert.equal(fresh.days[0].items[0].name, "X");
});

test("save_itinerary: 保存质量报告，strict 只拦截行程类 P1（餐饮建议不拦截）", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-itin-quality-"));
  const save = createSaveItineraryTool(root);
  const validate = createValidateItineraryTool(root);

  const output = await save.execute({ title: "杭州一日", days: COMPLETE_DAYS, budget_per_person_yuan: 200 });
  assert.match(output, /质量: 100 \/ 100/);
  assert.match(output, /P0 0 \/ P1 0 \/ P2 0/);
  assert.match(await readFile(join(root, "plans", "杭州一日.quality.md"), "utf8"), /状态: 通过/);
  assert.match(await validate.execute({ title: "杭州一日", strict: true, budget_per_person_yuan: 200 }), /状态: 通过/);

  // 只有餐饮问题（没有午餐/晚餐推荐）：strict 不拦截，单列"餐饮参考"
  const mealOnly = {
    days: [{
      date: "2026-10-10",
      items: [
        {
          time: "09:00", end_time: "11:00", type: "visit", name: "西湖公园",
          location: { latitude: 26.091, longitude: 119.2901 },
          opening_hours: { opens: "05:00", closes: "22:00" },
          source: "amap", confidence: "high",
        },
        {
          time: "12:00", end_time: "13:00", type: "rest", name: "午餐休整 · 候选餐厅自选",
          source: "amap", confidence: "high",
        },
        {
          time: "13:00", end_time: "15:00", type: "visit", name: "福建博物院",
          location: { latitude: 26.0945, longitude: 119.2897 },
          opening_hours: { opens: "09:00", closes: "17:00" },
          source: "amap", confidence: "high",
        },
      ],
    }],
  };
  const softOutput = await save.execute({ title: "餐饮提醒", ...mealOnly });
  assert.match(softOutput, /质量: 100 \/ 100/);
  assert.match(softOutput, /餐饮建议 2 条/);
  const soft = await validate.execute({ title: "餐饮提醒", strict: true });
  assert.match(soft, /状态: 通过/);
  assert.match(soft, /餐饮参考（不参与评分）/);
  assert.match(soft, /没有午餐推荐/);
  assert.match(soft, /没有晚餐推荐/);

  // 行程类 P1（景点缺游玩时长）：strict 仍然拦截
  await save.execute({ title: "行程硬伤", days: [{ items: [{ time: "09:00", type: "visit", name: "西湖公园" }] }] });
  await assert.rejects(
    () => validate.execute({ title: "行程硬伤", strict: true }),
    /行程质量校验未通过（strict）[\s\S]*缺少游玩时长/,
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
