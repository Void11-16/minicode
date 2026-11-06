import { normalizeStayReferences, compatibleStay } from "./stay-policy.ts";
import { routeQueryHint } from "./route-request.ts";
import { alignRouteContext } from "./itinerary-route-context.ts";
import { sameVisit, visitAssignments, materializedDay } from "./itinerary-planning.ts";
import { repeatVisitAllowed } from "./repeat-visit-policy.ts";
import { routeTimingTolerance, dayBoundarySeverity, activeDurationSeverity, ACTIVE_TARGET_MINUTES } from "./timing-policy.ts";
import { scenicVisitKey } from "./scenic-area.ts";
import { createHash } from "node:crypto";
import { requiredVisitIssues } from "./required-visits.ts";
import { CLOSURE_POLICY_VERSION } from "./closure-policy.ts";
import { availableDayWindow, timelineGaps, itemEndMinutes } from "./itinerary-timeline.ts";
import { QUALITY_SCORING_VERSION, aggregateIssues, qualityStatus, opportunityScore, issueCounts, type OpportunityScore } from "./itinerary-assessment.ts";
import { convertPoint } from "./coordinates.ts";
import {
  timeToMinutes,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
} from "./itinerary-schema.ts";
import { recommendationCoverage, recommendationPolicy, distinctMeals, formatRecommendationPolicy, type RecommendationPolicy } from "./recommendation-policy.ts";
import { isRemoteDayTravel, REMOTE_DAY_NEARBY_KM, DEFAULT_REMOTE_LEG_LIMIT_MINUTES } from "./remote-day-policy.ts";

export type QualityIssueLevel = "P0" | "P1" | "P2";
export type ItineraryQualityStatus = "ok" | "needs_confirmation" | "needs_revision" | "invalid";

export interface QualityIssue {
  readonly level: QualityIssueLevel;
  readonly code: string;
  readonly message: string;
  readonly day?: number;
  readonly item_id?: string;
  readonly kind?: "error" | "pending" | "advice";
  readonly related_days?: readonly number[];
  readonly related_item_ids?: readonly string[];
  readonly related_codes?: readonly string[];
  readonly root_key?: string;
}

export interface ItineraryQualityReport {
  readonly title: string;
  readonly generated_at: string;
  /** 行程质量状态：只由行程类问题决定（餐饮建议不参与） */
  readonly status: ItineraryQualityStatus;
  readonly score: number;
  readonly score_version?: typeof QUALITY_SCORING_VERSION;
  readonly source_signature?: string;
  readonly recommendation_policy?: RecommendationPolicy;
  readonly scoring?: OpportunityScore;
  readonly daily?: readonly DayQualityReport[];
  readonly changed_days?: readonly number[];
  readonly affected_days?: readonly number[];
  readonly repair_days?: readonly number[];
  /** 行程类问题计数（决定状态与评分，不含餐饮建议） */
  readonly issue_count: {
    readonly P0: number;
    readonly P1: number;
    readonly P2: number;
  };
  /** 行程类问题：时间线/路线/闭馆/重复等（决定状态与评分） */
  readonly issues: readonly QualityIssue[];
  /**
   * 餐饮参考建议（不参与状态/评分）：餐厅只是沿途候选，选哪家看当天想法；
   * 这里只做提示性检查（如某餐段没有推荐、候选合并成一条等），不拦截交付
   */
  readonly meal_notes: readonly QualityIssue[];
}

export interface DayQualityReport {
  readonly day: number;
  readonly status: ItineraryQualityStatus;
  readonly score: number;
  readonly strict_pass: boolean;
  readonly issues: readonly QualityIssue[];
}

export interface ValidateItineraryOptions {
  readonly budget_per_person_yuan?: number;
  readonly changed_days?: readonly number[];
}

const LONG_TRANSPORT_MINUTES = 60;
/**
 * 60 分钟只是“需要确认缓冲”的提示线，不能把北京去八达岭这类正常远郊行程判为失败；
 * 普通城市日超过 150 分钟阻断；远郊日使用独立的可配置单段上限。
 */
const EXTREME_TRANSPORT_MINUTES = 150;
/** 相邻定时条目之间允许的最大空档：超过视为"未规划"（游玩/用餐/休息/交通没排完整） */
const MAX_TIMELINE_GAP_MINUTES = 90;
/** 赶路时间核验：小于该距离的相邻停留点不检查（步行几分钟内不算问题） */
const MIN_TRANSFER_DISTANCE_KM = 0.25;
/** 赶路估算：步行 4.5km/h ≈ 13.3 分钟/公里；驾车 30km/h ≈ 2 分钟/公里 */
const WALKING_MINUTES_PER_KM = 13.3;
const DRIVING_MINUTES_PER_KM = 2;
const MEAL_WINDOWS: Record<string, readonly [number, number]> = {
  breakfast: [360, 630],
  lunch: [660, 870],
  dinner: [1020, 1290],
};

