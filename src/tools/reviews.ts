import { officialOpeningSource } from "./official-opening.ts";
import { cancellableFetch } from "./travel-request.ts";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { normalizeReviewArgs } from "./travel-query.ts";
import { OPENING_FIELDS, extractOpeningFacts, isHistoricalOpening, mentionsOpeningPlace, requestedOpeningFields, type OpeningSource } from "./opening-facts.ts";
import { annotateToolCall, observeProviderError } from "../core/tool-diagnostics.ts";
import { isSearchChallenge, openingArticle, openingPageSnippet, readOpeningPage, openingNavigationLinks } from "./opening-page.ts";
import { fetchPublicOpeningPage, openingPageUrl } from "./opening-page-fetch.ts";

type FetchLike = typeof fetch;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type SearchResult = OpeningSource;

const OPENING_KEYWORDS = {
  hours: "开放时间", closure: "每周 闭馆", last_admission: "停止入园 最后入场",
  sessions: "表演 场次", notices: "开放调整 临时公告",
};
const CAPTCHA_COOLDOWN_MS = 2 * 60_000;

function is360Redirect(url: URL): boolean {
  return url.hostname === "www.so.com" && url.pathname === "/link";
}

function isSearchPage(url: URL): boolean {
  return /^(?:(?:www\.)?(?:baidu|bing|so)\.com|(?:baike|wenku)\.baidu\.com|html\.duckduckgo\.com|(?:ai|map|wenda)\.so\.com|map\.360\.cn)$/.test(url.hostname);
}
/** 新搜索API适配到统一来源格式；正文片段也走相同实体/字段校验，不直接采用生成答案。 */
export interface ReviewSearchProvider {
  readonly name: string;
  search(query: string, options: { readonly maxResults: number; readonly signal?: AbortSignal }): Promise<readonly OpeningSource[]>;
}

/**
 * 抓取地点的网络评价摘要。
 * 数据来源是搜索引擎结果摘要（标题+片段），不是平台原始评分 ——
 * 返回内容明确标注这一点，让 LLM 据此做"口碑筛选"而不是编造分数。
 */
