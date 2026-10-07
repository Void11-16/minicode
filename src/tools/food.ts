import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { haversineKm } from "./geo.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
import { getAmapClient } from "./amap-access.ts";
import type { AmapPoi } from "./amap.ts";

type FetchLike = typeof fetch;

interface FoodInfo {
  readonly name: string;
  readonly cuisine: string;
  readonly distanceKm: number;
  readonly rating?: number;
  readonly avgCost?: number;
  readonly address?: string;
  readonly local: boolean;
  score: number;
}

/** 综合分权重：评分 40% + 就近 30% + 价格契合 20% + 本地特色 10% */
const W_RATING = 0.4;
const W_DISTANCE = 0.3;
const W_PRICE = 0.2;
const W_LOCAL = 0.1;

/** 默认评分门槛：候选充足时只推荐高分餐厅，不足时自动放宽（显式 min_rating 不放宽） */
const DEFAULT_MIN_RATING = 4.2;
const RELAX_THRESHOLD = 4;

/** 同一菜系最多出现次数，保证候选多样性（模型据此组合不重复的三餐） */
const MAX_PER_CUISINE = 2;

/** 省级行政区 → 本地菜系关键词（菜系名命中任一即标记"本地特色"） */
const LOCAL_CUISINE_HINTS: Record<string, string[]> = {
  浙江: ["浙", "杭帮", "杭州", "宁波", "绍兴", "温州", "金华", "江浙"],
  江苏: ["苏", "淮扬", "金陵", "南京", "苏州", "无锡", "江浙"],
  上海: ["本帮", "沪", "江浙", "生煎", "小笼"],
  广东: ["粤", "潮汕", "顺德", "客家", "广式", "早茶"],
  四川: ["川", "麻辣", "火锅", "串串", "钵钵"],
  重庆: ["渝", "火锅", "江湖", "串串"],
  湖南: ["湘", "剁椒"],
  湖北: ["鄂", "热干面", "武昌"],
  云南: ["滇", "云南", "米线", "菌"],
  贵州: ["黔", "酸汤", "贵州"],
  陕西: ["陕", "秦", "泡馍", "肉夹"],
  山东: ["鲁", "山东", "胶东"],
  福建: ["闽", "沙县", "佛跳墙", "厦门"],
  北京: ["京", "烤鸭", "炸酱", "涮"],
  新疆: ["新疆", "大盘鸡", "馕", "烤串"],
  黑龙江: ["东北", "锅包", "杀猪", "铁锅"],
  吉林: ["东北", "锅包", "杀猪", "铁锅"],
  辽宁: ["东北", "锅包", "杀猪", "铁锅"],
  西藏: ["藏", "酥油", "糌粑", "牦牛"],
  广西: ["桂", "桂林", "柳州", "螺蛳粉", "米粉", "老友"],
  内蒙古: ["蒙", "内蒙古", "烤全羊", "手把肉", "奶茶"],
  海南: ["琼", "海南", "文昌鸡", "加积鸭", "清补凉", "椰子"],
  甘肃: ["陇", "兰州", "拉面", "牛肉面", "敦煌"],
  宁夏: ["宁夏", "羊杂", "枸杞", "手抓"],
  青海: ["青海", "酸奶", "手抓", "酿皮"],
};

/**
 * 美食搜索 —— 多因子评分排序，而不是简单按距离罗列。
 * 数据层直接给出综合分与依据（评分/就近/价格/本地特色），
 * 模型只需要结合用户口味做最终裁决与行程编排。
 */
