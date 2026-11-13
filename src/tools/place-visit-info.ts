import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { normalizeVisitInfoArgs, VISIT_INFO_FIELDS, type VisitInfoField } from "./travel-query.ts";
import { annotateToolCall } from "../core/tool-diagnostics.ts";
import { extractOpeningFacts, isHistoricalOpening, lastAdmissionFor, openingHoursFor, type OpeningFact, type OpeningField } from "./opening-facts.ts";
import { PlaceSourceClient, type PlaceSearchProvider } from "./place-sources.ts";
import { renderDurationHints } from "./visit-duration.ts";
import { scopeApplies } from "./opening-schedule.ts";

const KEYWORDS: Record<VisitInfoField, string> = { hours: "开放时间", closure: "闭馆时间", last_admission: "停止入场", sessions: "演出时间", notices: "开放公告", visit_duration: "游玩时长" };

/** 只补参观资料缺口；同页其他字段顺带提取，不为可选时长额外增加搜索。 */
export function createVisitInfoTool(fetchFn: typeof fetch = fetch, provider?: PlaceSearchProvider, sources = new PlaceSourceClient(fetchFn, provider)): Tool {
  return {
    name: "get_place_visit_info",
    supportsRoutineVisitInfo: true,
    description: "补查已选地点的开放时段、闭馆日、最后入场、场次、临时公告及游玩时长。仅查询缺失fields，已有字段复用；同页资料一起保存。时长无依据可用注明来源的类型经验值。口碑/排队/招牌菜用get_place_reviews。",
    parameters: { type: "object", properties: {
      place: { type: "string", description: "实体名，不拼接开放时间等检索词" }, city: { type: "string", description: "所在城市" },
      fields: { type: "array", items: { type: "string", enum: [...VISIT_INFO_FIELDS] }, description: "所缺字段。默认普通地点hours，博物馆加closure，演出加sessions；时长用visit_duration。" },
      visit_date: { type: "string", description: "实际访问日期YYYY-MM-DD，临时公告查询时提供" },
      refresh: { type: "boolean", description: "明确重新核实时使用，仍受同地点请求预算限制" },
    }, required: ["place"] },
    async execute(raw, ctx) {
      const args = normalizeVisitInfoArgs(raw), city = typeof args.city === "string" ? args.city.trim() : "";
      const inputPlace = requireString(args, "place"), place = ctx?.evidence?.canonicalPlaceName(inputPlace, city) ?? inputPlace, fields = args.fields as VisitInfoField[];
      const opening = fields.filter((f): f is OpeningField => f !== "visit_duration");
      const visitDate = typeof args.visit_date === "string" ? args.visit_date : undefined;
      const applicable = (fact: OpeningFact) => {
        if (fact.status !== "verified") return false;
        if (fact.field === "hours") return visitDate ? Boolean(openingHoursFor(fact, visitDate)) : !isHistoricalOpening(fact);
        if (fact.field === "closure" && fact.value) return scopeApplies(fact.value, visitDate);
        if (fact.field === "last_admission" && visitDate) return Boolean(lastAdmissionFor(fact, visitDate));
        return true;
      };
      const missing = (items: Parameters<typeof extractOpeningFacts>[2], duration: readonly unknown[]): VisitInfoField[] => {
        const facts = extractOpeningFacts(city, place, items, opening);
        return fields.filter((field) => field === "visit_duration" ? duration.length === 0
          : !facts.some((fact) => fact.field === field && applicable(fact)));
      };
      const result = await sources.collect({ place, city, kind: "visit", openingFields: opening, duration: true, refresh: args.refresh === true,
        enough: (items, duration) => missing(items, duration).length === 0,
        // 下一来源围绕当前缺口，避免要求一个结果同时命中闭馆、场次和时长等词。
        suffix: (items, duration) => {
          const needed = missing(items, duration);
          const focus = (["hours", "closure", "sessions", "last_admission", "notices", "visit_duration"] as const).find((field) => needed.includes(field)) ?? "hours";
          return focus === "notices" && visitDate ? `${KEYWORDS.notices} ${visitDate}` : KEYWORDS[focus];
        } }, ctx);
      const interrupted = result.errors.length > 0;
      const facts = ctx?.evidence ? await ctx.evidence.observeOpening(city, place, result.sources, opening, interrupted || Boolean(args.visit_date), result.observedAt)
        : extractOpeningFacts(city, place, result.sources, opening, undefined, result.observedAt);
      const verified = facts.filter(applicable);
      annotateToolCall({ opening_fields: { requested: opening, retrieved_sources: result.sources.filter((s) => s.url).length,
        body_sources: result.sources.filter((s) => s.content_kind === "page").length,
        extracted: verified.filter((f) => opening.includes(f.field)).map((f) => f.field), evidence_ids: verified.map((f) => f.id) } });
      if (!result.sources.length && !result.duration.length && interrupted) return `「${place}」的参观信息搜索失败（${result.errors.join("; ")}），本次未完成资料查询，不记为已查无依据。`;
      const summary = ctx?.evidence?.openingSummary(city, place, [...new Set([...opening, ...verified.map((fact) => fact.field)])], visitDate)
        ?? facts.filter((f) => !interrupted || f.status !== "not_found").map((f) => `${f.field}: ${f.status}${f.value === undefined ? "" : ` ${JSON.stringify(f.value)}`} evidence_id=${f.id}`).join("\n");
      const unconfirmed = opening.filter((field) => !verified.some((fact) => fact.field === field));
      return [
        `「${place}」的参观资料（开放条件以来源原文为准）：`,
        ...result.sources.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}\n   ${s.snippet}${s.url ? `\n   来源 ${s.url}` : ""}`),
        ...(summary ? [`开放字段证据（逐字段保存，未知不等于关闭；场地开放与表演场次分开）：\n${summary}`] : []),
        renderDurationHints(result.duration),
        ...(fields.includes("visit_duration") && !result.duration.length ? ["未找到可引用的游玩时长参考，保持待确认，不编造时长。"] : []),
        ...(facts.some((fact) => isHistoricalOpening(fact)) ? ["仅历史参考：过期时段不适用于当前排程。"] : []),
        ...(interrupted && unconfirmed.length ? [`开放信息查询受阻，待确认字段：${unconfirmed.join("、")}。已取得的有效字段仍可使用。`] : []),
      ].filter(Boolean).join("\n");
    },
  };
}
