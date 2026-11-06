import type { ClosureSource } from "./closure-policy.ts";
import { isSearchChallenge, openingPageSnippet, readOpeningPage } from "./opening-page.ts";
import { observeProviderError } from "../core/tool-diagnostics.ts";

/** 已核对的官网入口，仅作为取证来源，不对行程验收提供豁免。 */
const VISIT_PAGES = [
  { city: "成都", names: ["成都大熊猫繁育研究基地", "成都熊猫基地", "大熊猫繁育研究基地", "熊猫基地"], url: "https://www.panda.org.cn/cn/service/ticket/", title: "成都大熊猫繁育研究基地" },
  { city: "北京", names: ["故宫", "故宫博物院"], url: "https://www.dpm.org.cn/Visit.html", title: "故宫博物院" },
  { city: "北京", names: ["国家博物馆", "中国国家博物馆"], url: "https://www.chnmuseum.cn/", title: "中国国家博物馆" },
];

function visitPage(place: string, city: string) {
  return VISIT_PAGES.find((page) => page.city === city.replace(/市$/, "") && page.names.includes(place));
}

export function isKnownOpeningOfficial(url: URL, place: string, city: string): boolean {
  const page = visitPage(place, city);
  return page !== undefined && url.protocol === "https:" && url.origin === new URL(page.url).origin;
}

/** 固定公开官网地址，无任意URL抓取/跳转；有界读取，保留各开放字段附近正文。 */
export async function officialOpeningSource(place: string, city: string, request: typeof fetch): Promise<ClosureSource | undefined> {
  const page = visitPage(place, city);
  if (!page) return undefined;
  const response = await request(page.url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "zh-CN" } });
  if (!response.ok) { await response.body?.cancel(); return undefined; }
  const html = await readOpeningPage(response);
  if (isSearchChallenge(html, response.url)) { observeProviderError("official-web", "CAPTCHA"); throw new Error("官网返回验证码/访问验证页面"); }
  const snippet = openingPageSnippet(html);
  return snippet ? { title: `${place}（${page.title}官网开放信息）`, snippet, engine: "official-web", url: page.url } : undefined;
}
