import { convertPoint, type GeoPoint } from "./coordinates.ts";
import { cancellableFetch } from "./travel-request.ts";
import type { Tool } from "./tool.ts";
import { requireNumber } from "./tool.ts";

type FetchLike = typeof fetch;

const MODES = new Set(["driving", "walking", "cycling"]);
const MODE_LABELS: Record<string, string> = {
  driving: "驾车",
  walking: "步行",
  cycling: "骑行",
};

/** OSRM 路线查询：距离 + 耗时（通勤规划的驾车兜底也复用这里） */
export async function fetchOsrmRoute(
  from: GeoPoint,
  to: GeoPoint,
  mode: string,
  fetchFn: FetchLike,
): Promise<{ distanceM: number; durationSec: number }> {
  from = convertPoint(from, "wgs84");
  to = convertPoint(to, "wgs84");
  const url =
    `https://router.project-osrm.org/route/v1/${mode}/` +
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
  const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`路由服务返回 ${response.status}`);
  }

  const data = (await response.json()) as {
    code?: string;
    routes?: Array<{ distance: number; duration: number }>;
  };
  const route = data.routes?.[0];
  if (data.code !== "Ok" || route === undefined) {
    throw new Error(`路线规划失败: ${data.code ?? "无路线"}`);
  }
  return { distanceM: route.distance, durationSec: route.duration };
}

/** OSRM 公共路由服务（免费无 Key） */
export function createRouteTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "get_route",
    description: "查询两个经纬度坐标之间的实际路线（距离和预计耗时）。支持驾车/步行/骑行。先用 geocode 获取坐标。",
    parameters: {
      type: "object",
      properties: {
        from_lat: { type: "number" }, from_lon: { type: "number" },
        to_lat: { type: "number" }, to_lon: { type: "number" },
        crs: { type: "string", enum: ["wgs84", "gcj02"], description: "坐标系，高德来源必须填 gcj02；默认 wgs84" },
        mode: { type: "string", description: "driving | walking | cycling，默认 driving" },
      },
      required: ["from_lat", "from_lon", "to_lat", "to_lon"],
    },
    async execute(args, ctx) {
      ctx?.signal?.throwIfAborted();
      const fromLat = requireNumber(args, "from_lat");
      const fromLon = requireNumber(args, "from_lon");
      const toLat = requireNumber(args, "to_lat");
      const toLon = requireNumber(args, "to_lon");
      const mode = typeof args.mode === "string" && MODES.has(args.mode) ? args.mode : "driving";

      const route = await fetchOsrmRoute(
        { latitude: fromLat, longitude: fromLon, crs: args.crs === "gcj02" ? "gcj02" : "wgs84" },
        { latitude: toLat, longitude: toLon, crs: args.crs === "gcj02" ? "gcj02" : "wgs84" },
        mode,
        cancellableFetch(fetchFn, ctx?.signal),
      );

      return `${MODE_LABELS[mode]} 约 ${(route.distanceM / 1000).toFixed(1)} 公里，预计 ${(route.durationSec / 3600).toFixed(1)} 小时`;
    },
  };
}
