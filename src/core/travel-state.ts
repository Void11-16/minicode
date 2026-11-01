import type { ItinerarySnapshot } from "../tools/tool.ts";
/**
 * 跨请求保留的旅行事实。
 *
 * 工具原文和历史对话会被裁剪，但目的地、约束、已选地点与质量状态必须稳定存在，
 * 否则跨天规划时模型会重复选点或遗忘已经落盘的版本。
 */
export interface TravelBriefState {
  readonly title: string;
  readonly destination: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly travelers?: number;
  readonly roomCount?: number;
  readonly budgetTotalYuan?: number;
  readonly budgetPerMealYuan?: number;
  readonly accommodation?: string;
  readonly pace?: string;
  readonly mustVisit: readonly string[];
  readonly avoid: readonly string[];
  readonly tastePreferences?: string;
  readonly notes?: string;
}

export interface TravelIssueState {
  readonly level: "P0" | "P1" | "P2";
  readonly day?: number;
  readonly message: string;
  readonly code?: string;
}

export interface TravelItineraryState {
  readonly title: string;
  readonly revision?: number;
  readonly timeline?: string;
  readonly itineraryId?: string;
  readonly daySummaries?: readonly { date?: string; day: number; itemCount: number; strictPass?: boolean }[];
  readonly repairDays?: readonly number[];
  readonly dayCount: number;
  readonly itemCount: number;
  readonly score?: number;
  readonly issueCount?: Readonly<Record<"P0" | "P1" | "P2", number>>;
  readonly strictPass?: boolean;
  readonly complete?: boolean;
  readonly issues: readonly TravelIssueState[];
}

export interface TravelPlaceState {
  readonly name: string;
  /** visit / meal / accommodation 等行程条目类型 */
  readonly kind: string;
  /** 古迹、博物馆、街区、公园、餐厅菜系等细分类 */
  readonly placeType?: string;
  readonly day: number;
  readonly date?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly source?: string;
}

export interface TravelState {
  readonly brief?: TravelBriefState;
  readonly itinerary?: TravelItineraryState;
  readonly places: readonly TravelPlaceState[];
  readonly updatedAt: number;
}

export function emptyTravelState(now: number = Date.now()): TravelState {
  return { places: [], updatedAt: now };
}

export function updateTravelStateFromBrief(
  current: TravelState | undefined,
  args: Record<string, unknown>,
  now: number = Date.now(),
): TravelState {
  const state = current ?? emptyTravelState(now);
  const title = stringValue(args.title);
  const destination = stringValue(args.destination);
  if (title === undefined || destination === undefined) return state;

  const brief: TravelBriefState = {
    title,
    destination,
    ...optional("startDate", stringValue(args.startDate)),
    ...optional("endDate", stringValue(args.endDate)),
    ...optional("roomCount", positiveNumber(args.roomCount)),
    ...optional("travelers", positiveNumber(args.travelers)),
    ...optional("budgetTotalYuan", positiveNumber(args.budgetTotalYuan)),
    ...optional("budgetPerMealYuan", positiveNumber(args.budgetPerMealYuan)),
    ...optional("accommodation", stringValue(args.accommodation)),
    ...optional("pace", stringValue(args.pace)),
    mustVisit: stringArray(args.mustVisit),
    avoid: stringArray(args.avoid),
    ...optional("tastePreferences", stringValue(args.tastePreferences)),
    ...optional("notes", stringValue(args.notes)),
  };
  return { ...state, brief, updatedAt: now };
}

