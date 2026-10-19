import type { Tool } from "./tool.ts";
import { geocodeLocation, regionLabel, type GeoResult } from "./geocoding.ts";
import { requireString } from "./tool.ts";

type FetchLike = typeof fetch;

/** WMO 天气代码 → 中文描述（常用子集） */
const WEATHER_CODES: Record<number, string> = {
  0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "毛毛雨", 55: "浓毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "强阵雨", 82: "暴雨",
  85: "阵雪", 86: "强阵雪",
  95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

/** 逐日预报窗口：Open-Meteo 最多预报今天起 16 天（第 17 天返回 out of allowed range） */
const MAX_FORECAST_DAYS = 16;
const DEFAULT_FORECAST_DAYS = 3;
/** 可靠性分档：第 8 天起降水误差明显增大，第 11 天起只能看趋势 */
const LOW_CONFIDENCE_OFFSET = 7;
const TREND_ONLY_OFFSET = 10;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface DailyForecast {
  readonly time: string[];
  readonly weather_code?: Array<number | null>;
  readonly temperature_2m_max?: Array<number | null>;
  readonly temperature_2m_min?: Array<number | null>;
  readonly precipitation_sum?: Array<number | null>;
}

export function createWeatherTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "get_weather",
    description:
      "查询指定地点的天气预报（温度、天气状况、降水量）。默认查未来 3 天，最多 16 天；" +
      "已知出行日期时用 start_date/end_date 直接查行程期间。" +
      "超出预报范围、服务不可用或数据可靠性差时，必须如实向用户说明，不要编造天气。",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "城市或地点名，例如：杭州" },
        days: { type: "number", description: "从今天起预报天数 1-16，默认 3；与 start_date/end_date 二选一" },
        start_date: { type: "string", description: "起始日期 YYYY-MM-DD（查行程期间时用）" },
        end_date: { type: "string", description: "结束日期 YYYY-MM-DD，省略时等于 start_date" },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = requireString(args, "location");
      if (args.start_date !== undefined && !isDateString(args.start_date)) {
        return "start_date 必须是 YYYY-MM-DD 格式，例如 2026-10-20";
      }
      if (args.end_date !== undefined && !isDateString(args.end_date)) {
        return "end_date 必须是 YYYY-MM-DD 格式，例如 2026-10-22";
      }

      const geo: GeoResult | null = await geocodeLocation(location, fetchFn);
      if (geo === null) {
        return `未找到地点: ${location}`;
      }

      const today = todayISO();
      const range = resolveRange(
        today,
        addDaysISO(today, MAX_FORECAST_DAYS - 1),
        isDateString(args.start_date) ? args.start_date : undefined,
        isDateString(args.end_date) ? args.end_date : undefined,
        typeof args.days === "number" ? args.days : DEFAULT_FORECAST_DAYS,
      );
      if (typeof range === "string") return range;

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&start_date=${range.start}&end_date=${range.end}&timezone=auto`;
      const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        return cannotFetch(geo.name, `天气服务返回 HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        readonly reason?: string;
        readonly daily?: DailyForecast;
      };
      const daily = data.daily;
      if (daily === undefined) {
        return cannotFetch(geo.name, data.reason ?? "天气服务未返回逐日数据");
      }

      const region = [regionLabel(geo), geo.country].filter(Boolean).join(", ");
      const lines = [
        `${geo.name}${region === "" ? "" : ` (${region})`} 天气预报 ${range.start} ~ ${range.end}（当地时间）:`,
      ];
      let farDays = 0;
      for (let i = 0; i < daily.time.length; i += 1) {
        const code = daily.weather_code?.[i] ?? null;
        const min = daily.temperature_2m_min?.[i] ?? null;
        const max = daily.temperature_2m_max?.[i] ?? null;
        const precipitation = daily.precipitation_sum?.[i] ?? null;
        const offset = daysBetween(today, daily.time[i]);
        if (offset >= LOW_CONFIDENCE_OFFSET) farDays += 1;
        lines.push(
          `${daily.time[i]}: ${code === null ? "天气数据缺失" : (WEATHER_CODES[code] ?? `未知代码 ${code}`)}, ` +
            `${min === null || max === null ? "温度数据缺失" : `${min}~${max}°C`}, ` +
            `${precipitation === null ? "降水数据缺失" : `降水 ${precipitation}mm`}${confidenceNote(offset)}`,
        );
      }
      if (farDays > 0) {
        lines.push(
          `说明：第 ${LOW_CONFIDENCE_OFFSET + 1} 天起的预报误差明显增大（尤其降水），越远越只能看趋势，临近出行时请复核。`,
        );
      }
      const lastDay = daily.time[daily.time.length - 1];
      if (lastDay !== undefined && lastDay < range.end) {
        lines.push(`注意：实际只返回 ${range.start} ~ ${lastDay}，${addDaysISO(lastDay, 1)} 之后没有预报数据，请如实说明。`);
      }
      lines.push(...range.notes);
      return lines.join("\n");
    },
  };
}

