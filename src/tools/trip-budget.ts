import type { Itinerary, ItineraryItem } from "./itinerary-schema.ts";
import { availableDayWindow, itemEndMinutes } from "./itinerary-timeline.ts";
import { distinctMeals, recommendationPolicy } from "./recommendation-policy.ts";
import { isConcreteStayName, normalizeStayReferences } from "./stay-policy.ts";
import { itineraryDayRole } from "./day-role.ts";

export const BUDGET_OVERRUN = 0.2;
const categories = ["stay", "transport", "meals", "visits"] as const;
type Category = typeof categories[number];
type Amounts = Record<Category, number>;
const labels: Record<Category, string> = { stay: "住宿", transport: "通勤", meals: "餐饮", visits: "景点" };
const money = (value: number) => Math.round(value * 100) / 100;
const empty = (): Amounts => ({ stay: 0, transport: 0, meals: 0, visits: 0 });
const sum = (values: Amounts) => categories.reduce((total, category) => total + values[category], 0);

export interface TripBudgetPlan {
  readonly target: number;
  readonly limit: number;
  readonly days: number;
  readonly travelers: number;
  readonly rooms: number;
  readonly nights: number;
  readonly allocation: Amounts;
  readonly roomPerNight?: number;
  readonly mealPerPerson: number;
  readonly transportPerPersonDay: number;
  readonly visitsPerPersonDay: number;
  readonly economy: boolean;
}

/** 分项按全团计，候选门槛再换算为每房每晚、单餐人均和每日人均。 */
export function allocateTripBudget(target: number, days: number, travelers: number, rooms: number, stays: boolean, overrun = BUDGET_OVERRUN): TripBudgetPlan {
  const nights = stays ? Math.max(0, days - 1) : 0;
  const economy = target / travelers / days <= 220;
  const stay = nights ? money(target * (economy ? .3 : .4)) : 0;
  const transport = money(target * (nights ? (economy ? .2 : .15) : .25));
  const meals = Math.min(money(target - stay - transport), money(target * (nights ? (economy ? .4 : .3) : .5)));
  const visits = money(Math.max(0, target - stay - transport - meals));
  return { target, limit: money(target * (1 + overrun)), days, travelers, rooms, nights, economy, allocation: { stay, transport, meals, visits },
    ...(nights ? { roomPerNight: money(stay / nights / rooms) } : {}), mealPerPerson: money(meals / days / travelers / 2),
    transportPerPersonDay: money(transport / days / travelers), visitsPerPersonDay: money(visits / days / travelers) };
}

export function budgetPlanText(plan: TripBudgetPlan): string {
  return `全团预算 ¥${money(plan.target)}，可接受上限 ¥${plan.limit}。分项：${categories.map((key) => `${labels[key]} ¥${plan.allocation[key]}`).join("、")}。候选参考：${plan.roomPerNight === undefined ? "" : `¥${plan.roomPerNight}/房/晚，`}¥${plan.mealPerPerson}/人/餐，通勤 ¥${plan.transportPerPersonDay}/人/天，景点 ¥${plan.visitsPerPersonDay}/人/天。${plan.economy ? "按穷游规划，优先青旅和经济住宿、公交地铁、小吃及免费景点。" : ""}`;
}

function mealPrices(items: readonly ItineraryItem[]): Map<string, number | undefined> {
  const meals = new Map<string, ItineraryItem[]>();
  for (const item of items) if (item.type === "meal") {
    const slot = item.subtype ?? "meal";
    const options = meals.get(slot) ?? [];
    options.push(item);
    meals.set(slot, options);
  }
  return new Map([...meals].map(([slot, options]) => {
    const prices = distinctMeals(options).flatMap((item) => item.cost_per_person === undefined ? [] : [item.cost_per_person]);
    return [slot, prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : undefined];
  }));
}

function dateIndex(date: string | undefined, fallback: number): number {
  const time = date === undefined ? NaN : Date.parse(date);
  return Number.isFinite(time) ? time / 86_400_000 : fallback;
}

