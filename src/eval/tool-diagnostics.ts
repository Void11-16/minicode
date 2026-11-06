import type { ToolCallObservation, ToolDiagnostics } from "../core/tool-diagnostics.ts";
import type { Itinerary } from "../tools/itinerary-schema.ts";
import { closureDiagnosticKey } from "../tools/travel-evidence.ts";
import { CLOSURE_POLICY_VERSION } from "../tools/closure-policy.ts";
import { TRAVEL_QUERY_TOOLS } from "../tools/travel-query.ts";

function counts(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
const ratio = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
const percentile = (values: readonly number[], p: number): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]! : null;
export function finalEvidenceKeys(itinerary: Itinerary | null | undefined): Set<string> | null {
  if (!itinerary) return null;
  const keys = new Set<string>();
  for (const item of itinerary.days.flatMap((day) => day.items)) {
    if (item.evidence_verified && item.evidence_id) keys.add(`place:${item.evidence_id}`);
    if (item.route_verified && item.route_evidence_id) keys.add(`route:${item.route_evidence_id}`);
    if (item.closure_verified && item.closure_policy_version === CLOSURE_POLICY_VERSION && item.closed_on !== undefined && itinerary.constraints?.destination) keys.add(closureDiagnosticKey(itinerary.constraints.destination, item.name, item.closed_on, item.closure_holiday_exception));
    for (const id of item.opening_evidence_ids ?? []) keys.add(`opening:${id}`);
  }
  return keys;
}

/** 引用率衡量可追踪的结构化证据，不把一般口碑阅读或候选淘汰强判为浪费。 */
export function summarizeToolDiagnostics(diagnostics: Pick<ToolDiagnostics, "records" | "total" | "dropped" | "peak_http_in_flight">, itinerary?: Itinerary | null) {
  const records = diagnostics.records;
  const executed = records.filter((r) => r.execution === "executed");
  const queries = records.filter((r) => TRAVEL_QUERY_TOOLS.includes(r.tool));
  const queryExecuted = queries.filter((r) => r.execution === "executed");
  const returned = queryExecuted.filter((r) => r.evidence_keys.length > 0 || r.query_status === "returned" || r.query_status === "verified");
  const keys = new Set<string>(); let repeats = 0, keyed = 0;
  for (const record of queries) if (record.query_key) { keyed++; if (keys.has(record.query_key)) repeats++; keys.add(record.query_key); }
  const evidenceCalls = queries.filter((r) => r.execution === "executed" && r.evidence_keys.length > 0);
  const allEvidence = new Set(evidenceCalls.flatMap((r) => r.evidence_keys));
  const used = finalEvidenceKeys(itinerary);
  const usedEvidence = used === null ? null : [...allEvidence].filter((key) => used.has(key));
  const http = records.flatMap((r) => r.http);
  const providers = records.flatMap((r) => r.provider_errors);
  const byTool = [...new Set(records.map((r) => r.tool))].sort().map((tool) => {
    const calls = records.filter((r) => r.tool === tool), actual = calls.filter((r) => r.execution === "executed");
    return { tool, requested: calls.length, executed: actual.length, errors: actual.filter((r) => r.outcome !== "ok").length,
      cache_hits: calls.filter((r) => r.execution === "cache_hit").length, blocked: calls.filter((r) => r.execution === "blocked").length,
      http_requests: calls.reduce((sum, r) => sum + r.http.length, 0), output_chars: calls.reduce((sum, r) => sum + r.output_chars, 0),
      latency_p50_ms: percentile(actual.map((r) => r.duration_ms), .5), latency_p95_ms: percentile(actual.map((r) => r.duration_ms), .95) };
  });
  const openingCalls = executed.filter((r) => r.opening_fields !== undefined), requestedFields = openingCalls.reduce((sum, r) => sum + r.opening_fields!.requested.length, 0);
  const extractedFields = openingCalls.reduce((sum, r) => sum + r.opening_fields!.extracted.length, 0);
  const openingIds = new Set(openingCalls.flatMap((r) => r.opening_fields!.evidence_ids));
  const savedOpening = itinerary ? new Set(itinerary.days.flatMap((day) => day.items.flatMap((item) => item.opening_evidence_ids ?? [])))
    : records.filter((r) => r.tool === "save_itinerary" && r.outcome === "ok" && r.opening_saved_ids !== undefined).at(-1)?.opening_saved_ids;
  const savedOpeningIds = savedOpening === undefined ? undefined : new Set(savedOpening);
  const retained = savedOpeningIds === undefined ? null : [...openingIds].filter((id) => savedOpeningIds.has(id)).length;
  return {
    version: "tool-diagnostics-v1" as const,
    requested: diagnostics.total, observed: records.length, dropped: diagnostics.dropped,
    execution: { executed: executed.length, errors: executed.filter((r) => r.outcome !== "ok").length,
      error_categories: counts(executed.flatMap((r) => r.error === undefined ? [] : [r.error])),
      success_rate: ratio(executed.filter((r) => r.outcome === "ok").length, executed.length),
      cache_hits: records.filter((r) => r.execution === "cache_hit").length, blocked: records.filter((r) => r.execution === "blocked").length,
      denied: records.filter((r) => r.execution === "denied").length },
    queries: { requested: queries.length, executed: queryExecuted.length, data_returned: returned.length, data_return_rate: ratio(returned.length, queryExecuted.length),
      unavailable: queryExecuted.filter((r) => r.query_status === "unavailable").length,
      failed: queryExecuted.filter((r) => r.outcome !== "ok" || (r.query_status === "failed" && r.evidence_keys.length === 0)).length,
      unknown: queryExecuted.filter((r) => r.query_status === undefined && r.evidence_keys.length === 0 && r.outcome === "ok").length,
      duplicate_requests: repeats, keyed_requests: keyed, duplicate_request_rate: ratio(repeats, keyed) },
    opening: { calls: openingCalls.length, source_return_rate: ratio(openingCalls.filter((r) => r.opening_fields!.retrieved_sources > 0).length, openingCalls.length),
      page_content_return_rate: ratio(openingCalls.filter((r) => (r.opening_fields!.body_sources ?? 0) > 0).length, openingCalls.length),
      requested_fields: requestedFields, extracted_fields: extractedFields, extraction_rate: ratio(extractedFields, requestedFields),
      returned_unique_fields: openingIds.size, final_retained_fields: retained, retention_rate: retained === null ? null : ratio(retained, openingIds.size),
      scope: "仅统计实际执行的开放字段查询；来源返回率要求相关结果带链接，正文占比单列；提取率按请求字段计，保留率按字段证据ID核对最终行程，均不代表事实准确率" },
    evidence: { returned_unique: allEvidence.size, new_unique: new Set(evidenceCalls.flatMap((r) => r.new_evidence_keys)).size,
      final_referenced: usedEvidence?.length ?? null, final_reference_rate: usedEvidence === null ? null : ratio(usedEvidence.length, allEvidence.size),
      producing_calls: evidenceCalls.length, adopted_calls: used === null ? null : evidenceCalls.filter((r) => r.evidence_keys.some((key) => used.has(key))).length,
      call_reference_rate: used === null ? null : ratio(evidenceCalls.filter((r) => r.evidence_keys.some((key) => used.has(key))).length, evidenceCalls.length),
      reference_scope: "仅统计本任务检索返回的结构化地点/路线/闭馆证据；缓存复用另列，一般口碑文字的采用情况未知" },
    http: { requests: http.length, failures: http.filter((h) => h.error !== undefined || h.status === undefined || h.status < 200 || h.status >= 400).length,
      success_rate: ratio(http.filter((h) => h.error === undefined && h.status !== undefined && h.status >= 200 && h.status < 400).length, http.length),
      status_counts: counts(http.flatMap((h) => h.status === undefined ? [] : [String(h.status)])),
      network_errors: counts(http.flatMap((h) => h.error === undefined ? [] : [h.error])),
      response_headers_p50_ms: percentile(http.map((h) => h.duration_ms), .5), response_headers_p95_ms: percentile(http.map((h) => h.duration_ms), .95),
      peak_in_flight: diagnostics.peak_http_in_flight,
      provider_errors: Object.fromEntries([...new Set(providers.map((p) => `${p.provider}:${p.code}`))].map((key) => [key, providers.filter((p) => `${p.provider}:${p.code}` === key).length])),
      scope: "仅已埋点的本任务旅行 HTTP 请求；耗时/并发计算到响应头，不含响应体读取、其他进程和模型 API；HTTP 200 不代表供应商业务成功" },
    output_chars: records.reduce((sum, r) => sum + r.output_chars, 0),
    by_tool: byTool,
  };
}
export type ToolDiagnosticsSummary = ReturnType<typeof summarizeToolDiagnostics>;

