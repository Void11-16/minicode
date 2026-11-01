import { availableDayWindow } from "./itinerary-timeline.ts";
import { convertPoint } from "./coordinates.ts";
import type { Itinerary, ItineraryItem, MealSubtype } from "./itinerary-schema.ts";

export const MIN_RECOMMENDATION_EVIDENCE_RATE = 0.8;
export const MEAL_SLOT_TARGET = 2;
export type RecommendationMode = "off" | "advisory" | "strict";
export interface RecommendationPolicy { readonly mode: RecommendationMode; readonly minCandidates: number; readonly minEvidenceRate: number }
export function recommendationPolicy(itinerary: Itinerary): RecommendationPolicy {
  const c = itinerary.constraints;
  return { mode: c?.recommendation_mode ?? (c?.recommendations === false ? "off" : "advisory"),
    minCandidates: c?.meal_candidates_target ?? MEAL_SLOT_TARGET, minEvidenceRate: c?.meal_evidence_target ?? MIN_RECOMMENDATION_EVIDENCE_RATE };
}

export function formatRecommendationPolicy(policy: RecommendationPolicy): string {
  return `${{ off: "关闭推荐质量检查", advisory: "仅建议，不阻断整体", strict: "严格餐饮验收" }[policy.mode]}；每个适用午晚餐时段目标 ${policy.minCandidates} 家，评分及价格证据目标 ${Math.round(policy.minEvidenceRate * 100)}%`;
}

/** 同一来源地点、同一日期和餐段才计一次；混合坐标系统一后再判重。 */
export function distinctMeals(items: readonly ItineraryItem[]): ItineraryItem[] {
  const unique = new Map<string, ItineraryItem>();
  for (const item of items) {
    const location = item.location;
    const point = location?.latitude === undefined || location.longitude === undefined ? undefined : convertPoint({ latitude: location.latitude, longitude: location.longitude, crs: location.crs ?? (location.source === "amap" || location.source === "amap-resolved" ? "gcj02" : "wgs84") }, "wgs84");
    const name = item.name.replace(/[\s·•()（）\-—_]/g, "").toLowerCase();
    const key = point === undefined ? item.evidence_id ?? name : JSON.stringify([name, point.latitude.toFixed(5), point.longitude.toFixed(5)]);
    const previous = unique.get(key);
    if (previous === undefined || !hasRecommendationEvidence(item)) unique.set(key, item);
  }
  return [...unique.values()];
}
export function hasRecommendationEvidence(item: ItineraryItem): boolean {
  return item.evidence_verified === true && typeof item.evidence_id === "string" && item.evidence_id !== "" &&
    item.rating !== undefined && item.rating > 0 && item.rating <= 5 &&
    item.cost_per_person !== undefined && Number.isFinite(item.cost_per_person) && item.cost_per_person > 0;
}
export function recommendationCoverage(itinerary: Itinerary) {
  const slots = itinerary.days.flatMap((day, index) => {
    const [start, end] = availableDayWindow(day);
    return (["lunch", "dinner"] as const).filter((subtype) => {
      const [opens, closes] = subtype === "lunch" ? [660, 870] : [1020, 1290];
      return start < closes && end > opens;
    }).map((subtype) => {
      const items = distinctMeals(day.items.filter((item) => item.type === "meal" && item.subtype === subtype));
      return { day: index + 1, subtype, items, count: items.length };
    });
  });
  const meals = itinerary.days.flatMap((day) => (["breakfast", "lunch", "dinner", "snack", undefined] as const).flatMap((subtype: MealSubtype | undefined) => distinctMeals(day.items.filter((item) => item.type === "meal" && item.subtype === subtype))));
  return { meals, slots, evidenceRate: meals.length === 0 ? 0 : meals.filter(hasRecommendationEvidence).length / meals.length };
}
