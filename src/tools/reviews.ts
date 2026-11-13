import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { normalizeReviewArgs, REVIEW_ASPECTS } from "./travel-query.ts";
import { PlaceSourceClient, type PlaceSearchProvider } from "./place-sources.ts";
import { filterPlaceSources } from "./place-search.ts";
import type { OpeningSource } from "./opening-facts.ts";
type SearchResult = OpeningSource;

/** 不以链接数量作为完成条件，只看本次体验问题是否取得有效描述。 */
export function hasReviewAnswer(sources: readonly OpeningSource[], aspect: string): boolean {
  return sources.some((source) => {
    const text = source.snippet;
    if (/暂无.{0,8}(?:信息|资料)|未找到|不详|没有.{0,8}(?:资料|数据)/.test(text)) return false;
    if (aspect === "人均价格") return /(?:人均|每人|客单价|人均消费)[^。；]{0,18}\d+(?:\.\d+)?\s*元|\d+(?:\.\d+)?\s*元\s*[/／]\s*人/.test(text);
    if (aspect === "招牌菜") return /(?:招牌|必点|推荐菜|特色菜|主打|拿手菜)[^。；]{1,50}/.test(text);
    if (aspect === "排队") return /(?:排队|等位|候位)[^。；]{0,35}(?:分钟|小时|不用|无需|不需要|高峰|周末|提前|较长|很久)|(?:不用|无需|不需要|免)排队/.test(text);
    return /值得|推荐|体验|人多|拥挤|安静|排队|服务|环境|口味|好吃|好评|差评|避坑|适合|干净|卫生|风景|景色/.test(text);
  });
}

export function createReviewsTool(fetchFn: typeof fetch = fetch, provider?: PlaceSearchProvider, sources = new PlaceSourceClient(fetchFn, provider)): Tool {
  return {
    name: "get_place_reviews",
    description: "查询用户明确需要的口碑、排队、招牌菜和人均消费体验。摘要不是平台官方评分；不逐个查询全部候选。开放时间、闭馆、公告和游玩时长用get_place_visit_info。",
    parameters: { type: "object", properties: {
      place: { type: "string", description: "地点实体名" }, city: { type: "string", description: "所在城市" },
      aspect: { type: "string", enum: [...REVIEW_ASPECTS], description: "本次体验问题，默认口碑" },
      refresh: { type: "boolean", description: "明确重新核实时使用，仍受共享地点来源预算限制" },
    }, required: ["place"] },
    async execute(raw, ctx) {
      const args = normalizeReviewArgs(raw), city = typeof args.city === "string" ? args.city.trim() : "", inputPlace = requireString(args, "place"), place = ctx?.evidence?.canonicalPlaceName(inputPlace, city) ?? inputPlace, aspect = String(args.aspect);
      const suffix = aspect === "人均价格" ? "人均 价格 多少钱" : aspect === "招牌菜" ? "招牌菜 必点 推荐" : aspect === "排队" ? "排队 等位 攻略" : "点评 评价 值得去吗";
      const result = await sources.collect({ place, city, suffix, kind: "reviews", openingFields: [], duration: false, refresh: args.refresh === true,
        enough: (items) => hasReviewAnswer(filterPlaceSources(items, place, city), aspect) }, ctx);
      const relevant = filterPlaceSources(result.sources, place, city);
      if (!relevant.length && result.errors.length) return `「${place}」的评价搜索失败（${result.errors.join("; ")}），本次未完成资料查询，不记为已查无依据。`;
      if (!relevant.length) return `没有搜到「${place}」的相关评价内容（已过滤百科/词典等无关结果）。口碑数据不足，请以高德评分、人均等结构化数据为准，不要臆测好坏。`;
      const answered = hasReviewAnswer(relevant, aspect);
      const lines = relevant.slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}${r.url ? `\n   来源 ${r.url}` : ""}`);
      return `「${place}」的网络评价摘要（搜索引擎结果，非官方评分，仅供参考）：\n` + lines.join("\n") + popularityNote(extractPopularity(relevant))
        + (answered ? "" : result.errors.length ? `\n评价信息查询受阻（${result.errors.join("; ")}），本次未查清${aspect}，保持待确认，不记为已查无依据。` : `\n未找到明确的${aspect}依据；相关链接不代表已回答该问题。`);
    },
  };
}

interface Popularity {
  readonly reviewCount?: number;
  readonly sourceRatings: number[];
}

/** 从摘要中解析评价数（"2231条点评" / "1.2万条评价"）与第三方评分（"4.6分"） */
function extractPopularity(results: SearchResult[]): Popularity {
  const text = results.map((r) => `${r.title} ${r.snippet}`).join(" ");
  let reviewCount: number | undefined;

  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*万\s*条\s*(?:点评|评价|评论)/g)) {
    const value = Math.round(Number(match[1]) * 10_000);
    if (reviewCount === undefined || value > reviewCount) reviewCount = value;
  }
  for (const match of text.matchAll(/(\d+)\s*条\s*(?:点评|评价|评论)/g)) {
    const value = Number(match[1]);
    if (reviewCount === undefined || value > reviewCount) reviewCount = value;
  }

  const sourceRatings = [...text.matchAll(/([3-5](?:\.\d)?)\s*分/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 3 && value <= 5);
  return { reviewCount, sourceRatings };
}

function popularityNote(popularity: Popularity): string {
  const parts: string[] = [];
  if (popularity.reviewCount !== undefined) {
    parts.push(`评价数约 ${popularity.reviewCount} 条`);
  }
  if (popularity.sourceRatings.length > 0) {
    parts.push(`第三方评分样本 ${[...new Set(popularity.sourceRatings)].slice(0, 4).join("/")}`);
  }
  if (parts.length === 0) return "";
  const confidence =
    popularity.reviewCount !== undefined && popularity.reviewCount < 50
      ? "（评价数偏少，评分参考性弱）"
      : "";
  return `\n口碑热度: ${parts.join("；")}${confidence}。评分相近的候选优先评价数多的。`;
}
