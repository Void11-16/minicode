import type { ToolOutputKind } from "../tools/tool.ts";

type Row = Record<string, unknown>;
const PLACE_KEYS = ["name", "id", "evidence_id", "type", "location", "latitude", "longitude", "lat", "lng", "lon", "crs", "rating", "cost_per_person", "price", "price_unit", "opening_hours", "source", "evidence_verified"];
const ROUTE_KEYS = ["from", "to", "id", "route_evidence_id", "mode", "transport_mode", "duration_min", "durationSec", "duration_sec", "distance_km", "distanceM", "distance_m", "estimated", "route_verified", "source"];
const ITEM_KEYS = [...PLACE_KEYS, ...ROUTE_KEYS, "time", "end_time", "subtype", "planned_duration_min", "reservation_required"];
const ISSUE_KEYS = ["level", "kind", "code", "day", "item_id", "related_days", "related_codes", "message"];

function row(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;
}

/** 只投影已知字段，省去描述、照片和路线几何；坐标、证据 ID 和单位不改写。 */
function project(value: Row, keys: readonly string[]): Row {
  return Object.fromEntries(keys.flatMap((key): [string, unknown][] => {
    const field = value[key];
    if (field === undefined) return [];
    if (key === "message" && typeof field === "string" && field.length > 240) return [[key, field.slice(0, 239) + "…"]];
    if (key === "location" && row(field)) return [[key, project(row(field)!, ["latitude", "longitude", "lat", "lng", "lon", "crs", "source"])]];
    if (key === "opening_hours" && row(field)) return [[key, project(row(field)!, ["opens", "closes", "closed_weekdays", "source"])]];
    if (key === "issue_count" && row(field)) return [[key, project(row(field)!, ["P0", "P1", "P2"])]];
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean" || field === null || Array.isArray(field)) return [[key, field]];
    return [];
  }));
}

/** 完整记录才能进入预览，绝不在一个候选/交通段中间切断并冒充完整数据。 */
function fit(header: string, records: readonly string[], budget: number): string | undefined {
  const prefix = `【字段摘要；未列字段与条目见归档】\n${header}\n`;
  const reserve = 48;
  if (prefix.length + reserve > budget) return undefined;
  const selected: string[] = [];
  let used = prefix.length + reserve;
  for (const record of records) {
    if (used + record.length + 1 > budget) continue;
    selected.push(record);
    used += record.length + 1;
  }
  const omitted = records.length - selected.length;
  return prefix + selected.join("\n") + (omitted ? `\n省略 ${omitted} 条记录，请按归档游标读取。` : "");
}

function arrayIn(value: unknown, keys: readonly string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const object = row(value);
  if (!object) return undefined;
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[];
  return undefined;
}

function jsonPreview(kind: ToolOutputKind, value: unknown, budget: number): string | undefined {
  const root = row(value) ?? {};
  const meta = JSON.stringify(project(root, ["title", "status", "score", "score_version", "revision", "strict_pass", "issue_count", "source", "crs", "total", "count", "total_duration_min", "total_distance_km"]));
  if (kind === "place-list" || kind === "route") {
    const values = arrayIn(value, kind === "place-list" ? ["places", "pois", "results", "items", "data"] : ["legs", "routes", "results"]);
    if (!values) return undefined;
    return fit(meta, values.flatMap((v) => row(v) ? [JSON.stringify(project(row(v)!, kind === "place-list" ? PLACE_KEYS : ROUTE_KEYS))] : []), budget);
  }
  if (kind === "validation" && Array.isArray(root.issues)) {
    const issues = root.issues.flatMap((v) => row(v) ? [row(v)!] : []).sort((a, b) => String(a.level).localeCompare(String(b.level)));
    return fit(meta, issues.map((v) => JSON.stringify(project(v, ISSUE_KEYS))), budget);
  }
  if (kind === "itinerary" && Array.isArray(root.days)) {
    const records: string[] = [];
    if (row(root.constraints)) records.push(`constraints=${JSON.stringify(root.constraints)}`);
    root.days.forEach((value, index) => {
      const day = row(value);
      if (!day) return;
      const label = `D${index + 1} ${JSON.stringify(project(day, ["date", "theme", "day_type", "available_start", "available_end"]))}`;
      records.push(label);
      if (Array.isArray(day.items)) for (const item of day.items) {
        if (row(item)) records.push(`D${index + 1} ${day.date ?? ""} ${JSON.stringify(project(row(item)!, ITEM_KEYS))}`);
      }
    });
    return fit(meta, records, budget);
  }
  return undefined;
}

