import type { Tool } from "./tool.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
import { haversineKm } from "./geo.ts";
import { requireString } from "./tool.ts";
import { overpassQuery, type OsmElement } from "./overpass.ts";
import { getAmapClient } from "./amap-access.ts";
import { rankPoisByRating } from "./amap.ts";

type FetchLike = typeof fetch;

/** OSM 标签 → 中文类型 */
const TYPE_LABELS: Record<string, string> = {
  attraction: "景点", viewpoint: "观景点", museum: "博物馆", zoo: "动物园",
  theme_park: "主题乐园", aquarium: "水族馆", gallery: "美术馆",
  monument: "历史遗迹", memorial: "纪念地", castle: "城堡", ruins: "遗址",
  park: "公园",
};

/** 基于 OpenStreetMap Overpass API 搜索地点周边的真实景点（免费无 Key） */
export function createAttractionsTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "search_attractions",
    description:
      "搜索某个地点周边的旅游景点和博物馆/纪念馆，返回名称、类型、距离、真实评分（高德数据）。" +
      "结果按评分降序排列，同一景区的子景点最多保留 2 个避免淹没列表。" +
      "先用它获取候选景点列表，再用 get_place_reviews 查口碑做筛选。",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "中心城市或地点名，例如：杭州" },
        radius_km: { type: "number", description: "搜索半径（公里），默认 10，最大 50" },
        limit: { type: "number", description: "返回数量上限，默认 10" },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = requireString(args, "location");
      const radiusKm = clamp(
        typeof args.radius_km === "number" ? args.radius_km : 10,
        1, 50,
      );
      const limit = Math.floor(clamp(typeof args.limit === "number" ? args.limit : 10, 1, 30));

      const geo: GeoResult | null = await geocodeLocation(location, fetchFn);
      if (geo === null) {
        return `未找到地点: ${location}`;
      }

      // 高德主源（配置了 Key 时）：国内 POI 全 + 真实评分
      const amap = getAmapClient();
      if (amap !== undefined && geo.country === "中国") {
        try {
          // 实测: 高德 POI 的 distance 字段经常为空，用坐标自算
          // 双路搜索：①"旅游景点"+风景名胜类（110000）；②"博物馆|纪念馆"不限类型。
          // 博物馆在高德属科教文化类（14xxxx），types=110000 完全搜不到，
          // 曾导致杜立特行动纪念馆等 4.2 分场馆被 3.4 分的景区子景点淹没
          const center = { latitude: geo.latitude, longitude: geo.longitude };
          // 博物馆搜索失败要可见（配额/网络），否则博物馆不可见会静默回归
          let museumError: string | undefined;
          const [scenicPois, museumPois] = await Promise.all([
            amap.poiSearch("旅游景点", center, radiusKm * 1000, "110000", 2),
            amap.poiSearch("博物馆|纪念馆", center, radiusKm * 1000).catch((error: unknown) => {
              museumError = error instanceof Error ? error.message : String(error);
              return [];
            }),
          ]);
          const seenIds = new Set<string>();
          const pois = [...scenicPois, ...museumPois].filter((poi) => {
            const key = poi.id ?? poi.name;
            if (seenIds.has(key)) return false;
            seenIds.add(key);
            return true;
          });
          if (pois.length > 0) {
            // 评分降序（无评分沉底），同分按距离：避免 API 原始顺序把高分景点挤出前列
            const enriched = rankPoisByRating(pois, center);

            // 同景区子景点折叠：一个景区（如"衢州古城文化旅游区"）的子 POI 最多保留 2 个高分项
            const perArea = new Map<string, number>();
            const selected = enriched.filter((entry) => {
              const area = areaKeyOf(entry.poi.name);
              if (area === "") return true;
              const count = perArea.get(area) ?? 0;
              if (count >= 2) return false;
              perArea.set(area, count + 1);
              return true;
            });

            const lines = selected.slice(0, limit).map((entry, index) => {
              const parts = [`${index + 1}. ${entry.poi.name}`, entry.poi.type ?? ""];
              parts.push(`距中心 ${entry.distanceKm.toFixed(1)} 公里`);
              if (entry.rating !== undefined) parts.push(`评分 ${entry.rating.toFixed(1)}`);
              if (entry.poi.address !== undefined && entry.poi.address !== "") parts.push(entry.poi.address);
              return parts.filter(Boolean).join(" | ");
            });
            const collapsedNote = enriched.length - selected.length > 0
              ? `，已合并 ${enriched.length - selected.length} 个同景区子景点`
              : "";
            const warning = museumError === undefined
              ? ""
              : `\n⚠️ 博物馆/纪念馆搜索失败（${museumError}），以上仅为风景名胜结果`;
            return (
              `${geo.name} 周边景点（按评分排序，前 ${Math.min(limit, selected.length)} / 共 ${enriched.length} 个，高德数据${collapsedNote}）：\n` +
              lines.join("\n") +
              warning
            );
          }
        } catch {
          // 高德失败（配额/网络）→ 降级 OSM
        }
      }

      const query =
        `[out:json][timeout:25];` +
        `(` +
        `nwr(around:${radiusKm * 1000},${geo.latitude},${geo.longitude})` +
        `[tourism~"^(attraction|viewpoint|museum|zoo|theme_park|aquarium|gallery)$"];` +
        // historic 只取主要类型：[historic]（任意值）在北京等古城会匹配海量微小
        // 元素（每块碑/每个挂牌建筑），服务端处理超载。实测收窄后 3.4s vs 超时。
        `nwr(around:${radiusKm * 1000},${geo.latitude},${geo.longitude})` +
        `[historic~"^(monument|memorial|castle|ruins|archaeological_site|fort)$"];` +
        `nwr(around:${radiusKm * 1000},${geo.latitude},${geo.longitude})[leisure=park];` +
        `);` +
        `out center ${limit * 4};`;

      const data = await overpassQuery(query, fetchFn);
      const attractions = (data.elements ?? [])
        .map((element) => toAttraction(element, geo))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      // 按名称去重（OSM 中 node/way/relation 可能重复表示同一景点）
      const seen = new Set<string>();
      const unique = attractions.filter((a) => {
        if (seen.has(a.name)) return false;
        seen.add(a.name);
        return true;
      });

      if (unique.length === 0) {
        return `在 ${geo.name} 周边 ${radiusKm} 公里内没有找到有名称的景点。`;
      }

      const lines = unique.slice(0, limit).map(
        (a) => `${a.name} | ${a.type} | 距市中心 ${a.distanceKm.toFixed(1)} 公里${a.website === undefined ? "" : ` | ${a.website}`}`,
      );
      return `${geo.name} 周边景点（前 ${Math.min(limit, unique.length)} / 共 ${unique.length} 个）:\n${lines.join("\n")}`;
    },
  };
}

interface AttractionInfo {
  readonly name: string;
  readonly type: string;
  readonly distanceKm: number;
  readonly website?: string;
}

function toAttraction(element: OsmElement, center: GeoResult): AttractionInfo | null {
  const tags = element.tags ?? {};
  const name = tags["name:zh"] ?? tags.name;
  if (name === undefined || name.trim() === "") return null;

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const osmType = tags.tourism ?? (tags.historic !== undefined ? "monument" : undefined) ?? (tags.leisure === "park" ? "park" : undefined);
  const type = (osmType !== undefined ? TYPE_LABELS[osmType] : undefined) ?? "景点";

  return {
    name,
    type,
    distanceKm: haversineKm(center.latitude, center.longitude, lat, lon),
    website: tags.website ?? tags["contact:website"],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 提取景区父级前缀：如「衢州古城文化旅游区天王塔」→「衢州古城文化旅游区」 */
function areaKeyOf(name: string): string {
  const match = name.match(/^(.{2,14}?(?:旅游区|景区|文化街区|历史文化街区|文化园|风景名胜区))/);
  if (match !== null) return match[1];
  const dot = name.indexOf("·");
  if (dot > 1) return name.slice(0, dot);
  return "";
}
