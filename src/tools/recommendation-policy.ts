import type { Itinerary, ItineraryItem } from "./itinerary-schema.ts";

export const MIN_RECOMMENDATION_EVIDENCE_RATE = 0.8;
export const MEAL_SLOT_TARGET = 4;

/** Only facts observed by a first-party tool count; prose such as “评分待核实” never does. */
export function hasRecommendationEvidence(item: ItineraryItem): boolean {
  return item.evidence_verified === true && typeof item.evidence_id === "string" &&
    item.rating !== undefined && item.rating > 0 && item.rating <= 5 &&
    item.cost_per_person !== undefined && Number.isFinite(item.cost_per_person) && item.cost_per_person > 0;
}

/** 同一地点在一个餐次只计一次；不同坐标的同名分店仍是不同候选。 */
function distinctMeals(items: readonly ItineraryItem[]): ItineraryItem[] {
  const unique = new Map<string, ItineraryItem>();
  for (const item of items) {
    const located = item.location?.latitude !== undefined && item.location.longitude !== undefined;
    const key = located ? JSON.stringify([item.name, item.location!.latitude, item.location!.longitude]) : item.evidence_id ?? item.name;
    const previous = unique.get(key);
    // 重复项中存在未核验版本时不应靠复制已核验标记提高覆盖率。
    if (previous === undefined || !hasRecommendationEvidence(item)) unique.set(key, item);
  }
  return [...unique.values()];
}
export function recommendationCoverage(itinerary: Itinerary) {
  const meals = itinerary.days.flatMap((day) => distinctMeals(day.items.filter((item) => item.type === "meal")));
  const slots = itinerary.days.flatMap((day, index) => (["lunch", "dinner"] as const).map((subtype) => ({
    day: index + 1, subtype, count: distinctMeals(day.items.filter((item) => item.type === "meal" && item.subtype === subtype)).length,
  })));
  return { meals, slots, evidenceRate: meals.length === 0 ? 0 : meals.filter(hasRecommendationEvidence).length / meals.length };
}