export function updateTravelStateFromItinerary(
  current: TravelState | undefined,
  args: Record<string, unknown>,
  now: number = Date.now(),
  dayStart: number = 1,
): TravelState {
  const state = current ?? emptyTravelState(now);
  const title = stringValue(args.title);
  if (title === undefined || !Array.isArray(args.days)) return state;

  const merge = args.merge === true;
  const incomingDays = args.days.flatMap((rawDay, index) => {
    const day = objectValue(rawDay);
    if (day === null || !Array.isArray(day.items)) return [];
    return [{
      date: stringValue(day.date),
      dayNumber: index + dayStart,
      items: day.items,
    }];
  });
  if (incomingDays.length === 0) return state;

  const replacedDates = new Set(
    incomingDays.flatMap((day) => day.date === undefined ? [] : [day.date]),
  );
  const retained = merge
    ? state.places.filter((place) => place.date === undefined || !replacedDates.has(place.date))
    : [];
  const incomingPlaces = incomingDays.flatMap((day) =>
    day.items.flatMap((rawItem) => {
      const item = objectValue(rawItem);
      if (item === null) return [];
      const name = stringValue(item.name);
      const kind = stringValue(item.type) ?? "visit";
      if (name === undefined || !["visit", "meal", "accommodation", "rest"].includes(kind)) return [];
      const location = objectValue(item.location);
      const subtype = stringValue(item.subtype);
      const placeType =
        stringValue(item.place_type) ??
        stringValue(item.visit_type) ??
        (kind === "meal" ? stringValue(item.cuisine) ?? subtype : undefined);
      return [{
        name,
        kind,
        ...optional("placeType", placeType),
        day: day.dayNumber,
        ...optional("date", day.date),
        ...optional("latitude", coordinate(location?.latitude, -90, 90)),
        ...optional("longitude", coordinate(location?.longitude, -180, 180)),
        ...optional(
          "source",
          stringValue(item.source) ?? stringValue(location?.source),
        ),
      } satisfies TravelPlaceState];
    }),
  );

  const places = uniquePlaces([...retained, ...incomingPlaces]);
  const incomingSummaries = incomingDays.map((day) => ({ date: day.date, day: day.dayNumber, itemCount: day.items.length }));
  const retainedSummaries = merge ? (state.itinerary?.daySummaries ?? []).filter((day) => day.date === undefined ? !incomingSummaries.some((incoming) => incoming.day === day.day) : !replacedDates.has(day.date)) : [];
  const daySummaries = [...retainedSummaries, ...incomingSummaries].sort((a, b) => a.date !== undefined && b.date !== undefined ? a.date.localeCompare(b.date) : a.day - b.day);
  if (dayStart === 1) daySummaries.forEach((day, index) => { day.day = index + 1; });
  const dayCount = Math.max(...daySummaries.map((day) => day.day));
  const itemCount = daySummaries.reduce((sum, day) => sum + day.itemCount, 0);
  const itinerary: TravelItineraryState = {
    title,
    dayCount,
    itemCount,
    daySummaries,
    ...(state.itinerary?.title === title
      ? {
          ...optional("score", state.itinerary.score),
          ...optional("issueCount", state.itinerary.issueCount),
          ...optional("strictPass", state.itinerary.strictPass),
          ...optional("complete", state.itinerary.complete),
        }
      : {}),
    issues: state.itinerary?.title === title ? state.itinerary.issues : [],
  };
  return { ...state, itinerary, places, updatedAt: now };
}

export function updateTravelStateFromItineraryJson(
  current: TravelState | undefined,
  raw: string,
  now: number = Date.now(),
  options?: {
    readonly merge?: boolean;
    readonly dayStart?: number;
  },
): TravelState {
  const value = parseObject(raw);
  if (value === null) return current ?? emptyTravelState(now);
  return updateTravelStateFromItinerary(
    current,
    options?.merge === true ? { ...value, merge: true } : value,
    now,
    options?.dayStart,
  );
}

/** The committed file and its structured validation report are the canonical state. */
export function updateTravelStateFromSnapshot(current: TravelState | undefined, snapshot: ItinerarySnapshot): TravelState {
  const state = updateTravelStateFromItinerary(current, snapshot.itinerary as unknown as Record<string, unknown>);
  const report = snapshot.report;
  return { ...state, itinerary: { ...state.itinerary!, revision: snapshot.itinerary.revision, itineraryId: snapshot.itinerary.itinerary_id,
    repairDays: report.repair_days,
    daySummaries: state.itinerary?.daySummaries?.map((day) => ({ ...day, strictPass: report.daily?.find((item) => item.day === day.day)?.strict_pass })),
    timeline: snapshot.itinerary.days.map((day, index) => `D${index + 1} ${day.date ?? ""}: ` + day.items.map((item) => `[${item.id}]${item.time ?? ""}${item.end_time === undefined ? "" : `-${item.end_time}`} ${item.type}${item.subtype === undefined ? "" : `/${item.subtype}`} ${item.name}${item.planned_duration_min === undefined ? "" : ` ${item.planned_duration_min}分钟`}`).join("；")).join("\n"),
    score: report.score, issueCount: report.issue_count,
    strictPass: report.issue_count.P0 === 0 && report.issue_count.P1 === 0,
    complete: (report.scoring?.completeness ?? 1) === 1 && !report.issues.some((issue) => ["title-day-mismatch", "missing-requested-date", "unexpected-itinerary-date"].includes(issue.code)),
    issues: report.issues.map((issue) => ({ level: issue.level, message: issue.message, code: issue.code, day: issue.day })),
  } };
}

