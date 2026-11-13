import { externalNow } from "../core/external-environment.ts";
import { annotateToolCall, observeProviderError } from "../core/tool-diagnostics.ts";
import type { ToolContext } from "./tool.ts";
import { cancellableFetch } from "./travel-request.ts";
import { OPENING_FIELDS, type OpeningField, type OpeningSource } from "./opening-facts.ts";
import { isOpeningVenueTitle, matchesOpeningCandidate, mentionsOpeningPlace, scopeOpeningCampus } from "./opening-place.ts";
import { isSearchChallenge, openingArticle, openingPageSnippet, readOpeningPage, openingNavigationLinks } from "./opening-page.ts";
import { fetchPublicOpeningPage, openingPageUrl } from "./opening-page-fetch.ts";
import { cleanHtml, isSearchPage, is360Redirect, queryVariants, filterPlaceSources, OPENING_SEARCH_ENGINES, SEARCH_ENGINES } from "./place-search.ts";
import { extractDurationHints, MAX_DURATION_HINTS, placeTokens, type DurationHint } from "./visit-duration.ts";

/** 两个领域工具共享搜索接口，适配器自身也必须有界，不能隐藏无限重试。 */
export interface PlaceSearchProvider {
  readonly name: string;
  search(query: string, options: { readonly maxResults: number; readonly signal?: AbortSignal }): Promise<readonly OpeningSource[]>;
}
interface Cached<T> { value: T; at: number }
interface PageSnapshot { title: string; opening?: string; review: string; duration: string[]; links: string[] }
interface SearchSnapshot { sources: OpeningSource[]; duration: string[] }
interface Scope {
  cache: Map<string, Cached<SearchSnapshot | PageSnapshot>>;
  sources: Map<string, Cached<OpeningSource[]>>;
  budgets: Map<string, { used: number; at: number }>;
  challenges: Map<string, { hits: number; at: number }>;
}
export interface PlaceLookupOptions {
  readonly place: string;
  readonly city: string;
  readonly suffix: string | ((sources: readonly OpeningSource[], duration: readonly DurationHint[]) => string);
  readonly kind: "visit" | "reviews";
  readonly openingFields: readonly OpeningField[];
  readonly duration: boolean;
  readonly refresh?: boolean;
  readonly enough: (sources: OpeningSource[], duration: DurationHint[]) => boolean;
}
export interface PlaceLookupResult {
  sources: OpeningSource[];
  duration: DurationHint[];
  errors: string[];
  requests: number;
  cacheHits: number;
  observedAt: number;
}

const TTL = 30 * 60_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MAX_CALL_REQUESTS = 4;
export const MAX_PLACE_SOURCE_REQUESTS = 8;

/**
 * 搜索、正文、导航只维护一份实现。缓存和来源预算按任务/证据仓库隔离；
 * 单次最多4次来源请求，同一地点两类工具合计最多8次，换工具/字段不能重置。
 */
export class PlaceSourceClient {
  private readonly scopes = new WeakMap<object, Scope>();
  private readonly fetchFn: typeof fetch;
  private readonly provider?: PlaceSearchProvider;
  constructor(fetchFn: typeof fetch = fetch, provider?: PlaceSearchProvider) { this.fetchFn = fetchFn; this.provider = provider; }

