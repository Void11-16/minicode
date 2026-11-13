import type { Itinerary, ItineraryDay, ItineraryDayType } from "./itinerary-schema.ts";

/** 有明确末日或完整日期清单时，局部保存也能识别真正的末日。 */
export function itineraryDayRole(plan: Itinerary, day: Pick<ItineraryDay, "date" | "day_type">, index?: number): ItineraryDayType {
  const constraints = plan.constraints;
  if (day.day_type && day.day_type !== "full") return day.day_type;
  if (!constraints?.return_last_day) return "full";
  const expected = constraints.expected_days ?? plan.outline?.length ?? plan.days.length;
  if (expected < 2) return "full";
  if (constraints.end_date && day.date) return day.date === constraints.end_date ? "departure" : "full";
  if (constraints.start_date && day.date) {
    return Date.parse(day.date) - Date.parse(constraints.start_date) === (expected - 1) * 86_400_000 ? "departure" : "full";
  }
  if (day.date && plan.outline?.length === expected) {
    const dates = plan.outline.map((entry) => entry.date).sort();
    return day.date === dates.at(-1) ? "departure" : "full";
  }
  return index === expected - 1 ? "departure" : "full";
}