export function createFoodTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "search_restaurants",
    description:
      "按多因子综合分搜索地点附近的餐厅（评分40% + 就近30% + 价格契合20% + 本地特色10%），" +
      "返回评分、人均、距离、菜系、本地特色标记与综合分。规划三餐时：中心传当期景点/住宿名（不是城市名），" +
      "中心是景点名时配合 region 传所在城市（消歧，避免命中外地同名地点）；" +
      "radius_km 建议 2-3；用户预算传 max_cost；当天已吃过的菜系传 avoid_cuisines 避免重复；" +
      "默认只保留评分≥4.2 的餐厅（高分管不够时自动放宽）。口碑细节（招牌菜/排队）再对具体餐厅调 get_place_reviews。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "搜索中心：景点/商圈/酒店名或城市名，例如：灵隐寺、西湖、杭州" },
        region: { type: "string", description: "所在城市名（如 杭州）。中心为景点名时建议传入，可选" },
        cuisine: { type: "string", description: "菜系或品类关键词，例如：杭帮菜、川菜、火锅。可选" },
        max_cost: { type: "number", description: "人均消费上限（元），可选" },
        min_rating: { type: "number", description: "最低评分（如 4.5），可选；不传则默认 4.2 且不足自动放宽" },
        avoid_cuisines: {
          type: "string",
          description: "要排除的菜系（逗号分隔），例如：川菜,火锅。用于避免与已安排餐次重复",
        },
        radius_km: { type: "number", description: "搜索半径（公里），默认 3，最大 30" },
        limit: { type: "number", description: "返回数量上限，默认 8" },
      },
      required: ["city"],
    },
    async execute(args) {
      const city = requireString(args, "city");
      const region = typeof args.region === "string" ? args.region.trim() : "";
      const cuisine = typeof args.cuisine === "string" ? args.cuisine.trim() : "";
      const maxCost = typeof args.max_cost === "number" ? args.max_cost : undefined;
      const minRating = typeof args.min_rating === "number" ? args.min_rating : undefined;
      const radiusKm = Math.min(30, Math.max(1, typeof args.radius_km === "number" ? args.radius_km : 3));
      const limit = Math.floor(Math.min(20, Math.max(1, typeof args.limit === "number" ? args.limit : 8)));
      const avoid = typeof args.avoid_cuisines === "string"
        ? args.avoid_cuisines.split(/[,，、;；]+/).map((term) => term.trim()).filter((term) => term !== "")
        : [];

      const amap = getAmapClient();
      if (amap === undefined) {
        return (
          "美食搜索依赖高德 POI 数据（评分/人均消费/菜系），当前未配置 amap_api_key。\n" +
          "在对话中执行 /config set amap_api_key <Key> 后即可使用（高德开放平台免费申请）。"
        );
      }

      const geo: GeoResult | null = await geocodeLocation(city, fetchFn, region === "" ? undefined : region);
      if (geo === null) {
        return `未找到地点: ${city}`;
      }

      // 高德 POI: 050000 = 餐饮服务；关键词用菜系（无菜系时用"美食"）
      const pois = await amap.poiSearch(
        cuisine === "" ? "美食" : cuisine,
        { latitude: geo.latitude, longitude: geo.longitude },
        radiusKm * 1000,
        "050000",
      );

      const hints = localHintsFor(geo);
      let foods = pois
        .map((poi) => toFood(poi, geo, hints))
        .filter((f): f is FoodInfo => f !== null);

      // 硬性过滤：人均上限 + 排除菜系（含 avoid 词的菜系直接剔除）
      if (maxCost !== undefined) {
        foods = foods.filter((f) => f.avgCost === undefined || f.avgCost <= maxCost);
      }
      if (avoid.length > 0) {
        foods = foods.filter((f) => !avoid.some((term) => f.cuisine.includes(term)));
      }

      // 评分门槛：默认 4.2 起步。高分候选充足 → 丢弃低分与无评分；
      // 不足 → 自动放宽（显式指定 min_rating 时严格按用户要求，不放宽）
      const floor = minRating ?? DEFAULT_MIN_RATING;
      const passing = foods.filter(
        (f): f is FoodInfo & { rating: number } => f.rating !== undefined && f.rating >= floor,
      );
      const relaxed = minRating === undefined && passing.length < RELAX_THRESHOLD;
      if (minRating !== undefined || passing.length >= RELAX_THRESHOLD) {
        foods = passing;
      }

      if (foods.length === 0) {
        const conditions: string[] = [];
        if (cuisine !== "") conditions.push(`菜系=${cuisine}`);
        if (minRating !== undefined) conditions.push(`评分≥${minRating}`);
        if (maxCost !== undefined) conditions.push(`人均≤${maxCost}元`);
        if (avoid.length > 0) conditions.push(`排除菜系=${avoid.join("、")}`);
        const conditionNote = conditions.length > 0 ? `（${conditions.join("、")}）` : "";
        return (
          `在 ${geo.name} 周边 ${radiusKm} 公里内没有符合条件的餐厅${conditionNote}。` +
          "可尝试放宽筛选、更换菜系关键词或加大搜索半径。"
        );
      }

      for (const f of foods) {
        f.score = scoreFood(f, radiusKm, maxCost);
      }
      foods.sort((a, b) => b.score - a.score);

      // 菜系多样性：同一菜系最多保留 MAX_PER_CUISINE 家，保证候选可组合出不重复的三餐
      const perCuisine = new Map<string, number>();
      const varied: FoodInfo[] = [];
      for (const f of foods) {
        if (varied.length >= limit) break;
        const count = perCuisine.get(f.cuisine) ?? 0;
        if (count >= MAX_PER_CUISINE) continue;
        perCuisine.set(f.cuisine, count + 1);
        varied.push(f);
      }

      const lines = varied.map((f, index) => {
        const parts = [`${index + 1}. ${f.name} 综合 ${f.score.toFixed(1)}`, `${f.cuisine}${f.local ? "·本地特色" : ""}`];
        if (f.rating !== undefined) parts.push(`评分 ${f.rating.toFixed(1)}`);
        if (f.avgCost !== undefined) parts.push(`人均 ¥${f.avgCost}`);
        parts.push(`距离 ${f.distanceKm.toFixed(1)} 公里`);
        if (f.address !== undefined && f.address !== "") parts.push(f.address);
        return parts.join(" | ");
      });

      const notes: string[] = [];
      if (cuisine !== "") notes.push(`菜系=${cuisine}`);
      if (minRating !== undefined) notes.push(`评分≥${minRating}`);
      else if (relaxed) notes.push(`高分候选不足，评分门槛 ${floor} 已自动放宽`);
      else notes.push(`评分门槛 ${floor}，低分与无评分已剔除`);
      if (maxCost !== undefined) notes.push(`人均≤${maxCost}元`);
      if (avoid.length > 0) notes.push(`已排除菜系: ${avoid.join("、")}`);
      notes.push(`同一菜系最多 ${MAX_PER_CUISINE} 家`);

      return (
        `${geo.name} 餐厅推荐（前 ${varied.length} / 共 ${foods.length} 家，高德真实数据）\n` +
        `排序依据: 评分40% + 就近30% + 价格契合20% + 本地特色10%（${notes.join("；")}）\n` +
        lines.join("\n") +
        "\n提示: 推荐理由请引用综合分/评分/人均/距离/菜系数据；对具体餐厅调用 get_place_reviews 可查招牌菜、排队等口碑细节。"
      );
    },
  };
}