export function validateItinerary(
  itinerary: Itinerary,
  options: ValidateItineraryOptions = {},
): ItineraryQualityReport {
  const sourceSignature = qualitySourceSignature(itinerary);
  itinerary = normalizeStayReferences(itinerary);
  itinerary = { ...itinerary, days: itinerary.days.map((day) => alignRouteContext(day, itinerary.constraints?.destination)) };
  // 空间算法统一用 WGS84；持久化数据仍保留原始供应商坐标及坐标系。
  itinerary = { ...itinerary, days: itinerary.days.map((day) => ({ ...day, items: day.items.map((item) => {
    const location = item.location;
    if (location?.latitude === undefined || location.longitude === undefined) return item;
    return { ...item, location: { ...location, ...convertPoint({ latitude: location.latitude, longitude: location.longitude, crs: location.crs ?? (location.source === "amap" || location.source === "amap-resolved" ? "gcj02" : "wgs84") }, "wgs84") } };
  }) })) };
  const issues = itinerary.days.flatMap((day, index) => validateDay(day, index + 1, itinerary.constraints?.remote_leg_limit_min));

  // 早餐候选与"当天起点"的距离核验（需要前一天的信息，故在跨天层面检查）
  itinerary.days.forEach((_, index) => {
    issues.push(...breakfastAnchorIssues(itinerary.days, index, index + 1));
  });

  // 主子点共享占用；重游须有程序保存的用户原文授权，模型的说明不能豁免。
  const visitGroups: { day: number; item: ItineraryItem }[][] = [];
  itinerary.days.forEach((day, index) => {
    for (const item of day.items.filter((item) => item.type === "visit")) {
      const group = visitGroups.find((candidate) => sameVisit(candidate[0]!.item, item, itinerary.constraints?.destination));
      if (group) group.push({ day: index + 1, item });
      else visitGroups.push([{ day: index + 1, item }]);
    }
  });
  for (const occurrences of visitGroups) {
    const name = occurrences[0]!.item.name;
    const days = [...new Set(occurrences.map((entry) => entry.day))];
    for (const day of days) {
      const sameDay = occurrences.filter((entry) => entry.day === day);
      if (new Set(sameDay.map((entry) => entry.item.name)).size > 1 && sameDay.some((entry) => entry.item.parent_visit || scenicVisitKey(entry.item.name) !== entry.item.name)) issues.push({ ...issue("P1", "duplicate-scenic-visit", `同一主景区被拆为独立景点：${sameDay.map((entry) => entry.item.name).join("、")}；保留主景区条目，子点放recommended_spots内部推荐，不另占景点/路线名额`, day, sameDay.at(-1)!.item.id), kind: "error", related_item_ids: sameDay.map((entry) => entry.item.id) });
    }
    if (days.length < 2) continue;
    if (occurrences.filter((entry) => entry.day !== days[0]).every((entry) => repeatVisitAllowed(itinerary, entry.item))) continue;
    const changed = days.filter((day) => options.changed_days?.includes(day));
    const repairDay = changed.at(-1) ?? days.at(-1)!;
    const identified = occurrences.every((entry) => entry.item.location?.latitude !== undefined && entry.item.location.longitude !== undefined)
      || occurrences.every((entry) => entry.item.evidence_verified && entry.item.evidence_id !== undefined && entry.item.evidence_id === occurrences[0]!.item.evidence_id);
    issues.push({ ...issue("P1", "cross-day-duplicate", `${name} 在第 ${days.join("、")} 天${identified ? "重复安排" : "存在同名地点，需确认是否重复"}；优先处理本次变动的第 ${repairDay} 天，保留其他日期`, repairDay,
      occurrences.find((entry) => entry.day === repairDay)?.item.id), kind: identified ? "error" : "pending", related_days: days, related_item_ids: occurrences.map((entry) => entry.item.id) });
  }
  itinerary.days.forEach((day, index) => {
    if (index === 0) return;
    const previousDay = itinerary.days[index - 1]!;
    const previousDate = previousDay.date === undefined ? NaN : Date.parse(previousDay.date);
    const date = day.date === undefined ? NaN : Date.parse(day.date);
    if (Number.isFinite(previousDate) && Number.isFinite(date) && date <= previousDate) issues.push(issue("P1", "date-out-of-order", "行程日期必须按实际出行顺序递增", index + 1));
    const stops = (items: readonly ItineraryItem[]) => items.filter((item) => ["visit", "accommodation", "rest"].includes(item.type) && item.time !== undefined && item.location?.latitude !== undefined && item.location.longitude !== undefined).slice().sort((a, b) => a.time!.localeCompare(b.time!));
    const from = stops(previousDay.items).at(-1), to = stops(day.items)[0];
    if (!from || !to) return;
    const distance = haversineKm(from.location!.latitude!, from.location!.longitude!, to.location!.latitude!, to.location!.longitude!);
    const calendarMinutes = Number.isFinite(date) && Number.isFinite(previousDate) && date > previousDate ? (date - previousDate) / 60000 : 1440;
    const available = calendarMinutes + timeToMinutes(to.time!) - (itemEndMinutes(from) ?? timeToMinutes(from.time!));
    if (distance < MIN_TRANSFER_DISTANCE_KM || available >= distance * DRIVING_MINUTES_PER_KM * 0.5) return;
    const changed = [index, index + 1].filter((dayNo) => options.changed_days?.includes(dayNo));
    const repairDay = changed.at(-1) ?? index + 1;
    issues.push({ ...issue("P1", "overnight-transfer-unverified", `${from.name} 到次日 ${to.name} 相距约 ${Math.round(distance)} 公里，仅有 ${available} 分钟；需核对跨天交通方式与预留时间，优先局部调整第 ${repairDay} 天`, repairDay, to.id), kind: "pending", related_days: [index, index + 1] });
  });
  // 标题「N日游」是明确的需求口径，天数不足通常意味着分批保存尚未完成。
  // 若降为 P2，2/5 天的半成品也会通过 strict，这正是热门长行程最容易出现的假通过。
  const titleDays = itinerary.constraints?.expected_days ?? expectedDaysFromTitle(itinerary.title) ?? (itinerary.outline?.length || undefined);
  if (titleDays !== undefined && titleDays !== itinerary.days.length) {
    issues.push(
      issue(
        "P1",
        "title-day-mismatch",
        itinerary.days.length < titleDays
          ? `标题为${titleDays}日游，实际仅排了 ${itinerary.days.length} 天：请补齐缺失日期；` +
            "若用户已明确缩短行程，再同步修改标题"
          : `标题为${titleDays}日游，实际排了 ${itinerary.days.length} 天：请核对是否多排了行程日，` +
            "或同步修正标题",
      ),
    );
  }
  const totalCost = totalCostPerPerson(itinerary);
  const budget = options.budget_per_person_yuan ?? itinerary.budget_per_person_yuan;
  if (budget !== undefined && totalCost > budget) {
    issues.push(
      issue("P1", "budget-exceeded", `人均预估花费 ¥${totalCost}，超过预算 ¥${budget}`),
    );
  }

  issues.push(...deliveryIssues(itinerary));
  const assignments = visitAssignments(itinerary), city = itinerary.constraints?.destination;
  const allocationGroups: typeof assignments[] = [];
  for (const entry of assignments) { const group = allocationGroups.find((items) => sameVisit(items[0]!, entry, city)); if (group) group.push(entry); else allocationGroups.push([entry]); }
  for (const group of allocationGroups) if (new Set(group.map((v) => v.date)).size > 1 && group.some((v) => v.status === "reserved") && !group.slice(1).every((v) => repeatVisitAllowed(itinerary, v))) issues.push(issue("P1", "visit-allocation-conflict", `「${group[0]!.name}」在 ${[...new Set(group.map((v) => v.date))].join("、")} 重复占用，请只修改冲突条目或显式移动；repeat_reason不是用户授权`));
  for (const day of itinerary.outline ?? []) {
    const actual = itinerary.days.find((entry) => entry.date === day.date);
    if (!actual || !materializedDay(actual)) issues.push(issue("P1", "unmaterialized-outline-day", `粗排 ${day.date} 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐`));
    for (const visit of day.visits) {
      if (actual && materializedDay(actual) && !actual.items.some((item) => item.type === "visit" && sameVisit(item, visit, city))) issues.push(issue("P1", "unfulfilled-reservation", `${day.date} 预留「${visit.name}」尚未安排；补充该景点或同步调整粗排`, itinerary.days.indexOf(actual) + 1));
    }
  }
  if (itinerary.outline?.length && titleDays !== undefined && itinerary.outline.length !== titleDays) issues.push(issue("P1", "outline-day-count-mismatch", `粗排 ${itinerary.outline.length}/${titleDays} 天，请先补齐全局分配，不能把粗排算作已完成`));
  if (itinerary.outline?.some((day) => (itinerary.constraints?.start_date !== undefined && day.date < itinerary.constraints.start_date) || (itinerary.constraints?.end_date !== undefined && day.date > itinerary.constraints.end_date))) issues.push(issue("P1", "outline-date-outside-request", "粗排包含需求日期范围之外的日期，请只调整相关预留"));
  for (const excluded of itinerary.excluded_visits ?? []) if (assignments.some((entry) => sameVisit(entry, excluded, city))) issues.push(issue("P1", "excluded-visit-assigned", `「${excluded.name}」已明确排除（${excluded.reason}），仍被预留或安排`));
  issues.push(...requiredVisitIssues(itinerary));
  // 餐饮默认仅作建议，显式严格策略才进入正式验收。
  const itineraryIssues = aggregateIssues(issues.filter((item) => !isMealNote(item)).map(plainIssue), itinerary);
  const mealNotes = recommendationPolicy(itinerary).mode === "off" ? [] : issues.filter(isMealNote).map(plainIssue);
  const counts = issueCounts(itineraryIssues);
  const scoring = opportunityScore(itinerary, itineraryIssues, titleDays);
  const daily = itinerary.days.map((_, index): DayQualityReport => {
    const day = index + 1;
    const relevant = itineraryIssues.filter((item) => item.day === day);
    const own = issueCounts(relevant);
    return { day, status: qualityStatus(relevant), score: opportunityScore(itinerary, relevant, undefined, day).score,
      strict_pass: own.P0 === 0 && own.P1 === 0, issues: relevant };
  });
  const changed = options.changed_days ?? itinerary.days.map((_, index) => index + 1);
  const affected = new Set(changed.flatMap((day) => [day - 1, day, day + 1]).filter((day) => day >= 1 && day <= itinerary.days.length));
  for (const item of itineraryIssues) if (item.related_days?.some((day) => affected.has(day))) item.related_days.forEach((day) => affected.add(day));
  const repairs = new Set(itineraryIssues.filter((item) => item.level !== "P2" && item.day !== undefined).map((item) => item.day!));
  return { title: itinerary.title, generated_at: new Date().toISOString(), status: qualityStatus(itineraryIssues),
    score: scoring.score, score_version: QUALITY_SCORING_VERSION, source_signature: sourceSignature, recommendation_policy: recommendationPolicy(itinerary), scoring, issue_count: counts,
    issues: itineraryIssues, meal_notes: mealNotes, daily,
    changed_days: [...changed], affected_days: [...affected].sort((a, b) => a - b), repair_days: [...repairs].sort((a, b) => a - b) };

}