/** 一晚只入账一次；同餐多个备选仍按一餐计算。旧文件显式的人均住宿费用保留。 */
function pricedDays(plan: Itinerary, travelers: number) {
  const paid = new Map<string, [number, number][]>();
  const coveredNights: [number, number][] = [];
  const days = plan.days.map((day, index) => {
    const amounts = empty(), meals = mealPrices(day.items);
    for (const price of meals.values()) amounts.meals += price ?? 0;
    for (const item of day.items) {
      if (item.type === "meal") continue;
      if (item.type === "accommodation" && item.room_price_per_night !== undefined) {
        const last = day.date !== undefined && plan.constraints?.end_date !== undefined ? day.date >= plan.constraints.end_date
          : index >= (plan.constraints?.expected_days ?? plan.days.length) - 1;
        const nights = itineraryDayRole(plan, day, index) === "departure" ? 0 : item.stay_nights ?? (last ? 0 : 1);
        if (!nights) continue;
        const start = dateIndex(day.date, index), end = start + nights;
        const key = JSON.stringify([item.name, item.location?.latitude, item.location?.longitude]);
        const earlier = paid.get(key) ?? [];
        let unpaid: [number, number][] = [[start, end]];
        for (const [a, b] of earlier) unpaid = unpaid.flatMap(([x, y]) => b <= x || a >= y ? [[x, y] as [number, number]]
          : [...(x < a ? [[x, a] as [number, number]] : []), ...(b < y ? [[b, y] as [number, number]] : [])]);
        const rooms = item.room_count ?? plan.room_count ?? Math.ceil(travelers / 2);
        amounts.stay += unpaid.reduce((total, [x, y]) => total + y - x, 0) * item.room_price_per_night * rooms / travelers;
        earlier.push([start, end]); paid.set(key, earlier);
        coveredNights.push([start, end]);
      } else {
        const category = item.type === "visit" ? "visits" : item.type === "accommodation" ? "stay" : "transport";
        amounts[category] += (item.cost_per_person ?? 0) + (item.ticket_price_per_person ?? 0);
        if (category === "stay" && item.cost_per_person !== undefined && item.stay_nights !== 0) {
          const start = dateIndex(day.date, index);
          coveredNights.push([start, start + (item.stay_nights ?? 1)]);
        }
      }
    }
    return { amounts, meals };
  });
  return { days, coveredNights };
}

export function recordedCostPerPerson(itinerary: Itinerary): number {
  const plan = normalizeStayReferences(itinerary);
  return pricedDays(plan, plan.travelers ?? 2).days.reduce((total, day) => total + sum(day.amounts), 0);
}

export interface TripBudgetDay {
  readonly day: number;
  readonly date?: string;
  readonly target: number;
  readonly projected: number;
  readonly gaps: readonly string[];
}
export interface TripBudgetReport {
  readonly plan: TripBudgetPlan;
  readonly categories: readonly { label: string; target: number; recorded: number; estimated: number }[];
  readonly recorded: number;
  readonly estimated: number;
  readonly projected: number;
  readonly status: "within" | "within_tolerance" | "over_limit";
  readonly days: readonly TripBudgetDay[];
}

