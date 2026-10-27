/** 单程达到该距离时视为远郊日。 */
export const REMOTE_DAY_DISTANCE_KM = 40;
/** 距离数据缺失时，单段达到该时长也视为远郊日。 */
export const REMOTE_DAY_DURATION_MINUTES = 90;
/** 多段长通勤组合的识别阈值。 */
export const REMOTE_DAY_PAIRED_LEG_MINUTES = 60;
export const REMOTE_DAY_PAIRED_TOTAL_MINUTES = 150;
/** 第二个游览点允许偏离远郊主景点的最大距离。 */
export const REMOTE_DAY_NEARBY_KM = 20;

export const REMOTE_DAY_TEMPLATE =
  "远郊日模板：出现单程至少 40 公里，或距离未知时单程至少 90 分钟、两段以上 60 分钟且全天交通至少 150 分钟时，" +
  "当天只安排 1 个远郊主景点；最多追加距主景点 20 公里内、单程约 30 分钟内的 1 个轻量活动。" +
  "返回市区后不再增加景点，把原市区景点移到其他日期；不要用交通或长时间休息凑满当天。";

export interface TravelLegSignal {
  readonly distance_km?: number;
  readonly planned_duration_min?: number;
}

export function isRemoteDayTravel(legs: readonly TravelLegSignal[]): boolean {
  if (
    legs.some(
      (leg) =>
        (leg.distance_km ?? 0) >= REMOTE_DAY_DISTANCE_KM ||
        (leg.distance_km === undefined && (leg.planned_duration_min ?? 0) >= REMOTE_DAY_DURATION_MINUTES),
    )
  ) {
    return true;
  }
  const totalMinutes = legs.reduce((sum, leg) => sum + (leg.planned_duration_min ?? 0), 0);
  const longLegs = legs.filter(
    (leg) => leg.distance_km === undefined && (leg.planned_duration_min ?? 0) >= REMOTE_DAY_PAIRED_LEG_MINUTES,
  );
  return longLegs.length >= 2 && totalMinutes >= REMOTE_DAY_PAIRED_TOTAL_MINUTES;
}
