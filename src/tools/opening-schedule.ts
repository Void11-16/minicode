import { sameVisitName } from "./required-visits.ts";
export interface OpeningScope {
  readonly weekdays?: readonly string[];
  readonly start_date?: string;
  readonly end_date?: string;
  readonly start_month_day?: string;
  readonly end_month_day?: string;
}
export interface TimeRule extends OpeningScope { readonly opens: string; readonly closes: string }
export interface AdmissionRule extends OpeningScope { readonly time: string }
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function clock(value: string): string | undefined {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(value); if (!m) return undefined;
  const hour = Number(m[1]); if (hour > 24 || (hour === 24 && m[2] !== "00")) return undefined;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}
export function calendarDate(value: string): string | undefined {
  const m = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/.exec(value); if (!m) return undefined;
  const iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : undefined;
}
function monthDay(month: string, day: string): string | undefined { return calendarDate(`2000-${month}-${day}`)?.slice(5); }
const MONTH_RANGE = /(?:每年)?(\d{1,2})月(\d{1,2})日?\s*(?:至|到|[-—~])\s*(?:次年|来年)?(\d{1,2})月(\d{1,2})日?|\b(\d{1,2})\.(\d{1,2})\s*(?:至|到|[-—~])\s*(\d{1,2})\.(\d{1,2})\b/g;

/** 每年重复的日期范围，跨年用首尾月日比较，不把冬季扩大成全年。 */
export function recurringScope(text: string): OpeningScope | undefined {
  if (/\d{4}[-年]/.test(text)) return undefined;
  for (const match of text.matchAll(new RegExp(MONTH_RANGE.source, "g"))) {
    if (match[5] && !/每年|旺季|淡季|夏季|冬季/.test(text) && match.index !== 0) continue;
    const start = monthDay(match[1] ?? match[5]!, match[2] ?? match[6]!), end = monthDay(match[3] ?? match[7]!, match[4] ?? match[8]!);
    if (start && end) return { start_month_day: start, end_month_day: end };
  }
  return undefined;
}

/** 同一摘要内的两张季节时刻表也保留独立边界。 */
export function splitRecurringSections(text: string): string {
  return text.replace(new RegExp(MONTH_RANGE.source, "g"), (match, ...args: unknown[]) => {
    const offset = args.at(-2) as number;
    return /\d{4}年\s*$/.test(text.slice(Math.max(0, offset - 8), offset)) ? match : `\n${match}`;
  });
}
export function scopeKey(scope: OpeningScope): string { return JSON.stringify([scope.weekdays, scope.start_date, scope.end_date, scope.start_month_day, scope.end_month_day]); }
export function hasScope(scope: OpeningScope): boolean { return [scope.weekdays, scope.start_date, scope.end_date, scope.start_month_day, scope.end_month_day].some((v) => v !== undefined); }
export function scopeApplies(scope: OpeningScope, day?: string): boolean {
  if (!hasScope(scope)) return true;
  if (!day || !calendarDate(day)) return false;
  const md = day.slice(5), a = scope.start_month_day, b = scope.end_month_day;
  const annual = !a || !b || (a <= b ? md >= a && md <= b : md >= a || md <= b);
  return annual && (!scope.start_date || day >= scope.start_date) && (!scope.end_date || day <= scope.end_date)
    && (!scope.weekdays || scope.weekdays.includes(WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!));
}
export function validScope(value: OpeningScope): boolean {
  return (!value.weekdays || (Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.every((d: string) => (WEEKDAYS as readonly string[]).includes(d))))
    && (!value.start_date || Boolean(calendarDate(value.start_date))) && (!value.end_date || Boolean(calendarDate(value.end_date)))
    && (!value.start_date || !value.end_date || value.start_date <= value.end_date)
    && ((value.start_month_day === undefined && value.end_month_day === undefined) || Boolean(value.start_month_day && value.end_month_day
      && /^\d{2}-\d{2}$/.test(value.start_month_day) && /^\d{2}-\d{2}$/.test(value.end_month_day)
      && calendarDate(`2000-${value.start_month_day}`) && calendarDate(`2000-${value.end_month_day}`)));
}

/** 不同场馆/子区域有明确主语时，不把其营业或公告规则归到页面所属主景区。 */
export function otherOpeningSubject(text: string, name: string, city?: string): boolean {
  if (!/博物馆|博物院|纪念馆|美术馆/.test(name) && !text.includes(name)
    && /[\u4e00-\u9fff]{2,24}(?:博物馆|博物院|纪念馆|美术馆)/.test(text)) return true;
  const generic = /^(?:本馆|本院|我馆|我院|全馆|全院|全园|本园|本景区|全景区)$/;
  const matches = text.matchAll(/(?:^|[\s，,:：“”"、])([\u4e00-\u9fff]{2,24}(?:博物院|博物馆|纪念馆|美术馆|展厅|景区|公园|馆|殿|宫|阁|楼|园|区域))(?=、|将于|将自|于\d|自\d|从\d|停止入|停止检票|暂停开放|停止开放|临时闭馆|临时闭园|闭馆时间|开馆时间|开放时间)/g);
  for (const match of matches) {
    const subject = match[1]!.replace(/^关于|^其中|^包括/, "").replace(/^.*(?:提供|介绍|显示)/, "");
    if (!generic.test(subject) && !sameVisitName(subject, name, city)) return true;
  }
  // 带景区名的体育设施也可能有独立时段。
  const sport = /([\u4e00-\u9fff]{0,16}(?:网球场|游泳场|游泳池|泳池|体育馆|体育场))[,，]?(?=的?(?:开放时间|闭馆时间|营业时间))/.exec(text)?.[1];
  if (sport && !sameVisitName(sport.replace(/^(?:有限)?开放(?:室[内外])?/, ""), name, city)) return true;
  return /(?:部分|个别|局部)(?:区域|展厅|场馆|景点|园区).{0,30}(?:暂停|停止|关闭|闭馆)/.test(text);
}
