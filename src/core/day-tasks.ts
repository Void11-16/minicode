import type { PlanningLayer } from "./planning-layers.ts";
import type { TravelState } from "./travel-state.ts";
import type { Itinerary, ItineraryDay } from "../tools/itinerary-schema.ts";
import { materializedDay } from "../tools/itinerary-planning.ts";
import type { CumulativeToolBudget } from "./execution-budget.ts";
import type { PromptMessage } from "./message.ts";
import type { ToolDefinition } from "../llm/provider.ts";
import { requiredVisitCoverage, requiredVisitMatches } from "../tools/required-visits.ts";
import { ToolValidationError } from "./tool-error.ts";

export const DAY_TASK_MAX_ATTEMPTS = 2;
export const DAY_TASK_ROUNDS = 8;
export const DAY_TASK_CALLS = 16;
export function dayTaskRounds(task: DayTask): number { return task.layer === "required" ? 2 : task.layer === "feasibility" || task.layer === "budget" ? 4 : DAY_TASK_ROUNDS; }
export function dayTaskCalls(task: DayTask): number { return task.layer === "required" ? 4 : task.layer === "budget" ? 6 : task.layer === "feasibility" ? 8 : DAY_TASK_CALLS; }
export interface DayTask {
  readonly date: string;
  readonly layer?: PlanningLayer;
  readonly goal_id?: string;
  readonly goal_name?: string;
  readonly input_signature?: string;
  readonly requirement_version?: string;
  readonly status: "pending" | "active" | "saved" | "blocked";
  readonly attempts: number;
  readonly rounds: number;
  readonly calls: number;
  readonly attempt_rounds: number;
  readonly attempt_calls: number;
  readonly failures: number;
  readonly last_error?: string;
  readonly draft_path?: string;
}
type BoundaryStop = Pick<ItineraryDay["items"][number], "id" | "type" | "name" | "time" | "end_time" | "planned_duration_min" | "location" | "evidence_id">;
export interface DayBoundary {
  readonly date: string;
  readonly first?: BoundaryStop;
  readonly last?: BoundaryStop;
}
export interface DayPlanningScope {
  readonly title: string;
  readonly layer?: PlanningLayer;
  readonly goal_name?: string;
  readonly date: string;
  readonly locked_dates: readonly string[];
  readonly day_number?: number;
}