export function createReviewsTool(fetchFn: FetchLike = fetch, provider?: ReviewSearchProvider): Tool {
  // queryAttempts 与一次旅游任务同寿命，其他会话可以独立尝试。
  const challenges = new WeakMap<Map<string, number>, Map<string, { hits: number; at: number }>>();
  return {
    name: "get_place_reviews",
    description:
      "抓取地点的网络评价和开放信息，摘要不完整时读取少量相关来源正文，清楚的地图、文旅、票务等资料均可回填。" +
      "仅补已选地点缺失的开放/闭馆/时长等关键事实或用户明确要求的口碑，不对候选逐个调用；" +
      "根据摘要中提到的评价关键词（好评/差评/人多/坑/值得等）给出筛选建议。" +
      "同时解析评价数量与第三方评分（口碑热度）——终选时评分相近优先评价数多的，" +
      "评价数过少（<50）的高分不可信。摘要不代表官方评分，不要编造具体分数。" +
      "输出中可能包含『游玩时长参考』（从摘要提取的建议游玩时长，如\"一般游玩 2-4 小时\"）——" +
      "给景点安排时长时优先采用，可用 aspect=游玩时长 专门查询。" +
      "结果已做相关性过滤（剔除百科/词典等无关词条）；返回「没有搜到相关评价内容」时说明该地点网上口碑数据不足，" +
      "不要据此推断好坏，改用高德评分/人均等结构化数据决策。place 只填实体名，不拼接开放时间或周一闭馆等检索词；同一事项已无依据时不要反复查询。",
    parameters: {
      type: "object",
      properties: {
        place: { type: "string", description: "景点名，例如：灵隐寺" },
        city: { type: "string", description: "所在城市，提高搜索准确性，例如：杭州" },
        aspect: { type: "string", description: "关注侧面：口碑(默认)/人均价格/招牌菜/排队/游玩时长/开放时间/闭馆时间" },
        fields: { type: "array", items: { type: "string", enum: [...OPENING_FIELDS] }, description: "开放信息可只补缺失字段：hours开放时段、closure闭馆日、last_admission最后入场、sessions场次、notices临时公告。默认按地点类型选择，一次提取所有返回字段，不重复查询已查缺口。" },
        visit_date: { type: "string", description: "补查临时公告时可提供实际访问日期，格式 YYYY-MM-DD" },
        refresh: { type: "boolean", description: "明确需要重新核实时跳过缓存一次；同一任务同事项最多两次查询/复用，不能无限刷新" },
      },
      required: ["place"],
    },
    async execute(args, ctx) {
      args = normalizeReviewArgs(args);
      ctx?.signal?.throwIfAborted();
      const request = cancellableFetch(fetchFn, ctx?.signal);
      const city = typeof args.city === "string" ? args.city.trim() : "";
      await ctx?.evidence?.load();
      const inputPlace = requireString(args, "place");
      const place = ctx?.evidence?.canonicalPlaceName(inputPlace, city) ?? inputPlace;
      const aspect = typeof args.aspect === "string" ? args.aspect.trim() : "";
      const openingFields = aspect === "开放时间" ? requestedOpeningFields({ ...args, place }) : [];
      if (openingFields.length) annotateToolCall({ opening_fields: { requested: openingFields, retrieved_sources: 0, extracted: [], evidence_ids: [] } });
      const suffix =
        aspect === "人均价格" ? "人均 价格 多少钱"
        : aspect === "招牌菜" ? "招牌菜 必点 推荐"
        : aspect === "排队" ? "排队 等位 攻略"
        : aspect === "游玩时长" ? "建议游玩时长"
        : aspect === "开放时间" ? [...openingFields.map((field) => OPENING_KEYWORDS[field]), args.visit_date].filter(Boolean).join(" ")
        : "点评 评价 值得去吗";

      const errors: string[] = [];
      const task = ctx?.queryAttempts;
      let challengeState = task && challenges.get(task);
      if (task && !challengeState && openingFields.length) {
        challengeState = new Map();
        challenges.set(task, challengeState);
      }
      let searchSucceeded = false; // 至少一个引擎成功返回过页面（用于区分"没搜到相关"与"搜索失败"）
      const collected: SearchResult[] = [];
      const finishOpening = async (sources: readonly SearchResult[], interrupted = false): Promise<string> => {
        if (!openingFields.length) return "";
        const facts = ctx?.evidence ? await ctx.evidence.observeOpening(city, place, sources, openingFields, interrupted || Boolean(args.visit_date)) : extractOpeningFacts(city, place, sources, openingFields);
        const verified = facts.filter((f) => f.status === "verified" && !isHistoricalOpening(f));
        const historical = facts.find((f) => isHistoricalOpening(f));
        annotateToolCall({ opening_fields: { requested: openingFields, retrieved_sources: sources.filter((s) => s.url).length, body_sources: sources.filter((s) => s.content_kind === "page" || s.engine === "official-web").length,
          extracted: verified.filter((f) => openingFields.includes(f.field)).map((f) => f.field), evidence_ids: verified.map((f) => f.id) } });
        const summary = ctx?.evidence?.openingSummary(city, place, [...new Set([...openingFields, ...facts.filter((f) => f.status === "verified").map((f) => f.field)])])
          ?? facts.filter((f) => !interrupted || f.status !== "not_found").map((f) => `${f.field}: ${f.status}${f.value === undefined ? "" : ` ${JSON.stringify(f.value)} evidence_id=${f.id}`}`).join("\n");
        const unconfirmed = openingFields.filter((field) => !verified.some((fact) => fact.field === field));
        const blocked = interrupted && unconfirmed.length
          ? `\n开放信息查询受阻，待确认字段：${unconfirmed.join("、")}。已取得的有效字段仍可使用。`
          : "";
        return `\n开放字段证据（逐字段保存，未知不等于关闭；场地开放与表演场次分开）：\n${summary}${historical ? "\n仅历史参考：上述过期时段不适用于当前排程。" : ""}${blocked}`;
      };
      let requestCount = 0;
      const visitedPages = new Set<string>();
      const navigation: SearchResult[] = [];
      const readPriority = (source: SearchResult) => {
        if (/维基百科|百科全书|百度知道/.test(source.title)) return -1;
        if (/开放时间|参观指南|参观须知|票务服务/.test(source.title)) return 100;
        if (/官网|官方网站/.test(source.title) || source.kind === "official" || source.engine === "official-web") return 80;
        try { if (new URL(source.url ?? "").hostname.endsWith(".gov.cn")) return 60; } catch { /* 无地址不排序加权。 */ }
        return 0;
      };
      const requestPage = cancellableFetch(fetchFn === fetch ? fetchPublicOpeningPage : fetchFn, ctx?.signal);
      const readSource = async (): Promise<boolean> => {
        if (!openingFields.length || requestCount >= 4 || visitedPages.size >= 3) return false;
        const candidates = [...navigation.splice(0), ...filterRelevant(collected, place, city, true)
          .filter((source) => readPriority(source) >= 0).sort((a, b) => readPriority(b) - readPriority(a))];
        for (const source of candidates) {
          if (source.content_kind === "page" || source.engine === "official-web") continue;
          let url = openingPageUrl(source.url);
          if (!url || visitedPages.has(url.href) || (isSearchPage(url) && !is360Redirect(url))) continue;
          // 已知搜索跳转需要预留一次请求读取落地页。
          if (is360Redirect(url) && requestCount >= 3) continue;
          visitedPages.add(url.href);
          try {
            const signal = AbortSignal.timeout(6_000);
            const read = (target: URL) => {
              requestCount++;
              return requestPage(target.href, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" } });
            };
            let response = await read(url);
            if ([301, 302, 303, 307, 308].includes(response.status) && requestCount < 4) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              const target = location && openingPageUrl(new URL(location, url).href);
              if (!target || isSearchPage(target) || isSearchChallenge("", target.href) || (url.protocol === "https:" && target.protocol !== "https:")) {
                errors.push("正文跳转目标不可用");
                return true;
              }
              url = target;
              response = await read(url);
            }
            const contentType = response.headers.get("content-type");
            if (!response.ok || (contentType && !/html|text\/plain/i.test(contentType))) {
              await response.body?.cancel();
              errors.push("正文未返回可读取页面");
              return true;
            }
            const html = await readOpeningPage(response);
            if (isSearchChallenge(html, url.href)) {
              observeProviderError("opening-page", "CAPTCHA");
              errors.push("正文需要访问验证");
              return true;
            }
            const snippet = openingPageSnippet(openingArticle(html));
            const pageTitle = cleanHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
            const belongs = mentionsOpeningPlace(`${pageTitle}\n${snippet ?? ""}`, place, city)
              || mentionsOpeningPlace(source.title, place, city);
            if (belongs) {
              for (const target of openingNavigationLinks(html, url, openingFields)) {
                if (!visitedPages.has(target.href)) navigation.push({ ...source, url: target.href, content_kind: "snippet" });
              }
            }
            if (snippet && belongs) {
              collected.unshift({ ...source, snippet, url: url.href, content_kind: "page" });
            }
          } catch {
            ctx?.signal?.throwIfAborted();
            errors.push("正文读取失败");
          }
          return true;
        }
        return false;
      };
      const readWithNavigation = async () => {
        await readSource();
        while (navigation.length && !hasEnoughReviewFacts(place, city, aspect, collected, 0, openingFields) && requestCount < 4 && visitedPages.size < 3) {
          if (!await readSource()) break;
        }
      };
      if (aspect === "开放时间") {
        // 官网读取占用同一4次请求预算，不增加无限重试分支。
        const counted: typeof fetch = (input, init) => { requestCount++; return request(input, init); };
        try {
          const source = await officialOpeningSource(place, city, counted);
          if (source) {
            searchSucceeded = true;
            collected.push(source);
            if (extractOpeningFacts(city, place, [source], openingFields).filter((f) => openingFields.includes(f.field)).every((f) => f.status === "verified" && !isHistoricalOpening(f))) {
              return formatResults(place, [source], true) + await finishOpening([source]);
            }
          }
        } catch (error) { ctx?.signal?.throwIfAborted(); errors.push(`官网: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const durationHints: Array<{ text: string; source: string }> = [];
      const variants = queryVariants(place, city, suffix);
      if (openingFields.length) variants.reverse();
      if (provider && requestCount < 4) {
        requestCount++;
        try {
          const results = await provider.search(variants[0]!, { maxResults: 5, signal: ctx?.signal });
          searchSucceeded = true;
          collected.push(...results.slice(0, 5).map((result) => ({ ...result, snippet: result.snippet.slice(0, 4000), engine: result.engine ?? provider.name })));
          if (!hasEnoughReviewFacts(place, city, aspect, collected, durationHints.length, openingFields)) await readWithNavigation();
          if (hasEnoughReviewFacts(place, city, aspect, collected, durationHints.length, openingFields)) {
            const relevant = filterRelevant(collected, place, city, false, openingFields.length > 0);
            return formatResults(place, relevant, openingFields.length > 0) + await finishOpening(relevant);
          }
        } catch (error) { ctx?.signal?.throwIfAborted(); errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      // 每个引擎只用一个有差异的查询，最多4次HTTP；不在同一引擎反复换词。
      const engines = openingFields.length ? OPENING_SEARCH_ENGINES : SEARCH_ENGINES;
      for (const [engineIndex, engine] of engines.entries()) {
        if (requestCount >= 4) break;
        const recent = challengeState?.get(engine.name);
        if (recent && recent.hits >= 2 && Date.now() - recent.at < CAPTCHA_COOLDOWN_MS) {
          errors.push(`${engine.name}: 验证码退避中`);
          continue;
        }
        requestCount++;
        const searchQuery = variants[Math.min(engineIndex, variants.length - 1)]!;
        try {
          const response = await request(engine.buildUrl(searchQuery), {
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
            signal: AbortSignal.timeout(engine.timeoutMs ?? 8_000),
          });
          const html = await readOpeningPage(response, response.ok ? 2_000_000 : 30_000);
          if (isSearchChallenge(html, response.url)) {
            const at = Date.now(), previous = challengeState?.get(engine.name);
            challengeState?.set(engine.name, { at, hits: previous && at - previous.at < CAPTCHA_COOLDOWN_MS ? previous.hits + 1 : 1 });
            observeProviderError(engine.name, "CAPTCHA");
            errors.push(`${engine.name}: 验证码/访问验证页面`);
            continue;
          }
          if (!response.ok) {
            errors.push(`${engine.name}: HTTP ${response.status}`);
            continue;
          }
          if ((challengeState?.get(engine.name)?.hits ?? 0) < 2) challengeState?.delete(engine.name);
          searchSucceeded = true;
          collected.push(...engine.parse(html).map((result) => ({ ...result, engine: engine.name })));
          // 顺手提取"建议游玩时长"类句子（百度 AI 摘要/攻略页面里常直接给时长）
          for (const hint of extractDurationHints(pageText(html), MAX_DURATION_HINTS, placeTokens(place))) {
            if (durationHints.length >= MAX_DURATION_HINTS) break;
            const key = hint.replace(/\s+/g, "").slice(0, 26);
            if (durationHints.some((entry) => entry.text.replace(/\s+/g, "").slice(0, 26) === key)) continue;
            durationHints.push({ text: hint, source: engine.name });
          }
        } catch (error) {
          ctx?.signal?.throwIfAborted();
          // 例如 DuckDuckGo 在部分网络环境不可达，降级到下一个引擎
          errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        // 按本次所需事实停止；标题数量不能冒充闭馆或时长依据。
        if (hasEnoughReviewFacts(place, city, aspect, collected, durationHints.length, openingFields)) break;
        await readWithNavigation();
        if (hasEnoughReviewFacts(place, city, aspect, collected, durationHints.length, openingFields)) break;
      }

      // 最后一个搜索失败或被跳过时，也允许在剩余预算内补读候选。
      while (!hasEnoughReviewFacts(place, city, aspect, collected, durationHints.length, openingFields) && await readSource()) { /* 正文与导航最多三个页面，同属四次请求预算 */ }
      const relevant = filterRelevant(collected, place, city, false, openingFields.length > 0);
      if (relevant.length === 0 && durationHints.length === 0 && (!searchSucceeded || openingFields.length > 0) && errors.length > 0) {
        return `「${place}」的评价搜索失败（${errors.join("; ")}），本次未完成资料查询，不记为已查无依据。`;
      }
      const closureNote = openingFields.length ? await finishOpening(relevant, errors.length > 0) : ctx?.evidence === undefined ? "" : "\n" + await ctx.evidence.observeClosure(city, place, relevant);
      if (relevant.length > 0) {
        return formatResults(place, relevant, openingFields.length > 0) + renderDurationHints(durationHints) + closureNote;
      }
      if (durationHints.length > 0) {
        return (
          `「${place}」没有足够的评价摘要（已过滤百科/词典等无关结果），但提取到游玩时长参考：` +
          renderDurationHints(durationHints) +
          "\n口碑数据不足，请以高德评分、人均等结构化数据为准。" + closureNote
        );
      }
      return (
        `没有搜到「${place}」的相关评价内容（已过滤百科/词典等无关结果）。` +
        `该地点网上口碑数据不足，请以高德评分、人均等结构化数据为准，不要臆测好坏。${closureNote}`
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
function filterRelevant(results: SearchResult[], place: string, city: string, allowTitleOnly = false, opening = allowTitleOnly): SearchResult[] {
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
    if (!allowTitleOnly && result.snippet.trim().length < 8 && !/(?:周[一二三四五六日天].*(?:闭馆|休馆)|\d{1,2}:\d{2}|全天开放|24小时|游玩.*\d.*小时)/.test(`${result.title} ${result.snippet}`)) return false;
    if (result.title.startsWith('"') || result.title.startsWith("“")) return false; // 搜索引擎回显的查询标题
    const text = `${result.title} ${result.snippet}`;
    return opening ? mentionsOpeningPlace(text, place, city) : tokens.some((token) => text.includes(token));
  });
  if (!opening && city !== "") {
    const local = relevantResults.filter((result) => `${result.title} ${result.snippet}`.includes(city));
    if (local.length >= 2) return local;
  }
  return relevantResults;
}

function hasEnoughReviewFacts(place: string, city: string, aspect: string, collected: SearchResult[], durationCount: number, fields: ReturnType<typeof requestedOpeningFields>): boolean {
  const relevant = filterRelevant(collected, place, city, false, aspect === "开放时间");
  if (aspect === "开放时间") return extractOpeningFacts(city, place, relevant, fields).filter((f) => fields.includes(f.field)).every((f) => f.status === "verified" && !isHistoricalOpening(f));
  if (aspect === "游玩时长") return durationCount > 0;
  return relevant.length >= 3;
}

function formatResults(place: string, results: SearchResult[], opening = false): string {
  const containsOpeningDetail = (result: SearchResult) => /\d{1,2}[:：][0-5]\d|全天|闭馆|闭园|暂停开放/.test(result.snippet);
  const ranked = opening
    ? [...results.filter(containsOpeningDetail), ...results.filter((result) => !containsOpeningDetail(result))]
    : results;
  const lines = ranked
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title}${r.snippet === "" ? "" : `\n   ${r.snippet}`}${r.url ? `\n   来源 ${r.url}` : ""}`);
  if (opening) return `「${place}」的开放信息来源片段（供核对，适用条件以原文为准）：\n` + lines.join("\n");
  const popularity = extractPopularity(results);
  return (
    `「${place}」的网络评价摘要（搜索引擎结果，非官方评分，仅供参考）:\n` +
    lines.join("\n") +
    popularityNote(popularity)
  );
}

const MAX_DURATION_HINTS = 3;
const ENGINE_LABELS: Record<string, string> = {
  bing: "必应",
  baidu: "百度",
  "360": "360搜索",
  duckduckgo: "DuckDuckGo",
};

/** 页面全文（去脚本/样式与标签）——在结果摘要之外对整页提取游玩时长句子 */
function pageText(html: string): string {
  return cleanHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
}

/** 时长句子需同时含"游玩语义"与时间数值；排队/交通/营业时间等噪声剔除 */
const PLAY_SIGNAL = /(游玩|游览|逛|玩)/;
const TIME_VALUE = /[0-9一二两三四五六七八九十]+(?:\s*[-–—~～至到]\s*[0-9一二两三四五六七八九十]+)?\s*个?\s*半?\s*(?:小时|钟头|分钟)|半\s*个?\s*小时|半天|大半天|一整天/;
const DURATION_NOISE = /(排队|等位|车程|开车|驾车|地铁|公交|打车|步行|营业|开放)/;

/**
 * 从搜索摘要/页面文本提取"建议游玩时长"类句子（供给景点定时长参考）。
 * 例："三坊七巷一般游玩 2 到 4 小时"、"只逛主街和拍照 2 小时左右"。
 * preferTokens 为地点名：命中地点名的句子排前面（避免搜 A 时混入相关地点 B 的时长）。
 */
export function extractDurationHints(
  text: string,
  limit = MAX_DURATION_HINTS,
  preferTokens: readonly string[] = [],
): string[] {
  const scored: Array<{ clause: string; score: number }> = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[。！？!?;；，,\n]/)) {
    const clause = raw
      .replace(/[\s\S]*?-->/, " ") // HTML 注释残留（如百度页内联脚本注释）
      .replace(/"[a-zA-Z_$][\w$]*"\s*:\s*"[^"]*"/g, " ") // JSON 片段残留
      .replace(/\s+/g, " ")
      .trim();
    if (clause.length < 6 || clause.length > 90) continue;
    if (!PLAY_SIGNAL.test(clause)) continue;
    const timeMatch = TIME_VALUE.exec(clause);
    if (timeMatch === null) continue;
    if (DURATION_NOISE.test(clause) && !/游玩|游览/.test(clause)) continue;
    const key = clause.replace(/[\s，,。\-–—~～]/g, "").slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    const score =
      (preferTokens.some((token) => clause.includes(token)) ? 2 : 0) +
      (/(建议|一般|通常|大概|左右|足够|合适)/.test(clause) ? 1 : 0);
    // 超长句只截取时长数值附近的片段，避免把表格/导航文字整段带出
    const display =
      clause.length > 64
        ? `${timeMatch.index > 16 ? "…" : ""}${clause.slice(Math.max(0, timeMatch.index - 16), timeMatch.index + 48).trim()}${
            timeMatch.index + 48 < clause.length ? "…" : ""
          }`
        : clause;
    scored.push({ clause: display, score });
    if (scored.length >= limit * 2) break;
  }
  return scored
    .sort((a, b) => b.score - a.score) // 稳定排序：同分保持出现顺序
    .slice(0, limit)
    .map((entry) => entry.clause);
}

function renderDurationHints(hints: ReadonlyArray<{ text: string; source: string }>): string {
  if (hints.length === 0) return "";
  return (
    "\n⏱ 游玩时长参考（摘自搜索摘要，非官方数据；给景点定时长时优先参考）:\n" +
    hints.map((hint) => `  - ${hint.text}（来源: ${ENGINE_LABELS[hint.source] ?? hint.source}）`).join("\n")
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
const OPENING_SEARCH_ENGINES = SEARCH_ENGINES.filter((engine) => engine.name !== "360")
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
