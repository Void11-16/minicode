import type { Itinerary } from "../tools/itinerary-schema.ts";
import { materializedDay } from "../tools/itinerary-planning.ts";
import { requiredVisitGoals } from "../tools/required-visits.ts";

export interface DeliveryMetrics {
  readonly materializedDays: number;
  readonly requiredVisits: { readonly scheduled: number; readonly total: number };
  readonly visitEvidence: { readonly verified: number; readonly total: number };
  readonly routeEvidence: { readonly verified: number; readonly total: number };
}

/** 单纯读取产物中已有的时间线和证据标记，不用当前规则重评旧版本的分数或通过结果。 */
export function measureDelivery(plan: Itinerary, mustVisit: readonly string[], expectedDates?: readonly string[]): DeliveryMetrics {
  const days = expectedDates ? plan.days.filter((day) => day.date && expectedDates.includes(day.date)) : plan.days;
  const timedDays = days.filter(materializedDay);
  const distinctDates = new Set(timedDays.flatMap((day) => day.date ? [day.date] : []));
  const items = days.flatMap((day) => day.items);
  const visits = items.filter((item) => item.type === "visit"), routes = items.filter((item) => item.type === "transport");
  const goals = requiredVisitGoals({ ...plan, days, constraints: { ...plan.constraints, must_visit: mustVisit } });
  return {
    materializedDays: distinctDates.size + timedDays.filter((day) => !day.date).length,
    requiredVisits: { scheduled: goals.filter((goal) => goal.status === "scheduled").length, total: goals.length },
    visitEvidence: { verified: visits.filter((item) => item.evidence_verified === true).length, total: visits.length },
    routeEvidence: { verified: routes.filter((item) => item.route_verified === true).length, total: routes.length },
  };
}
