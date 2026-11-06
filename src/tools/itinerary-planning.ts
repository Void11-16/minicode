import type { Itinerary, ItineraryDay, ItineraryItem, PlannedVisit, ItineraryOutlineDay } from "./itinerary-schema.ts";
import { itemEndMinutes } from "./itinerary-timeline.ts";
import { requiredVisitMatches } from "./required-visits.ts";
import { scenicVisitKey } from "./scenic-area.ts";
import { haversineKm } from "./geo.ts";
import { convertPoint } from "./coordinates.ts";
import { ToolValidationError, type ToolValidationIssue } from "../core/tool-error.ts";

type Visit = PlannedVisit & Pick<ItineraryItem, "location" | "evidence_verified"> & { readonly type?: string };
export interface VisitAssignment extends PlannedVisit { date: string; status: "reserved" | "saved"; item_id?: string }
function visitDistance(a: Visit, b: Visit): number | undefined {
  if (a.location?.latitude === undefined || a.location.longitude === undefined || b.location?.latitude === undefined || b.location.longitude === undefined) return undefined;
  const p = convertPoint({ latitude: a.location.latitude, longitude: a.location.longitude, crs: a.location.crs ?? "wgs84" }, "wgs84"), q = convertPoint({ latitude: b.location.latitude, longitude: b.location.longitude, crs: b.location.crs ?? "wgs84" }, "wgs84");
  return haversineKm(p.latitude, p.longitude, q.latitude, q.longitude);
}

/** 编辑时比较真实地点身份；共享主景区名额不意味着子点能继承主点票价等事实。 */
function samePlace(a: Visit, b: Visit, city = ""): boolean {
  if (a.evidence_id && a.evidence_id === b.evidence_id && a.evidence_verified === true) return true;
  if (!requiredVisitMatches(a.name, b.name, city) && !requiredVisitMatches(b.name, a.name, city)) return false;
  return (visitDistance(a, b) ?? 0) < .25;
}
export function sameVisit(a: Visit, b: Visit, city = ""): boolean {
  const trusted = (v: Visit) => v.evidence_verified === true || (v.evidence_verified === undefined && v.type === undefined);
  const parentA = trusted(a) ? a.parent_visit : undefined, parentB = trusted(b) ? b.parent_visit : undefined;
  const identityA = parentA?.evidence_id ?? a.evidence_id, identityB = parentB?.evidence_id ?? b.evidence_id;
  if (identityA && identityA === identityB && trusted(a) && trusted(b)) return true;
  if (a.evidence_id && a.evidence_id === b.evidence_id && trusted(a) && trusted(b)) return true;
  const x = scenicVisitKey(a.name, parentA?.name), y = scenicVisitKey(b.name, parentB?.name);
  if (x !== y && !requiredVisitMatches(x, y, city) && !requiredVisitMatches(y, x, city)) return false;
  return (visitDistance(a, b) ?? 0) < (x === y && a.name !== b.name ? 5 : .25);
}
export function materializedDay(day: ItineraryDay): boolean {
  return day.items.some((item) => item.type === "visit" && item.time !== undefined && itemEndMinutes(item) !== undefined)
    || ((day.day_type ?? "full") !== "full" && (day.available_start !== undefined || day.available_end !== undefined) && day.items.some((item) => item.type === "transport" && item.time !== undefined && itemEndMinutes(item) !== undefined));
}
export function visitAssignments(plan: Itinerary): VisitAssignment[] {
  const result: VisitAssignment[] = plan.days.flatMap((day) => day.items.filter((item) => item.type === "visit").map((item) => ({ name: item.name, evidence_id: item.evidence_verified ? item.evidence_id : undefined, parent_visit: item.evidence_verified ? item.parent_visit : undefined, repeat_reason: item.repeat_reason, date: day.date ?? "日期未定", status: "saved" as const, item_id: item.id })));
  for (const day of plan.outline ?? []) for (const visit of day.visits) if (!result.some((entry) => entry.date === day.date && sameVisit(entry, visit, plan.constraints?.destination))) result.push({ ...visit, date: day.date, status: "reserved" });
  return result;
}