/** 缓存报告必须对应同一份规范化行程，不能用旧公式或旧内容的分数冒充当前结果。 */
export function qualitySourceSignature(itinerary: Itinerary): string { return createHash("sha256").update(JSON.stringify(itinerary)).digest("hex"); }

/** Haversine 大圆距离（公里）——空间连贯性校验用 */
function haversineKm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function validateDay(
  day: ItineraryDay,
  dayNumber: number,
  remoteLegLimit = DEFAULT_REMOTE_LEG_LIMIT_MINUTES,
): QualityIssue[] {
  const remote = day.items.some((item) => item.type === "visit") && isRemoteDayTravel(day.items.filter((item) => item.type === "transport"));
  const weekday = weekdayOf(day.date);
  // 餐饮候选不参与时间线核验：它们是"沿途参考"而非日程条目（同一餐段多个候选本就同时存在，
  // 若把候选的 time 混入时间线会产生"时间重叠/时间倒序"的误报）
  const timedItems = day.items.filter(
    (item): item is ItineraryItem & { time: string } => item.time !== undefined && item.type !== "meal",
  );
  const issues = timedItems.flatMap((item, index) => {
    if (index === 0) return [];
    const previous = timedItems[index - 1];
    if (timeToMinutes(item.time) < timeToMinutes(previous.time)) {
      return [
        issue(
          "P0",
          "time-out-of-order",
          `时间线倒序: ${previous.name} ${previous.time} 后出现 ${item.name} ${item.time}`,
          dayNumber,
          item.id,
        ),
      ];
    }

    const previousEnd = itemEndMinutes(previous);
    if (previousEnd !== undefined && timeToMinutes(item.time) < previousEnd) {
      return [
        issue(
          "P0",
          "time-overlap",
          `${previous.name} 与 ${item.name} 时间重叠`,
          dayNumber,
          item.id,
        ),
      ];
    }
    return [];
  });

  // 餐饮候选允许没有 time（不排入时间线，供用户沿途自选）；其余条目缺时间则无法核验
  const untimedRequired = day.items.filter((item) => item.type !== "meal" && item.time === undefined);
  if (untimedRequired.length > 0) {
    issues.push(issue("P1", "missing-time", "存在缺少 time 的条目（餐饮候选除外），无法完整核验时间线", dayNumber));
  }

  // 全天没有任何游览安排（只有吃饭/交通/住宿）——典型是"空壳返程日"，
  // 模型为凑天数把纯返程拉成一天，或为过晚餐校验塞假条目
  if ((day.day_type ?? "full") === "full" && !day.items.some((item) => item.type === "visit")) {
    const kinds = [...new Set(day.items.map((item) => item.type))].join("、");
    issues.push(
      issue(
        "P1",
        "no-activity",
        `当天没有任何游览安排（仅有 ${kinds}）。返程日建议安排上午活动，或压缩行程天数`,
        dayNumber,
      ),
    );
  }

  issues.push(...day.items.flatMap((item) => validateItem(item, dayNumber, weekday, remote ? remoteLegLimit : EXTREME_TRANSPORT_MINUTES, day.date)));
  issues.push(...duplicateIssues(day.items, dayNumber));
  issues.push(...spatialIssues(day.items, dayNumber));
  issues.push(...routeEfficiencyIssues(day, dayNumber));
  issues.push(...remoteDayIssues(day.items, dayNumber));
  issues.push(...mergedMealCandidateIssues(day.items, dayNumber));
  issues.push(...mealMarkerOverlapIssues(day.items, dayNumber));
  issues.push(...timelineGaps(day).filter((gap) => gap.minutes > MAX_TIMELINE_GAP_MINUTES).map((gap) => issue("P1", "timeline-gap", `${gap.from.name}（${formatClock(itemEndMinutes(gap.from)!)} 结束）到 ${gap.to.name}（${gap.to.time} 开始）之间有 ${gap.minutes} 分钟空档未规划；请补充真实的交通/用餐/休息时间块`, dayNumber, gap.to.id)));
  issues.push(...transferTimeIssues(day.items, dayNumber));
  issues.push(...lowRatingVisitIssues(day.items, dayNumber));

  const activeMinutes = day.items
    .filter(
      (item) =>
        item.type !== "rest" && item.type !== "accommodation" && item.type !== "note" && item.type !== "meal",
    )
    .reduce((sum, item) => sum + itemDurationMinutes(item), 0);
  const activeSeverity = activeDurationSeverity(activeMinutes);
  if (activeSeverity !== undefined) {
    issues.push(
      issue(
        activeSeverity,
        "day-too-long",
        `全天游览及通勤约 ${formatMinutes(activeMinutes)}，参考目标 ${formatMinutes(ACTIVE_TARGET_MINUTES)}，超出 ${((activeMinutes / ACTIVE_TARGET_MINUTES - 1) * 100).toFixed(1)}%${activeSeverity === "P2" ? "；属于节奏提醒，不扣分、不阻断" : "；超过20%缓冲，请缩减安排"}`,
        dayNumber,
      ),
    );
  }
  return issues;
}

function remoteDayIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  if (!isRemoteDayTravel(items.filter((item) => item.type === "transport"))) return [];

  const visits = [...new Map(items.filter((item) => item.type === "visit").map((item) => [scenicVisitKey(item.name, item.parent_visit?.name), item])).values()];
  if (visits.length <= 1) return [];

  const points = visits.flatMap((item) => {
    if (item.location?.latitude === undefined || item.location.longitude === undefined) return [];
    return [{
      name: item.name,
      latitude: item.location.latitude,
      longitude: item.location.longitude,
    }];
  });
  const maxDistanceKm =
    points.length === visits.length
      ? points
          .flatMap((from, index) =>
            points
              .slice(index + 1)
              .map((to) => haversineKm(from.latitude, from.longitude, to.latitude, to.longitude)),
          )
          .reduce((max, distance) => Math.max(max, distance), 0)
      : undefined;
  const tooMany = visits.length > 2;
  const tooFar = maxDistanceKm !== undefined && maxDistanceKm > REMOTE_DAY_NEARBY_KM;
  if (!tooMany && !tooFar) return [];

  const distanceLabel =
    maxDistanceKm === undefined ? "" : `，最远相距约 ${Math.round(maxDistanceKm)} 公里`;
  return [
    issue(
      "P2",
      "remote-day-overpacked",
      `远郊日安排了 ${visits.length} 个游览点（${visits.map((item) => item.name).join("、")}）${distanceLabel}：` +
        `建议按远郊日模板只保留 1 个主景点，优先增加主景点 ${REMOTE_DAY_NEARBY_KM} 公里内的轻量活动；` +
        "可按真实路程和可用时间调整；此为节奏建议，仍须通过时间与路线核验",
      dayNumber,
    ),
  ];
}

/**
 * 从标题里提取行程天数。
 * 模型常生成「北京五日首访游」「北京三日·博物馆历史之旅」这类标题，
 * 不能只匹配连续的「N日游」，否则远端增加修饰词后，半成品会绕过天数校验。
 */
export function expectedDaysFromTitle(title: string): number | undefined {
  const match = title.match(/([0-9一二三四五六七八九十两]+)\s*(?:日|天)/u);
  if (match === null) return undefined;
  return parseDayCount(match[1]);
}

