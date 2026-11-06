import { AsyncLocalStorage } from "node:async_hooks";
import { ToolValidationError } from "./tool-error.ts";

export type ToolExecution = "executed" | "cache_hit" | "blocked" | "denied";
export type ToolErrorCategory = "rate_limit" | "quota" | "auth" | "timeout" | "network" | "invalid_arguments" | "validation" | "cancelled" | "other";
export interface HttpObservation {
  readonly host: string;
  readonly duration_ms: number;
  readonly status?: number;
  readonly error?: ToolErrorCategory;
}
export interface ToolCallObservation {
  readonly call_id: string;
  readonly tool: string;
  readonly round: number;
  readonly input_chars: number;
  output_chars: number;
  duration_ms: number;
  execution: ToolExecution;
  outcome: "ok" | "error" | "cancelled";
  query_key?: string;
  query_status?: "returned" | "verified" | "unavailable" | "failed";
  error?: ToolErrorCategory;
  error_code?: string;
  evidence_keys: string[];
  new_evidence_keys: string[];
  http: HttpObservation[];
  provider_errors: { provider: string; category: ToolErrorCategory; code: string }[];
  opening_fields?: { requested: readonly string[]; retrieved_sources: number; body_sources?: number; extracted: readonly string[]; evidence_ids: readonly string[] };
  opening_saved_ids?: readonly string[];
}
interface DiagnosticScope { record: ToolCallObservation; collector: ToolDiagnostics; insideFetch?: boolean }
const scope = new AsyncLocalStorage<DiagnosticScope>();

/** 只保留错误类别，不落盘参数、URL 查询、密钥或异常原文。 */
export function toolErrorCategory(error: unknown): ToolErrorCategory {
  if (error instanceof ToolValidationError) return "validation";
  const value = error instanceof Error ? `${error.name} ${error.message} ${String((error as Error & { cause?: { code?: string } }).cause?.code ?? "")}` : String(error);
  if (/Timeout|ETIMEDOUT|超时/i.test(value)) return "timeout";
  if (/AbortError|aborted|用户取消|cancelled/i.test(value)) return "cancelled";
  if (/质量校验|行程.*校验|版本冲突|未通过/i.test(value)) return "validation";
  if (/(?:^|\[|infocode[=: ]+)(?:10021|10020|10014)(?:\]|$)|HTTP\s*429|^429\b|QPS|并发.*超限|rate.limit/i.test(value)) return "rate_limit";
  if (/(?:^|\[|infocode[=: ]+)(?:10003|10044)(?:\]|$)|DAILY_QUERY|日.*配额|日调用量/i.test(value)) return "quota";
  if (/(?:^|\[|infocode[=: ]+)(?:10001|10019)(?:\]|$)|HTTP\s*(?:401|403)|INVALID_USER_KEY|密钥/i.test(value)) return "auth";
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|网络/i.test(value)) return "network";
  if (/参数|JSON|工具不存在|缺少或非法|_truncated/i.test(value)) return "invalid_arguments";
  return "other";
}
export function annotateToolCall(update: Partial<Pick<ToolCallObservation, "execution" | "query_key" | "query_status" | "evidence_keys" | "new_evidence_keys" | "opening_fields" | "opening_saved_ids">>): void {
  const current = scope.getStore();
  if (current) Object.assign(current.record, update);
}
export function observeProviderError(provider: string, code: string): void {
  const current = scope.getStore();
  if (current) current.record.provider_errors.push({ provider, code: /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN", category: toolErrorCategory(code) });
}

/** 统计到响应头的耗时和进程内请求并发；嵌套 fetch 包装不重复计数。 */
export async function diagnosticFetch(fetchFn: typeof fetch, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const current = scope.getStore();
  if (!current || current.insideFetch) return fetchFn(input, init);
  const started = performance.now();
  let host = "unknown";
  try { host = new URL(input instanceof Request ? input.url : String(input)).hostname; } catch { /* 无效 URL 留给 fetch 报错。 */ }
  current.collector.httpStarted();
  try {
    const result = await scope.run({ ...current, insideFetch: true }, () => fetchFn(input, init));
    current.record.http.push({ host, status: result.status, duration_ms: Math.max(0, performance.now() - started) });
    return result;
  } catch (error) {
    current.record.http.push({ host, error: toolErrorCategory(error), duration_ms: Math.max(0, performance.now() - started) });
    throw error;
  } finally { current.collector.httpEnded(); }
}

/** 与累计任务预算共用生命周期，自动续跑不清零；诊断数据不插入模型上下文。 */
export class ToolDiagnostics {
  readonly records: ToolCallObservation[] = [];
  total = 0;
  dropped = 0;
  peak_http_in_flight = 0;
  private inFlight = 0;
  httpStarted(): void { this.inFlight++; this.peak_http_in_flight = Math.max(this.peak_http_in_flight, this.inFlight); }
  httpEnded(): void { this.inFlight--; }
  async run<T extends { output: string; error?: string; errorCode?: string; errorCategory?: ToolErrorCategory }>(call: { id: string; name: string; arguments: string }, round: number, execute: () => Promise<T>): Promise<T> {
    const record = this.create(call, round);
    const started = performance.now();
    try {
      const result = await scope.run({ record, collector: this }, execute);
      record.output_chars = result.output.length;
      if (result.error !== undefined) {
        record.error = result.errorCategory ?? toolErrorCategory(result.error);
        if (result.errorCode) record.error_code = result.errorCode;
        record.outcome = record.error === "cancelled" ? "cancelled" : "error";
      }
      return result;
    } catch (error) {
      record.error = toolErrorCategory(error); record.outcome = record.error === "cancelled" ? "cancelled" : "error";
      if (error instanceof ToolValidationError) record.error_code = error.code;
      throw error;
    } finally { record.duration_ms = Math.max(0, performance.now() - started); }
  }
  snapshot() { return { records: this.records, total: this.total, dropped: this.dropped, peak_http_in_flight: this.peak_http_in_flight }; }
  skip(call: { id: string; name: string; arguments: string }, round: number, execution: "blocked" | "denied"): ToolCallObservation { const record = this.create(call, round); record.execution = execution; return record; }
  private create(call: { id: string; name: string; arguments: string }, round: number): ToolCallObservation {
    const record: ToolCallObservation = { call_id: call.id, tool: call.name, round, input_chars: call.arguments.length, output_chars: 0, duration_ms: 0,
      execution: "executed", outcome: "ok", evidence_keys: [], new_evidence_keys: [], http: [], provider_errors: [] };
    this.total++;
    if (this.records.length < 2000) this.records.push(record); else this.dropped++;
    return record;
  }
}
