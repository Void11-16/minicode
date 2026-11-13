import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { ToolValidationError } from "../core/tool-error.ts";
import type { ToolParameters } from "../llm/provider.ts";

const ajv = new Ajv({ allErrors: true, strict: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new WeakMap<ToolParameters, ValidateFunction>();

/** Only exact, reviewed aliases are adapted. Never infer facts, repair broken JSON, or coerce scalars. */
export function normalizeToolArguments(name: string, input: Record<string, unknown>): { args: Record<string, unknown>; corrections: string[] } {
  const args = { ...input }, corrections: string[] = [];
  if (name === "save_travel_brief") for (const key of ["mustVisit", "avoid", "travelerProfiles"]) {
    if (typeof args[key] !== "string") continue;
    try {
      const value: unknown = JSON.parse(args[key] as string);
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        args[key] = value; corrections.push(`${key}: JSON字符串→字符串数组`);
      }
    } catch { /* Invalid and ambiguous input is rejected by the schema. */ }
  }
  if (name === "save_itinerary") {
    const normalizeItem = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const item = value as Record<string, unknown>;
      const labels: Record<string, string> = { rest: "休息", free_time: "自由活动", note: "备注" };
      if (item.name !== undefined || typeof item.type !== "string" || !labels[item.type]) return item;
      const label = [item.activity, item.note].find((value) => typeof value === "string" && value.trim());
      corrections.push(`${item.type}:补齐展示名称`);
      return { ...item, name: label ?? labels[item.type] };
    };
    if (Array.isArray(args.days)) args.days = args.days.map((day) => day && typeof day === "object" && Array.isArray(day.items) ? { ...day, items: day.items.map(normalizeItem) } : day);
    if (Array.isArray(args.edits)) args.edits = args.edits.map((edit) => edit && typeof edit === "object" && edit.item ? { ...edit, item: normalizeItem(edit.item) } : edit);
  }
  if (name === "plan_day_routes" && args.mode === undefined && Array.isArray(args.stops) && args.stops.length >= 2
    && Array.isArray(args.leg_modes) && args.leg_modes.length === args.stops.length - 1
    && args.leg_modes.every((mode) => ["auto", "walking", "transit", "driving"].includes(mode))) {
    args.mode = args.leg_modes[0];
    corrections.push("leg_modes已指定每段方式，补齐mode");
  }
  if (name === "get_place_visit_info") {
    const aliases = ["name", "query"].filter((key) => args[key] !== undefined);
    const values = [args.place, ...aliases.map((key) => args[key])].filter((value) => value !== undefined);
    if (values.length > 1 && new Set(values.map((value) => typeof value === "string" ? value.trim() : value)).size > 1) {
      throw new ToolValidationError([{ code: "TOOL_ARGUMENT_ALIAS_CONFLICT", path: "place", message: "place与name/query指向不同地点，不能自动选择。", hint: "只提供一个明确的place，不要混入另一个地点或检索指令。" }]);
    }
    if (args.place === undefined && aliases.length) args.place = args[aliases[0]!];
    for (const key of aliases) { delete args[key]; corrections.push(`${key}→place`); }
    const fields = args.fields;
    const mapping: Record<string, string> = { opening_hours: "hours", closed_on: "closure", duration: "visit_duration" };
    if (Array.isArray(fields)) args.fields = fields.map((field) => {
      if (typeof field === "string" && mapping[field]) { corrections.push(`fields.${field}→${mapping[field]}`); return mapping[field]; }
      return field;
    });
  }
  return { args, corrections: [...new Set(corrections)] };
}

export function parseToolInput(json: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json === "" ? "{}" : json); }
  catch { throw new ToolValidationError([{ code: "TOOL_ARGUMENT_JSON_INVALID", path: "", message: "参数不是合法 JSON，工具未执行。", hint: "按工具schema重建完整JSON对象；不自动补括号或猜测截断内容。" }]); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolValidationError([{ code: "TOOL_ARGUMENT_OBJECT_REQUIRED", path: "", message: "参数必须是 JSON 对象。", hint: "传入对象，不要传入数组、null或JSON字符串。" }]);
  return value as Record<string, unknown>;
}

function issue(error: ErrorObject) {
  const key = error.keyword === "required" ? error.params.missingProperty : error.keyword === "additionalProperties" ? error.params.additionalProperty : undefined;
  const path = `${error.instancePath}${key ? `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}` : ""}`;
  return { code: "TOOL_ARGUMENT_SCHEMA_INVALID", path: path || "/", message: `非法参数 ${path || "/"}: ${error.message ?? error.keyword}`,
    hint: "仅修改指出的参数路径后重试；参数校验发生在查询、缓存扣额及业务写入之前。", expected: error.params };
}

/** The same declared schema is enforced for Agent, MCP, and direct registry calls. */
export function validateToolArguments(schema: ToolParameters, args: Record<string, unknown>): void {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  // Host defaults may contain undefined, which is absent in the JSON wire contract.
  const wire = JSON.parse(JSON.stringify(args));
  if (!validate(wire)) throw new ToolValidationError((validate.errors ?? []).slice(0, 12).map(issue));
}