function parseDayCount(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return value > 0 ? value : undefined;
  }
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!raw.includes("十")) return digits[raw];
  const parts = raw.split("十");
  if (parts.length !== 2) return undefined;
  const tens = parts[0] === "" ? 1 : digits[parts[0]];
  const ones = parts[1] === "" ? 0 : digits[parts[1]];
  if (tens === undefined || ones === undefined) return undefined;
  const value = tens * 10 + ones;
  return value > 0 ? value : undefined;
}

function validateItem(item: ItineraryItem, dayNumber: number, weekday: string | undefined, transportLimit: number, date?: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  // 餐饮条目的问题进"餐饮建议"（不参与状态/评分）；行程条目的问题进正式校验
  const meal = item.type === "meal";
  if (date && item.closed_dates?.includes(date)) issues.push(issue("P0", "closed-on-date", `${item.name}在${date}有明确临时闭馆公告`, dayNumber, item.id, meal));
  if (weekday !== undefined && item.closed_on?.includes(weekday)) {
    issues.push(issue(item.closure_holiday_exception ? "P1" : "P0", item.closure_holiday_exception ? "closure-exception-check" : "closed-on-date", `${item.name} 在${weekdayLabel(weekday)}${item.closure_holiday_exception ? "按常规闭馆；仅法定节假日可能例外，请确认例外或调整日期" : "闭馆/闭店"}`, dayNumber, item.id, meal));
  }
  const hasCoordinates =
    item.location?.latitude !== undefined && item.location.longitude !== undefined;
  if (!hasCoordinates && (item.type === "visit" || item.type === "meal" || item.location !== undefined)) {
    // note 里已标记「坐标待核实」的条目是有意不带坐标，不是遗漏：
    // 提示不参与空间核验即可，避免模型为了消 P2 而编造坐标
    const marked = item.note?.includes("坐标待核实") === true;
    if (marked) {
      issues.push(issue("P2", "unverified-coordinates", `${item.name} 坐标待核实（note 已标记）：不参与地图打点与顺路核验`, dayNumber, item.id, meal));
    } else {
      issues.push(
        item.location === undefined
          ? issue("P2", "missing-location", `${item.name} 缺少 location，无法做空间核验`, dayNumber, item.id, meal)
          : issue("P2", "missing-coordinates", `${item.name} 缺少经纬度，无法计算顺路程度`, dayNumber, item.id, meal),
      );
    }
  }
  if (item.source === undefined) {
    issues.push(issue("P2", "missing-source", `${item.name} 缺少数据来源`, dayNumber, item.id, meal));
  }
  if (item.confidence === undefined) {
    issues.push(issue("P2", "missing-confidence", `${item.name} 缺少置信度`, dayNumber, item.id, meal));
  }
  if (item.type === "meal" && item.subtype === undefined) {
    issues.push(issue("P2", "missing-meal-subtype", `${item.name} 缺少 meal subtype`, dayNumber, item.id, true));
  }
  if (item.type === "visit" && item.opening_hours === undefined) {
    issues.push(issue("P2", "missing-opening-hours", `${item.name} 缺少开放时间`, dayNumber, item.id));
  }
  if (item.opening_hours !== undefined && item.time !== undefined && outsideOpeningHours(item, item.opening_hours)) {
    issues.push(
      issue(
        "P1",
        "outside-opening-hours",
        `${item.name} 的完整停留时段不在 ${item.opening_hours.opens}-${item.opening_hours.closes} 内`,
        dayNumber,
        item.id,
        meal,
      ),
    );
  }
  if (item.reservation_required === true) {
    issues.push(issue("P2", "reservation-required", `${item.name} 需要预约，出发前应确认`, dayNumber, item.id, meal));
  }
  if (item.type === "transport") {
    if (item.from === undefined || item.to === undefined) {
      issues.push(issue("P2", "missing-transport-endpoints", `${item.name} 缺少 from / to`, dayNumber, item.id));
    }
    const duration = itemDurationMinutes(item);
    if (duration > LONG_TRANSPORT_MINUTES) {
      const extreme = duration > transportLimit;
      issues.push(
        issue(
          extreme ? "P1" : "P2",
          "long-transport",
          extreme
            ? `交通耗时 ${duration} 分钟，超过 ${transportLimit} 分钟：` +
              "建议调整顺序、交通或景点；仅用户允许时更换住宿"
            : `交通耗时 ${duration} 分钟，属于远郊/跨区长距离移动：` +
              `请确认当天已预留缓冲（超过 ${LONG_TRANSPORT_MINUTES} 分钟会提示，但不阻断交付）`,
          dayNumber,
          item.id,
        ),
      );
    }
  }
  // 无时间的条目（餐饮候选等沿途自选项）不要求时长；有时间的才核验。
  // 景点必须有游玩时长（时间管理核心），否则 P1；其余类型 P2 提示。
  if (item.type !== "rest" && item.type !== "note" && item.type !== "accommodation" && item.time !== undefined && itemDurationMinutes(item) === 0) {
    issues.push(
      issue(
        item.type === "visit" ? "P1" : "P2",
        "missing-duration",
        item.type === "visit"
          ? `${item.name} 缺少游玩时长（end_time 或 planned_duration_min），时间线无法核对`
          : `${item.name} 缺少 end_time 或 planned_duration_min`,
        dayNumber,
        item.id,
        meal,
      ),
    );
  }
  if (item.type === "meal" && item.time !== undefined && item.subtype !== undefined) {
    const window = MEAL_WINDOWS[item.subtype];
    if (window !== undefined) {
      const minutes = timeToMinutes(item.time);
      if (minutes < window[0] || minutes > window[1]) {
        issues.push(issue("P1", "meal-outside-window", `${item.name} 的时间不在常规${mealSubtypeLabel(item.subtype)}时段`, dayNumber, item.id, true));
      }
    }
  }
  return issues;
}

function duplicateIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  const seen = new Set<string>();
  return items
    .filter((item) => item.type === "visit" || item.type === "meal")
    .flatMap((item) => {
      const key = `${item.type}:${item.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        return [];
      }
      return [issue("P1", "duplicate-place", `当天重复安排 ${item.name}`, dayNumber, item.id, item.type === "meal")];
    });
}

/**
 * 空间连贯性：相邻定位条目相距超过阈值且中间没有交通安排时提示。
 * 利用已有经纬度做实际距离校验，防止"行程时间线合理但地理位置断裂"。
 */
function spatialIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  const issues: QualityIssue[] = [];
  // 只核验景点之间的距离衔接：餐厅是沿途候选，不参与空间序列
  const timed = items.filter((item) => item.type === "visit" && item.time !== undefined);
  const SPATIAL_GAP_KM = 5;

  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const curr = timed[i];
    const prevLat = prev.location?.latitude;
    const prevLon = prev.location?.longitude;
    const currLat = curr.location?.latitude;
    const currLon = curr.location?.longitude;
    if (prevLat === undefined || prevLon === undefined || currLat === undefined || currLon === undefined) continue;

    const distanceKm = haversineKm(prevLat, prevLon, currLat, currLon);
    if (distanceKm <= SPATIAL_GAP_KM) continue;

    // 两个景点相距超过阈值 → 检查中间有没有交通条目衔接（在完整时间线里找）
    const hasTransport = items.some((item) =>
      item.type === "transport" &&
      item.time! > prev.time! && item.time! < curr.time!,
    );
    if (!hasTransport) {
      issues.push(
        issue(
          "P2",
          "spatial-gap",
          `${prev.name} 与 ${curr.name} 相距约 ${distanceKm.toFixed(1)} 公里，中间缺少交通安排`,
          dayNumber,
          curr.id,
        ),
      );
    }
  }
  return issues;
}

/**
 * 当日路线效率：实际顺序总路程 vs 最优开放路径。
 * 偏差过大说明存在来回折返（如 鹿鸣山→水亭门→孔庙→鹿鸣山），
 * 拦截并给出按区域聚类后的建议顺序。
 */
function routeEfficiencyIssues(day: ItineraryDay, dayNumber: number): QualityIssue[] {
  const located = day.items.filter(
    (item): item is ItineraryItem & { location: { latitude: number; longitude: number } } =>
      item.type === "visit" &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined,
  );
  if (located.length < 4) return [];

  const coords = located.map((item) => ({
    latitude: item.location.latitude,
    longitude: item.location.longitude,
  }));
  const actual = pathLengthM(coords, coords.map((_, index) => index));
  const best = bestOpenPathM(coords);
  if (actual > best.length * 1.4 && actual - best.length > 1500) {
    const suggestion = best.order.map((index) => located[index].name).join(" → ");
    return [
      issue(
        "P1",
        "route-backtracking",
        `当日景点路线来回折返：按当前顺序约 ${(actual / 1000).toFixed(1)} 公里，` +
        `按区域聚类重排约 ${(best.length / 1000).toFixed(1)} 公里。建议顺序: ${suggestion}` +
        "（纯地理建议，需结合景点开放时间调整）",
        dayNumber,
      ),
    ];
  }
  return [];
}

/** 枚举符号——把多家餐厅合并进一条 note 时的典型写法（如"① 周叔烤饼 ② 汪馒头"） */
const CIRCLED_NUMBERS = /[①②③④⑤⑥⑦⑧⑨⑩]/g;
/** 餐标记与景点坐标视为"重合"的距离阈值（公里） */
const MARKER_OVERLAP_KM = 0.06;

/**
 * 多家餐厅被合并进一条 meal 条目（如"午餐 · 6个候选"）：
 * 地图上只会出现 1 个"餐"标记、且位置常取街区/景点坐标，与餐厅实际位置不符，用户无法按位置挑选。
 * 正确做法是每家候选餐厅独立成条、各带 search_restaurants 返回的真实坐标。
 */
function mergedMealCandidateIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  return items
    .filter((item) => item.type === "meal")
    .flatMap((item) => {
      const text = `${item.name}\n${item.note ?? ""}`;
      const circled = (text.match(CIRCLED_NUMBERS) ?? []).length;
      const stated = Number.parseInt(/(\d+)\s*个候选/.exec(item.name)?.[1] ?? "", 10);
      if (circled < 2 && !(Number.isFinite(stated) && stated >= 2)) return [];
      return [
        issue(
          "P1",
          "meal-merged-candidates",
          `${item.name} 把多家餐厅合并成一条：每家候选餐厅必须独立成条、各带真实坐标，` +
          `否则地图上只有一个餐标记且位置不符，用户无法按位置挑选`,
          dayNumber,
          item.id,
          true,
        ),
      ];
    });
}

/**
 * 餐标记与当天景点坐标几乎重合：地图上餐标记会盖住景点标记（表现为"当天没有景点"）。
 * location.name 与景点相同 → 几乎必然是把景点坐标当成了餐厅定位（P1）；
 * 其余小概率是景点内餐厅，提示确认（P2）。
 */
function mealMarkerOverlapIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  const visits = items.filter(
    (item): item is ItineraryItem & { location: { latitude: number; longitude: number } } =>
      item.type === "visit" &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined,
  );
  return items
    .filter(
      (item): item is ItineraryItem & { location: { latitude: number; longitude: number } } =>
        item.type === "meal" &&
        item.location?.latitude !== undefined &&
        item.location?.longitude !== undefined,
    )
    .flatMap((meal) => {
      const overlapping = visits
        .map((visit) => ({
          visit,
          distanceKm: haversineKm(
            meal.location.latitude,
            meal.location.longitude,
            visit.location.latitude,
            visit.location.longitude,
          ),
        }))
        .filter((entry) => entry.distanceKm < MARKER_OVERLAP_KM)
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];
      if (overlapping === undefined) return [];
      const sameName =
        meal.location.name !== undefined &&
        meal.location.name !== "" &&
        meal.location.name === overlapping.visit.location.name;
      if (
        sameName
      ) {
        return [
          issue(
            "P1",
            "meal-marker-overlap",
            `${meal.name} 与景点「${overlapping.visit.name}」共用同一坐标，餐标记会盖住景点标记；` +
            `请改用餐厅自身真实坐标（search_restaurants 的返回值）`,
            dayNumber,
            meal.id,
            true,
          ),
        ];
      }
      // 名称不同：只有几乎完全重合（<25 米）才提示，避免老城区餐馆紧邻景点造成误报
      if (overlapping.distanceKm >= 0.025) return [];
      return [
        issue(
          "P2",
          "meal-marker-overlap",
          `${meal.name} 与景点「${overlapping.visit.name}」坐标几乎重合（<25 米），餐标记可能盖住景点标记；` +
          `若非同一地点请改用餐厅自身坐标`,
          dayNumber,
          meal.id,
          true,
        ),
      ];
    });
}

/**
 * 赶路时间：相邻停留点（景点/住宿/休息）相距超过阈值时，时间线里必须留出足够的赶路时间。
 * 用距离估算最短耗时（步行 4.5km/h、驾车 30km/h），可用时间不足一半 → P1。
 */
function transferTimeIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  const waypoints = items.filter(
    (item): item is ItineraryItem & { time: string; location: { latitude: number; longitude: number } } =>
      (item.type === "visit" || item.type === "accommodation" || item.type === "rest") &&
      item.time !== undefined &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined,
  );
  const issues: QualityIssue[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const previous = waypoints[i - 1];
    const current = waypoints[i];
    const previousEnd = itemEndMinutes(previous);
    if (previousEnd === undefined) continue;
    const distanceKm = haversineKm(
      previous.location.latitude,
      previous.location.longitude,
      current.location.latitude,
      current.location.longitude,
    );
    if (distanceKm < MIN_TRANSFER_DISTANCE_KM) continue;
    const requiredMin = distanceKm <= 1.5
      ? Math.max(3, distanceKm * WALKING_MINUTES_PER_KM)
      : Math.max(10, distanceKm * DRIVING_MINUTES_PER_KM);
    const availableMin = timeToMinutes(current.time) - previousEnd;
    if (availableMin >= requiredMin * 0.5) continue;
    issues.push(
      issue(
        "P1",
        "transfer-too-tight",
        `${previous.name}（${formatClock(previousEnd)} 结束）到 ${current.name}（${current.time} 开始）相距约 ` +
        `${distanceKm.toFixed(1)} 公里，至少需要约 ${Math.round(requiredMin)} 分钟赶路，时间线上只留了 ${availableMin} 分钟：` +
        `请缩短前一项或把后续时间顺延`,
        dayNumber,
        current.id,
      ),
    );
  }
  return issues;
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** 博物馆/纪念馆类景点低于该评分时提示核对同区域替代（P2，不阻断交付） */
const LOW_RATING_THRESHOLD = 4.3;
const MUSEUM_LIKE_PATTERN = /(博物馆|纪念馆|展览馆|陈列馆|美术馆)/;
/** 早餐候选与当天起点的最大合理距离（公里） */
const BREAKFAST_ANCHOR_MAX_KM = 1.2;

interface LocatedStop {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** 取某天第一个/最后一个有坐标的停留点（景点/住宿/休息） */
function locatedStops(day: ItineraryDay | undefined, fromEnd: boolean): LocatedStop | undefined {
  if (day === undefined) return undefined;
  const stops = day.items.filter(
    (item): item is ItineraryItem & { location: { latitude: number; longitude: number } } =>
      (item.type === "visit" || item.type === "accommodation" || item.type === "rest") &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined,
  );
  const stop = fromEnd ? stops[stops.length - 1] : stops[0];
  return stop === undefined
    ? undefined
    : { name: stop.name, latitude: stop.location.latitude, longitude: stop.location.longitude };
}

/**
 * 早餐候选与当天起点脱节 → P2：最近一家也超过阈值距离。
 * 典型问题：早餐块排在 08:00 的住处侧，候选店却全在 2 公里外的景区门口。
 * 起点定义：前一天最后一个停留点（住处），否则当天第一个停留点。
 */
function breakfastAnchorIssues(
  days: readonly ItineraryDay[],
  dayIndex: number,
  dayNumber: number,
): QualityIssue[] {
  const day = days[dayIndex];
  const breakfast = day.items.filter(
    (item): item is ItineraryItem & { location: { latitude: number; longitude: number } } =>
      item.type === "meal" &&
      item.subtype === "breakfast" &&
      item.location?.latitude !== undefined &&
      item.location?.longitude !== undefined,
  );
  if (breakfast.length === 0) return [];
  const anchor = locatedStops(days[dayIndex - 1], true) ?? locatedStops(day, false);
  if (anchor === undefined) return [];
  const nearestKm = Math.min(
    ...breakfast.map((item) =>
      haversineKm(anchor.latitude, anchor.longitude, item.location.latitude, item.location.longitude),
    ),
  );
  if (nearestKm <= BREAKFAST_ANCHOR_MAX_KM) return [];
  return [
    issue(
      "P2",
      "breakfast-far-from-start",
      `早餐候选最近的也在 ${nearestKm.toFixed(1)} 公里外（当天起点：${anchor.name} 附近），` +
      `请补充起点附近的早餐店，或调整时间线先到候选店再出发`,
      dayNumber,
      undefined,
      true,
    ),
  ];
}

/**
 * 低分博物馆/纪念馆提示：note 里标注了评分且低于阈值 → 请确认同区域没有更高分替代。
 * （典型问题：选了 4.2 分的小吃博物馆，而附近有更高分的纪念馆/古迹）
 */
function lowRatingVisitIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  return items
    .filter((item) => item.type === "visit" && MUSEUM_LIKE_PATTERN.test(item.name))
    .flatMap((item) => {
      const match = /(?:高德)?评分\s*([0-9](?:\.[0-9])?)/.exec(item.note ?? "");
      if (match === null) return [];
      const rating = Number(match[1]);
      if (!(rating < LOW_RATING_THRESHOLD)) return [];
      return [
        issue(
          "P2",
          "low-rating-visit",
          `${item.name} 标注评分 ${rating}，低于 ${LOW_RATING_THRESHOLD}：请确认同区域没有更高分的博物馆/纪念馆替代；` +
          `保留需在 note 说明理由`,
          dayNumber,
          item.id,
        ),
      ];
    });
}

function pathLengthM(
  coords: ReadonlyArray<{ latitude: number; longitude: number }>,
  order: readonly number[],
): number {
  let total = 0;
  for (let i = 1; i < order.length; i++) {
    const a = coords[order[i - 1]];
    const b = coords[order[i]];
    total += haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) * 1000;
  }
  return total;
}

/**
 * 最优路径：首尾两站固定（一天从住处/首站出发、到最后一站收尾），只优化中间顺序。
 * ≤10 个点穷举全排列，更多用最近邻近似。
 * 两端固定很重要：自由换起点会把"郊区一日游往返"误判为可优化
 * （如把江郎山排到最后就意味着不用返程，与真实行程不符）。
 */
function bestOpenPathM(
  coords: ReadonlyArray<{ latitude: number; longitude: number }>,
): { length: number; order: number[] } {
  const n = coords.length;
  let best = { length: Number.POSITIVE_INFINITY, order: coords.map((_, index) => index) };
  // 中间可重排的节点；首（0）尾（n-1）固定
  const mid = coords.map((_, index) => index).slice(1, n - 1);
  if (n <= 10) {
    const current: number[] = [];
    const used = mid.map(() => false);
    const walk = () => {
      if (current.length === mid.length) {
        const order = [0, ...current, n - 1];
        const length = pathLengthM(coords, order);
        if (length < best.length) best = { length, order: [...order] };
        return;
      }
      for (let index = 0; index < mid.length; index++) {
        if (used[index]) continue;
        used[index] = true;
        current.push(mid[index]);
        walk();
        current.pop();
        used[index] = false;
      }
    };
    walk();
    return best;
  }
  const remaining = new Set(mid);
  const order = [0];
  while (remaining.size > 0) {
    const last = coords[order[order.length - 1]];
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of remaining) {
      const distance = haversineKm(last.latitude, last.longitude, coords[index].latitude, coords[index].longitude);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    order.push(bestIndex);
    remaining.delete(bestIndex);
  }
  order.push(n - 1);
  return { length: pathLengthM(coords, order), order };
}

export function totalCostPerPerson(itinerary: Itinerary): number {
  itinerary = normalizeStayReferences(itinerary);
  let total = 0;
  const travelers = itinerary.travelers ?? 2;
  const paidNights = new Map<string, [number, number][]>();
  for (const [dayIndex, day] of itinerary.days.entries()) {
    // 非餐饮条目直接累加
    for (const item of day.items) {
      if (item.type === "accommodation" && item.room_price_per_night !== undefined) {
        const isLastDay = day.date !== undefined && itinerary.constraints?.end_date !== undefined
          ? day.date >= itinerary.constraints.end_date
          : dayIndex >= (itinerary.constraints?.expected_days ?? itinerary.days.length) - 1;
        const nights = item.stay_nights ?? (isLastDay ? 0 : 1);
        const rooms = item.room_count ?? itinerary.room_count ?? Math.ceil(travelers / 2);
        const start = day.date === undefined || !Number.isFinite(Date.parse(day.date)) ? dayIndex : Date.parse(day.date) / 86400000;
        const key = JSON.stringify([item.name, item.location?.latitude, item.location?.longitude]);
        const paid = paidNights.get(key) ?? [];
        // 按日期区间去重，复杂度由条目数决定，避免大晚数触发逐晚循环。
        let unpaid: [number, number][] = nights === 0 ? [] : [[start, start + nights]];
        for (const [paidStart, paidEnd] of paid) {
          unpaid = unpaid.flatMap(([a, b]) => {
            if (paidEnd <= a || paidStart >= b) return [[a, b] as [number, number]];
            const segments: [number, number][] = [];
            if (a < paidStart) segments.push([a, paidStart]);
            if (paidEnd < b) segments.push([paidEnd, b]);
            return segments;
          });
        }
        total += unpaid.reduce((sum, [a, b]) => sum + b - a, 0) * item.room_price_per_night * rooms / travelers;
        if (nights > 0) paidNights.set(key, [...paid, [start, start + nights]]);
      } else if (item.type !== "meal") {
        // 历史文件中显式的人均费用保持原语义，不自动猜测成房价。
        total += (item.cost_per_person ?? 0) + (item.ticket_price_per_person ?? 0);
      }
    }
    // 餐饮是候选：用户每餐只选一家，按同餐候选均价估算一次（避免把所有候选重复累加）
    const costsBySubtype = new Map<string, ItineraryItem[]>();
    for (const item of day.items) {
      if (item.type !== "meal") continue;
      const key = item.subtype ?? "meal";
      costsBySubtype.set(key, [...(costsBySubtype.get(key) ?? []), item]);
    }
    for (const candidates of costsBySubtype.values()) {
      const costs = distinctMeals(candidates).flatMap((item) => item.cost_per_person === undefined ? [] : [item.cost_per_person]);
      if (costs.length > 0) total += costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
    }
  }
  return total;
}

function itemDurationMinutes(item: ItineraryItem): number {
  if (item.time !== undefined && item.end_time !== undefined) {
    return timeToMinutes(item.end_time) - timeToMinutes(item.time);
  }
  if (item.time !== undefined && item.planned_duration_min !== undefined) {
    return item.planned_duration_min;
  }
  return item.planned_duration_min ?? 0;
}


function outsideOpeningHours(item: ItineraryItem & { time?: string }, hours: { opens: string; closes: string; last_admission?: string; intervals?: readonly { opens: string; closes: string }[] }): boolean {
  if (hours.intervals !== undefined) return hours.intervals.every((interval) => outsideOpeningHours(item, { ...interval, last_admission: hours.last_admission }));
  let start = timeToMinutes(item.time!);
  const opens = timeToMinutes(hours.opens);
  let closes = timeToMinutes(hours.closes);
  const overnight = closes < opens;
  if (overnight) {
    closes += 1440;
    if (start < opens) start += 1440;
  }
  let end = itemEndMinutes(item) ?? timeToMinutes(item.time!);
  if (overnight && end < opens) end += 1440;
  let admission = hours.last_admission === undefined ? undefined : timeToMinutes(hours.last_admission);
  if (admission !== undefined && overnight && admission < opens) admission += 1440;
  return start < opens || start >= closes || end > closes || (admission !== undefined && start > admission);
}

function deliveryIssues(itinerary: Itinerary): QualityIssue[] {
  const constraints = itinerary.constraints ?? {};
  const issues: QualityIssue[] = [];
  if (constraints.start_date !== undefined && constraints.end_date !== undefined) {
    const start = Date.parse(constraints.start_date), end = Date.parse(constraints.end_date);
    const actual = itinerary.days.map((day) => day.date);
    for (let date = start; date <= end; date += 86400000) {
      const expected = new Date(date).toISOString().slice(0, 10);
      if (!actual.includes(expected)) issues.push(issue("P1", "missing-requested-date", `缺少需求单指定日期 ${expected}`));
    }
    if (actual.some((date) => date === undefined || Date.parse(date) < start || Date.parse(date) > end || !Number.isFinite(Date.parse(date)))) issues.push(issue("P1", "unexpected-itinerary-date", "存在需求单日期范围之外或无有效日期的行程日"));
  }
  itinerary.days.forEach((day, index) => {
    const number = index + 1;
    const [availableStart, availableEnd] = availableDayWindow(day);
    const role = day.day_type ?? "full";
    const expectedDays = constraints.expected_days ?? expectedDaysFromTitle(itinerary.title) ?? itinerary.days.length;
    const isFirst = constraints.start_date === undefined ? number === 1 : day.date === constraints.start_date;
    const isLast = constraints.end_date === undefined ? number === expectedDays : day.date === constraints.end_date;
    if ((role === "arrival" && !isFirst) || (role === "departure" && !isLast)) issues.push(issue("P1", "invalid-day-role", "抵达日只能是首日，离开日只能是实际末日", number));
    if (role === "transfer" && !day.items.some((item) => item.type === "transport" && item.time !== undefined && itemEndMinutes(item) !== undefined)) issues.push(issue("P1", "missing-transfer-activity", "转场日需要实际交通时间块，不能只有日期类型", number));
    if (["arrival", "departure", "transfer"].includes(role) && day.available_start === undefined && day.available_end === undefined) issues.push(issue("P1", "missing-day-window", "非完整游玩日需要明确可用时间，不能只改日期类型规避检查", number));
    if (constraints.require_accommodation && role !== "departure" && !day.items.some((item) => item.type === "accommodation")) issues.push(issue("P1", "missing-accommodation", "当天缺少住宿安排或已确认的住宿地点", number));
    const timed = day.items.filter((item) => item.time !== undefined && item.type !== "meal").sort((a, b) => a.time!.localeCompare(b.time!));
    const coreTimed = timed.filter((item) => ["visit", "transport", "accommodation"].includes(item.type));
    const remote = day.items.some((item) => item.type === "visit") && isRemoteDayTravel(day.items.filter((item) => item.type === "transport"));
    const starts = coreTimed.map((item) => timeToMinutes(item.time!));
    const ends = coreTimed.flatMap((item) => itemEndMinutes(item) === undefined ? [] : [itemEndMinutes(item)!]);
    const requiredStart = Math.max(availableStart, constraints.day_start === undefined ? availableStart : timeToMinutes(constraints.day_start));
    const requiredEnd = Math.min(availableEnd, constraints.day_end === undefined ? availableEnd : timeToMinutes(constraints.day_end));
    if (requiredStart < requiredEnd) {
      const window = requiredEnd - requiredStart;
      const startLevel = starts.length === 0 ? "P1" : dayBoundarySeverity(Math.min(...starts) - requiredStart, window);
      const endLevel = ends.length === 0 ? "P1" : dayBoundarySeverity(requiredEnd - Math.max(...ends), window);
      if (constraints.day_start !== undefined && startLevel) issues.push(issue(startLevel, "incomplete-day-start", `当天开始晚于参考 ${formatClock(requiredStart)}${startLevel === "P2" ? "；节奏提示，不扣分、不阻断" : "，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排"}`, number));
      if (!remote && constraints.day_end !== undefined && endLevel) issues.push(issue(endLevel, "incomplete-day-end", `当天结束早于参考 ${formatClock(requiredEnd)}${endLevel === "P2" ? "；允许提前返店，节奏提示不扣分、不阻断" : "，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排"}`, number));
    }
    for (const item of timed) if (timeToMinutes(item.time!) < availableStart || (itemEndMinutes(item) ?? timeToMinutes(item.time!)) > availableEnd) issues.push(issue("P1", "outside-day-window", `${item.name} 超出当天已知可用时间`, number, item.id));
    for (const item of day.items) {
      if (constraints.require_place_evidence && ["visit", "meal", "accommodation"].includes(item.type) && item.evidence_verified !== true) {
        issues.push(issue("P1", "unverified-place-evidence", `${item.name} 缺少对应城市的工具地点证据`, number, item.id, item.type === "meal" && recommendationPolicy(itinerary).mode !== "strict"));
      }
      if (constraints.require_place_evidence && item.type === "visit" && /博物馆|博物院|美术馆/.test(`${item.name} ${item.place_type ?? ""}`) && (item.closed_on === undefined || item.closure_verified !== true || item.closure_policy_version !== CLOSURE_POLICY_VERSION)) {
        issues.push({ ...issue("P2", "unverified-closure", `${item.name} 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分`, number, item.id), kind: "pending" });
      }
      if (item.type === "transport" && constraints.require_routes && item.route_verified !== true) {
        issues.push(issue("P1", "unverified-route", `${item.name}：${item.route_binding_error ?? `缺少匹配起终点和交通方式的实际路线证据。${routeQueryHint(constraints.destination, item.from, item.to, item.transport_mode)}`}`, number, item.id));
      }
      if (item.type === "transport" && item.route_duration_min !== undefined) {
        const planned = itemEndMinutes(item);
        const duration = planned !== undefined && item.time !== undefined ? planned - timeToMinutes(item.time) : item.planned_duration_min;
        if (duration !== undefined && duration < item.route_duration_min) {
          const minor = item.route_duration_min - duration <= routeTimingTolerance(item.route_duration_min, constraints) + 1e-9;
          issues.push({ ...issue(minor ? "P2" : "P1", "route-duration-too-short", `${item.name} 预留 ${duration} 分钟，路线查询需 ${item.route_duration_min} 分钟${minor ? "；差异在容差内，建议补充缓冲" : "；超过容差，请调整"}`, number, item.id), kind: minor ? "advice" : "error" });
        }
      }
    }
    if (constraints.require_routes) {
      const stops = timed.filter((item) => item.type === "visit" || item.type === "accommodation");
      for (let i = 1; i < stops.length; i++) {
        const from = stops[i - 1], to = stops[i];
        if (from.name === to.name) continue;
        const colocated = from.location?.latitude !== undefined && from.location.longitude !== undefined && to.location?.latitude !== undefined && to.location.longitude !== undefined && haversineKm(from.location.latitude, from.location.longitude, to.location.latitude, to.location.longitude) < MIN_TRANSFER_DISTANCE_KM;
        const departAfter = itemEndMinutes(from);
        if (!colocated && !day.items.some((item) => item.type === "transport" && item.from === from.name && item.to === to.name && item.route_verified === true &&
          item.time !== undefined && departAfter !== undefined && timeToMinutes(item.time) >= departAfter &&
          itemEndMinutes(item) !== undefined && itemEndMinutes(item)! <= timeToMinutes(to.time!))) {
          const candidate = day.items.some((item) => item.type === "transport" && item.from === from.name && item.to === to.name && item.time !== undefined && departAfter !== undefined && timeToMinutes(item.time) >= departAfter && itemEndMinutes(item) !== undefined && itemEndMinutes(item)! <= timeToMinutes(to.time!));
          const between = day.items.filter((item) => item.type === "transport" && item.time !== undefined && departAfter !== undefined && timeToMinutes(item.time) >= departAfter && timeToMinutes(item.time) <= timeToMinutes(to.time!));
          const actual = between.map((item) => `${item.from ?? "未填"} → ${item.to ?? "未填"} / ${item.transport_mode ?? "方式未填"}`).join("；");
          const mode = between.find((item) => item.from === from.name || item.to === to.name)?.transport_mode;
          issues.push({ ...issue("P1", "missing-route-leg", `${from.name} → ${to.name} 缺少已核验的交通段${actual ? `；该时段现有交通为「${actual}」，请核对变化后的相邻地点` : ""}。${routeQueryHint(constraints.destination, from.name, to.name, mode)}`, number, to.id), kind: candidate ? "pending" : "error", related_item_ids: [from.id, to.id, ...between.map((item) => item.id)] });
        }
      }
    }
  });
  if (constraints.allow_hotel_changes === false || (constraints.require_accommodation && constraints.allow_hotel_changes !== true)) {
    const stays = itinerary.days.flatMap((day, index) => day.items.filter((item) => item.type === "accommodation").map((item) => ({ item, day: index + 1 })));
    const base = stays.find((entry) => entry.item.name === constraints.base_stay_name)?.item ?? stays[0]?.item;
    const changed = new Set<string>();
    for (const entry of stays) if (base && ((constraints.base_stay_name !== undefined && entry.item.name !== constraints.base_stay_name) || !compatibleStay(base, entry.item)) && !changed.has(entry.item.name)) {
      changed.add(entry.item.name);
      issues.push(issue("P1", "hotel-change-not-allowed", `本次默认全程住「${constraints.base_stay_name ?? base.name}」，却安排「${entry.item.name}」；请沿用已选酒店，确需换酒店时先更新用户需求`, entry.day, entry.item.id));
    }
  }
  const policy = recommendationPolicy(itinerary);
  if (policy.mode !== "off") {
    const coverage = recommendationCoverage(itinerary);
    const advice = policy.mode !== "strict";
    for (const slot of coverage.slots) if (slot.count < policy.minCandidates) issues.push(issue(advice ? "P2" : "P1", "recommendation-slot-coverage", `${slot.subtype === "lunch" ? "午餐" : "晚餐"}候选 ${slot.count}/${policy.minCandidates}`, slot.day, undefined, advice));
    if (coverage.meals.length > 0 && coverage.evidenceRate < policy.minEvidenceRate) issues.push(issue(advice ? "P2" : "P1", "recommendation-evidence-coverage", `餐饮评分及价格证据覆盖率 ${(coverage.evidenceRate * 100).toFixed(0)}%，目标至少 ${(policy.minEvidenceRate * 100).toFixed(0)}%`, undefined, undefined, advice));
  }
  return issues;
}

function weekdayOf(date: string | undefined): string | undefined {
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return undefined;
  }
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][parsed.getDay()];
}

function weekdayLabel(weekday: string): string {
  const labels: Record<string, string> = {
    Monday: "周一",
    Tuesday: "周二",
    Wednesday: "周三",
    Thursday: "周四",
    Friday: "周五",
    Saturday: "周六",
    Sunday: "周日",
  };
  return labels[weekday] ?? weekday;
}


function issue(
  level: QualityIssueLevel,
  code: string,
  message: string,
  day?: number,
  itemId?: string,
  meal = false,
): QualityIssue {
  return {
    level,
    code,
    message,
    ...(day !== undefined ? { day } : {}),
    ...(itemId !== undefined ? { item_id: itemId } : {}),
    ...(meal ? { meal: true } : {}),
  };
}

/** 内部标记：餐饮建议（不参与状态/评分，发布报告前剥掉标记） */
function isMealNote(issue: QualityIssue): boolean {
  return (issue as { meal?: boolean }).meal === true;
}

function plainIssue(value: QualityIssue): QualityIssue {
  const { meal: _meal, ...plain } = value as QualityIssue & { meal?: boolean };
  return plain;
}

function mealSubtypeLabel(subtype: string): string {
  if (subtype === "breakfast") return "早餐";
  if (subtype === "lunch") return "午餐";
  if (subtype === "dinner") return "晚餐";
  return "小吃";
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function renderQualityReport(report: ItineraryQualityReport): string {
  const status =
    report.status === "ok" ? "通过"
    : report.status === "needs_confirmation" ? "需人工确认"
    : report.status === "needs_revision" ? "需修改"
    : "不可用";

  const sections = (["P0", "P1", "P2"] as const).flatMap((level) => {
    const levelIssues = report.issues.filter((item) => item.level === level);
    if (levelIssues.length === 0) return [];
    return [
      `## ${level}`,
      ...levelIssues.map((item) => {
        const location = item.day === undefined ? "" : `Day ${item.day} · `;
        const itemId = item.item_id === undefined ? "" : `${item.item_id}: `;
        return `- ${location}${itemId}${item.kind === "pending" ? "[资料待确认] " : ""}${item.message}（${item.code}${item.related_codes?.length ? `；关联检查 ${item.related_codes.join(",")}` : ""}）`;
      }),
      "",
    ];
  });

  // 餐饮单列：仅供参考，不参与状态/评分（选哪家看当天想法）
  const mealSection =
    report.meal_notes.length === 0
      ? []
      : [
          "## 餐饮参考（不参与评分）",
          ...report.meal_notes.map((item) => {
            const location = item.day === undefined ? "" : `Day ${item.day} · `;
            return `- ${location}${item.message}（${item.code}）`;
          }),
          "",
        ];

  const summary =
    report.issues.length === 0
      ? report.meal_notes.length === 0
        ? "未发现需要处理的问题。"
        : "行程校验通过；餐饮仅为参考（见上，可自行取舍，或让助手补充）。"
      : "";

  return [
    `# 行程质量报告: ${report.title}`,
    "",
    `- 状态: ${status}`,
    `- 评分: ${report.score} / 100${report.score_version === undefined ? "" : `（${report.score_version}，按检查对象归一化）`}`,
    ...(report.scoring === undefined ? [] : [`- 完整度: ${(report.scoring.completeness * 100).toFixed(0)}%`, ...Object.entries(report.scoring.dimensions).map(([name, d]) => `- ${{ schedule: "时间安排", routing: "交通衔接", evidence: "资料核验", consistency: "行程一致性" }[name as keyof OpportunityScore["dimensions"]]}: ${d.score} 分，${d.failed}/${d.checked} 个检查对象有问题`)]),
    ...(report.daily === undefined ? [] : ["- 分日验收: " + report.daily.map((day) => `D${day.day} ${day.strict_pass ? "通过" : day.status === "needs_confirmation" ? "待确认" : "待修改"}`).join("；")]),
    ...(report.repair_days?.length ? [`- 建议局部修复日期: ${report.repair_days.join("、")}`] : []),
    ...(report.recommendation_policy === undefined ? [] : [`- 餐饮策略: ${formatRecommendationPolicy(report.recommendation_policy)}`]),
    `- 行程问题: P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1} / P2 ${report.issue_count.P2}`,
    ...(report.meal_notes.length > 0
      ? [`- 餐饮建议: ${report.meal_notes.length} 条（仅供参考，不影响状态/评分）`]
      : []),
    "",
    ...sections,
    ...mealSection,
    summary,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