/** 同一文件维护粗排与实际安排；删除释放，替换/移动同步，不悄悄夺取其他日期预留。 */
export function syncOutline(saved: Itinerary | null, plan: Itinerary, explicit: boolean): Itinerary {
  if (explicit) return plan;
  let outline = plan.outline ?? saved?.outline;
  if (outline === undefined) outline = plan.days.filter((day) => day.date && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(Date.parse(day.date)) && new Date(day.date).toISOString().slice(0, 10) === day.date).map((day) => ({ date: day.date!, theme: day.theme, visits: day.items.filter((item) => item.type === "visit").map((item) => ({ name: item.name, evidence_id: item.evidence_id, repeat_reason: item.repeat_reason })) }));
  if (!outline.length) return plan;
  const next: ItineraryOutlineDay[] = outline.map((day) => ({ ...day, visits: [...day.visits] }));
  const current = plan.days.flatMap((day) => day.items.filter((item) => item.type === "visit").map((item) => ({ date: day.date, item })));
  for (const day of saved?.days ?? []) for (const old of day.items.filter((item) => item.type === "visit")) {
    const now = current.find((entry) => entry.item.id === old.id);
    if (!now || now.date !== day.date || !sameVisit(old, now.item, plan.constraints?.destination)) {
      const index = next.findIndex((entry) => entry.date === day.date);
      if (index >= 0 && !current.some((entry) => entry.date === day.date && sameVisit(entry.item, old, plan.constraints?.destination))) next[index] = { ...next[index], visits: next[index]!.visits.filter((v) => !sameVisit(v, old, plan.constraints?.destination)) };
    }
  }
  for (const { date, item } of current) if (date) {
    let index = next.findIndex((day) => day.date === date);
    if (index < 0) { next.push({ date, visits: [] }); index = next.length - 1; }
    if (!next[index]!.visits.some((v) => sameVisit(v, item, plan.constraints?.destination))) next[index] = { ...next[index]!, visits: [...next[index]!.visits, { name: item.name, evidence_id: item.evidence_id, repeat_reason: item.repeat_reason }] };
  }
  return { ...plan, outline: next.sort((a, b) => a.date.localeCompare(b.date)) };
}

