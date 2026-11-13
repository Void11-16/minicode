import type { OpeningSource } from "./opening-facts.ts";
import { matchesOpeningCandidate, mentionsOpeningPlace, scopeOpeningCampus } from "./opening-place.ts";
import { openingPageUrl } from "./opening-page-fetch.ts";
import { placeTokens } from "./visit-duration.ts";
type SearchResult = OpeningSource;
export function is360Redirect(url: URL): boolean { return url.hostname === "www.so.com" && url.pathname === "/link"; }
export function isSearchPage(url: URL): boolean { return /^(?:(?:www\.)?(?:baidu|bing|so)\.com|(?:baike|wenku)\.baidu\.com|html\.duckduckgo\.com|(?:ai|map|wenda)\.so\.com|map\.360\.cn)$/.test(url.hostname); }
const NOISE_TITLE_PATTERN = /(百度百科|百度词典|汉典|词典|字典|汉语国学|字的意思|的拼音|是什么意思|组词)/;

/** 地点名的定位词：全名、去括号、剥景区前缀（"衢州古城文化旅游区天王塔"→"天王塔"） */
export function queryVariants(place: string, city: string, suffix: string): string[] {
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
export function filterPlaceSources(results: SearchResult[], place: string, city: string, allowTitleOnly = false, opening = allowTitleOnly): SearchResult[] {
  const tokens = placeTokens(place);
  const seen = new Set<string>();
  const relevantResults = results.filter((result) => {
    const key = `${result.title}\n${result.snippet.slice(0, 40)}`;
    if (seen.has(key)) return false; // 多个查询变体可能带回重复结果
    seen.add(key);
    if (NOISE_TITLE_PATTERN.test(result.title)) return false;
    if (opening && /文库|招聘|招标/.test(result.title)) return false;
    const url = opening && openingPageUrl(result.url);
    if (url && /\.pdf$/i.test(url.pathname) && allowTitleOnly) return false;
    if (url && isSearchPage(url) && !is360Redirect(url)
      && !/\d{1,2}[:：][0-5]\d|全天开放|闭馆|闭园/.test(result.snippet)) return false;
    if (/放心购|大牌汇聚|在线下单|退换无忧|淘你满意|淘宝|京东商城|广告推广/.test(`${result.title} ${result.snippet}`)) return false;
    if (!allowTitleOnly && result.snippet.trim().length < 4 && !/(?:周[一二三四五六日天].*(?:闭馆|休馆)|\d{1,2}:\d{2}|全天开放|24小时|游玩.*\d.*小时)/.test(`${result.title} ${result.snippet}`)) return false;
    if (result.title.startsWith('"') || result.title.startsWith("“")) return false; // 搜索引擎回显的查询标题
    const text = `${result.title} ${result.snippet}`;
    if (!opening) return tokens.some((token) => text.includes(token));
    if (allowTitleOnly) return matchesOpeningCandidate(result.title, result.snippet, place, city);
    const body = scopeOpeningCampus(result.title, result.snippet, place, city);
    return body !== undefined && (body.campus !== undefined || mentionsOpeningPlace(text, place, city));
  });
  if (!opening && city !== "") {
    const local = relevantResults.filter((result) => `${result.title} ${result.snippet}`.includes(city));
    if (local.length >= 2) return local;
  }
  if (!opening || allowTitleOnly) return relevantResults;
  return relevantResults.map((result) => {
    const scoped = scopeOpeningCampus(result.title, result.snippet, place, city);
    return scoped?.campus ? { ...result, snippet: scoped.text } : result;
  });
}

/** 搜索引擎列表：按顺序尝试，前者失败或无结果时降级 */
export const SEARCH_ENGINES: Array<{
  readonly name: string;
  readonly timeoutMs?: number;
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
    // 国内网络下经常无响应；它是最后降级项，不能占用完整的 30 秒。
    timeoutMs: 4_000,
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGo,
  },
];
// 南昌样本中DuckDuckGo返回过明确的游览资料，360多为验证页或中转链接。
export const OPENING_SEARCH_ENGINES = SEARCH_ENGINES.filter((engine) => engine.name !== "360")
  .concat(SEARCH_ENGINES.filter((engine) => engine.name === "360"));

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
    results.push({ title, snippet: snippetMatch === null ? "" : cleanHtml(snippetMatch[1]), url: resultUrl(block, "https://www.so.com") });
  }
  return results;
}

/** 按各自标题后至下一标题的局部区域取摘要，避免缺摘要时把后一个结果错配给前一个。 */
function parseBaidu(html: string): SearchResult[] {
  // 新版结果把落地页和摘要放在卡片属性及服务端渲染数据里。
  const cards = [...html.matchAll(/<div\b[^<>]*\bmu="([^"]+)"[^<>]*>/gi)];
  const modern: SearchResult[] = [];
  for (const [index, card] of cards.entries()) {
    if (!/\bclass="result\s/.test(card[0])) continue;
    const block = html.slice(card.index + card[0].length, cards[index + 1]?.index ?? html.length);
    const title = cleanHtml(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? "");
    if (!title) continue;
    let snippet = "";
    const data = /<!--s-data:(\{"summaryData"[\s\S]*?)-->/.exec(block)?.[1];
    if (data) try {
      // 渲染器对HTML注释中的连字符转义，恢复后才是JSON。
      const lines = JSON.parse(data.replaceAll("\\-", "-")).summaryData?.generalLines;
      if (Array.isArray(lines)) snippet = cleanHtml(lines.flatMap((line) => Array.isArray(line?.data) ? line.data : [])
        .flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join(" ")).slice(0, 1500);
    } catch { /* 卡片数据损坏时仍可使用标题和落地页。 */ }
    const url = resultUrl(`<a href="${card[1]}">`, "https://www.baidu.com");
    modern.push({ title, snippet, url });
  }
  if (modern.length) return modern;
  const titles = [...html.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/g)];
  return titles.map((match, index) => {
    const block = html.slice(match.index + match[0].length, titles[index + 1]?.index ?? html.length);
    const snippet = block.match(/<(?:div|span|p)[^>]*class="[^"]*(?:c-abstract|c-span-last|content-right_[^"\s]*)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/);
    return { title: cleanHtml(match[1]!), snippet: snippet ? cleanHtml(snippet[1]!) : "", url: resultUrl(match[0], "https://www.baidu.com") };
  });
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
    results.push({ title, snippet, url: resultUrl(block, "https://www.bing.com") });
  }
  return results;
}

/** DuckDuckGo HTML 版结果页: result__a 标题 + result__snippet 摘要 */
function parseDuckDuckGo(html: string): SearchResult[] {
  const titles = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  return titles.map((match, index) => {
    const block = html.slice(match.index + match[0].length, titles[index + 1]?.index ?? html.length), snippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    return { title: cleanHtml(match[1]!), snippet: snippet ? cleanHtml(snippet[1]!) : "", url: resultUrl(match[0], "https://html.duckduckgo.com") };
  });
}

function resultUrl(block: string, base: string): string | undefined {
  const href = /<a\b[^>]*\bhref=["']([^"']+)["']/i.exec(block)?.[1]; if (!href) return undefined;
  try {
    let url = new URL(unescapeEntities(href), base);
    const destination = url.searchParams.get("uddg"); if (destination) url = new URL(destination);
    const encoded = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : undefined;
    if (encoded?.startsWith("a1")) url = new URL(Buffer.from(encoded.slice(2), "base64url").toString("utf8"));
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export function cleanHtml(fragment: string): string {
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
