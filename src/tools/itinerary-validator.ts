import {
  timeToMinutes,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
} from "./itinerary-schema.ts";

export type QualityIssueLevel = "P0" | "P1" | "P2";
export type ItineraryQualityStatus = "ok" | "needs_confirmation" | "needs_revision" | "invalid";

export interface QualityIssue {
  readonly level: QualityIssueLevel;
  readonly code: string;
  readonly message: string;
  readonly day?: number;
  readonly item_id?: string;
}

export interface ItineraryQualityReport {
  readonly title: string;
  readonly generated_at: string;
  /** 行程质量状态：只由行程类问题决定（餐饮建议不参与） */
  readonly status: ItineraryQualityStatus;
  readonly score: number;
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

export interface ValidateItineraryOptions {
  readonly budget_per_person_yuan?: number;
}

const MAX_ACTIVE_MINUTES = 600;
const LONG_TRANSPORT_MINUTES = 60;
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
  const issues = itinerary.days.flatMap((day, index) => validateDay(day, index + 1));

  // 早餐候选与"当天起点"的距离核验（需要前一天的信息，故在跨天层面检查）
  itinerary.days.forEach((_, index) => {
    issues.push(...breakfastAnchorIssues(itinerary.days, index, index + 1));
  });

  // 跨天重复：同一景点出现在多天——典型是分天调整时没有去重（如 D3、D4 都有市博物馆），
  // 需要修正到其中一天；确为有意重游的在 note 说明
  const visitDays = new Map<string, number[]>();
  itinerary.days.forEach((day, index) => {
    for (const item of day.items) {
      if (item.type !== "visit") continue;
      const days = visitDays.get(item.name) ?? [];
      days.push(index + 1);
      visitDays.set(item.name, days);
    }
  });
  for (const [name, days] of visitDays) {
    if (days.length > 1) {
      issues.push(
        issue(
          "P1",
          "cross-day-duplicate",
          `${name} 在第 ${days.join("、")} 天重复安排：请调整到其中一天（若确为有意重游，请在 note 说明理由）`,
        ),
      );
    }
  }
  // 标题「N日游」与实际天数不符（需求单口径与行程结构对不上，常见于返程日被单独拉成一天）
  const titleDays = parseDaysInTitle(itinerary.title);
  if (titleDays !== undefined && titleDays !== itinerary.days.length) {
    issues.push(
      issue(
        "P2",
        "title-day-mismatch",
        `标题为${titleDays}日游，实际排了 ${itinerary.days.length} 天（日期跨度与游玩天数可能不一致）`,
      ),
    );
  }
  const totalCost = totalCostPerPerson(itinerary);
  if (options.budget_per_person_yuan !== undefined && totalCost > options.budget_per_person_yuan) {
    issues.push(
      issue("P1", "budget-exceeded", `人均预估花费 ¥${totalCost}，超过预算 ¥${options.budget_per_person_yuan}`),
    );
  }

