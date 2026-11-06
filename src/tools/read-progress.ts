import { annotateToolCall } from "../core/tool-diagnostics.ts";
import type { ToolContext } from "./tool.ts";

type Range = readonly [number, number];
interface Part { ranges: Range[]; call?: string; replay?: boolean }
interface ReadRecord {
  resource: string;
  version: string;
  label: string;
  parts: Part[];
  total: number;
  kind: "file" | "itinerary";
  path?: string;
  hint?: string;
  undelivered?: boolean;
  retryUsed?: boolean;
}
const PREFIX = "read-progress:";

function record(map: Map<string, string> | undefined, resource: string): ReadRecord | undefined {
  const raw = map?.get(PREFIX + resource);
  return raw === undefined ? undefined : JSON.parse(raw) as ReadRecord;
}
function covered(parts: readonly Part[], wanted: readonly Range[]): boolean {
  const ranges = parts.flatMap((p) => p.ranges).sort((a, b) => a[0] - b[0]);
  return wanted.every(([start, end]) => {
    let cursor = start;
    for (const [a, b] of ranges) { if (a > cursor) break; cursor = Math.max(cursor, b); if (cursor >= end) return true; }
    return cursor >= end;
  });
}
function nextOffset(value: ReadRecord): number {
  let next = 0;
  for (const [a, b] of value.parts.flatMap((p) => p.ranges).sort((a, b) => a[0] - b[0])) { if (a > next) break; next = Math.max(next, b); }
  return next;
}
function save(map: Map<string, string>, value: ReadRecord): void {
  map.delete(PREFIX + value.resource); map.set(PREFIX + value.resource, JSON.stringify(value));
  if (map.size > 150) map.delete(map.keys().next().value!);
}

/** 以实际返回范围去重，分页大小不是身份；同一范围显式重读至多一次。 */
export function trackRead(ctx: ToolContext | undefined, info: Omit<ReadRecord, "parts">, ranges: Range[], reread = false): boolean {
  const map = ctx?.readVersions;
  if (!map) return false;
  const old = record(map, info.resource);
  const value: ReadRecord = old?.version === info.version ? { ...old, ...info } : { ...info, parts: [] };
  const repeated = covered(value.parts, ranges);
  if (value.kind === "itinerary" && value.undelivered && (!reread || value.retryUsed)) { annotateToolCall({ execution: "blocked" }); save(map, value); return true; }
  if (repeated) {
    annotateToolCall({ execution: "cache_hit" });
    if (!reread || covered(value.parts.filter((p) => p.replay), ranges)) { save(map, value); return true; }
  }
  if (value.undelivered && reread) value.retryUsed = true;
  value.undelivered = false;
  value.parts.push({ ranges, ...(ctx?.readCallId ? { call: ctx.readCallId } : {}), ...(repeated ? { replay: true } : {}) });
  save(map, value);
  return false;
}

/** 结果被再次压缩时，撤销这次“已读”，不能把未交付正文当成已掌握。 */
export function undoReadDelivery(map: Map<string, string> | undefined, callId: string): void {
  if (!map) return;
  for (const [key, raw] of map) if (key.startsWith(PREFIX)) {
    const value = JSON.parse(raw) as ReadRecord;
    if (value.parts.some((part) => part.call === callId)) { value.parts = value.parts.filter((part) => part.call !== callId); value.undelivered = true; map.set(key, JSON.stringify(value)); }
  }
}

export function fileReadHint(ctx: ToolContext | undefined, path: string, label: string, version: string, total: number, limit = 2000): string {
  const value = record(ctx?.readVersions, path);
  const next = value?.version === version ? nextOffset(value) : 0;
  return next >= total ? "【文件结束】该版本已完整读取，不要从头重读。"
    : `【续读】byte_offset=${next}，byte_limit=${limit}；read_file(${JSON.stringify({ path: label, byte_offset: next, byte_limit: limit })})`;
}

export function readWasDeferred(ctx: ToolContext | undefined, resource: string): boolean {
  return record(ctx?.readVersions, resource)?.undelivered === true;
}

/** 与历史压缩独立的有界索引，只存范围和下一步参数，不重复注入正文。 */
export function renderReadProgress(map: Map<string, string> | undefined, maxChars = 1200): string | undefined {
  if (!map || maxChars < 100) return undefined;
  const values = [...map.entries()].filter(([key]) => key.startsWith(PREFIX)).map(([, raw]) => JSON.parse(raw) as ReadRecord).reverse();
  if (!values.length) return undefined;
  let text = "【已读范围与游标】以下为读取历史，同范围内容变化后仍可读；勿因其他日期变化重读本日。只补未读或变化条目，确已丢失的字段可对小范围reread=true一次。\n";
  let count = 0;
  for (const value of values) {
    const complete = covered(value.parts, [[0, value.total]]);
    const line = value.kind === "file" ? `- ${value.label}: ${complete ? "已完整读取，勿从0重读" : `下一页 read_file(${JSON.stringify({ path: value.path, byte_offset: nextOffset(value), byte_limit: 2000 })})`}\n`
      : `- ${value.label}: ${complete ? "该范围已读" : value.undelivered ? "大范围正文未完整交付，勿原样重读" : "部分条目已读"}；${value.hint ?? "只读取未掌握的条目"}\n`;
    if (text.length + line.length > maxChars || count >= 8) continue;
    text += line; count++;
  }
  return count ? text : undefined;
}

export function artifactReadStatus(map: Map<string, string> | undefined, absolute: string): { next: number; complete: boolean } | undefined {
  const value = record(map, absolute);
  return value ? { next: nextOffset(value), complete: covered(value.parts, [[0, value.total]]) } : undefined;
}
