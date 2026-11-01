import { timeToMinutes, type ItineraryDay, type ItineraryItem } from "./itinerary-schema.ts";

export interface TimelineGap { readonly from: ItineraryItem; readonly to: ItineraryItem; readonly minutes: number }
export function itemEndMinutes(item: ItineraryItem): number | undefined {
  if (item.time === undefined) return undefined;
  if (item.end_time !== undefined) return timeToMinutes(item.end_time);
  if (item.time !== undefined && item.planned_duration_min !== undefined) return timeToMinutes(item.time) + item.planned_duration_min;
  return undefined;
}

/** 餐厅只是候选；用餐必须由 rest/free_time 等实际时间块占位。重叠区间先取并集。 */
export function timelineGaps(day: ItineraryDay): TimelineGap[] {
  const items = day.items.filter((item) => item.type !== "meal" && item.time !== undefined && itemEndMinutes(item) !== undefined)
    .slice().sort((a, b) => timeToMinutes(a.time!) - timeToMinutes(b.time!));
  const gaps: TimelineGap[] = [];
  let previous: ItineraryItem | undefined;
  let end: number | undefined;
  for (const item of items) {
    const start = timeToMinutes(item.time!);
    if (previous !== undefined && end !== undefined && start > end) gaps.push({ from: previous, to: item, minutes: start - end });
    const nextEnd = itemEndMinutes(item);
    if (nextEnd === undefined) { previous = item; end = undefined; }
    else if (end === undefined || nextEnd >= end) { previous = item; end = nextEnd; }
  }
  return gaps;
}
export function availableDayWindow(day: ItineraryDay): readonly [number, number] {
  return [day.available_start === undefined ? 0 : timeToMinutes(day.available_start), day.available_end === undefined ? 1440 : timeToMinutes(day.available_end)];
}
