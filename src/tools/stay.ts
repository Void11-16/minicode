import type { Tool } from "./tool.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
import { haversineKm } from "./geo.ts";
import { requireString } from "./tool.ts";
import { overpassFallback, type OsmElement } from "./overpass.ts";
import { getAmapClient } from "./amap-access.ts";
import { formatPoiCoordinates, rankPoisByRating } from "./amap.ts";

type FetchLike = typeof fetch;

const STAY_TYPE_LABELS: Record<string, string> = {
  hotel: "酒店",
  hostel: "青旅",
  guest_house: "民宿",
  apartment: "公寓",
  motel: "汽车旅馆",
};

interface StayInfo {
  readonly name: string;
  readonly type: string;
  readonly distanceKm: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly stars?: string;
  readonly phone?: string;
  readonly website?: string;
}

/**
 * 真实住宿搜索 —— 基于 OpenStreetMap（免费无 Key）。
 * 返回真实存在的住宿：名称/类型/距市中心距离/星级/电话/官网。
 * 注意：该数据源没有价格和评分 —— 口碑用 get_place_reviews 补充。
 */
export function createStayTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "search_stays",
    description:
      "搜索某个城市的真实住宿：酒店/民宿/青旅，返回名称、地址、距离、坐标（纬度,经度，可直接写入行程 location），" +
      "高德数据源还包含真实评分与参考价格，结果按评分降序排列。未配置高德或查询失败时使用 OpenStreetMap（无价格评分）。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名，例如：杭州" },
        radius_km: { type: "number", description: "搜索半径（公里），默认 10，最大 30" },
        limit: { type: "number", description: "返回数量上限，默认 10" },
      },
      required: ["city"],
    },
    async execute(args) {
      const city = requireString(args, "city");
      const radiusKm = Math.min(30, Math.max(1, typeof args.radius_km === "number" ? args.radius_km : 10));
      const limit = Math.floor(Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 10)));

      const geo: GeoResult | null = await geocodeLocation(city, fetchFn);
      if (geo === null) {
        return `未找到地点: ${city}`;
      }

      // 高德主源（配置了 Key 时）：真实评分 + 参考价格
      const amap = getAmapClient();
      let amapError: string | undefined;
      if (amap !== undefined && geo.country === "中国") {
        try {
          // 实测: 高德 POI 的 distance 字段经常为空，用坐标自算
          const pois = await amap.poiSearch(
            "酒店",
            { latitude: geo.latitude, longitude: geo.longitude },
            radiusKm * 1000,
            "100000", // 住宿服务 POI 分类
          );
          if (pois.length > 0) {
            // 评分降序（无评分沉底）：API 原始顺序会把高分酒店挤出前列
            const ranked = rankPoisByRating(pois, { latitude: geo.latitude, longitude: geo.longitude });
            const lines = ranked.slice(0, limit).map((entry, index) => {
              const parts = [`${index + 1}. ${entry.poi.name}`];
              if (entry.poi.type !== undefined && entry.poi.type !== "") parts.push(entry.poi.type);
              parts.push(`距中心 ${entry.distanceKm.toFixed(1)} 公里`);
              if (entry.rating !== undefined) parts.push(`评分 ${entry.rating.toFixed(1)}`);
              const coords = formatPoiCoordinates(entry.poi.location);
              if (coords !== null) parts.push(`坐标 ${coords}`);
              const cost = entry.poi.biz_ext?.cost;
              if (cost !== undefined && cost !== "" && cost !== "0") parts.push(`参考价 ¥${cost}起`);
              if (entry.poi.address !== undefined && entry.poi.address !== "") parts.push(entry.poi.address);
              return parts.filter(Boolean).join(" | ");
            });
            return (
              `${geo.name} 住宿（按评分排序，前 ${Math.min(limit, ranked.length)} / 共 ${ranked.length} 家，高德数据）：\n` +
              lines.join("\n")
            );
          }
        } catch (error) {
          // 高德失败（限流/配额/网络）→ 降级 OSM；原因要留给用户看，否则像 OSM 的锅
          amapError = error instanceof Error ? error.message : String(error);
        }
      }

      const query =
        "[out:json][timeout:25];" +
        "(" +
        `nwr(around:${radiusKm * 1000},${geo.latitude},${geo.longitude})` +
        '[tourism~"^(hotel|hostel|guest_house|apartment|motel)$"];' +
        ");" +
        `out center ${limit * 3};`;

      const data = await overpassFallback(query, amapError, fetchFn);
      const stays = (data.elements ?? [])
        .map((element) => toStay(element, geo))
        .filter((s): s is StayInfo => s !== null)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      // 按名称去重（node/way/relation 可能重复表示同一家住宿）
      const seen = new Set<string>();
      const unique = stays.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });

      if (unique.length === 0) {
        return (
          `在 ${geo.name} 周边 ${radiusKm} 公里内没有找到有名称的住宿。` +
          "可能该区域地图数据较少，可尝试扩大 radius_km 或换更具体的地点名。" +
          degradedNote(amapError)
        );
      }

      const lines = unique.slice(0, limit).map((s) => {
        const parts = [
          s.name,
          s.type,
          `距市中心 ${s.distanceKm.toFixed(1)} 公里`,
          `坐标 ${s.latitude.toFixed(4)},${s.longitude.toFixed(4)}`,
        ];
        if (s.stars !== undefined) parts.push(`${s.stars}星`);
        if (s.phone !== undefined) parts.push(`电话 ${s.phone}`);
        if (s.website !== undefined) parts.push(s.website);
        return parts.join(" | ");
      });

      return (
        `${geo.name} 的真实住宿（前 ${Math.min(limit, unique.length)} / 共 ${unique.length} 家，OpenStreetMap 数据）：\n` +
        lines.join("\n") +
        "\n注：以上为真实存在的住宿，但不含价格；口碑可用 get_place_reviews 查询。" +
        degradedNote(amapError)
      );
    },
  };
}

/** 降级说明：OSM 数据没有评分/价格，得让用户知道为什么 */
function degradedNote(amapError: string | undefined): string {
  if (amapError === undefined) return "";
  return `\n⚠️ 高德数据源失败（${amapError}），以上为 OpenStreetMap 数据（无评分/价格）`;
}

function toStay(element: OsmElement, center: GeoResult): StayInfo | null {
  const tags = element.tags ?? {};
  const name = tags["name:zh"] ?? tags.name;
  if (name === undefined || name.trim() === "") return null;

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const type = STAY_TYPE_LABELS[tags.tourism ?? ""] ?? "住宿";

  return {
    name,
    type,
    distanceKm: haversineKm(center.latitude, center.longitude, lat, lon),
    latitude: lat,
    longitude: lon,
    stars: tags.stars ?? tags["stars:zh"],
    phone: tags.phone ?? tags["contact:phone"],
    website: tags.website ?? tags["contact:website"],
  };
}