function toFood(poi: AmapPoi, center: GeoResult, localHints: readonly string[]): FoodInfo | null {
  if (poi.name === undefined || poi.name.trim() === "") return null;

  const poiLocation = poi.location.split(",").map(Number);
  if (poiLocation.length !== 2 || Number.isNaN(poiLocation[0]) || Number.isNaN(poiLocation[1])) {
    return null;
  }

  // 高德餐饮类型形如 "餐饮服务;中餐厅;浙江菜"
  const cuisine = poi.type?.split(";").filter((t) => t !== "餐饮服务").slice(0, 2).join("/") || "餐厅";

  const rating = poi.biz_ext?.rating !== undefined && poi.biz_ext.rating !== ""
    ? Number(poi.biz_ext.rating)
    : undefined;
  const avgCost = poi.biz_ext?.cost !== undefined && poi.biz_ext.cost !== ""
    ? Number(poi.biz_ext.cost)
    : undefined;

  return {
    name: poi.name,
    cuisine,
    distanceKm: haversineKm(center.latitude, center.longitude, poiLocation[1], poiLocation[0]),
    rating: rating !== undefined && !Number.isNaN(rating) ? rating : undefined,
    avgCost: avgCost !== undefined && !Number.isNaN(avgCost) && avgCost > 0 ? avgCost : undefined,
    address: poi.address,
    local: localHints.some((hint) => cuisine.includes(hint)),
    score: 0,
  };
}

/**
 * 综合分（0-10）：
 * - 评分 40%: (rating-3.5)/1.5*10，无评分按 4 分中性偏保守处理
 * - 就近 30%: 线性衰减，搜索中心处 10 分、半径处 0 分
 * - 价格契合 20%: 有预算时按预算占用给分；无预算时人均 60-150 视为主流舒适区
 * - 本地特色 10%: 菜系命中所在地菜系关键词
 */
function scoreFood(f: FoodInfo, radiusKm: number, maxCost: number | undefined): number {
  const ratingScore = f.rating === undefined
    ? 4
    : Math.min(10, Math.max(0, ((f.rating - 3.5) / 1.5) * 10));
  const distanceScore = Math.min(10, Math.max(0, 10 * (1 - f.distanceKm / radiusKm)));
  const localScore = f.local ? 10 : 5;
  return W_RATING * ratingScore + W_DISTANCE * distanceScore + W_PRICE * priceFit(f.avgCost, maxCost) + W_LOCAL * localScore;
}

function priceFit(cost: number | undefined, maxCost: number | undefined): number {
  if (maxCost !== undefined) {
    if (cost === undefined) return 5;
    return cost <= maxCost * 0.7 ? 10 : cost <= maxCost ? 8 : 0; // 超预算的会被前置过滤，0 仅兜底
  }
  if (cost === undefined) return 5;
  if (cost <= 60) return 8;
  if (cost <= 150) return 10;
  if (cost <= 300) return 6;
  return 3;
}

/** 从地理编码结果提取省市级 token，映射出"本地菜系"关键词集合 */
function localHintsFor(geo: GeoResult): string[] {
  const region = `${geo.admin1 ?? ""} ${geo.name}`;
  const tokens = region
    .replace(/(维吾尔|壮族自治区|回族|自治区|特别行政区|省|市|区|县|自治州)/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const hints = new Set<string>();
  for (const token of tokens) {
    for (const alias of LOCAL_CUISINE_HINTS[token] ?? []) hints.add(alias);
    hints.add(token);
  }
  return [...hints];
}
