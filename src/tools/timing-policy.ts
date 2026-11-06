import type { ItineraryConstraints } from "./itinerary-schema.ts";

/** 日程边界是参考目标；超过整段窗口四分之一才视为明显未排满。 */
export function dayBoundarySeverity(shortfall: number, windowMinutes: number): "P1" | "P2" | undefined {
  if (shortfall <= 30) return undefined;
  return shortfall > Math.max(30, windowMinutes * .25) ? "P1" : "P2";
}

export const ACTIVE_TARGET_MINUTES = 600;
/** 活动含通勤、不含吃饭休息；小幅超出只提醒，超过目标20%才要求调整。 */
export function activeDurationSeverity(minutes: number): "P1" | "P2" | undefined {
  if (minutes <= ACTIVE_TARGET_MINUTES) return undefined;
  return minutes > ACTIVE_TARGET_MINUTES * 1.2 ? "P1" : "P2";
}

/** 同时限制绝对分钟差和相对比例，不能用5分钟容差吞掉短途的一大半。 */
export function routeTimingTolerance(minutes: number, constraints?: ItineraryConstraints): number {
  return Math.min(constraints?.route_tolerance_min ?? 5, minutes * (constraints?.route_tolerance_ratio ?? .1));
}