function textPreview(kind: ToolOutputKind, text: string, budget: number): string | undefined {
  const lines = text.split("\n");
  const notices = lines.filter((line) => /⚠|数据源失败|降级|未配置|不可用/.test(line) && line.length < 300);
  const header = [...new Set([lines[0] ?? "", ...notices])].join("\n");
  if (kind === "place-list") {
    const ids = new Map<string, Set<string>>();
    for (const line of lines) {
      const m = /^(.+?): ([A-Za-z0-9_-]{1,100})$/.exec(line);
      if (m) ids.set(m[1]!, new Set([...(ids.get(m[1]!) ?? []), m[2]!]));
    }
    const records = lines.flatMap((line) => {
      const m = /^\s*\d+[.)]\s+(.+?)\s+\|(.+)$/.exec(line);
      if (!m) return [];
      const fields = m[2]!.split("|").map((field) => field.trim());
      const name = m[1]!;
      const kept = fields.filter((field, index) => (index === 0 && field.length < 120) || /坐标|crs|评分|人均|参考价|开放|闭馆|类型|来源|source|evidence_id/.test(field));
      const matches = ids.get(name) ?? ids.get(name.replace(/ 综合 [\d.]+$/, ""));
      const id = matches?.size === 1 ? [...matches][0] : undefined;
      return [[name, ...kept, ...(id ? [`evidence_id=${id}`] : [])].join(" | ")];
    });
    const ambiguity = [...ids.values()].some((values) => values.size > 1) ? "\n同名地点的证据 ID 不唯一，未自动绑定，请查原文核对。" : "";
    return records.length ? fit(header + ambiguity, records, budget) : undefined;
  }
  if (kind === "route") {
    const evidence = new Map<string, Set<string>>();
    const key = (s: string) => s.replace(/\s*→\s*/g, " → ").trim();
    for (const line of lines) {
      const m = /^(.+?→.+?): ([A-Za-z0-9_-]+) \/ (.+)$/.exec(line);
      if (m) {
        const route = key(m[1]!);
        evidence.set(route, new Set([...(evidence.get(route) ?? []), `route_evidence_id=${m[2]} / ${m[3]}`]));
      }
    }
    const records = lines.flatMap((line, index) => {
      const m = /^\d+\. (.+?→.+?):/.exec(line);
      if (!m) return [];
      const matches = evidence.get(key(m[1]!));
      const id = matches?.size === 1 ? [...matches][0] : undefined;
      const detail = lines[index + 1]?.trim();
      return [[line, ...(id ? [id] : []), ...(detail && detail.length < 240 && /距离|步行|估算/.test(detail) ? [detail] : [])].join(" | ")];
    });
    const total = lines.find((line) => line.startsWith("全天通勤合计"));
    const ambiguity = [...evidence.values()].some((values) => values.size > 1) ? "同端点存在多个路线证据，未自动绑定，请查原文核对。" : undefined;
    return records.length ? fit([header, total, ambiguity].filter(Boolean).join("\n"), records, budget) : undefined;
  }
  if (kind === "validation" || kind === "itinerary") {
    const meta = lines.filter((line) => /^(?:已保存|版本:|分日验收:|局部修复日期:|质量:|完整性:|strict:)/.test(line));
    const issues = lines.filter((line) => /^\[P[012]\]/.test(line)).sort();
    return meta.length && issues.length ? fit(meta.join("\n"), issues, budget) : undefined;
  }
  return undefined;
}

/** 优先使用工具类型的确定性字段投影；未知格式交还通用预览，不调用额外模型。 */
export function structuredToolPreview(kind: ToolOutputKind | "error", text: string, budget: number): string | undefined {
  if (kind === "error" || kind === "generic" || kind === "file" || kind === "command") return undefined;
  const first = text[text.search(/\S/)];
  if (text.length <= 2_000_000 && (first === "[" || first === "{")) {
    try {
      const preview = jsonPreview(kind, JSON.parse(text), budget);
      if (preview !== undefined) return preview;
    } catch { /* 非 JSON 或未知结构继续使用文本预览。 */ }
  }
  return textPreview(kind, text, budget);
}
