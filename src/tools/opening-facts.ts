import { isKnownOpeningOfficial } from "./official-opening.ts";
import { createHash } from "node:crypto";
import { extractClosure, type ClosureSource } from "./closure-policy.ts";
import type { ItineraryOpeningHours } from "./itinerary-schema.ts";
import { sameVisitName } from "./required-visits.ts";
import { WEEKDAYS, clock as time, calendarDate as date, recurringScope, splitRecurringSections, scopeKey, hasScope, scopeApplies, validScope, otherOpeningSubject, type TimeRule, type AdmissionRule, type OpeningScope } from "./opening-schedule.ts";
export type { TimeRule } from "./opening-schedule.ts";

export const OPENING_POLICY_VERSION = 8;
export const OPENING_FIELDS = ["hours", "closure", "last_admission", "sessions", "notices"] as const;
export type OpeningField = typeof OPENING_FIELDS[number];
export type OpeningStatus = "verified" | "not_found" | "conflicting" | "needs_confirmation";
export type SourceKind = "official" | "government" | "platform" | "amap" | "osm" | "search";
const SOURCE_PRIORITY: Record<SourceKind, number> = { official: 4, government: 3, platform: 2, amap: 1, osm: 1, search: 0 };
export interface OpeningSource extends ClosureSource { readonly kind?: SourceKind; readonly content_kind?: "snippet" | "page" }
export interface OpeningSession { readonly starts: string; readonly ends?: string }
export interface OpeningValues {
  hours: readonly TimeRule[];
  closure: { readonly closed_on: readonly string[]; readonly holiday_exception: boolean };
  last_admission: string | readonly AdmissionRule[];
  sessions: readonly OpeningSession[];
  notices: { readonly closed_dates: readonly string[]; readonly closed_ranges: readonly { start: string; end?: string }[] };
}
export interface OpeningCitation { readonly title: string; readonly url?: string; readonly quote: string; readonly kind: SourceKind; readonly observed_at: number; readonly content_kind?: "snippet" | "page" }
export type OpeningFact = { [K in OpeningField]: {
  readonly id: string; readonly policy_version: number; readonly city: string; readonly name: string; readonly place_id?: string;
  readonly field: K; readonly status: OpeningStatus; readonly value?: OpeningValues[K]; readonly sources: readonly OpeningCitation[]; readonly observed_at: number;
} }[OpeningField];
export { WEEKDAYS } from "./opening-schedule.ts";

export function requestedOpeningFields(args: Record<string, unknown>): OpeningField[] {
  if (Array.isArray(args.fields)) {
    if (!args.fields.length || args.fields.some((f) => !OPENING_FIELDS.includes(f as OpeningField))) throw new Error("fields必须为hours/closure/last_admission/sessions/notices的非空数组");
    return [...new Set(args.fields as OpeningField[])].sort();
  }
  const name = String(args.place ?? "");
  return ["hours", ...(/博物|纪念馆|美术馆/.test(name) ? ["closure" as const] : []), ...(/喷泉|演出|剧场|灯光秀/.test(name) ? ["sessions" as const] : [])].sort() as OpeningField[];
}

function normalized(text: string): string { return text.replace(/：/g, ":").replace(/([\u4e00-\u9fff]{2,3})省(?=博物(?:馆|院))/g, "$1"); }
export function mentionsOpeningPlace(text: string, name: string, city: string): boolean {
  const source = normalized(text).replace(/\s+/g, "");
  const subject = normalized(name).replace(/\s+/g, "");
  const prefix = city.replace(/市$/, "");
  const local = prefix && subject.startsWith(prefix) ? subject.slice(prefix.length).replace(/^市/, "") : subject;
  return [subject, local, local.replace(/(?:旅游景区|旅游区|景区)$/, "")].some((alias) => alias.length >= 2 && source.includes(alias));
}
function sourceKind(source: OpeningSource, place: string, city: string): SourceKind {
  if (source.kind) return source.kind;
  if (source.engine === "official-web") return "official";
  try {
    const url = new URL(source.url ?? "");
    if (isKnownOpeningOfficial(url, place, city)) return "official";
    if (url.hostname.endsWith(".gov.cn")) return "government";
    if (url.hostname.endsWith(".ctrip.com") && /\/sight\//.test(url.pathname)) return "platform";
  } catch { /* 无URL不伪装成可追溯来源。 */ }
  return "search";
}
export function sourcePriority(fact: OpeningFact): number {
  return Math.max(-1, ...fact.sources.map((s) => SOURCE_PRIORITY[s.kind]));
}

const chinaDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });

