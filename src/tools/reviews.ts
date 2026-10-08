import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";

type FetchLike = typeof fetch;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface SearchResult {
  readonly title: string;
  readonly snippet: string;
}

/**
 * 抓取地点的网络评价摘要。
 * 数据来源是搜索引擎结果摘要（标题+片段），不是平台原始评分 ——
 * 返回内容明确标注这一点，让 LLM 据此做"口碑筛选"而不是编造分数。
 */
export function createReviewsTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "get_place_reviews",
    description:
      "抓取某个景点/地点的网络评价摘要（来自搜索引擎）。用于筛选口碑好的地点：" +
      "先用 search_attractions 拿到候选列表，再对候选逐个查询口碑，" +
      "根据摘要中提到的评价关键词（好评/差评/人多/坑/值得等）给出筛选建议。" +
      "同时解析评价数量与第三方评分（口碑热度）——终选时评分相近优先评价数多的，" +
      "评价数过少（<50）的高分不可信。摘要不代表官方评分，不要编造具体分数。" +
      "结果已做相关性过滤（剔除百科/词典等无关词条）；返回「没有搜到相关评价内容」时说明该地点网上口碑数据不足，" +
      "不要据此推断好坏，改用高德评分/人均等结构化数据决策。",
    parameters: {
      type: "object",
      properties: {
        place: { type: "string", description: "景点名，例如：灵隐寺" },
        city: { type: "string", description: "所在城市，提高搜索准确性，例如：杭州" },
        aspect: { type: "string", description: "关注侧面：口碑(默认)/人均价格/招牌菜/排队。餐厅查价格用 人均价格" },
      },
      required: ["place"],
    },
    async execute(args) {
      const place = requireString(args, "place");
      const city = typeof args.city === "string" ? args.city.trim() : "";
      const aspect = typeof args.aspect === "string" ? args.aspect.trim() : "";
      const suffix =
        aspect === "人均价格" ? "人均 价格 多少钱"
        : aspect === "招牌菜" ? "招牌菜 必点 推荐"
        : aspect === "排队" ? "排队 等位 攻略"
        : "点评 评价 值得去吗";

      const errors: string[] = [];
      let searchSucceeded = false; // 至少一个引擎成功返回过页面（用于区分"没搜到相关"与"搜索失败"）
      const collected: SearchResult[] = [];
      for (const engine of SEARCH_ENGINES) {
        for (const searchQuery of queryVariants(place, city, suffix)) {
          try {
            const response = await fetchFn(engine.buildUrl(searchQuery), {
              headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) {
              errors.push(`${engine.name}: HTTP ${response.status}`);
              break; // 引擎不可用 → 换下一个引擎
            }
            searchSucceeded = true;
            collected.push(...engine.parse(await response.text()));
          } catch (error) {
            // 例如 DuckDuckGo 在部分网络环境不可达，降级到下一个引擎
            errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
            break;
          }
          // 相关结果够用就不再补查下一个变体
          if (filterRelevant(collected, place, city).length >= 3) break;
        }
        // 跨引擎累计：单一引擎命中不足时由下一个引擎补足，凑够 3 条相关即停
        if (filterRelevant(collected, place, city).length >= 3) break;
      }

      const relevant = filterRelevant(collected, place, city);
      if (relevant.length > 0) {
        return formatResults(place, relevant);
      }
      if (!searchSucceeded && errors.length > 0) {
        return `「${place}」的评价搜索失败（${errors.join("; ")}），建议参考其他来源判断。`;
      }
      return (
        `没有搜到「${place}」的相关评价内容（已过滤百科/词典等无关结果）。` +
        `该地点网上口碑数据不足，请以高德评分、人均等结构化数据为准，不要臆测好坏。`
      );
    },
  };
}

/** 噪声结果：百科/词典词条对口碑判断没有价值（冷门地点常命中汉字释义） */
const NOISE_TITLE_PATTERN = /(百度百科|百度词典|汉典|词典|字典|汉语国学|字的意思|的拼音|是什么意思|组词)/;

/** 地点名的定位词：全名、去括号、剥景区前缀（"衢州古城文化旅游区天王塔"→"天王塔"） */
function placeTokens(place: string): string[] {
  const tokens = new Set<string>();
  const base = place.replace(/[（(][^)）]*[)）]/g, "").trim();
  if (base.length >= 2) tokens.add(base);
  const stripped = base.replace(/^.*?(?:旅游区|景区|风景区|历史文化街区|文化街区|街区)(?=.)/, "").trim();
  if (stripped.length >= 2 && stripped !== base) tokens.add(stripped);
  return [...tokens];
}

/** 查询变体：先精确匹配（引号），再放宽；长景区名再补一个"短名"查询 */
function queryVariants(place: string, city: string, suffix: string): string[] {
  const cityPart = city === "" ? "" : ` ${city}`;
  const variants = [`"${place}"${cityPart} ${suffix}`, `${place}${cityPart} ${suffix}`];
  const short = placeTokens(place).find((token) => token !== place);
  if (short !== undefined) {
    variants.push(`"${short}"${cityPart} ${suffix}`);
  }
  return variants;
}

/**
 * 相关性过滤：只保留提及地点名的结果，剔除百科/词典等噪声；
 * 有足够提及城市的结果时优先用它们（排除同名异地）。
 */
