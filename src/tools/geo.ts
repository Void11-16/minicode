import type { Tool } from "./tool.ts";
import { requireNumber, requireString } from "./tool.ts";
import { geocodeCandidates, reverseGeocode } from "./geocoding.ts";

type FetchLike = typeof fetch;

/** Haversine 大圆距离，单位公里 */
export function haversineKm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function createGeocodeTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "geocode",
    description:
      "把地名（城市/景点/车站/POI）转换为经纬度坐标，返回多个候选（含所属省市国家）。" +
      "需要坐标信息的计算（距离、路线、天气）前先调用它。地名有歧义时参考候选列表选择。",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "地名，例如：北京、西湖、Chengdu" },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = requireString(args, "location");
      const candidates = await geocodeCandidates(location, fetchFn, 3);
      if (candidates.length === 0) {
        return `未找到地点: ${location}`;
      }
      const lines = candidates.map((candidate, index) => {
        const region = [candidate.admin1, candidate.country].filter(Boolean).join(", ");
        return `${index + 1}. ${candidate.name}${region === "" ? "" : ` (${region})`} — ${candidate.latitude.toFixed(4)}, ${candidate.longitude.toFixed(4)}`;
      });
      return `「${location}」的 ${candidates.length} 个候选:\n${lines.join("\n")}`;
    },
  };
}

export function createReverseGeocodeTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "reverse_geocode",
    description: "把经纬度坐标转换为地名（含所属省市国家）。用于确认某个坐标是什么地方。",
    parameters: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "纬度" },
        longitude: { type: "number", description: "经度" },
      },
      required: ["latitude", "longitude"],
    },
    async execute(args) {
      const latitude = requireNumber(args, "latitude");
      const longitude = requireNumber(args, "longitude");
      const result = await reverseGeocode(latitude, longitude, fetchFn);
      if (result === null) {
        return `无法解析坐标 ${latitude}, ${longitude}`;
      }
      const region = [result.admin1, result.country].filter(Boolean).join(", ");
      return `${result.name}${region === "" ? "" : ` (${region})`} — ${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`;
    },
  };
}

export function createDistanceTool(): Tool {
  return {
    name: "calculate_distance",
    description: "计算两个经纬度坐标之间的直线距离（公里）。先用 geocode 获取坐标。",
    parameters: {
      type: "object",
      properties: {
        from_lat: { type: "number", description: "起点纬度" },
        from_lon: { type: "number", description: "起点经度" },
        to_lat: { type: "number", description: "终点纬度" },
        to_lon: { type: "number", description: "终点经度" },
      },
      required: ["from_lat", "from_lon", "to_lat", "to_lon"],
    },
    async execute(args) {
      const fromLat = requireNumber(args, "from_lat");
      const fromLon = requireNumber(args, "from_lon");
      const toLat = requireNumber(args, "to_lat");
      const toLon = requireNumber(args, "to_lon");
      const km = haversineKm(fromLat, fromLon, toLat, toLon);
      return `直线距离约 ${km.toFixed(1)} 公里`;
    },
  };
}