/**
 * 保存和 strict 校验的文本都遵循同一份质量报告格式。
 * 这里只抽取稳定摘要，不保留整份报告。
 */
export function updateTravelStateFromQuality(
  current: TravelState | undefined,
  text: string,
  title?: string,
  now: number = Date.now(),
): TravelState {
  const state = current ?? emptyTravelState(now);
  const itinerary = state.itinerary;
  if (itinerary === undefined || (title !== undefined && itinerary.title !== title)) return state;

  const score = firstNumber(text, /(?:质量:\s*|评分:\s*)(\d+)\s*\/\s*100/);
  const counts = /P0\s*(\d+)\s*\/\s*P1\s*(\d+)\s*\/\s*P2\s*(\d+)/.exec(text);
  const issueCount = counts === null
    ? itinerary.issueCount
    : { P0: Number(counts[1]), P1: Number(counts[2]), P2: Number(counts[3]) };
  const issues = extractIssues(text);
  const completeness = /完整性:\s*(\d+)\s*\/\s*(\d+)\s*天/.exec(text);
  const complete = completeness === null
    ? itinerary.complete
    : Number(completeness[1]) === Number(completeness[2]);
  return {
    ...state,
    itinerary: {
      ...itinerary,
      ...optional("score", score),
      ...optional("issueCount", issueCount),
      ...(issueCount === undefined ? {} : { strictPass: issueCount.P0 === 0 && issueCount.P1 === 0 }),
      ...optional("complete", complete),
      issues: issues.length > 0 ? issues : issueCount?.P0 === 0 && issueCount.P1 === 0 ? [] : itinerary.issues,
    },
    updatedAt: now,
  };
}

