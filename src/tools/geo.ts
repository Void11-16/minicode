import type { Tool } from "./tool.ts";
import { requireNumber, requireString } from "./tool.ts";
import { geocodeCandidates, geocodeInCity, regionLabel, reverseGeocode } from "./geocoding.ts";

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
      "把地名（城市/景点/车站/POI）转换为经纬度坐标。强烈建议传 city（目标城市，如 北京）：" +
      "工具会限定城市搜索并校验返回结果的省市字段，避免命中其他城市的同名地点" +
      "（实测「北海公园」不带 city 首条返回新疆五家渠）。传了 city 仍核实不了会明确说明，" +
      "此时换查询词重查（城市+区+完整名称，如「北京市西城区北海公园」），或改用 search_attractions" +
      "（location 传城市名）从其返回条目里取坐标。行程条目的坐标必须来自核实过的工具返回；" +
      "无法核实的地点不要写经纬度，note 注明「坐标待核实」。" +
      "不传 city 时返回多条候选（含省市），需自行核对城市，仍可能命中外地同名地点。",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "地名，例如：北京、西湖、Chengdu" },
        city: {
          type: "string",
          description: "目标城市（强烈建议传），例如：北京、杭州。传入后做省市字段校验，防止外地同名地点",
        },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = requireString(args, "location");
      const city = typeof args.city === "string" ? args.city.trim() : "";

      if (city !== "") {
        const verified = await geocodeInCity(location, city, fetchFn);
        if (verified !== null) {
          const region = regionLabel(verified);
          return [
            `坐标已核实（目标城市 ${city}）：${verified.name}${region === "" ? "" : `（${region}）`}`,
            `纬度 ${verified.latitude.toFixed(4)}, 经度 ${verified.longitude.toFixed(4)}（高德，省市字段校验通过）`,
            "可直接写入行程条目的 location.latitude / location.longitude。",
          ].join("\n");
        }
        return (
          `未能在「${city}」核实「${location}」的坐标（未找到能通过省市校验的结果）。\n` +
          "下一步：① 换查询词重查——用城市+区+完整名称，例如「北京市西城区北海公园」；\n" +
          `② 或改用 search_attractions（location 传「${city}」）从其返回条目里取坐标；\n` +
          "③ 仍无法核实的：行程条目不要写经纬度，并在 note 注明「坐标待核实」。"
        );
      }

      const candidates = await geocodeCandidates(location, fetchFn, 3);
      if (candidates.length === 0) {
        return `未找到地点: ${location}`;
      }
      const lines = candidates.map((candidate, index) => {
        const region = [regionLabel(candidate), candidate.country].filter(Boolean).join(", ");
        return `${index + 1}. ${candidate.name}${region === "" ? "" : ` (${region})`} — ${candidate.latitude.toFixed(4)}, ${candidate.longitude.toFixed(4)}`;
      });
      return (
        `「${location}」的 ${candidates.length} 个候选（未做城市校验，可能含外地同名地点）:\n${lines.join("\n")}\n` +
        "⚠️ 请在查询时传 city 参数（如 city=北京）：工具会限定城市重查，命中外地同名地点时明确提示未核实。"
      );
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
      const region = [regionLabel(result), result.country].filter(Boolean).join(", ");
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
