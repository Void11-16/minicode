import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  briefForSessionTitle,
  BRIEF_TEMPLATE,
  createLoadTravelBriefTool,
  createSaveTravelBriefTool,
  listTravelBriefs,
  toolRoundsForBrief,
} from "../src/tools/brief.ts";

const BRIEF = {
  title: "杭州两日游",
  destination: "杭州",
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  travelers: 2,
  budgetTotalYuan: 3000,
  budgetPerMealYuan: 100,
  accommodation: "靠近西湖，500 元内",
  pace: "适中",
  mustVisit: ["灵隐寺", "西湖"],
  avoid: ["人多的网红店"],
  tastePreferences: "不吃辣、想尝试本地特色",
  notes: "带一位老人，节奏放慢",
};

test("save_travel_brief: 保存结构化需求单并输出确认摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-"));
  const save = createSaveTravelBriefTool(root);

  const output = await save.execute(BRIEF);

  assert.match(output, /需求单已保存/);
  assert.match(output, /- 目的地: 杭州/);
  assert.match(output, /- 日期: 2026-10-01 至 2026-10-02/);
  assert.match(output, /- 人数: 2 人/);
  assert.match(output, /- 单餐人均: ¥100/);
  assert.match(output, /- 必去: 灵隐寺、西湖/);
  assert.match(output, /确认后即可一步到位生成规划/);

  const saved = JSON.parse(await readFile(join(root, "plans", "briefs", "杭州两日游.json"), "utf8"));
  assert.equal(saved.destination, "杭州");
  assert.deepEqual(saved.mustVisit, ["灵隐寺", "西湖"]);
});

test("save/load 往返：缺省字段给默认值提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-"));
  const save = createSaveTravelBriefTool(root);
  const load = createLoadTravelBriefTool(root);

  const output = await save.execute({ title: "说走就走", destination: "上海" });
  assert.match(output, /- 日期: 未定（按当天推算）/);
  assert.match(output, /- 人数: 未填（按 2 人）/);
  assert.match(output, /- 单餐人均: 未填（不限制）/);

  const loaded = JSON.parse(await load.execute({ title: "说走就走" }) as string);
  assert.equal(loaded.title, "说走就走");
  assert.equal(loaded.destination, "上海");
  assert.equal(loaded.mustVisit, undefined);
});

test("save_travel_brief: 校验日期格式与正数", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-"));
  const save = createSaveTravelBriefTool(root);

  await assert.rejects(
    () => save.execute({ title: "x", destination: "杭州", startDate: "10月1日" }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => save.execute({ title: "x", destination: "杭州", budgetPerMealYuan: -5 }),
    /正数/,
  );
  await assert.rejects(
    () => save.execute({ title: "x", destination: "杭州", mustVisit: "灵隐寺" }),
    /字符串数组/,
  );
});

test("load_travel_brief: 不存在时提示目录位置", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-"));
  const output = await createLoadTravelBriefTool(root).execute({ title: "不存在" });
  assert.match(output, /未找到需求单「不存在」/);
  assert.match(output, /plans\/briefs\//);
});

test("BRIEF_TEMPLATE: 包含全部关键字段供用户填写", () => {
  for (const field of ["目的地", "出行日期", "人数", "总预算", "单餐人均", "口味偏好", "住宿偏好", "节奏", "必去", "避开", "其他"]) {
    assert.ok(BRIEF_TEMPLATE.includes(`${field}:`), `模板缺少 ${field}`);
  }
});

test("toolRoundsForBrief: 按行程天数放宽轮次预算（7 天明显多于 3 天）", () => {
  const three = toolRoundsForBrief({ title: "三日", destination: "杭州", startDate: "2026-10-01", endDate: "2026-10-03" }, 30);
  const seven = toolRoundsForBrief({ title: "七日", destination: "赤峰", startDate: "2026-10-20", endDate: "2026-10-26" }, 30);

  assert.ok(seven > three, `7 天(${seven}) 应比 3 天(${three}) 给更多轮次`);
  assert.ok(three >= 12 && seven <= 60, "轮次预算夹在 [12, 60]");
  // 没有日期无法估算 → 退回兜底值
  assert.equal(toolRoundsForBrief({ title: "x", destination: "上海" }, 30), 30);
  assert.equal(toolRoundsForBrief(null, 30), 30);
  // 紧凑/自驾需求给更多轮次，慢节奏给更少
  const tight = toolRoundsForBrief({ title: "x", destination: "赤峰", startDate: "2026-10-20", endDate: "2026-10-26", pace: "紧凑", notes: "自驾为主" }, 30);
  assert.ok(tight > seven);
  assert.ok(toolRoundsForBrief({ title: "x", destination: "赤峰", startDate: "2026-10-20", endDate: "2026-10-26", pace: "慢" }, 30) < seven);
});

test("briefForSessionTitle/listTravelBriefs: 会话文本匹配需求单，匹配不到取最近一份", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-"));
  const save = createSaveTravelBriefTool(root);
  await save.execute({ title: "杭州两日游", destination: "杭州" });
  await new Promise((resolve) => setTimeout(resolve, 10)); // 让 mtime 有先后（兜底取"最近一份"）
  await save.execute({ title: "赤峰七日游", destination: "赤峰", startDate: "2026-10-20", endDate: "2026-10-26" });

  const titles = (await listTravelBriefs(root)).map((brief) => brief.title).sort();
  assert.deepEqual(titles, ["杭州两日游", "赤峰七日游"]);

  const matched = await briefForSessionTitle(root, "帮我把赤峰七日游的第 3 天改轻松一点");
  assert.equal(matched?.title, "赤峰七日游");
  // 只提目的地也能匹配到对应的需求单（不必是最新的那份）
  assert.equal((await briefForSessionTitle(root, "我想去杭州玩两天"))?.title, "杭州两日游");
  // 会话里没提到任何需求单 → 退回最近保存的一份（一次会话通常只规划一个行程）
  assert.equal((await briefForSessionTitle(root, "随便聊聊"))?.destination, "赤峰");
  assert.equal(await briefForSessionTitle(await mkdtemp(join(tmpdir(), "minicode-brief-")), "空的"), null);
});
