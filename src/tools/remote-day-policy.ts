import { timeToMinutes } from "./itinerary-schema.ts";
/** 单程达到该距离时视为远郊日。 */
export const REMOTE_DAY_DISTANCE_KM = 40;
/** 距离数据缺失时，单段达到该时长也视为远郊日。 */
export const REMOTE_DAY_DURATION_MINUTES = 90;
/** 多段长通勤组合的识别阈值。 */
export const REMOTE_DAY_PAIRED_LEG_MINUTES = 60;
export const REMOTE_DAY_PAIRED_TOTAL_MINUTES = 150;
/** 远郊日附加轻量活动的建议距离，不作为硬性上限。 */
export const REMOTE_DAY_NEARBY_KM = 20;
/** 远郊单段允许更长通勤；硬时间约束仍照常核验。 */
export const DEFAULT_REMOTE_LEG_LIMIT_MINUTES = 240;

export const REMOTE_DAY_TEMPLATE =
  "远郊日模板：出现单程至少 40 公里，或距离未知时单程至少 90 分钟、两段以上 60 分钟且全天交通至少 150 分钟时，" +
  "建议以 1 个远郊主景点为主；可追加距主景点 20 公里内、单程约 30 分钟内的轻量活动，内部子点作为主景区推荐不独立计数。" +
  "返回市区后是否加点以真实交通、游览时长及可用时间为准；点数和距离仅作建议，不按热度豁免硬约束。单段通勤默认最多 240 分钟，可用 remote_leg_limit_min 调整；不要用交通或长时间休息凑满当天。";

export interface TravelLegSignal {
  readonly time?: string;
  readonly end_time?: string;
  readonly distance_km?: number;
  readonly planned_duration_min?: number;
}

function duration(leg: TravelLegSignal): number {
  return leg.time !== undefined && leg.end_time !== undefined ? timeToMinutes(leg.end_time) - timeToMinutes(leg.time) : leg.planned_duration_min ?? 0;
}

export function isRemoteDayTravel(legs: readonly TravelLegSignal[]): boolean {
  if (
    legs.some(
      (leg) =>
        (leg.distance_km ?? 0) >= REMOTE_DAY_DISTANCE_KM ||
        (leg.distance_km === undefined && duration(leg) >= REMOTE_DAY_DURATION_MINUTES),
    )
  ) {
    return true;
  }
  const totalMinutes = legs.reduce((sum, leg) => sum + duration(leg), 0);
  const longLegs = legs.filter(
    (leg) => leg.distance_km === undefined && duration(leg) >= REMOTE_DAY_PAIRED_LEG_MINUTES,
  );
  return longLegs.length >= 2 && totalMinutes >= REMOTE_DAY_PAIRED_TOTAL_MINUTES;
}
