export interface DurationHint { readonly text: string; readonly source: string }
export const MAX_DURATION_HINTS = 3;
const ENGINE_LABELS: Record<string, string> = { bing: "必应", baidu: "百度", "360": "360搜索", duckduckgo: "DuckDuckGo" };

export function placeTokens(place: string): string[] {
  const tokens = new Set<string>();
  const base = place.replace(/[（(][^)）]*[)）]/g, "").trim();
  if (base.length >= 2) tokens.add(base);
  const stripped = base.replace(/^.*?(?:旅游区|景区|风景区|历史文化街区|文化街区|街区)(?=.)/, "").trim();
  if (stripped.length >= 2 && stripped !== base) tokens.add(stripped);
  return [...tokens];
}

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

export function renderDurationHints(hints: ReadonlyArray<{ text: string; source: string }>): string {
  if (hints.length === 0) return "";
  return (
    "\n⏱ 游玩时长参考（摘自来源资料，非官方标准；给景点定时长时优先参考）:\n" +
    hints.map((hint) => `  - ${hint.text}（来源: ${ENGINE_LABELS[hint.source] ?? hint.source}）`).join("\n")
  );
}