/** 原子条目编辑；同地点补证据保留安排，真正替换才清除旧地点事实。 */
export function applyItemEdits(plan: Itinerary, raw: unknown): Itinerary {
  if (raw === undefined) return plan;
  if (!Array.isArray(raw) || raw.length > 30) throw new ToolValidationError([{
    code: "ITINERARY_EDITS_INVALID", path: "edits", message: "edits 必须为最多30项的数组",
    expected: "array (maxItems=30)", actual: Array.isArray(raw) ? { length: raw.length } : raw,
    hint: "按 edits 数组提交局部编辑，每批不超过30项。",
  }]);
  const days = plan.days.map((day) => ({ ...day, items: [...day.items] }));
  const issues: ToolValidationIssue[] = [];
  for (const [editIndex, edit] of raw.entries()) {
    const path = `edits[${editIndex}]`;
    const issue = (code: string, field: string, message: string, hint: string, expected?: unknown, actual?: unknown, old?: ItineraryItem) => {
      issues.push({ code, path: field ? `${path}.${field}` : path,
        message: `第${editIndex + 1}项编辑${typeof edit?.date === "string" ? `（${edit.date}/${String(edit.item_id ?? "未填ID")}）` : ""}：${message}`,
        hint, expected, actual, ...(typeof edit?.date === "string" ? { date: edit.date } : {}),
        ...(typeof edit?.item_id === "string" ? { item_id: edit.item_id } : {}), ...(old ? { item_name: old.name } : {}),
      });
    };
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      issue("ITINERARY_EDIT_INVALID", "", "编辑项必须为对象", "提供包含op、date和item_id的编辑对象。", "object", edit);
      continue;
    }
    const before = issues.length;
    if (!["remove", "move", "replace"].includes(edit.op)) issue("ITINERARY_EDIT_OP_INVALID", "op", "edits.op 必须为remove/move/replace", "使用remove删除、move跨日移动或replace替换。", ["remove", "move", "replace"], edit.op);
    if (!validEditDate(edit.date)) issue("ITINERARY_EDIT_DATE_INVALID", "date", "来源日期必须是有效的YYYY-MM-DD", "使用已保存条目所在的真实日期。", "YYYY-MM-DD", edit.date);
    if (typeof edit.item_id !== "string" || !edit.item_id.trim()) issue("ITINERARY_EDIT_ITEM_ID_REQUIRED", "item_id", "缺少有效条目ID", "使用已保存的稳定ID，不要猜测或用名称代替ID。", "non-empty string", edit.item_id);
    if (issues.length > before) continue;
    const source = days.find((day) => day.date === edit.date);
    if (!source) {
      issue("ITINERARY_EDIT_DAY_NOT_FOUND", "date", "编辑目标日期不存在，该日期尚未保存", "新增日期请提交days，不要对未保存日期使用edits。", days.map((day) => day.date), edit.date);
      continue;
    }
    const old = source.items.find((item) => item.id === edit.item_id);
    if (!old) {
      const available = source.items.slice(0, 12).map(({ id, name, type }) => ({ id, name: name.slice(0, 32), type }));
      issue("ITINERARY_EDIT_ITEM_NOT_FOUND", "item_id", `编辑目标条目ID不存在；当前可用ID：${available.map((item) => `${item.id}(${item.name})`).join("、") || "该日期暂无条目"}`,
        "改用该日期已保存的ID；新增条目请提交days，不要猜测ID。", available, edit.item_id);
      continue;
    }
    if (edit.op === "replace") {
      if (!edit.item || typeof edit.item !== "object" || Array.isArray(edit.item)) {
        issue("ITINERARY_EDIT_ITEM_REQUIRED", "item", "replace需要item对象", "提供item并填写name；只改时间时复制原名称。", "object", edit.item, old);
      } else {
        if (edit.item.name === undefined) issue("ITINERARY_EDIT_NAME_REQUIRED", "item.name", "replace缺少item.name", "只改时间或补证据也需填写原名称；真正替换地点时填写新地点名称。", old.name, undefined, old);
        else if (typeof edit.item.name !== "string" || !edit.item.name.trim()) issue("ITINERARY_EDIT_NAME_INVALID", "item.name", "item.name必须为非空字符串", "填写原名称或新地点的真实名称。", "non-empty string", edit.item.name, old);
        if (edit.item.id !== undefined && edit.item.id !== old.id) issue("ITINERARY_EDIT_ID_IMMUTABLE", "item.id", `不能将条目ID从「${old.id}」改为「${String(edit.item.id)}」`, "省略item.id，由程序保留原ID；目标条目由item_id指定。", old.id, edit.item.id, old);
        if (edit.item.type !== undefined && edit.item.type !== old.type) issue("ITINERARY_EDIT_TYPE_IMMUTABLE", "item.type", `「${old.name}」不能从${old.type}改为${String(edit.item.type)}`, `当前item_id属于${old.type}。其他类型应使用对应已保存条目的item_id或通过days新增；若仍编辑原条目，保留原类型及相应内容。不能只删除type却把景点/酒店写成交通。`, old.type, edit.item.type, old);
      }
    }
    if (edit.op === "move") {
      if (!validEditDate(edit.to_date)) issue("ITINERARY_EDIT_TARGET_DATE_INVALID", "to_date", "移动需要有效to_date", "填写移动目标日期YYYY-MM-DD。", "YYYY-MM-DD", edit.to_date, old);
      if (edit.item !== undefined && (!edit.item || typeof edit.item !== "object" || Array.isArray(edit.item))) issue("ITINERARY_EDIT_ITEM_INVALID", "item", "move.item必须为对象", "不调整时间时省略item，否则只填写时间及安排时长。", "object", edit.item, old);
      else if (edit.item && Object.keys(edit.item).some((key) => !["time", "end_time", "planned_duration_min"].includes(key))) issue("ITINERARY_EDIT_MOVE_FIELDS_INVALID", "item", "move.item只允许调整时间及安排时长", "修改名称或地点请使用replace；move只移动原条目并调整时间。", ["time", "end_time", "planned_duration_min"], Object.keys(edit.item), old);
    }
    if (issues.length > before) continue;
    const index = source.items.indexOf(old), stop = ["visit", "accommodation"].includes(old.type);
    const previous = source.items.slice(0, index).map((item, n) => ({ item, n })).reverse().find((v) => ["visit", "accommodation"].includes(v.item.type))?.n ?? -1;
    const after = source.items.slice(index + 1).findIndex((item) => ["visit", "accommodation"].includes(item.type));
    const last = after < 0 ? source.items.length : index + 1 + after;
    if (edit.op === "replace") {
      const same = samePlace(old, edit.item, plan.constraints?.destination);
      const replacement = same ? { ...old, ...edit.item } : { id: old.id, type: old.type, time: old.time, end_time: old.end_time, planned_duration_min: old.planned_duration_min, time_locked: old.time_locked, ...edit.item };
      source.items = source.items.map((item, n) => {
        if (item.id === old.id) return replacement;
        if (!stop || n <= previous || n >= last || item.type !== "transport" || (item.from !== old.name && item.to !== old.name) || (same && old.name === replacement.name)) return item;
        const from = item.from === old.name ? replacement.name : item.from, to = item.to === old.name ? replacement.name : item.to;
        // 保留交通位置、方式和已分配时长，不能因改名/换点把时间线挖空。
        return { ...item, from, to, name: `${from ?? "起点"} → ${to ?? "终点"}`, route_evidence_id: undefined, route_verified: false,
          route_duration_min: undefined, distance_km: undefined, cost_per_person: undefined, source: undefined, confidence: undefined, route_binding_error: "相邻地点已变化，需复用匹配路线证据" };
      });
      continue;
    }
    source.items = source.items.filter((item, n) => item.id !== old.id && !(stop && n > previous && n < last && item.type === "transport" && (item.from === old.name || item.to === old.name)));
    if (edit.op === "move") {
      let target = days.find((day) => day.date === edit.to_date);
      if (!target) { target = { date: edit.to_date, items: [] }; days.push(target); }
      target.items.push({ ...old, ...edit.item });
    }
  }
  if (issues.length) throw new ToolValidationError(issues);
  return { ...plan, days: days.filter((day) => day.items.length).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")).map((day) => ({ ...day, items: day.items.sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99")) })) };
}

/** 严格日历日期，避免2026-02-30被Date归一化为三月。 */
function validEditDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
