/** 有界读取公开页面；达到上限后取消流，调用方不保留整页作为模型上下文。 */
export async function readOpeningPage(response: Response, maxBytes = 512_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      const remaining = maxBytes - bytes;
      text += decoder.decode(next.value.subarray(0, remaining), { stream: true }); bytes += next.value.byteLength;
      if (bytes >= maxBytes) { await reader.cancel(); break; }
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** HTTP200的验证页不是一次有效搜索；不绕过验证，也不把它记为“已查无依据”。 */
export function isSearchChallenge(html: string, url = ""): boolean {
  try { if (/(?:^|[./_-])(?:captcha|qcaptcha|wappass|sorry)(?:[./_-]|$)/i.test(new URL(url).hostname + new URL(url).pathname)) return true; } catch { /* 注入的Response可能没有URL。 */ }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return /访问异常|安全验证|人机验证|百度安全验证|请输入验证码|captcha|verify you are human|just a moment/i.test(title)
    || (html.length < 30_000 && /请完成.{0,12}(?:验证|拼图)|拖动滑块|验证码.{0,10}(?:验证|访问)|verify (?:that )?you are human|confirm this search was made by a human|select all squares containing a duck/i.test(html));
}

/** 优先用网页标注的文章正文，保留嵌套段落并跳过外部推荐列表。 */
export function openingArticle(html: string): string {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const start = /<article\b[^>]*>|<div\b[^>]*\bclass=["'][^"']*\barticle-content\b[^"']*["'][^>]*>/i.exec(markup);
  if (!start) return html;
  const tag = start[0].toLowerCase().startsWith("<article") ? "article" : "div";
  const inner = start.index + start[0].length;
  const tags = new RegExp(`</?${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = inner;
  let depth = 1;
  for (let next = tags.exec(markup); next; next = tags.exec(markup)) {
    depth += next[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return markup.slice(inner, next.index);
  }
  return markup.slice(inner);
}

function decode(text: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", ndash: "–", mdash: "—", ldquo: "“", rdquo: "”" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, key: string) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? original;
    const code = key[1]?.toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

/** 保留块、表格行和单元格边界，不能直接把标签删空后拼接成一段文字。 */
export function openingPageLines(html: string): string[] {
  return decode(html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|head|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:div|p|li|tr|section|article|h[1-6]|br)\b[^>]*>/gi, "\n").replace(/<\/?(?:td|th)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, " "))
    .split(/[\n。！？]+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** 按时间事实选择附近正文，导航关键词和它在文档中的先后位置不再决定入选。 */
export function openingPageSnippet(html: string, maxChars = 4000): string | undefined {
  const lines = openingPageLines(html);
  const unrelated = (line: string) => /通行时间|交通路线|车程|地铁|公交|驾车|步行|预订|热线|服务时间/.test(line)
    || (/门票|票价|优惠|折扣|新闻列表|相关新闻/.test(line) && !/\d{1,2}[:：][0-5]\d/.test(line));
  const score = (line: string): number => {
    if (unrelated(line)) return 0;
    if (/\d{1,2}[:：][0-5]\d/.test(line) && /开放|营业|开馆|开园|闭馆|闭园|入馆|入园|入场|检票|场次|表演|喷放/.test(line)) return 6;
    if (/\d{1,2}[:：][0-5]\d\s*[-—~至到]\s*\d{1,2}[:：][0-5]\d|全天开放|24\s*小时(?:营业|开放)/.test(line)) return 6;
    if (/(?:每周|周|星期)[一二三四五六日天](?:例行|全天)?(?:闭馆|休馆|闭店)/.test(line)) return 5;
    if (/每年|旺季|淡季|夏季|冬季/.test(line) && /\d{1,2}[.月]\d{1,2}/.test(line)) return 4;
    if (/\d{4}[-年]\d{1,2}[-月]\d{1,2}/.test(line) && /暂停开放|停止开放|临时闭馆|临时闭园/.test(line)) return 3;
    return 0;
  };
  const selected = new Set<number>(); let size = 0;
  const anchors = lines.map((line, index) => ({ index, score: score(line) })).filter((v) => v.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index } of anchors) {
    for (const at of [index, index - 1, index - 2]) {
      if (at < 0 || selected.has(at)) continue;
      // 同行的新闻列表不能被闭馆规则一并带出；单行过大时保留事实附近片段。
      const line = lines[at]!.split(/新闻列表|相关新闻|更多资讯/)[0]!.trim();
      if (unrelated(line)) continue;
      if (at !== index && score(line) === 0 && !/^(?:每年|旺季|淡季|夏季|冬季|每周|周|星期)|开放时间|闭馆规则|关于.{0,30}(?:开放|闭馆)/.test(line)) continue;
      if (!line || size + line.length + 1 > maxChars) continue;
      selected.add(at); size += line.length + 1;
    }
  }
  const result = [...selected].sort((a, b) => a - b).map((index) => lines[index]!.split(/新闻列表|相关新闻|更多资讯/)[0]!.trim()).join("\n");
  return result || undefined;
}

/** 从当前页面选择同站参观入口，链接文本只是导航线索，不直接认定官网身份。 */
export function openingNavigationLinks(html: string, pageUrl: URL, fields: readonly string[]): URL[] {
  const links = new Map<string, { url: URL; score: number }>();
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1]!)?.[1];
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href.trim())) continue;
    const label = decode(match[2]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, "");
    const title = /\btitle=["']([^"']+)["']/i.exec(match[1]!)?.[1] ?? "";
    const text = label + title;
    const requested = (fields.includes("closure") && /闭馆|休馆/.test(text))
      || (fields.includes("last_admission") && /入园时间|停止入园|入馆时间|停止入馆/.test(text))
      || (fields.includes("sessions") && /演出时间|表演时间|场次安排/.test(text));
    const score = requested || /开放时间|参观时间|开闭园|开闭馆|开放安排|opening.?hours/i.test(text) ? 100
      : /参观指南|参观须知|游览须知|入园须知|票务服务|购票须知|visitorguide/i.test(text) ? 70
      : fields.includes("notices") && /公告通知|通知公告|最新公告/.test(text) ? 60
      : /游客服务|观众服务|参观服务/.test(text) ? 40 : 0;
    if (!score) continue;
    try {
      const url = new URL(decode(href), pageUrl);
      url.hash = "";
      if (url.origin !== pageUrl.origin || url.href === pageUrl.href || /\.(?:pdf|zip|jpe?g|png)$/i.test(url.pathname)) continue;
      const old = links.get(url.href);
      if (!old || old.score < score) links.set(url.href, { url, score });
    } catch { /* 损坏或脚本地址不参与导航。 */ }
  }
  return [...links.values()].sort((a, b) => b.score - a.score).map((link) => link.url);
}