export function isHistoricalOpening(fact: OpeningFact | undefined, now = Date.now()): boolean {
  return fact?.field === "hours" && fact.status === "verified" && Boolean(fact.value?.length
    && fact.value.every((rule) => rule.end_date !== undefined && rule.end_date < chinaDate.format(now)));
}

function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function closingMinute(rule: TimeRule): number {
  return clockMinutes(rule.closes) + (rule.closes < rule.opens ? 1440 : 0);
}

/** 官网票务表中的入园窗口与闭园时刻分开，月份列表保留实际适用范围。 */
function expandMonthlyAdmission(text: string): string {
  return text.replace(/(\d{1,2}月(?:(?:、|至)\d{1,2}月)+)\s*入园时间\s*:\s*(\d{1,2}:[0-5]\d)\s*[-—至]\s*(\d{1,2}:[0-5]\d)\s*[;；]\s*闭园时间\s*:\s*(\d{1,2}:[0-5]\d)/g,
    (original, months: string, opens: string, admission: string, closes: string) => {
      const values = [...months.matchAll(/(\d{1,2})月/g)].map((match) => Number(match[1]));
      if (values.some((month) => month < 1 || month > 12) || (months.includes("至") && values.length !== 2)) return original;
      const spans: Array<[number, number]> = [];
      if (months.includes("至")) spans.push([values[0]!, values[1]!]);
      else for (const month of values) {
        const previous = spans.at(-1);
        if (previous && month === previous[1] + 1) previous[1] = month;
        else spans.push([month, month]);
      }
      return spans.map(([start, end]) => {
        const last = new Date(Date.UTC(2000, end, 0)).getUTCDate();
        return `${start}月1日至${end}月${last}日 开放时间${opens}-${closes}，最后入园${admission}`;
      }).join("。");
    });
}