/** 每轮注入的紧凑状态卡；放在临时 system 消息尾部，避免破坏历史前缀缓存。 */
export function renderTravelState(state: TravelState | undefined, maxChars = 16000): string | undefined {
  if (state === undefined || (state.brief === undefined && state.itinerary === undefined)) return undefined;
  const lines = [
    "【结构化旅行状态卡】以下是跨请求保留的事实；工具原文可能已裁剪，应以本卡和已落盘行程为准。",
  ];
  if (state.brief !== undefined) {
    const brief = state.brief;
    lines.push(
      `需求单「${brief.title}」：${brief.destination}；日期 ${brief.startDate ?? "未定"} 至 ${brief.endDate ?? "未定"}；` +
        `节奏 ${brief.pace ?? "未指定"}；人数 ${brief.travelers ?? "未指定"}；` +
        `总预算 ${brief.budgetTotalYuan === undefined ? "未指定" : `¥${brief.budgetTotalYuan}`}；` +
        `单餐 ${brief.budgetPerMealYuan === undefined ? "未指定" : `¥${brief.budgetPerMealYuan}`}。`,
    );
    lines.push(`必去：${brief.mustVisit.join("、") || "无"}；避开：${brief.avoid.join("、") || "无"}。`);
    if (brief.tastePreferences !== undefined || brief.accommodation !== undefined || brief.notes !== undefined) {
      lines.push(
        `其他约束：${[
          brief.tastePreferences === undefined ? undefined : `口味 ${brief.tastePreferences}`,
          brief.accommodation === undefined ? undefined : `住宿 ${brief.accommodation}`,
          brief.notes === undefined ? undefined : brief.notes,
        ].filter((value): value is string => value !== undefined).join("；")}`,
      );
    }
  }
  if (state.itinerary !== undefined) {
    const itinerary = state.itinerary;
    const quality = itinerary.score === undefined
      ? ""
      : `；质量 ${itinerary.score}/100，P0 ${itinerary.issueCount?.P0 ?? "?"} / P1 ${itinerary.issueCount?.P1 ?? "?"} / P2 ${itinerary.issueCount?.P2 ?? "?"}` +
        `，strict ${itinerary.strictPass === true ? "通过" : "未通过"}`;
    lines.push(
      `当前行程「${itinerary.title}」${itinerary.revision === undefined ? "" : ` v${itinerary.revision}`}：${itinerary.dayCount} 天 / ${itinerary.itemCount} 项` +
        `${itinerary.complete === false ? "（完整性未确认）" : ""}${quality}。`,
    );
  }

  if (state.itinerary?.timeline !== undefined) lines.push(`已落盘条目索引（按 id 修改；无需反复 load）：\n${state.itinerary.timeline}`);
  const grouped = new Map<string, TravelPlaceState[]>();
  for (const place of state.places) {
    const key = `D${place.day}${place.date === undefined ? "" : ` ${place.date}`}`;
    grouped.set(key, [...(grouped.get(key) ?? []), place]);
  }
  if (grouped.size > 0) {
    lines.push("已选地点（跨天去重，不要重复安排同名地点）：");
    for (const [day, places] of grouped) {
      const labels = places.map((place) =>
        `${place.name}[${place.kind}${place.placeType === undefined ? "" : `/${place.placeType}`}]`,
      );
      lines.push(`- ${day}: ${labels.join("、")}`);
    }
  }
  const issues = state.itinerary?.issues.slice(0, 10) ?? [];
  if (issues.length > 0) {
    lines.push("当前待修问题（逐项修复，完成后再 strict 复验）：");
    for (const issue of issues) {
      lines.push(
        `- ${issue.level}${issue.day === undefined ? "" : ` Day ${issue.day}`}：${issue.message}` +
          `${issue.code === undefined ? "" : `（${issue.code}）`}`,
      );
    }
  }
  const rendered = lines.join("\n");
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, Math.max(0, maxChars - 20))}\n…（状态卡过长，已截断）`;
}

/** 反序列化旧数据或损坏数据时只在字段合法时恢复 */
export function normalizeTravelState(value: unknown, now: number = Date.now()): TravelState | undefined {
  const raw = objectValue(value);
  if (raw === null) return undefined;
  const briefRaw = objectValue(raw.brief);
  const itineraryRaw = objectValue(raw.itinerary);
  const brief = briefRaw === null ? undefined : normalizeBrief(briefRaw);
  const itinerary = itineraryRaw === null ? undefined : normalizeItinerary(itineraryRaw);
  const places = Array.isArray(raw.places)
    ? raw.places.flatMap((item) => {
        const place = objectValue(item);
        if (place === null) return [];
        const name = stringValue(place.name);
        const kind = stringValue(place.kind);
        const day = positiveNumber(place.day);
        if (name === undefined || kind === undefined || day === undefined) return [];
        return [{
          name,
          kind,
          day,
          ...optional("placeType", stringValue(place.placeType)),
          ...optional("date", stringValue(place.date)),
          ...optional("latitude", coordinate(place.latitude, -90, 90)),
          ...optional("longitude", coordinate(place.longitude, -180, 180)),
          ...optional("source", stringValue(place.source)),
        } satisfies TravelPlaceState];
      })
    : [];
  if (brief === undefined && itinerary === undefined && places.length === 0) return undefined;
  return {
    ...(brief === undefined ? {} : { brief }),
    ...(itinerary === undefined ? {} : { itinerary }),
    places: uniquePlaces(places),
    updatedAt: positiveNumber(raw.updatedAt) ?? now,
  };
}

function normalizeBrief(raw: Record<string, unknown>): TravelBriefState | undefined {
  const title = stringValue(raw.title);
  const destination = stringValue(raw.destination);
  if (title === undefined || destination === undefined) return undefined;
  return {
    title,
    destination,
    ...optional("startDate", stringValue(raw.startDate)),
    ...optional("endDate", stringValue(raw.endDate)),
    ...optional("roomCount", positiveNumber(raw.roomCount)),
    ...optional("travelers", positiveNumber(raw.travelers)),
    ...optional("budgetTotalYuan", positiveNumber(raw.budgetTotalYuan)),
    ...optional("budgetPerMealYuan", positiveNumber(raw.budgetPerMealYuan)),
    ...optional("accommodation", stringValue(raw.accommodation)),
    ...optional("pace", stringValue(raw.pace)),
    mustVisit: stringArray(raw.mustVisit),
    avoid: stringArray(raw.avoid),
    ...optional("tastePreferences", stringValue(raw.tastePreferences)),
    ...optional("notes", stringValue(raw.notes)),
  };
}

function normalizeItinerary(raw: Record<string, unknown>): TravelItineraryState | undefined {
  const title = stringValue(raw.title);
  const dayCount = positiveNumber(raw.dayCount);
  const itemCount = positiveNumber(raw.itemCount);
  if (title === undefined || dayCount === undefined || itemCount === undefined) return undefined;
  const counts = objectValue(raw.issueCount);
  const issueCount = counts === null
    ? undefined
    : {
        P0: nonNegativeNumber(counts.P0) ?? 0,
        P1: nonNegativeNumber(counts.P1) ?? 0,
        P2: nonNegativeNumber(counts.P2) ?? 0,
      };
  const issues = Array.isArray(raw.issues)
    ? raw.issues.flatMap((item) => normalizeIssue(item))
    : [];
  return {
    title,
    dayCount,
    itemCount,
    ...optional("score", nonNegativeNumber(raw.score)),
    ...optional("issueCount", issueCount),
    ...optional("strictPass", typeof raw.strictPass === "boolean" ? raw.strictPass : undefined),
    ...optional("complete", typeof raw.complete === "boolean" ? raw.complete : undefined),
    ...optional("revision", positiveNumber(raw.revision)),
    ...optional("timeline", stringValue(raw.timeline)),
    ...optional("itineraryId", stringValue(raw.itineraryId)),
    ...(Array.isArray(raw.repairDays) ? { repairDays: raw.repairDays.filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= dayCount) } : {}),
    ...(Array.isArray(raw.daySummaries) ? { daySummaries: raw.daySummaries.flatMap((value) => {
      const day = objectValue(value);
      return day !== null && positiveNumber(day.day) !== undefined && nonNegativeNumber(day.itemCount) !== undefined ? [{ date: stringValue(day.date), day: day.day as number, itemCount: day.itemCount as number, ...(typeof day.strictPass === "boolean" ? { strictPass: day.strictPass } : {}) }] : [];
    }) } : {}),
    issues,
  };
}

function normalizeIssue(value: unknown): TravelIssueState[] {
  const raw = objectValue(value);
  if (raw === null || (raw.level !== "P0" && raw.level !== "P1" && raw.level !== "P2")) return [];
  const message = stringValue(raw.message);
  if (message === undefined) return [];
  return [{
    level: raw.level,
    message,
    ...optional("day", positiveNumber(raw.day)),
    ...optional("code", stringValue(raw.code)),
  }];
}

function extractIssues(text: string): TravelIssueState[] {
  let level: TravelIssueState["level"] | undefined;
  const issues: TravelIssueState[] = [];
  for (const line of text.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      level = ["P0", "P1", "P2"].includes(heading[1]) ? heading[1] as TravelIssueState["level"] : undefined;
      continue;
    }
    if (level === undefined) continue;
    const match = /^- (?:Day (\d+) · )?(?:[^:：]+: )?(.+?)（([^）]+)）$/.exec(line.trim());
    if (match !== null) issues.push({ level, message: match[2].trim(), day: match[1] === undefined ? undefined : Number(match[1]), code: match[3] });
  }
  return issues.slice(0, 30);
}

function uniquePlaces(places: readonly TravelPlaceState[]): TravelPlaceState[] {
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.day}\n${place.date ?? ""}\n${normalizeName(place.name)}\n${place.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s·•()（）\-—_]/g, "");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function coordinate(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => {
        const text = stringValue(item);
        return text === undefined ? [] : [text];
      }))]
    : [];
}

function firstNumber(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
