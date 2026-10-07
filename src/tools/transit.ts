import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { haversineKm } from "./geo.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
import { getAmapClient } from "./amap-access.ts";
import { fetchOsrmRoute } from "./route.ts";

type FetchLike = typeof fetch;

interface LegResult {
  readonly from: string;
  readonly to: string;
  readonly mode: string;
  readonly durationMin: number;
  readonly detail: string;
  readonly estimated: boolean;
}

/** 单段通勤超过该分钟数时标记建议调整（顺序/住宿） */
const LONG_LEG_MINUTES = 60;

/**
 * 一天行程的通勤规划：按访问顺序对相邻地点逐段计算
 * 公交/地铁（高德）→ 驾车（OSRM）→ 直线距离估算 的降级链，
 * 输出每段方式与耗时、全天通勤合计，并标记过长路段。
 */
export function createPlanRoutesTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "plan_day_routes",
    description:
      "规划行程中相邻地点之间的通勤：按访问顺序传入地点列表，逐段返回交通方式（公交/地铁优先，" +
      "降级驾车）与耗时、步行距离、全天通勤总时长，并标记超过 60 分钟的路段。" +
      "生成或调整行程顺序后必须调用它验证可行性，并在行程中标注每段的通勤方式与耗时；两地单段查询也可用。",
    parameters: {
      type: "object",
      properties: {
        stops: {
          type: "array",
          items: { type: "string" },
          description: "按访问顺序排列的地点名，例如：[\"灵隐寺\", \"西湖\", \"河坊街\"]",
        },
        city: { type: "string", description: "所在城市（公交/地铁规划需要），例如：杭州" },
      },
      required: ["stops", "city"],
    },
    async execute(args) {
      const stops = (Array.isArray(args.stops) ? args.stops : [])
        .filter((stop): stop is string => typeof stop === "string" && stop.trim() !== "")
        .map((stop) => stop.trim());
      if (stops.length < 2) {
        return "至少需要 2 个地点才能规划通勤（stops 按访问顺序传入）。";
      }
      const city = requireString(args, "city");

      const locations: GeoResult[] = [];
      const missing: string[] = [];
      // 并行 geocode：顺序等待最坏 N×15s（超时叠加），并行只需最慢那一个
      const results = await Promise.all(
        stops.map((stop) => geocodeLocation(stop, fetchFn, city).catch(() => null)),
      );
      results.forEach((geo, index) => {
        if (geo === null) missing.push(stops[index]);
        else locations.push(geo);
      });
      if (missing.length > 0) {
        return `未找到地点: ${missing.join("、")}。请更换更具体的名称后重试。`;
      }

      const legs: LegResult[] = [];
      for (let i = 0; i < locations.length - 1; i++) {
        legs.push(await planLeg(locations[i], locations[i + 1], city, fetchFn));
      }

      const lines = legs.map((leg, index) => {
        const flag = leg.durationMin > LONG_LEG_MINUTES ? " ⚠️过长，建议调整顺序或换住宿" : "";
        return `${index + 1}. ${leg.from} → ${leg.to}: ${leg.mode}约 ${Math.round(leg.durationMin)} 分钟${leg.estimated ? "（估算）" : ""}${flag}\n   ${leg.detail}`;
      });
      const totalMin = legs.reduce((sum, leg) => sum + leg.durationMin, 0);
      const longCount = legs.filter((leg) => leg.durationMin > LONG_LEG_MINUTES).length;
      const summary = longCount > 0
        ? `全天通勤合计约 ${Math.round(totalMin / 60)} 小时 ${Math.round(totalMin % 60)} 分钟，其中 ${longCount} 段过长，建议重新排序或调整住宿位置。`
        : `全天通勤合计约 ${Math.round(totalMin / 60)} 小时 ${Math.round(totalMin % 60)} 分钟，节奏可行。`;

      return `${city} 行程通勤规划（${stops.length} 个地点，${legs.length} 段）:\n${lines.join("\n")}\n${summary}`;
    },
  };
}

/** 单段通勤：公交/地铁 → 驾车 → 直线距离估算 */
async function planLeg(
  from: GeoResult,
  to: GeoResult,
  city: string,
  fetchFn: FetchLike,
): Promise<LegResult> {
  const amap = getAmapClient();
  if (amap !== undefined) {
    try {
      const transit = await amap.transitRoute(
        { latitude: from.latitude, longitude: from.longitude },
        { latitude: to.latitude, longitude: to.longitude },
        city,
      );
      if (transit !== null && transit.durationSec > 0) {
        const parts = transit.segments.length > 0 ? transit.segments.join(" → ") : "公交方案";
        return {
          from: from.name,
          to: to.name,
          mode: "公交/地铁",
          durationMin: transit.durationSec / 60,
          detail: `${parts}，步行共 ${Math.round(transit.walkingDistanceM)} 米`,
          estimated: false,
        };
      }
    } catch {
      // 公交无方案或服务失败 → 降级驾车
    }
  }

  try {
    const route = await fetchOsrmRoute(from, to, "driving", fetchFn);
    return {
      from: from.name,
      to: to.name,
      mode: "驾车",
      durationMin: route.durationSec / 60,
      detail: `距离 ${(route.distanceM / 1000).toFixed(1)} 公里${amap === undefined ? "（未配置 amap_api_key，公交方案不可用）" : ""}`,
      estimated: false,
    };
  } catch {
    // OSRM 也失败 → 直线距离按 40km/h 估算
    const km = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
    return {
      from: from.name,
      to: to.name,
      mode: "驾车",
      durationMin: (km / 40) * 60,
      detail: `直线 ${km.toFixed(1)} 公里，按 40km/h 估算（路由服务不可用）`,
      estimated: true,
    };
  }
}