/** 只提取当前实体的句子；招聘、其他场馆及不明确季节条件不降格成通用事实。 */
export function extractOpeningFacts(city: string, name: string, sources: readonly OpeningSource[], requested: readonly OpeningField[], placeId?: string, now = Date.now()): OpeningFact[] {
  const candidates = new Map<OpeningField, { value: OpeningValues[OpeningField]; citation: OpeningCitation }[]>();
  const uncertain = new Map<OpeningField, OpeningCitation[]>();
  const add = <K extends OpeningField>(field: K, value: OpeningValues[K], citation: OpeningCitation) => candidates.set(field, [...candidates.get(field) ?? [], { value, citation }]);
  for (const source of sources.slice(0, 8)) {
    const subject = normalized(name), title = normalized(source.title);
    const body = normalized(source.snippet).slice(0, 4000)
      .replace(/(\d{1,2}:[0-5]\d)\s*[-‐‑‒–—―－~～]+\s*(?=\d{1,2}:[0-5]\d)/g, "$1-");
    if (!mentionsOpeningPlace(`${title}\n${body}`, subject, city) || /招聘|雇用|招标|培训资料|文库/.test(title)) continue;
    const kind = sourceKind(source, name, city), traceable = kind === "amap" || Boolean(source.url && /^https?:\/\//.test(source.url));
    const ambiguous = new Set<OpeningField>();
    // 先过滤完整句段，再拆字段分句；否则其他场馆逗号后的“停止入馆”会失去主语。
    const sentences = splitRecurringSections(expandMonthlyAdmission(body)).replace(/[，,](?=\s*(?:但|其中)?[^，,。；;\n]{2,28}(?:博物馆|博物院|纪念馆|街区)(?:开放时间|的开放时间|有参观时间|\s*\d{1,2}:))/g, "\n").split(/[。！？；;\n]|(?=(?:简介|服务内容|游玩时间|景点地址|出行攻略|门票(?:价格)?)\s*:)/).map((s) => s.trim()).filter((s) => {
      if (!s || /^(?:简介|服务内容|游玩时间|景点地址|出行攻略|门票(?:价格)?)\s*:/.test(s)) return false;
      if (/通行时间|交通路线|车程|地铁|公交|驾车|步行|热线|服务时间|选择入馆时段|(?:售票|预约)(?:时间|时段)/.test(s)) return false;
      const label = /^(.{2,40}?(?:博物馆|博物院|纪念馆|美术馆|公园|景区))\s*:/.exec(s)?.[1];
      const matches = mentionsOpeningPlace(s, subject, city);
      if (!matches && !mentionsOpeningPlace(title, subject, city)) return false;
      const otherVenue = /[\u4e00-\u9fff]{2,24}(?:博物馆|博物院|纪念馆|美术馆)/.test(s) && !matches;
      return (!label || sameVisitName(label, subject, city)) && !otherVenue && !otherOpeningSubject(s, subject, city) && !(/它们|这些场馆|类似|参考其他/.test(s) && !matches);
    }).flatMap((s) => /延时|试行|临时/.test(s) ? [s] : s.split(/[，,](?=\s*(?:周|星期|每周|开放|开馆|入馆|最后|最晚|《[^》]+》|\d{1,2}:[0-5]\d\s*(?:停止|截止)))/));
    const text = sentences.join("；"), citation: OpeningCitation = { title: source.title, url: source.url, quote: text, kind, observed_at: now, content_kind: source.content_kind };
    const hours: TimeRule[] = [], sessions: OpeningSession[] = [], admissions: AdmissionRule[] = [];
    const tables = new Map<string, { scope: OpeningScope; opens: Set<string>; closes: Set<string> }>();
    let activeScope: OpeningScope = {}, unclearScope = false;
    for (const sentence of sentences) {
      const recurring = recurringScope(sentence);
      if (recurring) { activeScope = recurring; unclearScope = false; }
      else if (/^(?:旺季|淡季|夏季|冬季|暑期)/.test(sentence)
        || (!/\d{4}[-年]/.test(sentence) && /\d{1,2}月\d{1,2}日?\s*(?:至|到|[-—~])/.test(sentence))) { activeScope = {}; unclearScope = true; }
      const ranges = [...sentence.matchAll(/(\d{1,2}:[0-5]\d)\s*[-—~至到]\s*(\d{1,2}:[0-5]\d)/g)].flatMap((m) => {
        const opens = time(m[1]!), closes = time(m[2]!); return opens && closes && opens !== "24:00" && opens !== closes ? [{ opens, closes }] : [];
      });
      const namedOpen = /(?:开放入[馆园场]|开馆|开园|开始参观)(?:时间)?\s*:?\s*(\d{1,2}:[0-5]\d)/.exec(sentence)?.[1];
      const namedClose = /(?:闭馆|闭园|停止开放|结束营业)(?:时间)?\s*:?\s*(\d{1,2}:[0-5]\d)/.exec(sentence)?.[1];
      const event = /场次|第[一二三四五六七八九十\d]+场|开演|喷泉|水幕电影|灯光秀|(?:演出|表演)\s*(?:开放)?\s*时间|喷放时间|各一场/.test(sentence);
      const conditional = /并非|不是|不再|曾经|此前|原定|原为|旧公告|淡季|旺季|冬季|夏季|暑期|节假日|\d{1,2}月\d{1,2}日/.test(sentence);
      if (event && (conditional || /\d{4}[-年]|(?:周|星期)[一二三四五六日天]/.test(sentence) || ranges.some((r) => r.closes === "24:00"))) ambiguous.add("sessions");
      else if (event) {
        if (ranges.length) sessions.push(...ranges.map((r) => ({ starts: r.opens, ends: r.closes })));
        else sessions.push(...[...sentence.matchAll(/\d{1,2}:[0-5]\d/g)].flatMap((m) => { const t = time(m[0]); return t && t !== "24:00" ? [{ starts: t }] : []; }));
      }
      const admission = /(?:最后|最晚|停止|截止)(?:入场|入馆|入园|检票)(?:时间)?\s*:?\s*(\d{1,2}:[0-5]\d)|(\d{1,2}:[0-5]\d)\s*(?:停止|截止)(?:入场|入馆|入园|检票)/.exec(sentence);
      const hasFullDate = /\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月\d{1,2}日)/.test(sentence);
      const unsupported = /非全天|不全天|并非|不是|不再|曾经|此前|原定|原为|旧公告/.test(sentence)
        || (!hasFullDate && /节假日|临时|调整(?!为|至)/.test(sentence))
        || (!hasFullDate && !activeScope.start_month_day && (/淡季|旺季|冬季|夏季|暑期|\d{1,2}月\d{1,2}日|\d{1,2}日期间/.test(sentence) || unclearScope));
      if (unsupported) {
        if (ranges.length || namedOpen || namedClose || /全天开放|全天营业|24\s*小时(?:开放|营业)/.test(sentence)) ambiguous.add("hours");
        if (admission) ambiguous.add("last_admission"); continue;
      }
      const dates = [...sentence.matchAll(/\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月\d{1,2}日)/g)].flatMap((m) => { const d = date(m[0]); return d ? [d] : []; });
      const weekRange = /(?:周|星期)([一二三四五六日天])\s*(?:至|到|[-—])\s*(?:周|星期)?([一二三四五六日天])/.exec(sentence);
      const singleWeek = /(?:每周|周|星期)([一二三四五六日天])/.exec(sentence);
      let weekdays: string[] | undefined;
      const firstTime = sentence.search(/\d{1,2}:[0-5]\d/);
      if (weekRange) {
        const a = "日一二三四五六".indexOf(weekRange[1]!.replace("天", "日")), b = "日一二三四五六".indexOf(weekRange[2]!.replace("天", "日"));
        weekdays = []; for (let i = a; ; i = (i + 1) % 7) { weekdays.push(WEEKDAYS[i]!); if (i === b) break; }
      } else if (/周末/.test(sentence)) weekdays = ["Saturday", "Sunday"];
      else if (/工作日/.test(sentence)) weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      else if (singleWeek && (firstTime < 0 || singleWeek.index < firstTime)) weekdays = [...new Set([...sentence.slice(0, firstTime < 0 ? undefined : firstTime).matchAll(/(?:每周|周|星期)([一二三四五六日天])/g)].map((m) => WEEKDAYS["日一二三四五六".indexOf(m[1]!.replace("天", "日"))]!))];
      if (dates.length > 2 || (dates.length === 2 && (!/至|到|—|~|\d\s*-\s*\d{4}/.test(sentence) || dates[0]! > dates[1]!))) { if (ranges.length) ambiguous.add("hours"); continue; }
      const scope: OpeningScope = { ...(dates.length ? {} : activeScope), ...(weekdays ? { weekdays } : {}), ...(dates.length ? {
        ...(!/截至|截止/.test(sentence) ? { start_date: dates[0] } : {}),
        ...(!(dates.length === 1 && /起|开始|自|从/.test(sentence)) ? { end_date: dates.at(-1) } : {}),
      } : {}) };
      if (!validScope(scope)) { if (ranges.length || namedOpen || namedClose) ambiguous.add("hours"); if (admission) ambiguous.add("last_admission"); continue; }
      // 独立日期/星期表头约束后续行；闭馆公告中的日期和星期不能变成开放表头。
      if (!/\d{1,2}:[0-5]\d|闭馆|闭园|暂停|停止|公告|发布/.test(sentence) && (dates.length || weekdays)) { activeScope = scope; unclearScope = false; }
      if (hasFullDate && dates.length === 0) { activeScope = {}; unclearScope = true; if (ranges.length || namedOpen || namedClose) ambiguous.add("hours"); continue; }
      if (admission) { const t = time(admission[1] ?? admission[2]!); if (t && t !== "24:00") admissions.push({ time: t, ...scope }); else ambiguous.add("last_admission"); }
      if (!ranges.length && (namedOpen || namedClose)) {
        const key = scopeKey(scope), table = tables.get(key) ?? { scope, opens: new Set<string>(), closes: new Set<string>() };
        const opens = namedOpen && time(namedOpen), closes = namedClose && time(namedClose);
        if (opens && opens !== "24:00") table.opens.add(opens);
        if (closes) table.closes.add(closes);
        tables.set(key, table);
      }
      if (/24\s*小时(?:营业|开放)|全天开放|全天营业|开放时间\s*:?\s*全天(?:24小时)?/.test(sentence)) hours.push({ opens: "00:00", closes: "24:00", ...scope });
      else if (!event && !/(?:上午票|下午票|夜场票)\s*入园时间/.test(sentence)) hours.push(...ranges.map((r) => ({ ...r, ...scope })));
    }
    for (const table of tables.values()) {
      // 同一日期块中，明确“闭馆时间”优先于未标用途的区间终点。
      // 仅借用唯一的开始时刻，不把未标明用途的终点推断为最后入场。
      if (table.opens.size === 0 && table.closes.size === 1) {
        const matching = hours.filter((rule) => scopeKey(rule) === scopeKey(table.scope));
        const starts = new Set(matching.map((rule) => rule.opens));
        if (starts.size === 1) {
          const opens = [...starts][0]!, closes = [...table.closes][0]!;
          if (opens !== closes) {
            for (let i = hours.length - 1; i >= 0; i--) if (scopeKey(hours[i]!) === scopeKey(table.scope)) hours.splice(i, 1);
            hours.push({ opens, closes, ...table.scope });
          }
        }
      }
      if (table.opens.size === 1 && table.closes.size === 1) {
        const opens = [...table.opens][0]!, closes = [...table.closes][0]!;
        if (opens !== closes) hours.push({ opens, closes, ...table.scope }); else ambiguous.add("hours");
      } else if ((table.opens.size || table.closes.size) && !hours.some((r) => scopeKey(r) === scopeKey(table.scope)
        && (table.opens.size === 0 || (table.opens.size === 1 && table.opens.has(r.opens))) && (table.closes.size === 0 || (table.closes.size === 1 && table.closes.has(r.closes))))) ambiguous.add("hours");
    }
    const submit = <K extends OpeningField>(field: K, value: OpeningValues[K]) => {
      if (ambiguous.has(field)) return;
      if (traceable || kind === "osm") add(field, value, citation);
      else ambiguous.add(field);
    };
    const distinctHours = [...new Map(hours.map((r) => [JSON.stringify(r), r])).values()];
    const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    const overlaps = distinctHours.some((a, i) => distinctHours.slice(i + 1).some((b) => scopeKey(a) === scopeKey(b)
      && Math.max(minutes(a.opens), minutes(b.opens)) < Math.min(minutes(a.closes), minutes(b.closes))));
    if (overlaps || distinctHours.length > 30) ambiguous.add("hours"); else if (distinctHours.length && !ambiguous.has("hours")) submit("hours", distinctHours);
    if (sessions.length > 30) ambiguous.add("sessions"); else if (sessions.length) submit("sessions", [...new Map(sessions.map((r) => [JSON.stringify(r), r])).values()]);
    const distinctAdmissions = [...new Map(admissions.map((r) => [JSON.stringify(r), r])).values()];
    if (distinctAdmissions.length > 30 || distinctAdmissions.some((a, i) => distinctAdmissions.slice(i + 1).some((b) => scopeKey(a) === scopeKey(b) && a.time !== b.time))) ambiguous.add("last_admission");
    else if (distinctAdmissions.length) submit("last_admission", distinctAdmissions.length === 1 && !hasScope(distinctAdmissions[0]!) ? distinctAdmissions[0]!.time : distinctAdmissions);
    const closureText = sentences.filter((s) => !/调整为|恢复/.test(s) || /闭馆|休馆|无休/.test(s)).join("；");
    const closure = extractClosure(name, [{ ...source, title: name, snippet: closureText }]);
    if (closure.verified) submit("closure", { closed_on: closure.closed_on, holiday_exception: closure.holiday_exception });
    else if (closure.mentioned) ambiguous.add("closure");
    const closedDates: string[] = [], closedRanges: { start: string; end?: string }[] = [];
    for (const sentence of sentences) {
      // “某日17:00闭馆”是当天关门时刻，不是全天闭馆公告。
      const notice = sentence.replace(/\d{1,2}:[0-5]\d\s*(?:闭馆|闭园|停止开放)/g, "")
        .replace(/(?:闭馆|闭园|停止开放)(?:时间)?\s*:?\s*\d{1,2}:[0-5]\d/g, "");
      if (!/闭馆|暂停开放|停止开放|闭园/.test(notice) || /不闭馆|正常开放|照常开放|取消闭馆/.test(notice)) continue;
      if (/若|如遇|遇到|遇恶劣|视天气|视情况/.test(notice)) continue;
      if (/曾经|此前|原定|原为|旧公告/.test(notice) || (/(?:每周|周|星期)[一二三四五六日天]/.test(notice) && !/临时|暂停/.test(notice))) continue;
      const dates = [...sentence.matchAll(/\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月\d{1,2}日)/g)].flatMap((m) => { const d = date(m[0]); return d ? [d] : []; });
      if (dates.length === 1 && /(?:即日|日起|\d起)|(?:自|从).{0,20}(?:暂停|停止)开放/.test(sentence)) closedRanges.push({ start: dates[0]! });
      else if (dates.length === 1) closedDates.push(dates[0]!);
      else if (dates.length === 2 && /至|到|—|~/.test(sentence) && dates[0]! <= dates[1]!) closedRanges.push({ start: dates[0]!, end: dates[1]! });
      else if (dates.length) ambiguous.add("notices");
      else if (/\d{1,2}月\d{1,2}日|近日|即日起|临时/.test(sentence)) ambiguous.add("notices");
    }
    if (closedDates.length || closedRanges.length) submit("notices", { closed_dates: [...new Set(closedDates)], closed_ranges: closedRanges });
    for (const field of ambiguous) uncertain.set(field, [...uncertain.get(field) ?? [], citation]);
  }
  const fields = new Set<OpeningField>([...requested, ...candidates.keys(), ...uncertain.keys()]);
  const today = chinaDate.format(now);
  return [...fields].map((field) => {
    const values = candidates.get(field) ?? [];
    const current = field === "hours" ? values.filter(({ value }) =>
      (value as OpeningValues["hours"]).some((rule) => !rule.end_date || rule.end_date >= today)) : values;
    const eligible = current.length ? current : values;
    const priority = (s: OpeningCitation) => SOURCE_PRIORITY[s.kind] * 2 + Number(s.content_kind === "page");
    const best = eligible.filter((v) => priority(v.citation) === Math.max(...eligible.map((r) => priority(r.citation))));
    if (field === "hours") {
      // 比较同级来源各自最后一段的闭园时刻，完整保留选中来源的时段和适用条件。
      const closes = (value: OpeningValues[OpeningField]) =>
        Math.max(...(value as OpeningValues["hours"]).map(closingMinute));
      best.sort((a, b) => closes(a.value) - closes(b.value));
    }
    const first = best[0]?.value;
    const differs = field !== "hours" && best.some(({ value }) => first !== undefined && openingValuesConflict(field, first, value));
    const unresolved = best.length === 0 && (uncertain.get(field)?.length ?? 0) > 0;
    const status: OpeningStatus = unresolved ? "needs_confirmation" : differs ? "conflicting" : best.length ? "verified" : "not_found";
    let value = status === "verified" ? first : undefined;
    if (value && field === "closure") value = { ...(value as OpeningValues["closure"]), holiday_exception: best.some((v) => (v.value as OpeningValues["closure"]).holiday_exception) };
    const citations = unresolved ? uncertain.get(field)! : best.filter((v) => status !== "verified" || field === "closure" || JSON.stringify(v.value) === JSON.stringify(value)).map((v) => v.citation);
    const id = createHash("sha256").update(JSON.stringify([OPENING_POLICY_VERSION, city, placeId ?? name, field, status, value, citations.map((s) => [s.url, s.kind, s.quote])])).digest("hex").slice(0, 20);
    return { id, policy_version: OPENING_POLICY_VERSION, city, name, place_id: placeId, field, status, value, sources: citations, observed_at: now } as OpeningFact;
  });
}

