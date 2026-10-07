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
  readonly status: ItineraryQualityStatus;
  readonly score: number;
  readonly issue_count: {
    readonly P0: number;
    readonly P1: number;
    readonly P2: number;
  };
  readonly issues: readonly QualityIssue[];
}

export interface ValidateItineraryOptions {
  readonly budget_per_person_yuan?: number;
}

const MAX_ACTIVE_MINUTES = 600;
const LONG_TRANSPORT_MINUTES = 60;
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

  // 跨天重复：同一景点出现在多天（可能是有意重游，P2 提示确认）
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
        issue("P2", "cross-day-duplicate", `${name} 在第 ${days.join("、")} 天重复安排（若为有意重游请确认）`),
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

  const counts = countIssues(issues);
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
    issues,
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
  const timedItems = day.items.filter((item): item is ItineraryItem & { time: string } => item.time !== undefined);
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

  if (timedItems.length !== day.items.length) {
    issues.push(issue("P1", "missing-time", "存在缺少 time 的条目，无法完整核验时间线", dayNumber));
  }

  for (const subtype of ["lunch", "dinner"] as const) {
    if (!day.items.some((item) => item.type === "meal" && item.subtype === subtype)) {
      issues.push(issue("P1", `missing-${subtype}`, `当天没有安排${subtype === "lunch" ? "午餐" : "晚餐"}`, dayNumber));
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

  const activeMinutes = day.items
    .filter((item) => item.type !== "rest" && item.type !== "accommodation" && item.type !== "note")
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
  if (weekday !== undefined && item.closed_on?.includes(weekday)) {
    issues.push(issue("P0", "closed-on-date", `${item.name} 在${weekdayLabel(weekday)}闭馆/闭店`, dayNumber, item.id));
  }
  if ((item.type === "visit" || item.type === "meal") && item.location === undefined) {
    issues.push(issue("P2", "missing-location", `${item.name} 缺少 location，无法做空间核验`, dayNumber, item.id));
  }
  if (item.location !== undefined && (item.location.latitude === undefined || item.location.longitude === undefined)) {
    issues.push(issue("P2", "missing-coordinates", `${item.name} 缺少经纬度，无法计算顺路程度`, dayNumber, item.id));
  }
  if (item.source === undefined) {
    issues.push(issue("P2", "missing-source", `${item.name} 缺少数据来源`, dayNumber, item.id));
  }
  if (item.confidence === undefined) {
    issues.push(issue("P2", "missing-confidence", `${item.name} 缺少置信度`, dayNumber, item.id));
  }
  if (item.type === "meal" && item.subtype === undefined) {
    issues.push(issue("P2", "missing-meal-subtype", `${item.name} 缺少 meal subtype`, dayNumber, item.id));
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
    issues.push(issue("P2", "reservation-required", `${item.name} 需要预约，出发前应确认`, dayNumber, item.id));
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
  if (item.type !== "rest" && item.type !== "note" && itemDurationMinutes(item) === 0) {
    issues.push(issue("P2", "missing-duration", `${item.name} 缺少 end_time 或 planned_duration_min`, dayNumber, item.id));
  }
  if (item.type === "meal" && item.time !== undefined && item.subtype !== undefined) {
    const window = MEAL_WINDOWS[item.subtype];
    if (window !== undefined) {
      const minutes = timeToMinutes(item.time);
      if (minutes < window[0] || minutes > window[1]) {
        issues.push(issue("P1", "meal-outside-window", `${item.name} 的时间不在常规${mealSubtypeLabel(item.subtype)}时段`, dayNumber, item.id));
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
      return [issue("P1", "duplicate-place", `当天重复安排 ${item.name}`, dayNumber, item.id)];
    });
}

/**
 * 空间连贯性：相邻定位条目相距超过阈值且中间没有交通安排时提示。
 * 利用已有经纬度做实际距离校验，防止"行程时间线合理但地理位置断裂"。
 */
function spatialIssues(items: readonly ItineraryItem[], dayNumber: number): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const timed = items.filter((item) => item.time !== undefined);
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

    // 两个非交通条目相距超过阈值 → 检查中间有没有交通条目衔接
    if (prev.type === "transport" || curr.type === "transport") continue;
    const hasTransport = timed.some((item) =>
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

function totalCostPerPerson(itinerary: Itinerary): number {
  return itinerary.days
    .flatMap((day) => day.items)
    .reduce(
      (sum, item) => sum + (item.cost_per_person ?? 0) + (item.ticket_price_per_person ?? 0),
      0,
    );
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
): QualityIssue {
  return {
    level,
    code,
    message,
    ...(day !== undefined ? { day } : {}),
    ...(itemId !== undefined ? { item_id: itemId } : {}),
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

  return [
    `# 行程质量报告: ${report.title}`,
    "",
    `- 状态: ${status}`,
    `- 评分: ${report.score} / 100`,
    `- 问题: P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1} / P2 ${report.issue_count.P2}`,
    "",
    ...sections,
    report.issues.length === 0 ? "未发现需要处理的问题。" : "",
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