export function renderToolDiagnostics(summary: ToolDiagnosticsSummary): string {
  const percent = (value: number | null) => value === null ? "未知/不适用" : `${(value * 100).toFixed(1)}%`;
  const lines = ["工具调用诊断：", `- 记录 ${summary.observed}/${summary.requested}；丢弃 ${summary.dropped}；执行 ${summary.execution.executed}，异常 ${summary.execution.errors}，缓存 ${summary.execution.cache_hits}，拦截 ${summary.execution.blocked}，拒绝 ${summary.execution.denied}；异常类别 ${JSON.stringify(summary.execution.error_categories)}`,
    `- 执行成功率 ${percent(summary.execution.success_rate)}；检索返回数据率 ${percent(summary.queries.data_return_rate)}；同事项重复请求率 ${percent(summary.queries.duplicate_request_rate)}`,
    `- 开放字段：来源返回率 ${percent(summary.opening.source_return_rate)}，含正文来源调用占比 ${percent(summary.opening.page_content_return_rate)}；字段提取 ${summary.opening.extracted_fields}/${summary.opening.requested_fields}（${percent(summary.opening.extraction_rate)}），最终保留 ${summary.opening.final_retained_fields ?? "未知"}/${summary.opening.returned_unique_fields}（${percent(summary.opening.retention_rate)}）`,
    `- 结构化证据最终引用 ${summary.evidence.final_referenced ?? "未知"}/${summary.evidence.returned_unique}（${percent(summary.evidence.final_reference_rate)}）；${summary.evidence.reference_scope}`,
    `- HTTP 请求 ${summary.http.requests}，失败 ${summary.http.failures}，成功率 ${percent(summary.http.success_rate)}，观测并发峰值 ${summary.http.peak_in_flight}；供应商业务错误 ${JSON.stringify(summary.http.provider_errors)}`,
    `- ${summary.http.scope}`, "", "| 工具 | 请求 | 执行 | 异常 | 缓存 | 拦截 | HTTP | p95(ms) | 返回字符 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const tool of summary.by_tool) lines.push(`| ${tool.tool} | ${tool.requested} | ${tool.executed} | ${tool.errors} | ${tool.cache_hits} | ${tool.blocked} | ${tool.http_requests} | ${tool.latency_p95_ms?.toFixed(1) ?? "—"} | ${tool.output_chars} |`);
  return lines.join("\n");
}

export type { ToolCallObservation };
