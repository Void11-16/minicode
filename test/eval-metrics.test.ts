import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../src/eval/cases.ts";
import { computeItineraryMetrics } from "../src/eval/metrics.ts";
import type { Itinerary, ItineraryItem } from "../src/tools/itinerary-schema.ts";

function meal(
  id: string,
  subtype: "lunch" | "dinner",
  name: string,
  cost: number,
  cuisine: string,
  note: string,
): ItineraryItem {
  return { id, type: "meal", subtype, name, cost_per_person: cost, cuisine, note };
}

function visit(id: string, name: string, time: string, endTime: string): ItineraryItem {
  return { id, type: "visit", name, time, end_time: endTime, planned_duration_min: 90 };
}

/** 固定样例：2 天；午餐/晚餐候选按预期分布，第 1 天有 180 分钟空档 */
function fixture(): Itinerary {
  return {
    title: "测试两日游",
    days: [
      {
        date: "2026-10-01",
        items: [
          visit("v1", "西湖", "09:00", "10:30"),
          meal("m1", "lunch", "本地小吃店", 30, "本地小吃", "4.6分｜人均¥30｜本地特色，好吃"),
          meal("m2", "lunch", "面馆", 60, "面馆", "4.5分｜人均¥60"),
          meal("m3", "lunch", "火锅店", 90, "火锅", "4.7分｜人均¥90"),
          meal("m4", "lunch", "日料店", 150, "日料", "4.8分｜人均¥150"),
          meal("m5", "dinner", "烧烤店", 40, "烧烤", "4.4分｜人均¥40"),
          meal("m6", "dinner", "私房菜", 200, "私房菜", "环境不错，朋友推荐"), // 无评分/人均 → 不算证据
          visit("v2", "灵隐寺", "13:30", "15:00"), // 与 10:30 之间空档 180 分钟
        ],
      },
      {
        date: "2026-10-02",
        items: [
          visit("v3", "博物馆", "09:30", "11:00"),
          meal("m7", "lunch", "杭帮菜馆", 45, "杭帮菜", "4.6分｜人均¥45｜本地特色"),
          meal("m8", "lunch", "粤菜馆", 70, "粤菜", "4.5分｜人均¥70"),
          meal("m9", "lunch", "川菜馆", 110, "川菜", "4.4分｜人均¥110"),
          meal("m10", "lunch", "西餐厅", 130, "西餐", "4.5分｜人均¥130"),
          meal("m11", "dinner", "小吃铺", 50, "小吃", "4.7分｜人均¥50"),
          meal("m12", "dinner", "粤菜酒楼", 80, "粤菜", "4.5分｜人均¥80"),
          meal("m13", "dinner", "川菜馆二店", 100, "川菜", "4.3分｜人均¥100"),
          meal("m14", "dinner", "高档餐厅", 160, "西餐", "4.8分｜人均¥160"),
        ],
      },
    ],
  };
}

test("评测指标：推荐证据、候选充足度、多样性、空档、预算", () => {
  const metrics = computeItineraryMetrics(fixture(), { expectedDays: 2 });

  // 硬校验接线：无 P0
  assert.equal(metrics.issueCounts.P0, 0);

  // 美食
  assert.equal(metrics.mealCandidates, 14);
  assert.ok(Math.abs(metrics.mealEvidenceRate - 13 / 14) < 1e-9, `证据率 ${metrics.mealEvidenceRate}`);
  assert.equal(metrics.mealSlotsTotal, 4);
  assert.equal(metrics.mealSlotsOk, 3);
  assert.equal(metrics.mealSlotsUnderStocked, 1);
  assert.equal(metrics.mealSlotsMissing, 0);
  assert.equal(metrics.cuisineDiversityAvg, 3.5);
  assert.equal(metrics.priceTierAvg, 2.75);
  assert.equal(metrics.localSpecialtySlots, 2);

  // 时间线 / 结构
  assert.equal(metrics.maxGapMinutes, 180);
  assert.equal(metrics.visitsPerDay, 1.5);
  assert.equal(metrics.routeIssueCount, 0);

  // 预算：未给预算 → 无比值
  assert.ok(metrics.costPerPerson > 0);
  assert.equal(metrics.budgetRatio, undefined);
});

test("评测指标：预算超支接线到校验器（budget-exceeded）", () => {
  const metrics = computeItineraryMetrics(fixture(), { expectedDays: 2, budgetPerPersonYuan: 1 });
  assert.ok(metrics.issueCodes.includes("budget-exceeded"));
  assert.ok(metrics.issueCounts.P1 > 0);
  assert.ok((metrics.budgetRatio ?? 0) > 1);
});

test("金标准样例文件：全部可加载且字段合法", async () => {
  const cases = await loadCases(join(import.meta.dirname, "..", "eval", "cases.json"));
  assert.equal(cases.length, 6);
  for (const item of cases) {
    assert.ok(item.id.length > 0);
    assert.ok(item.title.length > 0);
    assert.ok(item.days > 0);
    assert.ok(item.request.length > 0);
  }
  const ids = cases.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "样例 id 不应重复");
});

test("金标准样例文件：格式错误给出明确报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-eval-"));
  const file = join(dir, "cases.json");
  await writeFile(file, JSON.stringify([{ id: "x", title: "缺字段" }]), "utf8");
  await assert.rejects(() => loadCases(file), /缺少非空字符串字段 request/);
});