/** 已录金额和规划估算以全团计。空白日期留预算；未知价格不写成免费或已核实。 */
export function tripBudgetReport(itinerary: Itinerary, perPerson: number | undefined, days: number): TripBudgetReport | undefined {
  if (!(perPerson && perPerson > 0 && days > 0)) return undefined;
  const itineraryPlan = normalizeStayReferences(itinerary);
  const travelers = itineraryPlan.travelers ?? 2, rooms = itineraryPlan.room_count ?? Math.ceil(travelers / 2);
  const plan = allocateTripBudget(money(perPerson * travelers), days, travelers, rooms, itineraryPlan.constraints?.require_accommodation !== false, itineraryPlan.budget_overrun_ratio);
  const actual = pricedDays(itineraryPlan, travelers), recorded = empty(), estimated = empty();
  const baseDate = itineraryPlan.constraints?.start_date;
  const reservedNights = actual.coveredNights.slice();
  const recommendMeals = recommendationPolicy(itineraryPlan).mode !== "off";
  const resultDays = itineraryPlan.days.map((day, index): TripBudgetDay => {
    const dayIndex = dateIndex(day.date, index);
    const offset = baseDate && day.date ? dayIndex - dateIndex(baseDate, 0) : index;
    const departure = itineraryDayRole(itineraryPlan, day, index) === "departure";
    const night = offset >= 0 && offset < plan.nights && !departure;
    const { amounts, meals } = actual.days[index]!, reserve = empty();
    const [start, availableEnd] = availableDayWindow(day), gaps: string[] = [];
    const scheduledEnd = Math.max(0, ...day.items.filter((item) => item.type !== "meal").map((item) => itemEndMinutes(item) ?? 0));
    const end = departure ? Math.min(availableEnd, scheduledEnd || availableEnd) : availableEnd;
    const roomTarget = night ? plan.allocation.stay / plan.nights : 0;
    const pricedNight = actual.coveredNights.some(([a, b]) => dayIndex >= a && dayIndex < b);
    if (night) {
      reservedNights.push([dayIndex, dayIndex + 1]);
      if (!pricedNight) reserve.stay = roomTarget;
    }
    if (night && !day.items.some((item) => item.type === "accommodation" && item.stay_nights !== 0 && isConcreteStayName(item.name))
      && !pricedNight) gaps.push("补选本晚住宿");
    const mealTarget = plan.allocation.meals / plan.days / 2;
    const slots = (["lunch", "dinner"] as const).filter((slot) => slot === "lunch" ? start < 870 && end > 660 : start < 1290 && end > 1020);
    let untyped = meals.has("meal");
    for (const slot of slots) {
      if (meals.has(slot)) { if (meals.get(slot) === undefined) reserve.meals += mealTarget; continue; }
      if (untyped) { untyped = false; if (meals.get("meal") === undefined) reserve.meals += mealTarget; continue; }
      reserve.meals += mealTarget;
      if (recommendMeals) gaps.push(slot === "lunch" ? "补午餐候选" : "补晚餐候选");
    }
    const visits = day.items.filter((item) => item.type === "visit");
    const routes = day.items.filter((item) => item.type === "transport" && item.transport_mode !== "walking");
    const transportTarget = plan.allocation.transport / plan.days, visitTarget = plan.allocation.visits / plan.days;
    if (routes.length) reserve.transport = transportTarget * routes.filter((item) => item.cost_per_person === undefined).length / routes.length;
    else if (!day.items.some((item) => item.type === "transport")) reserve.transport = transportTarget;
    reserve.visits = visits.length ? visitTarget * visits.filter((item) => item.ticket_price_per_person === undefined && item.cost_per_person === undefined).length / visits.length : departure && scheduledEnd > 0 ? 0 : visitTarget;
    for (const category of categories) { recorded[category] += amounts[category] * travelers; estimated[category] += reserve[category]; }
    return { day: index + 1, date: day.date, target: money(roomTarget + mealTarget * slots.length + transportTarget + visitTarget),
      projected: money(sum(amounts) * travelers + sum(reserve)), gaps };
  });
  const remaining = Math.max(0, days - resultDays.length);
  for (const category of ["transport", "meals", "visits"] as const) estimated[category] += plan.allocation[category] * remaining / days;
  if (remaining && plan.nights) {
    const first = dateIndex(baseDate ?? itineraryPlan.days[0]?.date, 0), last = first + plan.nights;
    let coveredUntil = first, coveredCount = 0;
    for (const [start, end] of reservedNights.sort((a, b) => a[0] - b[0])) {
      const uncoveredStart = Math.max(start, coveredUntil), clippedEnd = Math.min(end, last);
      if (clippedEnd > uncoveredStart) { coveredCount += clippedEnd - uncoveredStart; coveredUntil = clippedEnd; }
    }
    estimated.stay += (plan.nights - coveredCount) * plan.allocation.stay / plan.nights;
  }
  const projected = money(sum(recorded) + sum(estimated));
  return { plan, recorded: money(sum(recorded)), estimated: money(sum(estimated)), projected,
    status: projected > plan.limit ? "over_limit" : projected > plan.target ? "within_tolerance" : "within",
    categories: categories.map((key) => ({ label: labels[key], target: plan.allocation[key], recorded: money(recorded[key]), estimated: money(estimated[key]) })), days: resultDays };
}

export function budgetResultText(budget: TripBudgetReport): string {
  return `预算（全团）：预计 ¥${budget.projected}，已录费用 ¥${budget.recorded}，未定项目估算 ¥${budget.estimated}。目标 ¥${budget.plan.target}，上限 ¥${budget.plan.limit}，${{ within: "在目标内", within_tolerance: "在允许超支范围内", over_limit: "超出可接受上限" }[budget.status]}。`;
}
