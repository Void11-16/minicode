import { timeToMinutes } from "../tools/itinerary-schema.ts";
import type { Itinerary, ItineraryItem, MealSubtype } from "../tools/itinerary-schema.ts";
import { totalCostPerPerson, validateItinerary } from "../tools/itinerary-validator.ts";
import type { ItineraryQualityStatus } from "../tools/itinerary-validator.ts";

/**
 * 行程质量评测指标 —— 离线评测骨架的核心。
 * 在 validate_itinerary 的硬校验之上，补充"推荐质量"的可量化口径：
 * 推荐证据覆盖率、候选充足度、价位/菜系多样性、时间空档、路线效率、预算达成。
 */

export interface EvalExpectations {
  readonly expectedDays: number;
  readonly budgetPerPersonYuan?: number;
}

export interface ItineraryEvalMetrics {
  // 硬校验（来自 validate_itinerary）
  readonly status: ItineraryQualityStatus;
  readonly score: number;
  readonly issueCounts: { readonly P0: number; readonly P1: number; readonly P2: number };
  readonly issueCodes: readonly string[];
  // 结构
  readonly days: number;
  readonly expectedDays: number;
  readonly visitsPerDay: number;
  // 美食推荐质量
  readonly mealCandidates: number;
  /** note 里同时有评分与人均价格才算"有依据"，0-1 */
  readonly mealEvidenceRate: number;
  readonly mealSlotsTotal: number;
  readonly mealSlotsOk: number;
  readonly mealSlotsUnderStocked: number;
  readonly mealSlotsMissing: number;
  readonly cuisineDiversityAvg: number;
  readonly priceTierAvg: number;
  readonly localSpecialtySlots: number;
  // 时间线
  readonly maxGapMinutes: number;
  // 空间/路线
  readonly routeIssueCount: number;
  // 预算
  readonly costPerPerson: number;
  readonly budgetPerPersonYuan: number | undefined;
  readonly budgetRatio: number | undefined;
}

/** 推荐证据：note 同时包含"评分/口碑分"和"人均/价格"才算有依据 */
const RATING_EVIDENCE = /(?:评分|\d(?:\.\d+)?\s*分)/;
const PRICE_EVIDENCE = /(?:人均|均价|¥\s*\d)/;
const LOCAL_SPECIALTY = /本地/;
/** 路线效率类问题码（顺路程度相关） */
const ROUTE_ISSUE_CODES = new Set([
  "route-backtracking",
  "spatial-gap",
  "transfer-too-tight",
  "long-transport",
]);
/** 午餐/晚餐候选数达标线（与校验器 few-meal-options 的口径一致） */
const MEAL_SLOT_TARGET = 4;

export function computeItineraryMetrics(
  itinerary: Itinerary,
  expectations: EvalExpectations,
): ItineraryEvalMetrics {
  const report = validateItinerary(
    itinerary,
    expectations.budgetPerPersonYuan === undefined
      ? {}
      : { budget_per_person_yuan: expectations.budgetPerPersonYuan },
  );

  const slots = collectMealSlots(itinerary);
  const meals = itinerary.days.flatMap((day) => day.items.filter((item) => item.type === "meal"));
  const evidenceCount = meals.filter(hasRecommendationEvidence).length;
  const visitCount = itinerary.days.reduce(
    (sum, day) => sum + day.items.filter((item) => item.type === "visit").length,
    0,
  );
  const cost = totalCostPerPerson(itinerary);

  return {
    status: report.status,
    score: report.score,
    issueCounts: report.issue_count,
    issueCodes: [...new Set(report.issues.map((issue) => issue.code))],
    days: itinerary.days.length,
    expectedDays: expectations.expectedDays,
    visitsPerDay: itinerary.days.length === 0 ? 0 : visitCount / itinerary.days.length,
    mealCandidates: meals.length,
    mealEvidenceRate: meals.length === 0 ? 0 : evidenceCount / meals.length,
    mealSlotsTotal: itinerary.days.length * 2,
    mealSlotsOk: slots.filter((slot) => slot.items.length >= MEAL_SLOT_TARGET).length,
    mealSlotsUnderStocked: slots.filter((slot) => slot.items.length > 0 && slot.items.length < MEAL_SLOT_TARGET).length,
    mealSlotsMissing: Math.max(0, itinerary.days.length * 2 - slots.length),
    cuisineDiversityAvg: average(slots.map((slot) => distinctCuisines(slot.items))),
    priceTierAvg: average(slots.map((slot) => distinctPriceTiers(slot.items))),
    localSpecialtySlots: slots.filter((slot) =>
      slot.items.some((item) => LOCAL_SPECIALTY.test(`${item.cuisine ?? ""} ${item.note ?? ""}`)),
    ).length,
    maxGapMinutes: maxTimelineGapMinutes(itinerary),
    routeIssueCount: report.issues.filter((issue) => ROUTE_ISSUE_CODES.has(issue.code)).length,
    costPerPerson: cost,
    budgetPerPersonYuan: expectations.budgetPerPersonYuan,
    budgetRatio:
      expectations.budgetPerPersonYuan === undefined || expectations.budgetPerPersonYuan <= 0
        ? undefined
        : cost / expectations.budgetPerPersonYuan,
  };
}

interface MealSlot {
  readonly subtype: MealSubtype;
  readonly items: ItineraryItem[];
}

/** 只统计午餐/晚餐时段（早餐/小吃是补充，不作为候充足度口径） */
function collectMealSlots(itinerary: Itinerary): MealSlot[] {
  const slots: MealSlot[] = [];
  for (const day of itinerary.days) {
    for (const subtype of ["lunch", "dinner"] as const) {
      const items = day.items.filter((item) => item.type === "meal" && item.subtype === subtype);
      if (items.length > 0) slots.push({ subtype, items });
    }
  }
  return slots;
}

function hasRecommendationEvidence(item: ItineraryItem): boolean {
  const note = item.note ?? "";
  return RATING_EVIDENCE.test(note) && PRICE_EVIDENCE.test(note);
}

/** 价位档：经济 ≤50 / 中档 ≤120 / 高档 >120，返回该时段覆盖的档数 */
function distinctPriceTiers(items: readonly ItineraryItem[]): number {
  const tiers = new Set<number>();
  for (const item of items) {
    if (item.cost_per_person === undefined) continue;
    tiers.add(item.cost_per_person <= 50 ? 0 : item.cost_per_person <= 120 ? 1 : 2);
  }
  return tiers.size;
}

function distinctCuisines(items: readonly ItineraryItem[]): number {
  const cuisines = new Set<string>();
  for (const item of items) {
    if (item.cuisine !== undefined && item.cuisine !== "") cuisines.add(item.cuisine);
  }
  return cuisines.size;
}

/** 相邻定时条目之间的最大空档（分钟）；重叠（负值）不计入 */
function maxTimelineGapMinutes(itinerary: Itinerary): number {
  let maxGap = 0;
  for (const day of itinerary.days) {
    const timed = day.items
      .filter((item): item is ItineraryItem & { time: string } => item.time !== undefined)
      .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    for (let index = 1; index < timed.length; index++) {
      const previousEnd = endMinutes(timed[index - 1]);
      if (previousEnd === undefined) continue;
      const gap = timeToMinutes(timed[index].time) - previousEnd;
      if (gap > maxGap) maxGap = gap;
    }
  }
  return maxGap;
}

function endMinutes(item: ItineraryItem & { time: string }): number | undefined {
  if (item.end_time !== undefined) return timeToMinutes(item.end_time);
  if (item.planned_duration_min !== undefined) return timeToMinutes(item.time) + item.planned_duration_min;
  return undefined;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
