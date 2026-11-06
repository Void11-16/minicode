import { scenicVisitKey } from "../tools/scenic-area.ts";
import { timelineGaps } from "../tools/itinerary-timeline.ts";
import { recommendationCoverage, recommendationPolicy } from "../tools/recommendation-policy.ts";
import type { Itinerary, ItineraryItem } from "../tools/itinerary-schema.ts";
import { totalCostPerPerson, validateItinerary } from "../tools/itinerary-validator.ts";
import type { ItineraryQualityStatus } from "../tools/itinerary-validator.ts";

/**
 * 行程质量评测指标 —— 离线评测骨架的核心。
 * 在 validate_itinerary 的硬校验之上，补充"推荐质量"的可量化口径：
 * 推荐证据覆盖率、候选充足度、价位/菜系多样性、时间空档、路线效率、预算达成。
 */

export interface EvalExpectations {
  readonly expectedDays: number;
  readonly mustVisit?: readonly string[];
  readonly budgetPerPersonYuan?: number;
}

export interface ItineraryEvalMetrics {
  // 硬校验（来自 validate_itinerary）
  readonly status: ItineraryQualityStatus;
  readonly score: number;
  readonly scoreVersion?: string;
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

const LOCAL_SPECIALTY = /本地/;
/** 路线效率类问题码（顺路程度相关） */
const ROUTE_ISSUE_CODES = new Set([
  "route-backtracking",
  "spatial-gap",
  "transfer-too-tight",
  "long-transport",
  "remote-day-overpacked",
]);

export function computeItineraryMetrics(
  itinerary: Itinerary,
  expectations: EvalExpectations,
): ItineraryEvalMetrics {
  const validated = { ...itinerary, constraints: { ...itinerary.constraints, expected_days: expectations.expectedDays,
    must_visit: [...new Set([...(itinerary.constraints?.must_visit ?? []), ...(expectations.mustVisit ?? [])])] } };
  const report = validateItinerary(validated, expectations.budgetPerPersonYuan === undefined ? {} : { budget_per_person_yuan: expectations.budgetPerPersonYuan });
  const expectedDayMismatch = itinerary.days.length !== expectations.expectedDays;
  const issueCounts = report.issue_count;
  const score = report.score;

  const coverage = recommendationCoverage(itinerary);
  const slots = coverage.slots;
  const meals = coverage.meals;
  const target = recommendationPolicy(itinerary).minCandidates;
  const visitCount = itinerary.days.reduce(
    (sum, day) => sum + new Set(day.items.filter((item) => item.type === "visit").map((item) => scenicVisitKey(item.name, item.parent_visit?.name))).size,
    0,
  );
  const cost = totalCostPerPerson(itinerary);

  return {
    status: report.status,
    score,
    scoreVersion: report.score_version,
    issueCounts,
    issueCodes: [
      ...new Set([
        ...report.issues.flatMap((issue) => [issue.code, ...(issue.related_codes ?? [])]),
        ...(expectedDayMismatch ? ["expected-day-count-mismatch"] : []),
      ]),
    ],
    days: itinerary.days.length,
    expectedDays: expectations.expectedDays,
    visitsPerDay: itinerary.days.length === 0 ? 0 : visitCount / itinerary.days.length,
    mealCandidates: meals.length,
    mealEvidenceRate: coverage.evidenceRate,
    mealSlotsTotal: slots.length,
    mealSlotsOk: slots.filter((slot) => slot.items.length >= target).length,
    mealSlotsUnderStocked: slots.filter((slot) => slot.items.length > 0 && slot.items.length < target).length,
    mealSlotsMissing: slots.filter((slot) => slot.items.length === 0).length,
    cuisineDiversityAvg: average(slots.map((slot) => distinctCuisines(slot.items))),
    priceTierAvg: average(slots.map((slot) => distinctPriceTiers(slot.items))),
    localSpecialtySlots: slots.filter((slot) =>
      slot.items.some((item) => LOCAL_SPECIALTY.test(`${item.cuisine ?? ""} ${item.note ?? ""}`)),
    ).length,
    maxGapMinutes: Math.max(0, ...itinerary.days.flatMap(timelineGaps).map((gap) => gap.minutes)),
    routeIssueCount: report.issues.filter((issue) => ROUTE_ISSUE_CODES.has(issue.code)).length,
    costPerPerson: cost,
    budgetPerPersonYuan: expectations.budgetPerPersonYuan,
    budgetRatio:
      expectations.budgetPerPersonYuan === undefined || expectations.budgetPerPersonYuan <= 0
        ? undefined
        : cost / expectations.budgetPerPersonYuan,
  };
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

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
