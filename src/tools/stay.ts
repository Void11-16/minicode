import { cancellableFetch } from "./travel-request.ts";
import { convertPoint } from "./coordinates.ts";
import type { Tool } from "./tool.ts";
import { geocodeLocation, poiCityVerdict, type GeoResult } from "./geocoding.ts";
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
const ECONOMY_STAY = /青年旅舍|青旅|经济型|快捷酒店|招待所|宾馆|旅馆|客栈|住宿旅社|全季|如家|汉庭|7天|格林豪泰|锦江之星|速8|布丁酒店|怡莱|海友/;
const HOSTEL = /青年旅舍|青旅|hostel/i;

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
    recordsPlaceEvidence: true,
    description:
      "搜索某个城市的真实住宿：酒店/民宿/青旅，返回名称、地址、距离、坐标（纬度,经度，可直接写入行程 location），" +
      "高德可能提供评分与每房每晚参考价。穷游优先青旅和经济住宿，按已知价格与距离排序，青旅床位及房型价格待确认。高德不可用时使用 OpenStreetMap（无价格评分）。",
    parameters: {
      type: "object",
      properties: {
        region: { type: "string", description: "目标城市；city 为酒店/商圈名时用于城市核验" },
        city: { type: "string", description: "城市名，例如：杭州" },
        radius_km: { type: "number", description: "搜索半径（公里），默认 10，最大 30" },
        max_room_price: { type: "number", minimum: 0, description: "每房每晚参考价上限（元）。省略时沿用需求单分项额度；无价格候选单列待确认。" },
        economy: { type: "boolean", description: "穷游优先青旅、经济型住宿。床位与独立房分别确认，明确房型要求照常保留。" },
        limit: { type: "number", description: "返回数量上限，默认 10" },
      },
      required: ["city"],
    },
    async execute(args, ctx) {
      ctx?.signal?.throwIfAborted();
      const request = cancellableFetch(fetchFn, ctx?.signal);
      const city = requireString(args, "city");
      const cap = typeof args.max_room_price === "number" ? args.max_room_price : undefined;
      const economy = args.economy === true;
      const price = (value: string | undefined) => {
        const cost = Number(value);
        return Number.isFinite(cost) && cost > 0 ? cost : undefined;
      };
      const radiusKm = Math.min(30, Math.max(1, typeof args.radius_km === "number" ? args.radius_km : 10));
      const limit = Math.floor(Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 10)));

      const geo: GeoResult | null = await geocodeLocation(city, request, typeof args.region === "string" ? args.region : ctx?.destination, ctx?.signal);
      if (geo === null) {
        return `未找到地点: ${city}`;
      }

      // 高德主源（配置了 Key 时）：真实评分 + 参考价格
      const amap = getAmapClient(ctx?.signal);
      let amapError: string | undefined;
      if (amap !== undefined && geo.country === "中国") {
        try {
          // 实测: 高德 POI 的 distance 字段经常为空，用坐标自算
          const center = convertPoint(geo, "gcj02");
          const searches = economy ? ["青年旅舍", "经济型酒店|招待所"] : ["酒店"];
          const results = await Promise.allSettled(searches.map((keyword) => amap.poiSearch(keyword, center, radiusKm * 1000, "100000")));
          const pois = [...new Map(results.flatMap((result) => result.status === "fulfilled" ? result.value.map((poi) => [poi.id, poi] as const) : [])).values()];
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected" && pois.length === 0) throw failure.reason;
          if (pois.length > 0) {
            // 评分降序（无评分沉底）：API 原始顺序会把高分酒店挤出前列
            const nearby = rankPoisByRating(pois, center).filter((entry) => entry.distanceKm <= radiusKm && (typeof args.region !== "string" || poiCityVerdict(entry.poi, args.region) === "match"));
            const hostel = (poi: typeof pois[number]) => HOSTEL.test(`${poi.name} ${poi.type ?? ""}`);
            const roomPrice = (poi: typeof pois[number]) => hostel(poi) ? undefined : price(poi.biz_ext?.cost);
            const ranked = nearby.filter(({ poi }) => {
              const cost = roomPrice(poi);
              if (cost !== undefined && cap !== undefined) return cost <= cap;
              return !economy || ECONOMY_STAY.test(`${poi.name} ${poi.type ?? ""}`);
            });
            if (economy) ranked.sort((a, b) => (roomPrice(a.poi) ?? Infinity) - (roomPrice(b.poi) ?? Infinity)
              || Number(hostel(b.poi)) - Number(hostel(a.poi)) || a.distanceKm - b.distanceKm);
            else if (cap !== undefined) ranked.sort((a, b) => Number(roomPrice(a.poi) === undefined) - Number(roomPrice(b.poi) === undefined));
            if (!economy && cap !== undefined && !ranked.length) return `未找到每房每晚参考价不超过 ¥${cap} 的住宿；请调整区域或核对全程余额再调整上限。`;
            if (ranked.length) {
              const lines = ranked.slice(0, limit).map((entry, index) => {
                const parts = [`${index + 1}. ${entry.poi.name}`];
                if (entry.poi.type !== undefined && entry.poi.type !== "") parts.push(entry.poi.type);
                parts.push(`距中心 ${entry.distanceKm.toFixed(1)} 公里`);
                if (entry.rating !== undefined) parts.push(`评分 ${entry.rating.toFixed(1)}`);
                const coords = formatPoiCoordinates(entry.poi.location);
                if (coords !== null) parts.push(`坐标 ${coords}`);
                const cost = roomPrice(entry.poi);
                if (cost !== undefined) parts.push(`参考价 ¥${cost}/房/晚起`);
                else if (hostel(entry.poi)) parts.push("床位或独立房及到店价格待确认");
                else if (cap !== undefined) parts.push("房价待确认");
                if (entry.poi.address !== undefined && entry.poi.address !== "") parts.push(entry.poi.address);
                return parts.filter(Boolean).join(" | ");
              });
              const output = (
                `${geo.name} 住宿（${economy ? "青旅及经济候选，" : cap === undefined ? "按评分排序，" : ""}前 ${Math.min(limit, ranked.length)} / 共 ${ranked.length} 家，高德数据${cap === undefined ? "" : `，已知参考价上限 ¥${cap}/房/晚，缺价在后`}）：\n` +
                lines.join("\n") + (failure ? "\n部分住宿来源查询失败，候选可能不完整。" : "")
              );
              return await ctx?.evidence?.observePlaces("search_stays", String(args.region ?? ctx?.destination ?? city), output, "amap") ?? output;
            }
          }
        } catch (error) {
          ctx?.signal?.throwIfAborted();
          // 高德失败（限流/配额/网络）→ 降级 OSM；原因要留给用户看，否则像 OSM 的锅
          amapError = error instanceof Error ? error.message : String(error);
        }
      }

      const osmGeo = { ...geo, ...convertPoint(geo, "wgs84") };
      const query =
        "[out:json][timeout:25];" +
        "(" +
        `nwr(around:${radiusKm * 1000},${osmGeo.latitude},${osmGeo.longitude})` +
        (economy ? '[tourism~"^(hostel|guest_house)$"];' : '[tourism~"^(hotel|hostel|guest_house|apartment|motel)$"];') +
        ");" +
        `out center ${limit * 3};`;

      const data = await overpassFallback(query, amapError, request, ctx?.signal);
      const stays = (data.elements ?? [])
        .map((element) => toStay(element, osmGeo))
        .filter((s): s is StayInfo => s !== null && s.distanceKm <= radiusKm)
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

      const output = (
        `${geo.name} 的真实住宿（前 ${Math.min(limit, unique.length)} / 共 ${unique.length} 家，OpenStreetMap 数据）：\n` +
        lines.join("\n") +
        "\n注：以上为真实存在的住宿，但不含价格；口碑可用 get_place_reviews 查询。" +
        degradedNote(amapError)
      );
      return await ctx?.evidence?.observePlaces("search_stays", String(args.region ?? ctx?.destination ?? city), output, "osm") ?? output;
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