function filterRelevant(results: SearchResult[], place: string, city: string): SearchResult[] {
  const tokens = placeTokens(place);
  const seen = new Set<string>();
  const relevantResults = results.filter((result) => {
    const key = `${result.title}\n${result.snippet.slice(0, 40)}`;
    if (seen.has(key)) return false; // 多个查询变体可能带回重复结果
    seen.add(key);
    if (NOISE_TITLE_PATTERN.test(result.title)) return false;
    if (result.title.startsWith('"') || result.title.startsWith("“")) return false; // 搜索引擎回显的查询标题
    const text = `${result.title} ${result.snippet}`;
    return tokens.some((token) => text.includes(token));
  });
  if (city !== "") {
    const local = relevantResults.filter((result) => `${result.title} ${result.snippet}`.includes(city));
    if (local.length >= 2) return local;
  }
  return relevantResults;
}

function formatResults(place: string, results: SearchResult[]): string {
  const lines = results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title}${r.snippet === "" ? "" : `\n   ${r.snippet}`}`);
  const popularity = extractPopularity(results);
  return (
    `「${place}」的网络评价摘要（搜索引擎结果，非官方评分，仅供参考）:\n` +
    lines.join("\n") +
    popularityNote(popularity)
  );
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

/** 搜索引擎列表：按顺序尝试，前者失败或无结果时降级 */
const SEARCH_ENGINES: Array<{
  readonly name: string;
  buildUrl(query: string): string;
  parse(html: string): SearchResult[];
}> = [
  {
    name: "bing",
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`,
    parse: parseBing,
  },
  {
    // 百度对国内小店/本地内容的收录明显更好（Bing 常对冷门店名回退成字典词条）
    name: "baidu",
    buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=20`,
    parse: parseBaidu,
  },
  {
    // 360 搜索：本地生活/点评类内容（携程美食林、大众点评页）收录好，结果页是标准 HTML
    name: "360",
    buildUrl: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: parse360,
  },
  {
    name: "duckduckgo",
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGo,
  },
];

/** 360 搜索: <li class="res-list"> 块内 <h3><a>标题</a> + res-desc 摘要 */
function parse360(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of html.matchAll(/<li class="res-list[\s\S]*?<\/li>/g)) {
    const block = match[0];
    const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch === null) continue;
    const title = cleanHtml(titleMatch[1]);
    if (title === "") continue;
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, snippet: snippetMatch === null ? "" : cleanHtml(snippetMatch[1]) });
  }
  return results;
}

/** 百度结果页: <h3> 内的 <a> 标题 + c-abstract/content-right 摘要（两列按序配对） */
function parseBaidu(html: string): SearchResult[] {
  const titles: string[] = [];
  for (const match of html.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/g)) {
    const title = cleanHtml(match[1]);
    if (title !== "") titles.push(title);
  }
  const snippets: string[] = [];
  for (const match of html.matchAll(
    /<(?:div|span)[^>]*class="[^"]*(?:c-abstract|c-span-last|content-right_[^"\s]*)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/g,
  )) {
    snippets.push(cleanHtml(match[1]));
  }

  const results: SearchResult[] = [];
  const count = Math.max(titles.length, snippets.length);
  for (let i = 0; i < count; i++) {
    const title = titles[i] ?? "";
    const snippet = snippets[i] ?? "";
    if (title === "" && snippet === "") continue;
    results.push({ title, snippet });
  }
  return results;
}

/** Bing 结果页: <li class="b_algo"> 块内 <h2><a>标题</a></h2> + 第一个 <p>摘要</p> */
function parseBing(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of html.matchAll(/<li class="b_algo[^"]*"[\s\S]*?<\/li>/g)) {
    const block = match[0];
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (titleMatch === null) continue;

    const title = cleanHtml(titleMatch[1]);
    const snippet = snippetMatch === null ? "" : cleanHtml(snippetMatch[1]);
    if (title === "" && snippet === "") continue;
    results.push({ title, snippet });
  }
  return results;
}

/** DuckDuckGo HTML 版结果页: result__a 标题 + result__snippet 摘要 */
function parseDuckDuckGo(html: string): SearchResult[] {
  const titles: string[] = [];
  const snippets: string[] = [];

  for (const match of html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    titles.push(cleanHtml(match[1]));
  }
  for (const match of html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    snippets.push(cleanHtml(match[1]));
  }

  const results: SearchResult[] = [];
  const count = Math.min(titles.length, snippets.length);
  for (let i = 0; i < count; i++) {
    if (titles[i] === "" && snippets[i] === "") continue;
    results.push({ title: titles[i], snippet: snippets[i] });
  }
  return results;
}

function cleanHtml(fragment: string): string {
  return unescapeEntities(fragment.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function unescapeEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#x27;": "'", "&#39;": "'", "&nbsp;": " ",
    "&ensp;": " ", "&emsp;": " ", "&mdash;": "—", "&middot;": "·",
    "&hellip;": "…", "&ldquo;": "“", "&rdquo;": "”", "&lsquo;": "‘", "&rsquo;": "’",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  // 数字实体：&#183; / &#0183; / &#xB7;
  result = result.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
  return result;
}