  // 餐饮与行程分开校验：餐饮建议仅供参考，不参与状态与评分
  const itineraryIssues = issues.filter((item) => !isMealNote(item)).map(plainIssue);
  const mealNotes = issues.filter(isMealNote).map(plainIssue);
  const counts = countIssues(itineraryIssues);
  const score = Math.max(0, 100 - counts.P0 * 20 - counts.P1 * 7 - counts.P2 * 2);
  return {
    title: itinerary.title,
    generated_at: new Date().toISOString(),
    status:
      counts.P0 > 0 ? "invalid"
      : counts.P1 > 0 ? "needs_revision"
      : counts.P2 > 0 ? "needs_confirmation"
      : "ok",
    score,
    issue_count: counts,
    issues: itineraryIssues,
    meal_notes: mealNotes,
  };
}

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
): QualityIssue[] {
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

  for (const subtype of ["lunch", "dinner"] as const) {
    if (!day.items.some((item) => item.type === "meal" && item.subtype === subtype)) {
      issues.push(
        issue("P1", `missing-${subtype}`, `当天没有${subtype === "lunch" ? "午餐" : "晚餐"}推荐（餐饮仅供参考，不参与评分）`, dayNumber, undefined, true),
      );
    }
  }

  // 候选数量：餐厅是"供用户自选"的候选，太少等于没得选（P2 提示，不阻断交付）
  for (const subtype of ["lunch", "dinner"] as const) {
    const count = day.items.filter((item) => item.type === "meal" && item.subtype === subtype).length;
    if (count > 0 && count < 4) {
      issues.push(
        issue(
          "P2",
          "few-meal-options",
          `${subtype === "lunch" ? "午餐" : "晚餐"}候选只有 ${count} 个，建议提供 4-6 个供用户挑选`,
          dayNumber,
          undefined,
          true,
        ),
      );
    }
  }

  // 全天没有任何游览安排（只有吃饭/交通/住宿）——典型是"空壳返程日"，
  // 模型为凑天数把纯返程拉成一天，或为过晚餐校验塞假条目
  if (!day.items.some((item) => item.type === "visit")) {
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

  issues.push(...day.items.flatMap((item) => validateItem(item, dayNumber, weekday)));
  issues.push(...duplicateIssues(day.items, dayNumber));
  issues.push(...spatialIssues(day.items, dayNumber));
  issues.push(...routeEfficiencyIssues(day, dayNumber));
  issues.push(...mergedMealCandidateIssues(day.items, dayNumber));
  issues.push(...mealMarkerOverlapIssues(day.items, dayNumber));
  issues.push(...timelineGapIssues(timedItems, day.items, dayNumber));
  issues.push(...transferTimeIssues(day.items, dayNumber));
  issues.push(...lowRatingVisitIssues(day.items, dayNumber));

  const activeMinutes = day.items
    .filter(
      (item) =>
        item.type !== "rest" && item.type !== "accommodation" && item.type !== "note" && item.type !== "meal",
    )
    .reduce((sum, item) => sum + itemDurationMinutes(item), 0);
  if (activeMinutes > MAX_ACTIVE_MINUTES) {
    issues.push(
      issue(
        "P1",
        "day-too-long",
        `全天活动约 ${formatMinutes(activeMinutes)}，超过 ${formatMinutes(MAX_ACTIVE_MINUTES)}`,
        dayNumber,
      ),
    );
  }
  return issues;
}

/** 解析标题里的「N日游」，支持中文数字（一~十）与阿拉伯数字 */
function parseDaysInTitle(title: string): number | undefined {
  const match = title.match(/([0-9一二三四五六七八九十]+)\s*日游/);
  if (match === null) return undefined;
  const raw = match[1];
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chinese[raw];
}

function validateItem(item: ItineraryItem, dayNumber: number, weekday: string | undefined): QualityIssue[] {
  const issues: QualityIssue[] = [];
  // 餐饮条目的问题进"餐饮建议"（不参与状态/评分）；行程条目的问题进正式校验
  const meal = item.type === "meal";
  if (weekday !== undefined && item.closed_on?.includes(weekday)) {
    issues.push(issue("P0", "closed-on-date", `${item.name} 在${weekdayLabel(weekday)}闭馆/闭店`, dayNumber, item.id, meal));
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
  if (item.opening_hours !== undefined && item.time !== undefined && outsideOpeningHours(item.time, item.opening_hours)) {
    issues.push(
      issue(
        "P1",
        "outside-opening-hours",
        `${item.name} 的开始时间不在 ${item.opening_hours.opens}-${item.opening_hours.closes} 内`,
        dayNumber,
        item.id,
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
    if (item.planned_duration_min !== undefined && item.planned_duration_min > LONG_TRANSPORT_MINUTES) {
      issues.push(
        issue(
          "P1",
          "long-transport",
          `交通耗时 ${item.planned_duration_min} 分钟，超过 ${LONG_TRANSPORT_MINUTES} 分钟`,
          dayNumber,
          item.id,
        ),
      );
    }
  }
  // 无时间的条目（餐饮候选等沿途自选项）不要求时长；有时间的才核验。
  // 景点必须有游玩时长（时间管理核心），否则 P1；其余类型 P2 提示。
  if (item.type !== "rest" && item.type !== "note" && item.time !== undefined && itemDurationMinutes(item) === 0) {
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
 * 时间线空档：相邻定时条目之间超过阈值且没有任何条目填充 →
 * 用餐/休息/交通等没有规划完整（典型：上午景点结束后直接跳到下午景点，中午空着）。
 *
 * 注：sequence 只含非餐饮条目（餐饮候选不排时间线）；但候选用餐时间落在空档内时
 * （如 12:00 的午餐候选）说明这段时间有安排（选家餐厅吃饭），不算未规划空档。
 */
function timelineGapIssues(
  timedItems: readonly (ItineraryItem & { time: string })[],
  allItems: readonly ItineraryItem[],
  dayNumber: number,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (let i = 1; i < timedItems.length; i++) {
    const previousEnd = itemEndMinutes(timedItems[i - 1]);
    if (previousEnd === undefined) continue;
    const gap = timeToMinutes(timedItems[i].time) - previousEnd;
    if (gap <= MAX_TIMELINE_GAP_MINUTES) continue;
    const filledByMeal = allItems.some(
      (item) =>
        item.type === "meal" &&
        item.time !== undefined &&
        timeToMinutes(item.time) >= previousEnd &&
        timeToMinutes(item.time) <= timeToMinutes(timedItems[i].time),
    );
    if (filledByMeal) continue;
    issues.push(
      issue(
        "P1",
        "timeline-gap",
        `${timedItems[i - 1].name}（${formatClock(previousEnd)} 结束）到 ${timedItems[i].name}（${timedItems[i].time} 开始）` +
        `之间有约 ${(gap / 60).toFixed(1)} 小时空档未规划：请补充交通/用餐/休息条目或调整时间`,
        dayNumber,
        timedItems[i].id,
      ),
    );
  }
  return issues;
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
  let total = 0;
  for (const day of itinerary.days) {
    // 非餐饮条目直接累加
    for (const item of day.items) {
      if (item.type !== "meal") {
        total += (item.cost_per_person ?? 0) + (item.ticket_price_per_person ?? 0);
      }
    }
    // 餐饮是候选：用户每餐只选一家，按同餐候选均价估算一次（避免把所有候选重复累加）
    const costsBySubtype = new Map<string, number[]>();
    for (const item of day.items) {
      if (item.type !== "meal" || item.cost_per_person === undefined) continue;
      const key = item.subtype ?? "meal";
      costsBySubtype.set(key, [...(costsBySubtype.get(key) ?? []), item.cost_per_person]);
    }
    for (const costs of costsBySubtype.values()) {
      total += costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
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

function itemEndMinutes(item: ItineraryItem): number | undefined {
  if (item.time === undefined) return undefined;
  if (item.end_time !== undefined) return timeToMinutes(item.end_time);
  if (item.planned_duration_min !== undefined) {
    return timeToMinutes(item.time) + item.planned_duration_min;
  }
  return undefined;
}

function outsideOpeningHours(time: string, hours: { opens: string; closes: string }): boolean {
  const minutes = timeToMinutes(time);
  const opens = timeToMinutes(hours.opens);
  const closes = timeToMinutes(hours.closes);
  if (opens <= closes) return minutes < opens || minutes > closes;
  return minutes < opens && minutes > closes;
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

function countIssues(issues: readonly QualityIssue[]) {
  return {
    P0: issues.filter((item) => item.level === "P0").length,
    P1: issues.filter((item) => item.level === "P1").length,
    P2: issues.filter((item) => item.level === "P2").length,
  };
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

function plainIssue(issue: QualityIssue): QualityIssue {
  const { level, code, message, day, item_id } = issue as QualityIssue & { meal?: boolean };
  return {
    level,
    code,
    message,
    ...(day !== undefined ? { day } : {}),
    ...(item_id !== undefined ? { item_id } : {}),
  };
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
        return `- ${location}${itemId}${item.message}（${item.code}）`;
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
    `- 评分: ${report.score} / 100`,
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