  async collect(options: PlaceLookupOptions, ctx?: ToolContext): Promise<PlaceLookupResult> {
    const owner = ctx?.queryAttempts ?? ctx?.evidence ?? this;
    let state = this.scopes.get(owner);
    if (!state) { state = { cache: new Map(), sources: new Map(), budgets: new Map(), challenges: new Map() }; this.scopes.set(owner, state); }
    const scope = state, now = externalNow().getTime(), entity = JSON.stringify([options.city.replace(/市$/, ""), options.place]);
    let budget = scope.budgets.get(entity);
    if (!budget || (!ctx?.queryAttempts && now - budget.at >= TTL)) { budget = { used: 0, at: now }; scope.budgets.set(entity, budget); }
    const entityBudget = budget;
    const result: PlaceLookupResult = { sources: [], duration: [], errors: [], requests: 0, cacheHits: 0, observedAt: now };
    const opening = options.kind === "visit" && options.openingFields.length > 0;
    const request = cancellableFetch(this.fetchFn, ctx?.signal), requestPage = cancellableFetch(this.fetchFn === fetch ? fetchPublicOpeningPage : this.fetchFn, ctx?.signal);
    const hasBudget = () => result.requests < MAX_CALL_REQUESTS && entityBudget.used < MAX_PLACE_SOURCE_REQUESTS;
    const count = () => { if (!hasBudget()) throw new Error("地点来源请求预算已用尽"); result.requests++; entityBudget.used++; };
    const enough = () => options.enough(result.sources, result.duration);
    const observeDuration = (hints: readonly string[], source: string) => {
      if (!options.duration) return;
      for (const text of hints) if (result.duration.length < MAX_DURATION_HINTS && !result.duration.some((h) => h.text === text)) result.duration.push({ text, source });
    };
    const cached = <T>(key: string): Cached<T> | undefined => {
      if (options.refresh) return undefined;
      const item = scope.cache.get(key); if (!item || now < item.at || now - item.at >= TTL) return undefined;
      result.cacheHits++; result.observedAt = Math.min(result.observedAt, item.at); return item as Cached<T>;
    };
    const save = (key: string, value: SearchSnapshot | PageSnapshot) => {
      if (scope.cache.size >= 64) scope.cache.delete(scope.cache.keys().next().value!);
      scope.cache.set(key, { value, at: now });
    };
    const seed = scope.sources.get(entity);
    if (!options.refresh && seed && now >= seed.at && now - seed.at < TTL) {
      result.sources.push(...seed.value); result.cacheHits++; result.observedAt = seed.at;
      for (const source of seed.value) observeDuration(extractDurationHints(source.snippet, MAX_DURATION_HINTS, placeTokens(options.place)), source.engine ?? "web");
    }
    const visited = new Set<string>(), navigation: OpeningSource[] = [];
    const enqueueLinks = (source: OpeningSource, links: readonly string[]) => {
      for (const url of links) if (!visited.has(url) && !navigation.some((entry) => entry.url === url)) {
        navigation.push({ ...source, url, content_kind: "snippet" });
      }
    };
    const readSource = async (): Promise<boolean> => {
      if (visited.size >= 3) return false;
      const priority = (source: OpeningSource) => {
        const url = openingPageUrl(source.url);
        if (/维基百科|百科全书|百度知道/.test(source.title) || /^(?:easylearn\.baidu\.com|www\.douyin\.com)$/.test(url?.hostname ?? "")) return -1;
        if (opening && isOpeningVenueTitle(source.title, options.place, options.city)) return 130;
        if (url?.hostname.endsWith(".gov.cn")) return 120;
        if (/开放时间|参观指南|参观须知|票务服务/.test(source.title)) return 100;
        return /官网|官方网站/.test(source.title) || source.kind === "official" ? 80 : 0;
      };
      const candidates = [...navigation, ...filterPlaceSources(result.sources, options.place, options.city, true, options.kind === "visit")
        .filter((source) => priority(source) >= 0).sort((a, b) => priority(b) - priority(a))];
      for (const source of candidates) {
        if (visited.size >= 3) break;
        let url = openingPageUrl(source.url);
        if (!url || visited.has(url.href) || (isSearchPage(url) && !is360Redirect(url))) continue;
        const key = `page:${entity}:${url.href}`; let page = cached<PageSnapshot>(key)?.value;
        if (!page && source.content_kind === "page") continue;
        if (!page && !hasBudget()) continue;
        visited.add(url.href);
        const queued = navigation.indexOf(source);
        if (queued >= 0) navigation.splice(queued, 1);
        try {
          if (!page) {
            const signal = AbortSignal.timeout(6_000);
            const read = (target: URL) => {
              count();
              return requestPage(target.href, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN" } });
            };
            let response = await read(url);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              const target = location ? openingPageUrl(new URL(location, url).href) : undefined; await response.body?.cancel();
              if (!target || isSearchPage(target) || isSearchChallenge("", target.href) || (url.protocol === "https:" && target.protocol !== "https:") || !hasBudget()) { result.errors.push("正文跳转目标不可用"); continue; }
              url = target; response = await read(url);
            }
            if (!response.ok) { await response.body?.cancel(); result.errors.push(`正文HTTP ${response.status}`); continue; }
            if (response.headers.get("content-type") && !/text\/html|application\/xhtml|text\/plain/i.test(response.headers.get("content-type")!)) { await response.body?.cancel(); result.errors.push("正文未返回可读取页面"); continue; }
            const html = await readOpeningPage(response);
            if (isSearchChallenge(html, url.href)) { observeProviderError("opening-page", "CAPTCHA"); result.errors.push("正文需要访问验证"); continue; }
            const article = openingArticle(html);
            page = { title: cleanHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""),
              opening: openingPageSnippet(article, 4000, { name: options.place, city: options.city }), review: cleanHtml(article).slice(0, 4000),
              duration: extractDurationHints(cleanHtml(article), MAX_DURATION_HINTS, placeTokens(options.place)), links: openingNavigationLinks(html, url, OPENING_FIELDS).map((link) => link.href) };
            save(key, page);
          }
          const snippet = opening ? page.opening : page.review;
          const titleMatches = mentionsOpeningPlace(page.title, options.place, options.city);
          const sourceMatches = mentionsOpeningPlace(source.title, options.place, options.city);
          const belongs = mentionsOpeningPlace(`${page.title}\n${snippet ?? ""}`, options.place, options.city) || sourceMatches;
          const pageTitleRelated = opening && matchesOpeningCandidate(page.title, "", options.place, options.city);
          const related = opening && (pageTitleRelated || matchesOpeningCandidate(page.title, snippet ?? "", options.place, options.city)
            || matchesOpeningCandidate(source.title, source.snippet, options.place, options.city));
          if (belongs || related) enqueueLinks(source, page.links);
          const title = titleMatches || pageTitleRelated || (!sourceMatches && page.title) ? page.title : source.title;
          const scoped = snippet && opening ? scopeOpeningCampus(title, snippet, options.place, options.city) : undefined;
          if (snippet && (belongs || scoped?.campus) && (!opening || scoped)) result.sources.unshift({ ...source, title,
            snippet, url: url.href, content_kind: "page" });
          if (belongs) observeDuration(page.duration, source.engine ?? "web");
        } catch { ctx?.signal?.throwIfAborted(); result.errors.push("正文读取失败"); }
        return true;
      }
      return false;
    };
    const readNavigation = async () => { await readSource(); while (navigation.length && !enough() && visited.size < 3) if (!await readSource()) break; };
    try {
      // 先投影已取得的正文，切换领域工具不能先发起新搜索。
      if (!enough() && result.sources.length) await readNavigation();
      const searchQuery = (index: number) => {
        const suffix = typeof options.suffix === "string" ? options.suffix : options.suffix(result.sources, result.duration);
        const variants = queryVariants(options.place, options.city, suffix);
        if (options.kind === "visit") variants.reverse();
        return variants[Math.min(index, variants.length - 1)]!;
      };
      if (!enough() && this.provider) {
        const query = searchQuery(0), key = `provider:${entity}:${query}`, hit = cached<SearchSnapshot>(key);
        if (hit) { result.sources.push(...hit.value.sources); observeDuration(hit.value.duration, this.provider.name); }
        else if (hasBudget()) try {
          count(); const sources = (await this.provider.search(query, { maxResults: 5, signal: ctx?.signal })).slice(0, 5).map((s) => ({ ...s, snippet: s.snippet.slice(0, 4000), engine: s.engine ?? this.provider!.name }));
          const duration = sources.flatMap((s) => extractDurationHints(s.snippet, MAX_DURATION_HINTS, placeTokens(options.place)));
          save(key, { sources, duration }); result.sources.push(...sources); observeDuration(duration, this.provider.name);
        } catch (error) { ctx?.signal?.throwIfAborted(); result.errors.push(`${this.provider.name}: ${error instanceof Error ? error.message : String(error)}`); }
        if (!enough()) await readNavigation();
      }
      const engines = options.kind === "visit" ? OPENING_SEARCH_ENGINES : SEARCH_ENGINES;
      for (const [index, engine] of engines.entries()) {
        if (enough()) break;
        const query = searchQuery(index), key = `search:${engine.name}:${query}`, hit = cached<SearchSnapshot>(key);
        if (hit) { result.sources.push(...hit.value.sources); observeDuration(hit.value.duration, engine.name); }
        else {
          if (!hasBudget()) break;
          const recent = scope.challenges.get(engine.name);
          if (recent && recent.hits >= 2 && Date.now() - recent.at < 120_000) { result.errors.push(`${engine.name}: 验证码退避中`); continue; }
          try {
            count(); const response = await request(engine.buildUrl(query), { signal: AbortSignal.timeout(engine.timeoutMs ?? 8_000), headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN" } });
            const html = await readOpeningPage(response, response.ok ? 2_000_000 : 30_000);
            if (isSearchChallenge(html, response.url)) {
              observeProviderError(engine.name, "CAPTCHA"); const at = Date.now(); scope.challenges.set(engine.name, { hits: (recent?.hits ?? 0) + 1, at }); result.errors.push(`${engine.name}: 验证码/访问验证页面`); continue;
            }
            if (!response.ok) { result.errors.push(`${engine.name}: HTTP ${response.status}`); continue; }
            scope.challenges.delete(engine.name);
            const sources = engine.parse(html).map((s) => ({ ...s, engine: engine.name }));
            const duration = extractDurationHints(cleanHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")), MAX_DURATION_HINTS, placeTokens(options.place));
            save(key, { sources, duration }); result.sources.push(...sources); observeDuration(duration, engine.name);
          } catch (error) { ctx?.signal?.throwIfAborted(); result.errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        }
        if (!enough()) await readNavigation();
      }
      while (!enough() && await readSource()) { /* 正文和导航共享同一请求预算。 */ }
      result.sources = filterPlaceSources(result.sources, options.place, options.city, false, opening);
      if (result.sources.length) {
        if (scope.sources.size >= 64) scope.sources.delete(scope.sources.keys().next().value!);
        scope.sources.set(entity, { value: result.sources.slice(0, 10), at: result.observedAt });
      }
      if (!enough() && entityBudget.used >= MAX_PLACE_SOURCE_REQUESTS) result.errors.push("本任务该地点来源预算已用尽，保留已取得信息，不换工具重复取证");
      if (result.requests === 0 && result.cacheHits > 0) ctx?.onQueryReuse?.(result.observedAt);
      return result;
    } finally {
      annotateToolCall({ place_lookup: { kind: options.kind, requests: result.requests, cache_hits: result.cacheHits, entity_requests: entityBudget.used, entity_limit: MAX_PLACE_SOURCE_REQUESTS } });
    }
  }
}