function openingValuesConflict(field: OpeningField, a: OpeningValues[OpeningField], b: OpeningValues[OpeningField]): boolean {
  if (field === "last_admission") {
    const byDay = (value: OpeningValues[OpeningField]) => {
      const rules = typeof value === "string" ? [{ time: value }] : value as readonly AdmissionRule[];
      const slots = new Map<string, Set<string>>();
      for (const rule of rules) for (const weekday of rule.weekdays ?? WEEKDAYS) {
        const key = `${scopeKey({ ...rule, weekdays: undefined })}:${weekday}`;
        const times = slots.get(key) ?? new Set<string>();
        times.add(rule.time);
        slots.set(key, times);
      }
      return slots;
    };
    // 常规与限时安排可以不同。只比较同一日期范围内双方都给出的星期时段。
    const right = byDay(b);
    return [...byDay(a)].some(([key, times]) => {
      const matching = right.get(key);
      return matching !== undefined && (times.size !== matching.size || [...times].some((time) => !matching.has(time)));
    });
  }
  if (field === "closure") {
    const days = (value: OpeningValues[OpeningField]) => [...(value as OpeningValues["closure"]).closed_on].sort().join(",");
    return days(a) !== days(b);
  }
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function ruleApplies(rule: TimeRule, day?: string): boolean { return scopeApplies(rule, day); }
export function lastAdmissionFor(fact: OpeningFact | undefined, day?: string): string | undefined {
  if (fact?.field !== "last_admission" || fact.status !== "verified" || !fact.value) return undefined;
  if (typeof fact.value === "string") return fact.value;
  const values = new Set(fact.value.filter((r) => scopeApplies(r, day)).map((r) => r.time));
  return values.size === 1 ? [...values][0] : undefined;
}
export function openingHoursFor(fact: OpeningFact | undefined, day?: string, admission?: OpeningFact): ItineraryOpeningHours | undefined {
  if (fact?.field !== "hours" || fact.status !== "verified" || !fact.value) return undefined;
  const applicable = fact.value.filter((rule) => ruleApplies(rule, day));
  if (!applicable.length) return undefined;
  const rules: TimeRule[] = [];
  for (const rule of applicable.sort((a, b) => closingMinute(a) - closingMinute(b))) {
    const overlaps = rules.some((chosen) => Math.max(clockMinutes(chosen.opens), clockMinutes(rule.opens))
      < Math.min(closingMinute(chosen), closingMinute(rule)));
    if (!overlaps) rules.push(rule);
  }
  rules.sort((a, b) => a.opens.localeCompare(b.opens));
  const lastAdmission = lastAdmissionFor(admission, day);
  return { opens: rules[0]!.opens, closes: rules[0]!.closes, intervals: rules.map(({ opens, closes }) => ({ opens, closes })), source: fact.sources[0]?.url ?? fact.sources[0]?.kind,
    ...(lastAdmission ? { last_admission: lastAdmission } : {}) };
}

export function validOpeningFact(value: unknown): value is OpeningFact {
  if (!value || typeof value !== "object") return false;
  const r = value as OpeningFact;
  // 上一版已经取到的时段仍可用，旧开放时段冲突需要按新规则重查。
  const compatible = r.policy_version === OPENING_POLICY_VERSION || ((r.policy_version === 5 || r.policy_version === 6 || r.policy_version === 7) && r.field !== "closure" && (r.field !== "hours" || r.status !== "conflicting"));
  if (!compatible || typeof r.id !== "string" || typeof r.city !== "string" || typeof r.name !== "string" || !Number.isFinite(r.observed_at)
    || !OPENING_FIELDS.includes(r.field) || !["verified", "not_found", "conflicting", "needs_confirmation"].includes(r.status) || !Array.isArray(r.sources)
    || !r.sources.every((s) => s && ["official", "government", "platform", "amap", "osm", "search"].includes(s.kind) && typeof s.quote === "string")) return false;
  if (r.status !== "verified") return r.value === undefined;
  if (r.field === "hours") return Array.isArray(r.value) && r.value.length > 0 && r.value.every((v) => Boolean(v && time(v.opens) && v.opens !== "24:00" && time(v.closes) && v.opens !== v.closes && validScope(v)));
  if (r.field === "closure") return Boolean(r.value && Array.isArray(r.value.closed_on) && r.value.closed_on.every((d) => (WEEKDAYS as readonly string[]).includes(d)) && typeof r.value.holiday_exception === "boolean");
  if (r.field === "last_admission") return typeof r.value === "string" ? Boolean(time(r.value) && r.value !== "24:00")
    : Array.isArray(r.value) && r.value.length > 0 && r.value.every((v) => v && time(v.time) && v.time !== "24:00" && validScope(v));
  if (r.field === "sessions") return Array.isArray(r.value) && r.value.every((v) => v && time(v.starts) && (!v.ends || time(v.ends)));
  return Boolean(r.value && Array.isArray(r.value.closed_dates) && r.value.closed_dates.every((v) => date(v)) && Array.isArray(r.value.closed_ranges) && r.value.closed_ranges.every((v) => date(v.start) && (v.end === undefined || (date(v.end) && v.start <= v.end))));
}
