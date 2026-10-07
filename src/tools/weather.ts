import type { Tool } from "./tool.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
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

export function createWeatherTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "get_weather",
    description: "查询指定地点未来几天的天气预报（温度、天气状况、降水量）。做行程规划时先用它了解目的地天气。",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "城市或地点名，例如：杭州" },
        days: { type: "number", description: "预报天数 1-7，默认 3" },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = requireString(args, "location");
      const days = Math.min(7, Math.max(1, Math.floor(typeof args.days === "number" ? args.days : 3)));

      const geo: GeoResult | null = await geocodeLocation(location, fetchFn);
      if (geo === null) {
        return `未找到地点: ${location}`;
      }

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&forecast_days=${days}&timezone=auto`;
      const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        throw new Error(`天气服务返回 ${response.status}`);
      }

      const data = (await response.json()) as {
        daily?: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_sum: number[];
        };
      };
      const daily = data.daily;
      if (daily === undefined) {
        throw new Error("天气服务返回数据不完整");
      }

      const region = [geo.admin1, geo.country].filter(Boolean).join(", ");
      const lines = [`${geo.name}${region === "" ? "" : ` (${region})`} 未来 ${days} 天天气:`];
      for (let i = 0; i < daily.time.length; i++) {
        const desc = WEATHER_CODES[daily.weather_code[i]] ?? `未知代码 ${daily.weather_code[i]}`;
        lines.push(
          `${daily.time[i]}: ${desc}, ${daily.temperature_2m_min[i]}~${daily.temperature_2m_max[i]}°C, 降水 ${daily.precipitation_sum[i]}mm`,
        );
      }
      return lines.join("\n");
    },
  };
}