export function taskDates(state: TravelState): string[] {
  const brief = state.brief, plan = state.itinerary;
  const start = brief?.startDate;
  const span = start && brief.endDate ? Math.round((Date.parse(brief.endDate) - Date.parse(start)) / 86400000) + 1 : brief?.durationDays ?? plan?.expectedDays;
  if (start && span && span > 0 && span <= 90 && Number.isFinite(Date.parse(start))) return Array.from({ length: span }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
  return [...new Set(plan?.outline?.map((day) => day.date) ?? [])].sort();
}
export function reconcileDayTasks(state: TravelState, previous = state.itinerary?.dayTasks): DayTask[] {
  const layers = state.itinerary?.planningLayers;
  const dates = taskDates(state);
  const version = state.brief?.requirementVersion;
  const requirement = version ? { requirement_version: version } : {};
  const current = previous?.filter((task) => task.requirement_version === version);
  const required = !layers ? [] : (state.itinerary?.requiredVisits ?? []).flatMap((goal): DayTask[] => {
    const old = current?.find((task) => task.goal_id === goal.id && task.layer === "required");
    // A matching name is only a date-selection hint, never proof of goal coverage.
    const related = state.itinerary?.outline?.find((day) => day.visits.some((visit) => visit.name.includes(goal.name)))?.date;
    const leastBusy = [...state.itinerary?.outline ?? []].sort((a, b) => a.visits.length - b.visits.length)[0]?.date;
    const date = goal.date ?? (old && dates.includes(old.date) ? old.date : related ?? leastBusy ?? dates[0]);
    if (!date) return [];
    const saved = goal.status === "reserved" || goal.status === "scheduled";
    return [{ date, ...requirement, layer: "required", goal_id: goal.id, goal_name: goal.name, status: saved ? "saved" : old?.status === "saved" ? "pending" : old?.status ?? "pending",
      attempts: old?.attempts ?? 0, rounds: old?.rounds ?? 0, calls: old?.calls ?? 0, attempt_rounds: old?.attempt_rounds ?? 0, attempt_calls: old?.attempt_calls ?? 0, failures: old?.failures ?? 0,
      ...(old?.last_error ? { last_error: old.last_error } : {}), ...(old?.draft_path ? { draft_path: old.draft_path } : {}) }];
  });
  return [...required, ...dates.flatMap((date) => {
    const detail = layers?.days.find((day) => day.date === date);
    const budgetTask = detail?.budget_gaps?.length || current?.some((task) => task.date === date && task.layer === "budget");
    const dateLayers: (PlanningLayer | undefined)[] = layers ? ["feasibility", "schedule", ...(budgetTask ? ["budget" as const] : [])] : [undefined];
    return dateLayers.map((layer): DayTask => {
    const old = current?.find((task) => task.date === date && task.layer === layer);
    const saved = layer === "feasibility" ? detail?.feasibility === "checked" : layer === "schedule" ? detail?.schedule === "ready"
      : layer === "budget" ? !detail?.budget_gaps?.length
      : state.itinerary?.daySummaries?.some((day) => day.date === date && day.materialized === true);
    const changed = old?.input_signature && old.input_signature !== detail?.signature;
    return { date, ...requirement, ...(layer ? { layer, input_signature: detail?.signature } : {}), status: saved ? "saved" : old?.status === "saved" || changed ? "pending" : old?.status ?? "pending", attempts: old?.attempts ?? 0,
      rounds: old?.rounds ?? 0, calls: old?.calls ?? 0, attempt_rounds: old?.attempt_rounds ?? 0, attempt_calls: old?.attempt_calls ?? 0, failures: old?.failures ?? 0, ...(old?.last_error === undefined ? {} : { last_error: old.last_error }), ...(old?.draft_path === undefined ? {} : { draft_path: old.draft_path }) };
    });
  })];
}

export function dayBoundaries(plan: Itinerary): DayBoundary[] {
  return plan.days.flatMap((day) => {
    if (!day.date || !materializedDay(day)) return [];
    const stops = day.items.filter((item) => ["visit", "accommodation"].includes(item.type) && item.time).slice().sort((a, b) => a.time!.localeCompare(b.time!));
    const boundary = (item: ItineraryDay["items"][number] | undefined): BoundaryStop | undefined => item ? { id: item.id, type: item.type, name: item.name, time: item.time, end_time: item.end_time, planned_duration_min: item.planned_duration_min, location: item.location, evidence_id: item.evidence_id } : undefined;
    return [{ date: day.date, first: boundary(stops[0]), last: boundary(stops.at(-1)) }];
  });
}
export function normalizeDayTasks(raw: unknown): DayTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 240).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const task = value as Record<string, unknown>;
    if (typeof task.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(task.date) || !["pending", "active", "saved", "blocked"].includes(String(task.status))) return [];
    const count = (key: string) => typeof task[key] === "number" && Number.isSafeInteger(task[key]) && task[key] >= 0 ? task[key] : 0;
    return [{ date: task.date, ...(["required", "feasibility", "schedule", "budget"].includes(String(task.layer)) ? { layer: task.layer as PlanningLayer } : {}), ...(typeof task.goal_id === "string" && typeof task.goal_name === "string" ? { goal_id: task.goal_id, goal_name: task.goal_name } : {}), ...(typeof task.input_signature === "string" ? { input_signature: task.input_signature } : {}), ...(typeof task.requirement_version === "string" ? { requirement_version: task.requirement_version } : {}), status: task.status as DayTask["status"], attempts: count("attempts"), rounds: count("rounds"), calls: count("calls"), attempt_rounds: count("attempt_rounds"), attempt_calls: count("attempt_calls"), failures: count("failures"), ...(typeof task.draft_path === "string" ? { draft_path: task.draft_path } : {}), ...(typeof task.last_error === "string" ? { last_error: task.last_error.slice(0, 800) } : {}) }];
  });
}
export function setDayTasks(state: TravelState, tasks: readonly DayTask[]): TravelState {
  return state.itinerary ? { ...state, itinerary: { ...state.itinerary, dayTasks: tasks } } : state;
}
/** 单日软额度只影响该日，先遍历所有未尝试日期，再重试失败日；硬总预算始终累计。 */
export function selectDayTask(state: TravelState, budget: CumulativeToolBudget): { state: TravelState; task?: DayTask } {
  let tasks = reconcileDayTasks(state);
  const taskKey = (task: DayTask) => `${state.itinerary?.itineraryId ?? state.itinerary?.title}:${task.layer === "required" ? task.goal_id : task.date}:${task.layer ?? "legacy"}:${task.requirement_version ?? ""}`;
  budget.dayTaskAttemptBaselines ??= new Map();
  for (const task of tasks) {
    const key = taskKey(task);
    if (!budget.dayTaskAttemptBaselines.has(key)) budget.dayTaskAttemptBaselines.set(key, task.attempts - (task.status === "active" ? 1 : 0));
  }
  const allowed = (task: DayTask) => task.attempts < budget.dayTaskAttemptBaselines!.get(taskKey(task))! + (task.layer === "budget" ? 1 : DAY_TASK_MAX_ATTEMPTS);
  const verifyPending = tasks.some((t) => t.layer === "feasibility" && t.status !== "saved" && (t.status === "active" || allowed(t)));
  const requiredPending = tasks.some((t) => t.layer === "required" && t.status !== "saved" && (t.status === "active" || allowed(t)));
  const missingSchedule = (t: DayTask) => t.layer === "schedule" && state.itinerary?.planningLayers?.days.find((day) => day.date === t.date)?.schedule === "missing";
  const coveragePending = tasks.some((t) => missingSchedule(t) && t.status !== "saved" && (t.status === "active" || allowed(t)));
  const schedulePending = tasks.some((t) => t.layer === "schedule" && t.status !== "saved" && (t.status === "active" || allowed(t)));
  const eligible = (t: DayTask) => coveragePending ? missingSchedule(t) : requiredPending ? t.layer === "required"
    : verifyPending ? t.layer === "feasibility" : !schedulePending || t.layer !== "budget";
  tasks = tasks.map((task) => task.status === "active" && !eligible(task) ? { ...task, status: "pending" } : task);
  let task = tasks.find((t) => t.status === "active" && eligible(t));
  if (!task) {
    const rank = (t: DayTask) => t.layer === "schedule" && state.itinerary?.planningLayers?.days.find((day) => day.date === t.date)?.schedule === "missing" ? 0 : 1;
    task = tasks.filter((t) => t.status === "pending" && allowed(t) && eligible(t)).sort((a, b) => rank(a) - rank(b))[0]
      ?? tasks.filter((t) => t.status === "blocked" && allowed(t) && eligible(t)).sort((a, b) => rank(a) - rank(b))[0];
    if (task) { task = { ...task, status: "active", attempts: task.attempts + 1, attempt_rounds: 0, attempt_calls: 0 }; tasks = tasks.map((t) => t.date === task!.date && t.layer === task!.layer && t.goal_id === task!.goal_id ? task! : t); }
  }
  return { state: setDayTasks(state, tasks), task };
}
export function recordDayTaskRound(state: TravelState, date: string, calls: number, error?: string, layer?: PlanningLayer | "legacy", goalId?: string): TravelState {
  return setDayTasks(state, (state.itinerary?.dayTasks ?? []).map((task) => task.date !== date || (layer ? (task.layer ?? "legacy") !== layer : task.status !== "active") || task.layer === "required" && task.goal_id !== goalId ? task : { ...task,
    rounds: task.rounds + 1, calls: task.calls + calls, attempt_rounds: task.attempt_rounds + 1, attempt_calls: task.attempt_calls + calls,
    failures: task.failures + (error ? 1 : 0), ...(error ? { last_error: error.slice(0, 800) } : {}),
  }));
}
export function blockDayTask(state: TravelState, date: string, reason: string): TravelState {
  return setDayTasks(state, (state.itinerary?.dayTasks ?? []).map((task) => task.date === date && task.status === "active" ? { ...task, status: "blocked", last_error: reason.slice(0, 800) } : task));
}
export function activeDayTask(state: TravelState | undefined): DayTask | undefined { return state?.itinerary?.dayTasks?.find((task) => task.status === "active"); }
export function dayTaskScope(state: TravelState | undefined, date?: string): DayPlanningScope | undefined {
  return state?.itinerary && date ? { title: state.itinerary.title, layer: activeDayTask(state)?.layer, goal_name: activeDayTask(state)?.goal_name, date, day_number: taskDates(state).indexOf(date) + 1, locked_dates: state.itinerary.planningLayers ? state.itinerary.daySummaries?.flatMap((day) => day.date && day.date !== date ? [day.date] : []) ?? [] : state.itinerary.daySummaries?.flatMap((day) => day.materialized === true && day.date ? [day.date] : []) ?? [] } : undefined;
}
export function isExplicitPlanEdit(input: string): boolean {
  if (/评测自动续跑/.test(input)) return false;
  if (/重新规划|重做行程|重新生成/.test(input)) return true;
  return /^(?:请|帮我|麻烦)?(?:把|将).{0,40}(?:改|换成|删除|调整|替换)/.test(input) || /修改需求|更新需求|更改需求/.test(input) || /^(?:请|帮我|麻烦|把|将|我想|我需要)?\s*(?:修改|修复|修订|重排|调整|替换|删除|调换)/.test(input) || /第\s*[一二三四五六七八九十\d]+\s*天.{0,20}(?:改为|换成|调整|删除|修改)/.test(input);
}
/** 仅发送当前日期的工作历史；原始需求由宿主提供，旧日期工具过程不再送模型。 */
export function dayTaskHistory(history: readonly PromptMessage[], boundary: string, requests: readonly PromptMessage[]): PromptMessage[] {
  let start = -1;
  history.forEach((m, index) => { if (m.role === "system" && m.content === boundary) start = index; });
  return [...requests.filter((m) => m.role === "user"), ...history.slice(start >= 0 ? start + 1 : history.length).filter((m) => m.role !== "user")];
}
export function dayTaskDefinitions(definitions: readonly ToolDefinition[], scope: DayPlanningScope): ToolDefinition[] {
  return definitions.filter((tool) => !["bash", "write_file", "edit_file", "save_travel_brief"].includes(tool.name)
    && !(scope.layer === "feasibility" && tool.name === "plan_day_routes")
    && (scope.layer !== "required" || ["search_attractions", "load_itinerary", "save_itinerary", "read_file", "find_tools", "list_tools", "activate_tools", "deactivate_tools"].includes(tool.name))).map((tool) => {
    if (scope.layer === "required" && tool.name === "search_attractions") return { ...tool, description: `定向识别必去「${scope.goal_name}」的主实体；不以附近子点或同区域其他地点代替。`, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties as Record<string, unknown>, location: { type: "string", enum: [scope.goal_name] } } } };
    if (tool.name === "load_itinerary") {
      const { day: _day, ...properties } = tool.parameters.properties as Record<string, unknown>;
      return { ...tool, parameters: { ...tool.parameters, properties: { ...properties, date: { type: "string", enum: [scope.date] } } } };
    }
    if (tool.name !== "save_itinerary") return tool;
    const properties = tool.parameters.properties as Record<string, unknown>;
    const schedule = properties.schedule as { properties?: Record<string, unknown> } | undefined;
    const safeDefaults = { merge: { type: "boolean", const: true }, strict: { type: "boolean", const: false } };
    const days = properties.days as Record<string, unknown> | undefined;
    const item = days?.items as { properties?: Record<string, unknown> } | undefined;
    const outline = properties.outline as { items?: { properties?: Record<string, unknown> } } | undefined;
    const scopedOutline = { ...outline, minItems: 1, maxItems: 1, items: { ...outline?.items, properties: { ...outline?.items?.properties, date: { type: "string", enum: [scope.date] } } } };
    if (scope.layer === "feasibility" || scope.layer === "required") return { ...tool, description: scope.layer === "required" ? `为必去「${scope.goal_name}」识别真实实体，并在${scope.date}的outline明确预留。必须保留其他必去及其他日期。预留不算完成，不生成详细days。` : `核验${scope.date}的地点身份和开放/闭馆；必要时只替换当前日期outline，未知如实保留。不要排具体时间和交通。`, parameters: { ...tool.parameters, additionalProperties: false, properties: { ...safeDefaults, title: properties.title, outline: scopedOutline, expected_revision: properties.expected_revision }, required: ["title", "outline"] } };
    if (scope.layer === "budget") return { ...tool, description: `只补${scope.date}预算缺项。用days的单日增量添加餐厅候选或用已有ID更新费用；需要补酒店并重算路线时用schedule，保留本日已选景点。`,
      parameters: { ...tool.parameters, additionalProperties: false, properties: { ...safeDefaults, title: properties.title, expected_revision: properties.expected_revision,
        ...(schedule ? { schedule: { ...schedule, properties: { ...schedule.properties, date: { type: "string", enum: [scope.date] } } } } : {}),
        days: { ...days, minItems: 1, maxItems: 1, items: { ...item, required: ["date", "items"], properties: { ...item?.properties, date: { type: "string", enum: [scope.date] } } } },
      }, required: ["title"] } };
    return { ...tool, description: `优先用schedule生成${scope.date}时间路线，模型只给景点顺序/时长/出行方式，程序计算时间与交通占位；或局部修复现有日程；日内P0/P1未清零仅算草稿，仍可局部修改。其他日期保持。需要换景点时提交当前日期outline，已有日程保留，替代方案校验通过后提交。`, parameters: { ...tool.parameters, additionalProperties: false,
      properties: { ...safeDefaults, title: properties.title, ...(schedule ? { schedule: { ...schedule, properties: { ...schedule.properties, date: { type: "string", enum: [scope.date] } } } } : {}), outline: scopedOutline, days: { ...days, minItems: 1, maxItems: 1, items: { ...item, properties: { ...item?.properties, date: { type: "string", enum: [scope.date] } } } }, edits: properties.edits, repair_routes: { type: "array", maxItems: 1, items: { type: "string", enum: [scope.date] } }, expected_revision: properties.expected_revision }, required: ["title"],
    } };
  });
}
export function dayTaskCallIssue(name: string, args: Record<string, unknown>, scope: DayPlanningScope): string | undefined {
  if (scope.layer === "required") {
    if (!["search_attractions", "load_itinerary", "save_itinerary", "read_file", "find_tools", "list_tools", "activate_tools", "deactivate_tools"].includes(name)) return `当前仅识别并预留必去「${scope.goal_name}」；其他日期会按独立任务继续。`;
    if (name === "search_attractions" && (typeof args.location !== "string" || !requiredVisitMatches(scope.goal_name!, args.location, typeof args.city === "string" ? args.city : undefined))) return `请定向search_attractions(location=${JSON.stringify(scope.goal_name)})识别该必去，不能改搜全城或周边无关地点。`;
  }
  if (name === "load_travel_brief" && args.title !== scope.title) return "当前日期只使用对应行程的需求版本。";
  if (name === "save_travel_brief") return "当前需求已固定；补天时不能自行更改用户需求、缩短天数或清空必去目标。";
  if (["bash", "write_file", "edit_file"].includes(name)) return "补天阶段不直接读写整份行程文件，请用save_itinerary只提交当前日期。";
  if (name === "read_file" && typeof args.path === "string" && /(?:^|\/)plans\//.test(args.path)) return "已保存日期固定，所需景点占用和相邻日期边界已提供；局部读取使用load_itinerary当前日期。";
  if (name === "load_itinerary" && (args.date !== undefined && args.date !== scope.date || args.day !== undefined && args.day !== scope.day_number)) return `当前只处理${scope.date}；已保存日期只保留共享摘要，不展开重读。`;
  if (name === "load_itinerary" && args.summary === false && args.date === undefined && args.day === undefined) return `只展开当前${scope.date}，不要读取整份行程。`;
  if (scope.layer === "feasibility" && name === "plan_day_routes") return "当前先核验地点与开放可行性，具体交通与时间在下一层处理。";
  if (name === "validate_itinerary" && (scope.layer === "required" || scope.layer === "feasibility")) return "当前层进度由程序校验，完整strict留到详细时间与路线完成后。";
  return undefined;
}
export function assertDayTaskSave(saved: Itinerary | null, plan: Itinerary, scope: DayPlanningScope | undefined, args: Record<string, unknown>, evidenceBound = false): void {
  if (!scope) return;
  const fail = (reason: string): never => { throw new Error(`DAY_TASK_FROZEN：${reason}。当前仅安排${scope.date}，已保存日期固定；未提交修改。`); };
  if (plan.title !== scope.title) fail("不能更换行程标题另存");
  if (["feasibility", "required"].includes(scope.layer ?? "") && (args.schedule !== undefined || args.days !== undefined || args.edits !== undefined || args.repair_routes !== undefined)) fail("当前层只修改outline，详细日程留到时间路线层");
  if (scope.layer === "budget") {
    const visitNames = (input: Itinerary | null) => input?.days.find((day) => day.date === scope.date)?.items.filter((item) => item.type === "visit").map((item) => item.name);
    if (JSON.stringify(visitNames(saved)) !== JSON.stringify(visitNames(plan))) fail("补预算时保留本日已选景点");
  }
  if (scope.layer === "required" && evidenceBound && !plan.outline?.find((day) => day.date === scope.date)?.visits.some((visit) => requiredVisitCoverage(scope.goal_name!, visit, plan.constraints?.destination))) throw new ToolValidationError([{ code: "REQUIRED_VISIT_RESERVATION_MISSING", path: "outline", message: `当前任务必须在${scope.date}明确预留必去「${scope.goal_name}」。`, hint: "使用原始目标名或有证据的主景点覆盖关系；附近子点、备注或排除理由不能替代必去。" }]);
  if (scope.layer === "required" && evidenceBound) for (const goal of saved?.required_visit_goals ?? []) {
    if (!["reserved", "scheduled"].includes(goal.status)) continue;
    if (!plan.outline?.some((day) => day.visits.some((visit) => requiredVisitCoverage(goal.name, visit, plan.constraints?.destination)))) throw new ToolValidationError([{ code: "REQUIRED_VISIT_RESERVATION_LOST", path: "outline", message: `本次预留不能移除已经预留的必去「${goal.name}」。`, hint: "保留原必去分配，只增加或调整当前待解决目标；不能用解决一个必去来删除另一个必去。" }]);
  }
  if (args.strict === true) fail("补天阶段使用strict=false，最终统一验收");
  for (const date of args.repair_routes as string[] ?? []) if (date !== scope.date || scope.locked_dates.includes(date)) fail(`不能修订已固定或非当前日期${date}`);
  const dates = new Set([...(saved?.days ?? []), ...plan.days].map((day) => day.date));
  for (const date of dates) {
    if (date === scope.date && !scope.locked_dates.includes(date!)) continue;
    if (JSON.stringify(saved?.days.find((day) => day.date === date)) !== JSON.stringify(plan.days.find((day) => day.date === date))) fail(`不能修改${date ?? "未定日期"}`);
  }
  if (Array.isArray(args.outline)) for (const patch of args.outline as { date: string; visits?: { name: string }[] }[]) if (patch.date !== scope.date) {
    const before = saved?.outline?.find((day) => day.date === patch.date);
    if (JSON.stringify(before?.visits.map((visit) => visit.name)) !== JSON.stringify(patch.visits?.map((visit) => visit.name))) fail(`不能改动其他日期${patch.date}的基础安排`);
  }
  for (const date of scope.locked_dates) if (JSON.stringify(saved?.outline?.find((day) => day.date === date)) !== JSON.stringify(plan.outline?.find((day) => day.date === date))) fail(`不能改动${date}的景点预留`);
}

export function setDayTaskDraft(state: TravelState, date: string, path: string): TravelState {
  return setDayTasks(state, (state.itinerary?.dayTasks ?? []).map((task) => task.date === date && task.status === "active" ? { ...task, draft_path: path } : task));
}