/** 查询区间：已知出行日期用 start_date/end_date，否则按 days 从今天起算；超出窗口的部分裁剪并说明 */
function resolveRange(
  today: string,
  horizonEnd: string,
  startDate: string | undefined,
  endDate: string | undefined,
  days: number,
): { readonly start: string; readonly end: string; readonly notes: readonly string[] } | string {
  if (startDate !== undefined || endDate !== undefined) {
    const start = startDate ?? today;
    const end = endDate ?? start;
    if (start > end) return `起始日期 ${start} 晚于结束日期 ${end}，请调整后重试`;
    if (start > horizonEnd) {
      return (
        `无法获取 ${start} ~ ${end} 的天气预报：超出预报范围（最多预报今天起 ${MAX_FORECAST_DAYS} 天，即 ${today} ~ ${horizonEnd}）。` +
        "请如实告知用户该期间暂无预报数据，不要编造；建议临近出行（两周内）再查。"
      );
    }
    if (end <= horizonEnd) return { start, end, notes: [] };
    return {
      start,
      end: horizonEnd,
      notes: [
        `注意：${addDaysISO(horizonEnd, 1)} ~ ${end} 超出预报范围（最多预报今天起 ${MAX_FORECAST_DAYS} 天），` +
          "未覆盖的日期没有可用的天气预报，请如实告知用户，不要编造。",
      ],
    };
  }

  const requested = Number.isFinite(days) ? Math.floor(days) : DEFAULT_FORECAST_DAYS;
  const count = Math.min(MAX_FORECAST_DAYS, Math.max(1, requested));
  return {
    start: today,
    end: addDaysISO(today, count - 1),
    notes:
      requested > MAX_FORECAST_DAYS
        ? [`注意：请求了 ${requested} 天，但预报最多 ${MAX_FORECAST_DAYS} 天，已按上限返回；更远日期没有预报数据，请如实说明。`]
        : [],
  };
}

/** 拿不到数据时的统一话术：明确不可用 + 禁止编造 */
function cannotFetch(name: string, reason: string): string {
  return `无法获取${name}的天气预报（${reason}）。请如实告知用户当前拿不到天气数据，不要凭常识推测或编造；可稍后重试。`;
}

/** 逐日预报可靠性随距离衰减：远日直接标注，避免模型把远期预报当成确定信息 */
function confidenceNote(offset: number): string {
  if (offset >= TREND_ONLY_OFFSET) return "（远期，仅供趋势参考）";
  if (offset >= LOW_CONFIDENCE_OFFSET) return "（较远，参考性低）";
  return "";
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value);
}

function todayISO(): string {
  const now = new Date();
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 日期加减：按 UTC 计算，避开夏令时导致的"差一天" */
function addDaysISO(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return isoFromParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function daysBetween(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000,
  );
}
