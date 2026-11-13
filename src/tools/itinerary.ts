import { buildDaySchedule, dayScheduleSchema, parseDaySchedule } from "./day-schedule.ts";
import { validateToolArguments } from "./tool-contract.ts";
import { derivePlanningLayers, planningOutline, planningLayerSummary } from "../core/planning-layers.ts";
import { assertDayTaskSave, assertVisitAddition, assertVisitAdditionDurations, dayTaskDefinitions } from "../core/day-tasks.ts";
import { requiredVisitCoverage, requiredVisitGoals, requiredVisitGoalLabel } from "./required-visits.ts";
import { normalizeStayReferences, isConcreteStayName } from "./stay-policy.ts";
import { alignRouteContext, routeTimelineSignature } from "./itinerary-route-context.ts";
import { repairDayRoutes } from "./itinerary-route-repair.ts";
import { renderItineraryOverview } from "./itinerary-overview.ts";
import { ToolValidationError } from "../core/tool-error.ts";
import { runManagedOperation, type ManagedCommit } from "../storage/managed-operation.ts";
import { resolveRepeatPermissions } from "./repeat-visit-policy.ts";
import { applyItemEdits, syncOutline, visitAssignments, materializedDay } from "./itinerary-planning.ts";
import { annotateToolCall } from "../core/tool-diagnostics.ts";
import { QUALITY_SCORING_VERSION } from "./itinerary-assessment.ts";
import { formatRecommendationPolicy } from "./recommendation-policy.ts";
import { budgetResultText } from "./trip-budget.ts";
import { itineraryDayRole } from "./day-role.ts";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import type { Tool, ToolContext, ItinerarySnapshot } from "./tool.ts";
import { requireString } from "./tool.ts";
import { trackRead, readWasDeferred } from "./read-progress.ts";
import { TravelEvidenceStore, evidenceId } from "./travel-evidence.ts";
import { DEFAULT_TRAVELERS, briefDays, loadBriefForTitle, type TravelBrief } from "./brief.ts";
import { atomicWrite, planFileFor, withPlanLock, withTripTitleLock } from "./plan-files.ts";
export { planFileFor } from "./plan-files.ts";
import {
  parseItinerary,
  itineraryItemName,
  ITINERARY_ITEM_TYPES,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
} from "./itinerary-schema.ts";
import {
  qualitySourceSignature,
  expectedDaysFromTitle,
  renderQualityReport,
  validateItinerary,
  type ItineraryQualityReport,
  type ValidateItineraryOptions,
} from "./itinerary-validator.ts";

/**
 * 结构化行程单：JSON 持久化 + 可读 Markdown + 质量报告。
 * 修改行程时模型先 load → 只改受影响条目 → save，
 * 不需要重新生成整份行程（增量修改工作流）。
 */
/** 旧行程复验也读取当前需求单；可独立绑定事实供列表缓存与评测使用。 */
export async function itineraryWithBriefRequirements(rootDir: string, itinerary: Itinerary): Promise<Itinerary> {
  const { plan, evidence } = await loadItineraryQualityInputs(rootDir, itinerary);
  return refreshItineraryEvidence(plan, evidence);
}

export async function loadItineraryQualityInputs(rootDir: string, itinerary: Itinerary) {
  const brief = await loadBriefForTitle(rootDir, itinerary.title);
  const plan = applyBriefRequirements(itinerary, brief ?? undefined);
  const evidence = new TravelEvidenceStore(rootDir);
  await evidence.load();
  return { plan, evidence };
}

function briefConstraints(brief: TravelBrief, title: string, fallback: Itinerary["constraints"] = {}): Itinerary["constraints"] {
  const { room_count: _rooms, travelers: _travelers, dates: _dates, fixed_stay: _fixedStay, ...requirements } = brief.requirements ?? {};
  return {
    destination: brief.destination,
    start_date: brief.startDate,
    end_date: brief.endDate,
    expected_days: briefDays(brief) ?? expectedDaysFromTitle(title) ?? fallback.expected_days,
    must_visit: brief.mustVisit ?? [],
    require_accommodation: briefAccommodationRequired(brief, title, fallback.require_accommodation),
    return_last_day: brief.returnLastDay !== false,
    allow_hotel_changes: brief.allowHotelChanges,
    requirement_version: brief.requirementVersion,
    requirements: {
      ...requirements,
      ...(brief.travelers === undefined ? {} : { travelers: brief.travelers }),
      ...(brief.roomCount === undefined ? {} : { room_count: brief.roomCount }),
    },
  };
}

export function applyBriefRequirements(plan: Itinerary, brief: TravelBrief | undefined): Itinerary {
  if (brief?.title !== plan.title) return plan;
  const budget = brief.budgetTotalYuan === undefined || plan.budget_source === "explicit" ? undefined : brief.budgetTotalYuan / (brief.travelers ?? DEFAULT_TRAVELERS);
  const constraints = { ...plan.constraints, ...briefConstraints(brief, plan.title, plan.constraints) };
  if (brief.allowHotelChanges !== false) delete constraints.base_stay_name;
  return {
    ...plan, constraints, budget_overrun_ratio: brief.budgetOverrunRatio,
    ...(budget !== undefined ? { budget_per_person_yuan: budget, budget_source: "brief" }
      : plan.budget_source === "brief" ? { budget_per_person_yuan: undefined, budget_source: undefined } : {}),
  };
}

export async function inspectSavedItinerary(rootDir: string, itinerary: Itinerary, options?: ValidateItineraryOptions) {
  const { plan, evidence } = await loadItineraryQualityInputs(rootDir, itinerary);
  return inspectItinerary(plan, evidence, options);
}

export function refreshItineraryEvidence(plan: Itinerary, evidence: TravelEvidenceStore): Itinerary {
  return inspectItinerary(plan, evidence).itinerary;
}

export function inspectItinerary(plan: Itinerary, evidence: TravelEvidenceStore, options?: ValidateItineraryOptions) {
  const refreshed = bindItineraryEvidence({ ...plan, days: plan.days.map((day, index) =>
    day.day_type !== "departure" && itineraryDayRole(plan, day, index) === "departure" ? { ...day, day_type: "departure" } : day) }, evidence);
  const report = validateItinerary(refreshed, options);
  return { itinerary: withPlanningLayers(refreshed, report, evidence), report };
}

export function bindItineraryEvidence(plan: Itinerary, evidence: TravelEvidenceStore): Itinerary {
  const city = plan.constraints?.destination;
  const refreshed = { ...plan, days: plan.days.map((day) => ({ ...day, items: day.items.map((item) => {
    const bound = evidence.bind({ ...item, evidence_verified: false }, city, day.date);
    return bound.evidence_verified ? bound : item;
  }) })),
    outline: plan.outline?.map((day) => ({ ...day, visits: day.visits.map((visit) => bindPlannedVisit(visit, evidence, city)) })) };
  return withRequiredVisitGoals(refreshed, evidence);
}

function bindPlannedVisit(visit: import("./itinerary-schema.ts").PlannedVisit, evidence: TravelEvidenceStore, city?: string): import("./itinerary-schema.ts").PlannedVisit {
  const bound = evidence.bind({ id: "outline", type: "visit", name: evidence.canonicalPlaceName(visit.name, city ?? ""), evidence_id: visit.evidence_id }, city);
  return { name: bound.name, ...(bound.evidence_verified ? { evidence_id: bound.evidence_id, parent_visit: bound.parent_visit, area_group: bound.area_group, covered_visits: bound.covered_visits } : {}), ...(visit.repeat_reason ? { repeat_reason: visit.repeat_reason } : {}) };
}

function withRequiredVisitGoals(plan: Itinerary, evidence: TravelEvidenceStore): Itinerary {
  const goals = requiredVisitGoals(plan, (name) => evidence.bind({ id: "required", type: "visit", name: evidence.canonicalPlaceName(name, plan.constraints?.destination ?? "") }, plan.constraints?.destination));
  const result = { ...plan };
  if (goals.length) result.required_visit_goals = goals;
  else delete result.required_visit_goals;
  return result;
}

function withPlanningLayers(plan: Itinerary, report: ItineraryQualityReport, evidence: TravelEvidenceStore): Itinerary {
  return { ...plan, planning_layers: derivePlanningLayers(plan, report, (visit, date) => evidence.visitFeasibility(visit, plan.constraints?.destination ?? "", date)) };
}

function briefAccommodationRequired(brief: TravelBrief, title: string, fallback: boolean | undefined): boolean | undefined {
  const days = briefDays(brief) ?? expectedDaysFromTitle(title);
  return brief.requireAccommodation ?? (days === 1 ? false : fallback);
}

export function createSaveItineraryTool(rootDir: string = process.cwd()): Tool {
  const tool: Tool = {
    name: "save_itinerary",
    effect: "managed_write",
    operationRoot: rootDir,
    alwaysActive: "travel",
    description:
      "保存行程并返回版本与主要问题。默认按日期和ID增量保存，保留未提交日期与条目；已保存条目用稳定 ID 更新，新增条目省略 ID。整份覆盖须显式merge=false。" +
      "新增单日优先用schedule={date,visits:[{name,duration_min}],mode}，程序生成时间、交通和午餐；不需要手写整份days。schedule独立使用，不能与days/outline/edits/repair_routes混用。" +
      "地点和交通优先引用 evidence_id / route_evidence_id，程序回填核验数据。P0 和未授权重复拒绝保存，strict=true 也拒绝 P1。",
    parameters: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "与需求单一致" },
        schedule: dayScheduleSchema,
        outline: {
          type: "array", maxItems: 90, description: "全局粗排，预留主景点，完成日以 days 为准",
          items: {
            type: "object", required: ["date", "visits"],
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              theme: { type: "string" },
              visits: {
                type: "array", maxItems: 20,
                items: { type: "object", required: ["name"], properties: { name: { type: "string" }, evidence_id: { type: "string" }, repeat_reason: { type: "string" } } },
              },
            },
          },
        },
        days: {
          type: "array",
          items: {
            type: "object", required: ["items"],
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              theme: { type: "string" },
              day_type: { type: "string", enum: ["full", "arrival", "departure", "transfer"] },
              available_start: { type: "string", description: "已知硬边界 HH:MM" },
              available_end: { type: "string", description: "已知硬边界 HH:MM" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  anyOf: [{ required: ["name"] }, { required: ["id"] }, { required: ["route_evidence_id"] }, { required: ["activity"] }, { required: ["type", "from", "to"] }],
                  properties: {
                    id: { type: "string", description: "仅填写已保存的稳定 ID" },
                    type: { type: "string", enum: [...ITINERARY_ITEM_TYPES] },
                    name: { type: "string", description: "真实地点名，返回酒店等动作写 activity" },
                    activity: { type: "string" },
                    time: { type: "string", description: "开始 HH:MM" },
                    end_time: { type: "string", description: "结束 HH:MM" },
                    planned_duration_min: { type: "number", description: "计划时长（分钟）" },
                    time_locked: { type: "boolean", description: "仅确认的固定开始时刻" },
                    evidence_id: { type: "string" },
                    route_evidence_id: { type: "string", description: "可自动回填交通端点、方式和距离" },
                    subtype: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
                    place_type: { type: "string" },
                    recommended_spots: { type: "array", maxItems: 10, items: { type: "string", maxLength: 100 }, description: "主景区内部推荐" },
                    repeat_reason: { type: "string", description: "重游说明，授权由程序核对" },
                    location: {
                      type: "object",
                      properties: {
                        name: { type: "string" }, address: { type: "string" },
                        latitude: { type: "number" }, longitude: { type: "number" },
                        crs: { type: "string", enum: ["gcj02", "wgs84"] }, source: { type: "string" },
                      },
                    },
                    transport_mode: { type: "string", enum: ["walking", "transit", "driving", "cycling", "taxi"] },
                    from: { type: "string" }, to: { type: "string" },
                    distance_km: { type: "number" },
                    room_price_per_night: { type: "number", description: "每房每晚（元）" },
                    room_count: { type: "integer" },
                    stay_nights: { type: "integer", description: "住宿晚数，末日默认 0" },
                    cost_per_person: { type: "number", description: "人均消费（元）" },
                    ticket_price_per_person: { type: "number", description: "人均门票（元）" },
                    opening_hours: {
                      type: "object", required: ["opens", "closes"],
                      properties: {
                        opens: { type: "string" }, closes: { type: "string" },
                        last_admission: { type: "string" }, source: { type: "string" },
                        intervals: { type: "array", items: { type: "object", required: ["opens", "closes"], properties: { opens: { type: "string" }, closes: { type: "string" } } } },
                      },
                    },
                    closed_on: { type: "array", items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] } },
                    reservation_required: { type: "boolean" },
                    cuisine: { type: "string" },
                    source: { type: "string" },
                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                    note: { type: "string" },
                  },
                },
              },
            },
          },
        },
        edits: {
          type: "array", maxItems: 30, description: "按日期和已保存 ID 局部修改。replace必须提供item.name，只改时间也复制原名，不能修改原id/type；move提供to_date。校验失败按issues中的code/path修正整批。",
          items: {
            type: "object", required: ["op", "date", "item_id"],
            properties: {
              op: { type: "string", enum: ["remove", "replace", "move"] },
              date: { type: "string" }, item_id: { type: "string" }, to_date: { type: "string" },
              item: { type: "object", properties: {
                name: { type: "string" }, evidence_id: { type: "string" },
                time: { type: "string" }, end_time: { type: "string" },
                planned_duration_min: { type: "number" }, time_locked: { type: "boolean" },
                repeat_reason: { type: "string" }, note: { type: "string" },
              } },
            },
          },
        },
        repair_routes: { type: "array", minItems: 1, maxItems: 90, items: { type: "string" }, description: "日期 YYYY-MM-DD。复用已查路线补交通并顺延，保留硬时间。" },
        excluded_visits: { type: "array", maxItems: 100, description: "本次明确排除的主景点，[] 清空", items: { type: "object", required: ["name", "reason"], properties: { name: { type: "string" }, evidence_id: { type: "string" }, reason: { type: "string" } } } },
        merge: { type: "boolean", description: "默认true按日期和ID增量保存；显式false才整份覆盖，须提供完整days" },
        merge_mode: { type: "string", enum: ["patch_items", "replace_day"], description: "replace_day 删除该日未提交项，不能与 edits 同用" },
        expected_revision: { type: "integer", description: "版本不匹配时拒绝覆盖" },
        strict: { type: "boolean" },
        travelers: { type: "integer" },
        room_count: { type: "integer" },
        budget_per_person_yuan: { type: "number", description: "人均总预算（元）" },
        recommendation_policy: {
          type: "object", description: "餐饮默认 advisory，strict 才阻断验收",
          properties: {
            mode: { type: "string", enum: ["advisory", "strict", "off"] },
            min_candidates: { type: "integer", minimum: 1, maximum: 20 },
            min_evidence_rate: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        route_tolerance_min: { type: "number", minimum: 0, maximum: 15, description: "交通差异容差（分钟）" },
        route_tolerance_ratio: { type: "number", minimum: 0, maximum: .25, description: "交通差异容差比例" },
        remote_leg_limit_min: { type: "number", minimum: 60, maximum: 480, description: "远郊单段交通提示阈值（分钟）" },
      },
    },
    async execute(args, ctx) {
      if (ctx?.dayPlanningScope) {
        const [scoped] = dayTaskDefinitions([tool], ctx.dayPlanningScope);
        try { validateToolArguments(scoped!.parameters, args); }
        catch (error) {
          if (!(error instanceof ToolValidationError)) throw error;
          const scope = ctx.dayPlanningScope;
          const restriction = scope.layer === "required" || scope.layer === "feasibility" ? "当前层只修改outline" : "当前层只修改本日行程";
          throw new ToolValidationError(error.issues.map((issue) => ({
            ...issue, code: "DAY_TASK_FROZEN", date: scope.date, message: `${restriction}；${issue.message}`,
          })));
        }
      }
      const file = itineraryFile(rootDir, requireString(args, "title"));
      const save = () => runManagedOperation({ root: rootDir, file, tool: "save_itinerary", request: args, ...ctx,
        onReplay: async () => { const plan = await readSaved(file); if (plan) ctx?.onItinerary?.({ itinerary: plan, report: validateItinerary(plan), file }); },
      }, (commit) => saveItineraryUnlocked(rootDir, args, ctx, commit));
      return ctx?.newTravelPlan ? withTripTitleLock(rootDir, save, ctx.signal) : save();
    },
  };
  return tool;
}

/** 调用者持有行程锁；Web 编辑与工具保存复用相同校验和提交逻辑。 */
async function saveItineraryUnlocked(rootDir: string, args: Record<string, unknown>, ctx: ToolContext | undefined, commit: ManagedCommit): Promise<string> {
  const title = requireString(args, "title");
  if (args.repair_routes !== undefined && (!Array.isArray(args.repair_routes) || args.repair_routes.length < 1 || args.repair_routes.length > 90 || args.repair_routes.some((date) => typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date))) throw new Error("repair_routes必须为1—90个有效日期YYYY-MM-DD");
  const repairDates = new Set<string>(args.repair_routes as string[] | undefined);
  // Incremental chunks must not all reuse the generated day-1-item-N IDs.
  if (args.days === undefined && args.outline === undefined && args.edits === undefined && args.excluded_visits === undefined && args.repair_routes === undefined && args.schedule === undefined) throw new Error("至少提供schedule、days、outline、edits、excluded_visits或repair_routes");
  if (args.edits !== undefined && args.merge_mode === "replace_day") throw new Error("edits不能与replace_day混用");
  if (args.merge !== undefined && typeof args.merge !== "boolean") throw new Error("merge必须为布尔值；默认增量保存，整份覆盖用merge=false");
  if (args.merge === false && (args.days === undefined || args.edits !== undefined || args.repair_routes !== undefined || args.merge_mode !== undefined)) throw new ToolValidationError([{ code: "ITINERARY_REPLACE_ALL_INVALID", path: "merge", message: "整份覆盖须显式merge=false并提供完整days，不能与edits、repair_routes或merge_mode混用", hint: "局部修改省略merge或设为true；只有明确替换整份行程时才提交完整days并设merge=false。" }]);
  const merge = args.merge !== false;
  const file = itineraryFile(rootDir, title);
  const saved = await readSaved(file);
  const localEdit = ctx?.dayPlanningScope?.edit ? ctx.dayPlanningScope : undefined;
  if (localEdit && !saved) throw new Error("未找到要修改的已保存行程，请重新选择行程。");
  if (localEdit?.revision !== undefined && localEdit.revision !== (saved?.revision ?? 0)) throw new Error("行程版本冲突，请重新读取后再提交");
  if (args.expected_revision !== undefined && args.expected_revision !== (saved?.revision ?? 0)) throw new Error("行程版本冲突，请重新读取后再提交");
  if (ctx?.basicPlanning && (args.schedule !== undefined || args.days !== undefined || args.edits !== undefined || args.repair_routes !== undefined || !Array.isArray(args.outline))) throw new ToolValidationError([{ code: "BASIC_LAYER_OUTLINE_REQUIRED", path: "outline", message: "基础层先保存各日期的景点outline，不提交详细时间草稿。", hint: "使用outline=[{date,visits:[{name,evidence_id}]}]；未识别必去由后续独立任务处理，不会阻挡其他日期。" }]);
  const sessionBrief = ctx?.brief?.title === title ? ctx.brief : undefined;
  const brief = sessionBrief?.requirementVersion ? sessionBrief : await loadBriefForTitle(rootDir, title) ?? sessionBrief;
  if (ctx?.newTravelPlan && (saved || brief) && !sessionBrief) throw new ToolValidationError([{
    code: "ITINERARY_TITLE_OCCUPIED", path: "title", message: `已有行程或需求单使用「${title}」，本次新行程尚未关联需求单`,
    hint: "先用save_travel_brief保存本次需求，程序会分配独立标题。编辑旧行程时使用明确选中的已有行程。",
  }]);
  const evidence = ctx?.evidence ?? new TravelEvidenceStore(rootDir);
  await evidence.load();
  await evidence.refresh();
  const scheduleInput = args.schedule === undefined ? undefined : parseDaySchedule(args.schedule);
  if (scheduleInput) {
    if (["days", "outline", "edits", "repair_routes", "merge_mode"].some((key) => args[key] !== undefined) || args.merge === false) throw new Error("schedule不能与days/outline/edits/repair_routes/merge_mode/merge=false混用");
    const input = scheduleInput;
    if (ctx?.dayPlanningScope && (!["schedule", "budget"].includes(ctx.dayPlanningScope.layer ?? "") || input.date !== ctx.dayPlanningScope.date)) throw new Error("DAY_TASK_FROZEN：schedule仅生成当前日期");
    if (localEdit?.edit === "append_visit" && saved && input.visits) assertVisitAdditionDurations(saved, input.date, input.visits);
    const base = applyBriefRequirements(saved ?? { title, days: [], constraints: args.constraints as Itinerary["constraints"] }, brief ?? undefined);
    const day = buildDaySchedule(base, input, evidence);
    const existingOutline = planningOutline(base);
    const previous = existingOutline.find((entry) => entry.date === input.date);
    const old = base.days.find((entry) => entry.date === input.date);
    for (const name of base.constraints?.must_visit ?? []) {
      const city = base.constraints?.destination;
      const covers = (item: import("./itinerary-schema.ts").PlannedVisit) => requiredVisitCoverage(name, item, city);
      const previouslyCovered = previous?.visits.some(covers) || old?.items.some((item) => item.type === "visit" && covers(item));
      if (previouslyCovered && !day.items.some((item) => item.type === "visit" && covers(item))) throw new ToolValidationError([{ code: "REQUIRED_VISIT_RESERVATION_LOST", path: "schedule.visits", date: input.date,
        message: `本次替换会删除${input.date}的必去「${name}」，已有日程保留。`, hint: "保留必去景点或用有依据的主景点覆盖。" }]);
    }
    const outline = [...existingOutline.filter((entry) => entry.date !== input.date), { ...previous, date: input.date, visits: day.items.filter((item) => item.type === "visit").map(({ name, evidence_id, repeat_reason }) => ({ name, evidence_id, repeat_reason })) }];
    args = { ...args, days: [day], outline, merge_mode: "replace_day" };
  }
  if (ctx?.dayPlanningScope && Array.isArray(args.outline) && saved?.outline) {
    const patches = args.outline as { date: string }[];
    args = { ...args, outline: [...saved.outline.filter((day) => !patches.some((patch) => patch.date === day.date)), ...patches] };
  }
  const rawInput = { ...args, days: args.days ?? saved?.days ?? [] };
  // 先按模型显式传入的ID补丁恢复字段，再给新增条目生成ID。
  const hydrated = merge && saved && args.merge_mode !== "replace_day" ? hydrateItemPatches(rawInput, saved) : rawInput;
  const incoming = parseItinerary(merge ? stableIncrementalIds(hydrated) : hydrated);
  const baseMerged = merge ? mergeSavedItinerary(saved, incoming, args.merge_mode === "replace_day") : incoming;
  const keepOutline = args.outline !== undefined || args.days === undefined && args.edits === undefined;
  const edited = applyItemEdits(syncOutline(null, baseMerged, keepOutline), args.edits);
  let merged = syncOutline(saved, { ...edited, ...(incoming.excluded_visits === undefined && saved?.excluded_visits ? { excluded_visits: saved.excluded_visits } : {}) }, keepOutline);
  // 粗排变更只让本日待重排；已有日程保留到替代方案通过整体验证后原子提交。
  assertDayTaskSave(saved, merged, ctx?.dayPlanningScope, args);
  for (const date of repairDates) if (!merged.days.some((day) => day.date === date)) throw new Error(`路线修复日期${date}尚未保存，未提交任何修改；请先保存该日期实际安排`);
  const travelers = brief === undefined ? incoming.travelers ?? saved?.travelers ?? DEFAULT_TRAVELERS : brief.travelers ?? DEFAULT_TRAVELERS;
  const rooms = brief?.roomCount ?? incoming.room_count ?? saved?.room_count;
  const explicit = optionalNonNegativeNumber(args.budget_per_person_yuan, "budget_per_person_yuan");
  const briefBudget = brief?.budgetTotalYuan === undefined ? undefined : brief.budgetTotalYuan / travelers;
  const budgetSource = explicit !== undefined && args.budget_source !== "brief" ? "explicit"
    : saved?.budget_source === "explicit" || (saved?.budget_source === undefined && saved?.budget_per_person_yuan !== undefined) ? "explicit"
    : briefBudget !== undefined ? "brief" : saved?.budget_source;
  const budget = budgetSource === "explicit" ? explicit ?? saved?.budget_per_person_yuan : brief === undefined ? saved?.budget_per_person_yuan : briefBudget;
  const policy = args.recommendation_policy;
  if (policy !== undefined && (policy === null || typeof policy !== "object" || Array.isArray(policy))) throw new Error("recommendation_policy 必须为对象");
  const recommendation = policy as { mode?: unknown; min_candidates?: unknown; min_evidence_rate?: unknown } | undefined;
  const constraints = { ...incoming.constraints, ...saved?.constraints,
    ...(args.route_tolerance_min === undefined ? {} : { route_tolerance_min: args.route_tolerance_min }),
    ...(args.route_tolerance_ratio === undefined ? {} : { route_tolerance_ratio: args.route_tolerance_ratio }),
    ...(args.remote_leg_limit_min === undefined ? {} : { remote_leg_limit_min: args.remote_leg_limit_min }),
    ...(brief === undefined ? {} : {
      ...briefConstraints(brief, title, { ...saved?.constraints, expected_days: merged.outline?.length, require_accommodation: true }),
      day_start: "10:00", day_end: "18:00",
      require_routes: true, require_place_evidence: true, recommendations: true,
    }),
    ...(recommendation?.mode === undefined ? {} : { recommendation_mode: recommendation.mode }),
    ...(recommendation?.min_candidates === undefined ? {} : { meal_candidates_target: recommendation.min_candidates }),
    ...(recommendation?.min_evidence_rate === undefined ? {} : { meal_evidence_target: recommendation.min_evidence_rate }),
  };
  if (constraints.expected_days === undefined && merged.outline?.length) Object.assign(constraints, { expected_days: expectedDaysFromTitle(title) ?? merged.outline.length });
  if (constraints.destination && Array.isArray(args.edits)) for (const edit of args.edits) {
    const old = baseMerged.days.find((day) => day.date === edit.date)?.items.find((item) => item.id === edit.item_id);
    if (edit.op === "replace" && old?.name === edit.item?.name) continue;
    for (const date of [edit.date, edit.to_date]) if (typeof date === "string" && merged.days.some((day) => day.date === date)) repairDates.add(date);
  }
  if (args.schedule === undefined && (Array.isArray(args.days) || Array.isArray(args.edits))) {
    merged = { ...merged, days: merged.days.map((day, index) => {
      if (!day.schedule_input) return day;
      const previous = day.date ? saved?.days.find((entry) => entry.date === day.date) : saved?.days[index];
      return JSON.stringify(day) === JSON.stringify(previous) ? day : { ...day, schedule_input: undefined };
    }) };
  }
  const normalized = normalizeStayReferences(parseItinerary({ ...merged, constraints }), evidence.stayNames(constraints.destination));
  const previousBase = saved?.constraints?.base_stay_name ?? (saved ? normalizeStayReferences(saved).days.flatMap((day) => day.items).find((item) => item.type === "accommodation")?.name : undefined);
  const stayNames = [...new Set(normalized.days.flatMap((day) => day.items).filter((item) => item.type === "accommodation" && (isConcreteStayName(item.name) || evidence.stayNames(constraints.destination).includes(item.name))).map((item) => item.name))];
  const baseStay = stayNames.length === 1 ? stayNames[0] : previousBase ?? stayNames[0];
  if (constraints.allow_hotel_changes !== false) delete constraints.base_stay_name;
  if (baseStay && constraints.allow_hotel_changes === false && constraints.require_accommodation) Object.assign(constraints, { base_stay_name: baseStay });
  const bindPlanned = (visit: import("./itinerary-schema.ts").PlannedVisit) => bindPlannedVisit(visit, evidence, constraints.destination);
  const routeMessages: string[] = [];
  const keepDays = !!scheduleInput || (args.days === undefined && args.edits === undefined && merge);
  let itinerary: Itinerary = parseItinerary({ ...normalized,
    ...(normalized.outline ? { outline: normalized.outline.map((day) => ctx?.dayPlanningScope?.locked_dates.includes(day.date) ? saved!.outline?.find((old) => old.date === day.date) ?? day : { ...day, visits: day.visits.map(bindPlanned) }) } : {}),
    ...(normalized.excluded_visits ? { excluded_visits: normalized.excluded_visits.map((visit) => ({ ...bindPlanned(visit), reason: visit.reason })) } : {}),
    itinerary_id: saved?.itinerary_id ?? evidenceId([resolve(rootDir), title]),
    revision: (saved?.revision ?? 0) + 1,
    travelers, ...(rooms === undefined ? {} : { room_count: rooms }),
    ...(budgetSource === undefined ? {} : { budget_source: budgetSource }),
    budget_per_person_yuan: budget,
    budget_overrun_ratio: brief ? brief.budgetOverrunRatio : saved?.budget_overrun_ratio,
    ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
    days: normalized.days.map((day, index) => {
      const previous = day.date ? saved?.days.find((old) => old.date === day.date) : saved?.days[index];
      if (previous && (day.date && ctx?.dayPlanningScope?.locked_dates.includes(day.date)
        || keepDays && (day.date === undefined || day.date !== scheduleInput?.date && !repairDates.has(day.date)))) return previous;
      const role = itineraryDayRole(normalized, day, index);
      let bound = { ...day, ...(role === "departure" ? { day_type: role } : {}), items: day.items.map((item) => {
        const untrusted = { ...item, evidence_verified: false, closure_verified: false, route_verified: false, route_duration_min: undefined };
        return evidence.bind(untrusted, constraints.destination, day.date);
      }) };
      if (!scheduleInput && day.date && constraints.destination && constraints.require_routes === true &&
        (previous === undefined || routeTimelineSignature(previous) !== routeTimelineSignature(bound))) repairDates.add(day.date);
      if (day.date && repairDates.has(day.date)) {
        if (!constraints.destination) throw new Error("路线本地修复需要需求单或constraints.destination指定城市，未提交任何修改");
        const result = day.schedule_input
          ? { day: buildDaySchedule(normalized, day.schedule_input, evidence), messages: ["按已选景点和交通方式重新计算本日时间；未知路线仍为估算"] }
          : repairDayRoutes(bound, evidence, constraints.destination, day.items);
        bound = { ...result.day, items: day.schedule_input ? result.day.items.map((item) => evidence.bind(item, constraints.destination, day.date)) : [...result.day.items] };
        routeMessages.push(...result.messages.map((message) => `${day.date} ${message}`));
      }
      return alignRouteContext(bound, constraints.destination);
    }),
  });
  // 本次参数中的授权字段不可信；仅依据宿主用户消息和之前已保存的授权重建。
  const repeatPermissions = resolveRepeatPermissions(itinerary, saved, ctx?.userRequests);
  itinerary = parseItinerary({ ...itinerary, constraints: { ...itinerary.constraints, repeat_visit_permissions: repeatPermissions.length ? repeatPermissions : undefined } });
  assertDayTaskSave(saved, itinerary, ctx?.dayPlanningScope, args, true);
  if (localEdit?.edit === "append_visit" && saved) assertVisitAddition(saved, itinerary, localEdit.date, args.repair_routes !== undefined);
  itinerary = withRequiredVisitGoals(itinerary, evidence);
  const strict = args.strict === true;
  const changedDays = itinerary.days.flatMap((day, index) => {
    const before = day.date === undefined ? saved?.days[index] : saved?.days.find((old) => old.date === day.date);
    return JSON.stringify(before) === JSON.stringify(day) ? [] : [index + 1];
  });
  const constraintChange = JSON.stringify(saved?.constraints) !== JSON.stringify(itinerary.constraints);
  const report = validateItinerary(itinerary, { ...(budget === undefined ? {} : { budget_per_person_yuan: budget }), changed_days: constraintChange ? itinerary.days.map((_, index) => index + 1) : changedDays });
  itinerary = withPlanningLayers(itinerary, report, evidence);
  const routeIssue = report.issues.find((issue) => issue.day !== undefined && itinerary.days[issue.day - 1]?.date && [issue.code, ...issue.related_codes ?? []].some((code) => ["missing-route-leg", "unverified-route", "route-duration-too-short"].includes(code)));
  const routeRepairDate = routeIssue?.day === undefined ? undefined : itinerary.days[routeIssue.day - 1]?.date;
  const repairHardConflict = report.issues.some((issue) => issue.day !== undefined && repairDates.has(itinerary.days[issue.day - 1]?.date ?? "") && ["outside-day-window", "outside-opening-hours"].includes(issue.code) && issue.level !== "P2");
  const visitConflict = report.issues.some((issue) => ["cross-day-duplicate", "visit-allocation-conflict", "duplicate-scenic-visit"].includes(issue.code));
  const scheduleConflict = scheduleInput && report.issues.some((issue) => (issue.date === scheduleInput.date || issue.day !== undefined && itinerary.days[issue.day - 1]?.date === scheduleInput.date)
    && ["outside-day-window", "outside-opening-hours", "forbidden-visit", "daily-visit-limit"].includes(issue.code));
  if (report.issue_count.P0 > 0 || (strict && report.issue_count.P1 > 0) || repairHardConflict || visitConflict || scheduleConflict) {
    throw new Error(`行程质量校验未通过；未提交任何修改，${saved ? `仍为版本${saved.revision ?? 0}` : "尚未保存"}。${visitConflict ? "未经用户授权的景点重复或主子点拆分不能保存；repeat_reason只是说明。请仅调整冲突条目，主子点保留主条目并将子点放recommended_spots，不重写其他已通过日期。" : ""}${repairDates.size ? "路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。" : ""}\n${renderQualityReport(report)}`);
  }
  const routeSummary = repairDates.size ? `路线修复: 仅本地处理${[...repairDates].join("、")}，未联网；${routeMessages.length ? routeMessages.slice(0, 8).join("；") : "已有交通与时间安排无需改变"}${routeMessages.length > 8 ? `；其余${routeMessages.length - 8}项见已保存时间线与质量报告` : ""}` : undefined;

  const base = file.slice(0, -5);
  if (saved !== null && JSON.stringify({ ...saved, revision: 0 }) === JSON.stringify({ ...itinerary, revision: 0 })) {
    let artifactsCurrent = false;
    try {
      const oldReport = JSON.parse(await readFile(`${base}.quality.json`, "utf8"));
      await Promise.all([access(`${base}.md`), access(`${base}.quality.md`)]);
      artifactsCurrent = oldReport.score_version === QUALITY_SCORING_VERSION && oldReport.source_signature === qualitySourceSignature(saved);
    } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (artifactsCurrent) {
      const unchangedReport = { ...report, source_signature: qualitySourceSignature(saved) };
      annotateToolCall({ execution: "cache_hit" });
      ctx?.onItinerary?.({ itinerary: saved, report: unchangedReport, file });
      annotateToolCall({ opening_saved_ids: saved.days.flatMap((day) => day.items.flatMap((item) => item.opening_evidence_ids ?? [])) });
      return [`内容未变化，沿用已保存「${title}」，未增加版本或重写文件。`, `版本: ${saved.itinerary_id}@${saved.revision}`,
        ...(routeSummary ? [routeSummary] : []),
        `质量: ${unchangedReport.score} / 100（P0 ${unchangedReport.issue_count.P0} / P1 ${unchangedReport.issue_count.P1} / P2 ${unchangedReport.issue_count.P2}）`,
        `strict: ${unchangedReport.issue_count.P1 === 0 ? "通过" : "未通过"}；复用现有资料，直接修改明确问题或补齐缺失日期，不要原样重保存。`,
        ...unchangedReport.issues.slice(0, 4).map((value) => `[${value.level}] ${value.code}: ${value.message}`), `${file}（结构化数据）`, `${base}.md（可读版本）`, `${base}.quality.md（质量报告）`].join("\n");
    }
  }
  await mkdir(dirname(file), { recursive: true });
  ctx?.signal?.throwIfAborted();
  // JSON 是唯一业务提交点；其余文件由已验证版本导出，失败后核对并重建。
  await commit.commit(JSON.stringify(itinerary, null, 2), [
    { file: `${base}.md`, content: renderMarkdown(itinerary, report.budget) },
    { file: `${base}.quality.json`, content: JSON.stringify(report, null, 2) },
    { file: `${base}.quality.md`, content: renderQualityReport(report) },
  ]);
  ctx?.onItinerary?.({ itinerary, report, file });
  annotateToolCall({ opening_saved_ids: itinerary.days.flatMap((day) => day.items.flatMap((item) => item.opening_evidence_ids ?? [])) });

  const itemCount = itinerary.days.reduce((sum, day) => sum + day.items.length, 0);
  const savedLabel = merge && saved !== null
    ? `已保存「${title}」（合并保存 ${incoming.days.length} 天，共 ${itinerary.days.length} 天 / ${itemCount} 项）:`
    : `已保存「${title}」（${itinerary.days.length} 天 / ${itemCount} 项）:`;
  const targetDays = itinerary.constraints?.expected_days ?? expectedDaysFromTitle(title);
  const completedDays = itinerary.days.filter(materializedDay).length;
  const changedDates = [...new Set([...(saved?.days ?? []), ...itinerary.days].flatMap((day) => day.date ? [day.date] : []))].filter((date) => JSON.stringify(saved?.days.find((day) => day.date === date)) !== JSON.stringify(itinerary.days.find((day) => day.date === date)));
  return [
    savedLabel,
    ...(itinerary.planning_layers ? [planningLayerSummary(itinerary.planning_layers)] : []),
    ...(report.budget ? [budgetResultText(report.budget)] : []),
    ...(itinerary.required_visit_goals?.length ? ["必去目标: " + itinerary.required_visit_goals.map(requiredVisitGoalLabel).join("；")] : []),
    `版本: ${itinerary.itinerary_id}@${itinerary.revision}；可读交付以 ${base}.md 为准`,
    ...(routeSummary ? [routeSummary] : []),
    ...(itinerary.outline?.length ? [`粗排: ${itinerary.outline.length}天预留，实际有效安排${completedDays}天；骨架不计完成。`, "全局景点清单: " + visitAssignments(itinerary).map((v) => `${v.name}@${v.date}[${v.status === "saved" ? "已保存" : "预留"}]`).join("；")] : []),
    ...(changedDates.length ? [`本次变动日期: ${changedDates.join("、")}；仅补这些日期受影响的前后路段，其余安排保留。`] : []),
    ...(merge && args.merge_mode === "replace_day" ? [`显式整天替换：原条目 ${saved?.days.reduce((sum, day) => sum + day.items.length, 0) ?? 0}，现条目 ${itemCount}；未提交的当天条目已删除`] : []),
    `分日验收: ${(report.daily ?? []).filter((day) => report.changed_days?.includes(day.day)).map((day) => `D${day.day} ${day.strict_pass ? "日内通过" : day.status === "needs_confirmation" ? "资料待确认" : "待修改"}`).join("；") || "本次未改变日期内容"}`,
    ...(report.repair_days?.length ? [`局部修复日期: ${report.repair_days.join("、")}；跨天冲突优先改本次变动日期，不必重写其他已通过日期`] : []),
    ...(report.recommendation_policy === undefined ? [] : [`餐饮策略: ${formatRecommendationPolicy(report.recommendation_policy)}`]),
    `质量: ${report.score} / 100（P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1} / P2 ${report.issue_count.P2}）`,
    ...(targetDays === undefined || targetDays === completedDays
      ? []
      : [`完整性: ${completedDays}/${targetDays} 天，尚未完成，不能按完整行程交付`]),
    `strict: ${report.issue_count.P0 === 0 && report.issue_count.P1 === 0 ? "通过" : "未通过"}（整体验收，包含跨天重复和缺失日期；分日通过不代表整体已完成）`,
    ...(routeRepairDate ? [`路线下一步: 优先save_itinerary(${JSON.stringify({ title, repair_routes: [routeRepairDate] })})复用已查证据；修复返回缺少真实证据时才查询对应路段。`] : []),
    ...report.issues.slice().sort((a, b) => a.level.localeCompare(b.level)).slice(0, 6).map((issue) =>
      `[${issue.level}]${issue.day === undefined ? "" : ` Day ${issue.day}`}${issue.item_id === undefined ? "" : ` ${issue.item_id}`} ${issue.code}: ${issue.message}`),
    ...(report.issues.length > 6 ? [`其余 ${report.issues.length - 6} 项见质量报告；同一版本无需重复调用 validate_itinerary`] : []),
    ...(report.meal_notes.length > 0 ? [`餐饮建议 ${report.meal_notes.length} 条（仅供参考，不影响评分）`] : []),
    `${file}（结构化数据）`,
    `${base}.md（可读版本）`,
    `${base}.quality.md（质量报告）`,
  ].join("\n");
}

export async function updateSavedItinerary(
  rootDir: string, title: string, edit: (plan: Record<string, unknown>) => Promise<void>, ctx?: ToolContext,
): Promise<ItinerarySnapshot> {
  const file = itineraryFile(rootDir, title);
  let snapshot: ItinerarySnapshot | undefined;
  await runManagedOperation({ root: rootDir, file, tool: "update_itinerary", request: ctx?.operationRequest ?? { title }, ...ctx,
    onReplay: async () => { const plan = await readSaved(file); if (plan) { snapshot = { itinerary: plan, report: validateItinerary(plan), file }; ctx?.onItinerary?.(snapshot); } },
  }, async (commit) => {
    const saved = await readSaved(file);
    if (saved === null) throw new Error(`未找到行程「${title}」`);
    const plan = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
    await edit(plan);
    // 当前预算来源由保存核心处理，编辑全文不构成新的显式预算覆盖。
    delete plan.budget_per_person_yuan;
    return saveItineraryUnlocked(rootDir, { ...plan, title, merge: false }, { workspace: rootDir, ...ctx, onItinerary: (value) => { snapshot = value; ctx?.onItinerary?.(value); } }, commit);
  });
  return snapshot!;
}

/**
 * 合并保存：按日期、稳定条目 ID 更新；只有 replace_day 才删除当天未提交条目。
 * 供条目多时按天分批保存，避免单次工具调用输出超出模型上限。
 */
async function readSaved(file: string): Promise<Itinerary | null> {
  try {
    return parseItinerary(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error; // Corrupted existing plans must never be silently replaced.
  }
}

function hydrateItemPatches(args: Record<string, unknown>, saved: Itinerary): Record<string, unknown> {
  if (!Array.isArray(args.days)) return args;
  const incomingDays = args.days;
  return { ...args, days: incomingDays.map((day) => {
    if (!day || typeof day !== "object" || !Array.isArray(day.items)) return day;
    const before = saved.days[incomingDayIndex(saved.days, day, incomingDays.length === 1)];
    return { ...day, items: day.items.map((item: Record<string, unknown>) => {
      if (!item || typeof item !== "object" || typeof item.id !== "string") return item;
      const old = before?.items.find((entry) => entry.id === item.id);
      if (!old && (item.name === undefined || item.type === undefined)) throw new Error(`参数中的条目ID「${item.id}」在日期「${String(day.date ?? "未指定")}」不存在，不能作为局部补丁；当前可用ID：${before?.items.slice(0, 12).map((entry) => `${entry.id}(${entry.name.slice(0, 32)})`).join("、") || "该日期尚未保存"}。新增条目需要完整name/type，不要猜测ID或重读整天。`);
      if (!old || (item.name !== undefined && item.name !== old.name) || (item.type !== undefined && item.type !== old.type)) return item;
      const merged: Record<string, unknown> = { ...old, ...item };
      if (old.type === "transport" && item.route_evidence_id !== undefined && item.route_evidence_id !== old.route_evidence_id) {
        // 新选择的路线ID拥有自己的事实；旧副本不应变成用户显式填写的冲突。
        // 既有方式代表计划意图，切换到驾车等方式须显式填写，不能仅换ID就悄悄改变。
        for (const key of ["from", "to", "distance_km", "route_duration_min", "route_binding_error"]) if (!(key in item)) delete merged[key];
      }
      return merged;
    }) };
  }) };
}

function stableIncrementalIds(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.days)) return args;
  return { ...args, days: args.days.map((day, dayIndex) => ({
    ...day,
    items: Array.isArray(day.items) ? day.items.map((item: Record<string, unknown>) => ({
      ...item,
      id: item.id ?? `item-${evidenceId([day.date ?? `undated-${dayIndex}`, item.type, item.subtype, itineraryItemName(item), item.time, item.activity])}`,
    })) : day.items,
  })) };
}

/** 未定日期旧行程可按唯一ID定位；已有真实日期时仍要求date，不猜多日位置。 */
function incomingDayIndex(days: readonly ItineraryDay[], day: { date?: unknown; items: readonly unknown[] }, single: boolean): number {
  if (day.date !== undefined) return days.findIndex((entry) => entry.date === day.date);
  const ids = new Set(day.items.flatMap((item) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : []));
  const matches = days.flatMap((entry, index) => entry.date === undefined && entry.items.some((item) => ids.has(item.id)) ? [index] : []);
  if (matches.length > 1) throw new Error("未指定日期的条目ID命中多天，请提供date后再增量保存");
  return matches[0] ?? (days.length === 1 && single && days[0].date === undefined ? 0 : -1);
}

function mergeSavedItinerary(saved: Itinerary | null, incoming: Itinerary, replaceDay: boolean): Itinerary {
  if (saved === null) return incoming;
  const days = [...saved.days];
  for (const day of incoming.days) {
    const index = incomingDayIndex(days, day, incoming.days.length === 1);
    if (day.date === undefined && index < 0) throw new Error("多日增量保存需要date；未定日期旧行程须使用唯一条目ID，不要用不完整的整份行程覆盖");
    if (index >= 0) {
      const items = [...days[index].items];
      for (const item of day.items) {
        const found = items.findIndex((old) => old.id === item.id || (old.name === item.name && old.type === item.type && old.time === item.time && old.subtype === item.subtype && old.activity === item.activity));
        if (found < 0) items.push(item);
        else items[found] = { ...item, id: items[found].id };
      }
      days[index] = replaceDay ? day : { ...days[index], ...day, items: items.sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99")) };
    }
    else days.push(day);
  }
  return parseItinerary({ ...saved, ...incoming, days: days.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")) });
}

export function createLoadItineraryTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "load_itinerary",
    alwaysActive: "travel",
    description:
      "读取已保存的行程。默认返回覆盖全部需求日期的概览；用date/day+summary=true看条目目录，用date/day+item_ids取完整字段。" +
      "修订已知条目时用day+item_ids只读取这些条目，避免整日JSON和归档分页。先检查已读索引；修改其他日期不会使本日已读内容失效。上下文丢失时可对小范围reread=true一次。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
        summary: {
          type: "boolean",
          description: "无日期时默认全局概览；有日期时true返回条目目录、默认返回完整单日字段。false且无日期时显式读整份JSON（不推荐）",
        },
        day: {
          type: "number",
          description: "从 1 开始的单日序号；只返回这一天的完整 JSON，可与 summary 同时使用",
        },
        date: { type: "string", description: "按YYYY-MM-DD精确定位已保存日期；粗排日期与已保存序号不一致时优先用date，可配item_ids" },
        item_ids: { type: "array", maxItems: 20, items: { type: "string" }, description: "需同时指定day，只取稳定条目ID对应的完整字段；局部修改优先使用，最多20项" },
        reread: { type: "boolean", description: "已读内容离开上下文且确需字段时，对该范围重读一次；常规读取不填" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      const title = requireString(args, "title");
      if (args.reread !== undefined && typeof args.reread !== "boolean") throw new Error("reread 必须为布尔值");
      if (args.summary !== undefined && typeof args.summary !== "boolean") throw new Error("summary必须为布尔值");
      let day = args.day === undefined ? undefined : Math.floor(args.day as number);
      if (
        day !== undefined &&
        (!Number.isFinite(day) || day < 1)
      ) {
        throw new Error("day 必须是大于等于 1 的整数");
      }
      if (args.date !== undefined && (typeof args.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.date))) throw new Error("date 需要YYYY-MM-DD");
      if (args.item_ids !== undefined && ((day === undefined && args.date === undefined) || !Array.isArray(args.item_ids) || args.item_ids.length === 0 || args.item_ids.length > 20 || args.item_ids.some((id) => typeof id !== "string" || id.trim() === ""))) throw new Error("item_ids 需要day/date和1—20个有效条目ID");
      try {
        const { itinerary, report } = await inspectSavedItinerary(rootDir, parseItinerary(JSON.parse(await readFile(itineraryFile(rootDir, title), "utf8"))));
        ctx?.onItinerary?.({ itinerary, report, file: itineraryFile(rootDir, title) });
        if (args.date !== undefined) {
          const index = itinerary.days.findIndex((entry) => entry.date === args.date);
          if (index < 0) return `日期${args.date}尚未保存实际行程；粗排不等于已完成，请直接按此日期save_itinerary补齐，不要重复读取。`;
          if (day !== undefined && day !== index + 1) throw new Error("day和date指向不同日期，请只使用date");
          day = index + 1;
        }
        if (day !== undefined && day > itinerary.days.length) {
          return `行程「${title}」只有 ${itinerary.days.length} 天，不存在 Day ${day}。`;
        }
        const ids = args.item_ids === undefined ? undefined : [...new Set(args.item_ids as string[])].sort();
        const selectedDay = day === undefined ? undefined : itinerary.days[day - 1];
        if (ids?.some((id) => !selectedDay!.items.some((item) => item.id === id))) throw new Error("item_ids 包含当天不存在的条目，请沿用当前摘要中的稳定ID");
        const overview = selectedDay === undefined && args.summary !== false;
        const view = overview ? "overview" : selectedDay === undefined ? "full" : args.summary === true ? "directory" : ids ? "items" : "day";
        const selected = selectedDay === undefined ? itinerary : { title: itinerary.title, days: [{ ...selectedDay, ...(ids ? { items: selectedDay.items.filter((item) => ids.includes(item.id)) } : {}) }] };
        const summaryPlan = selectedDay === undefined ? itinerary : { ...itinerary, days: itinerary.days.map((entry, index) => index === day! - 1 ? selected.days[0] : entry) };
        const output = overview ? renderItineraryOverview(itinerary, report) ?? renderItineraryOverview(itinerary, report, Infinity)!
          : args.summary === true ? "【行程条目目录】\n" + renderItinerarySummary(summaryPlan, day)
          : JSON.stringify({ ...selected, view, ...(day === undefined ? {} : { selected_day: day }) }, null, 2);
        // 单日/条目签名不含其他日期和全局revision，防止无关修改导致正文反复返回。
        const version = evidenceId({ view: overview || args.summary === true ? output : selected, constraints: itinerary.constraints, travelers: itinerary.travelers });
        const resource = JSON.stringify([itineraryFile(rootDir, title), selectedDay?.date ?? day, view, ids]);
        if (trackRead(ctx, { resource, version, kind: "itinerary", total: 1, label: `「${title}」${day === undefined ? "全程" : `D${day}`}${ids ? `条目${ids.join(",")}` : overview ? "概览" : args.summary === true ? "目录" : "正文"}`, hint: "沿用已知ID增量保存；缺字段时只取day+item_ids" }, [[0, 1]], args.reread === true)) return readWasDeferred(ctx, resource)
          ? overview ? "全局概览上次未完整进入上下文；请单独用load_itinerary(title,reread=true)重读一次，不能依据片段推断全程。"
            : `该范围上次未完整进入上下文，重复整日/全程加载会再次被压缩。请用load_itinerary(day,item_ids)只取所需条目，或按归档已读游标续读；不要原样重试。`
          : `行程「${title}」的该范围已读取，内容及需求约束未变化；沿用已有正文，直接按ID增量修订。确需丢失字段时只用day+item_ids指定条目，可reread=true重读一次。`;
        return output;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return `未找到行程「${title}」。可用 list_itineraries 查看已保存的行程。`;
      }
    },
  };
}

function renderItinerarySummary(itinerary: Itinerary, selectedDay?: number): string {
  const selected = selectedDay === undefined
    ? itinerary.days
    : [itinerary.days[selectedDay - 1]];
  const itemCount = selected.reduce((sum, day) => sum + day.items.length, 0);
  const lines = [
    `${itinerary.title}（${selectedDay === undefined ? `${itinerary.days.length} 天` : `Day ${selectedDay}`} / ${itemCount} 项）`,
    "读取单日完整数据：load_itinerary({ title, day: N })；修改后只保存受影响的日期。",
  ];
  if (selectedDay === undefined && itinerary.outline?.length) lines.push("全局粗排（预留不计完成）：" + itinerary.outline.map((day, index) => `${day.date} ${outlineDayLabel(itinerary, day, index)}`).join("；"));
  for (const [offset, itineraryDay] of selected.entries()) {
    const dayNumber = selectedDay ?? offset + 1;
    const header = [`Day ${dayNumber}`];
    if (itineraryDay.theme !== undefined) header.push(itineraryDay.theme);
    if (itineraryDay.date !== undefined) header.push(itineraryDay.date);
    lines.push("", header.join(" · "));
    for (const item of itineraryDay.items) {
      const type = item.place_type === undefined ? item.type : `${item.type}/${item.place_type}`;
      const coordinate = item.location?.latitude !== undefined && item.location.longitude !== undefined
        ? ` | ${item.location.latitude},${item.location.longitude}`
        : "";
      lines.push(
        `- ${item.time ?? "--:--"} [${type}] ${item.name}${item.activity ? `（${item.activity}）` : ""}` +
        ` | id=${item.id}${coordinate}${item.recommended_spots?.length ? ` | 内部推荐 ${item.recommended_spots.join("、")}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function createValidateItineraryTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "validate_itinerary",
    alwaysActive: "travel",
    description:
      "核验已保存的行程：时间顺序与重叠、时间线空档、赶路时间、游玩时长、过长交通、当日总时长、景点路线折返、跨天重复、闭馆、预算、数据置信度。" +
      "继承已保存的预算、日期和餐饮策略，与 live 评测共用规则；" +
      "默认餐饮问题仅作建议。scope=day 只验收指定日并展示跨天关联，交付前 scope=all 做整体验收；strict=true 拦截对应范围的 P0/P1。保存本身已校验，不必对同一版本重复调用。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
        scope: { type: "string", enum: ["all", "day"], description: "默认all；day须传day，日内验收不代替整体验收" },
        day: { type: "integer", description: "分日验收日期下标，从1开始" },
        strict: { type: "boolean", description: "默认 false；true 时 P0/P1 问题会失败；餐饮仅在显式 strict 策略下参与" },
        budget_per_person_yuan: { type: "number", description: "人均总预算（元），可选" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      const title = requireString(args, "title");
      return withPlanLock(itineraryFile(rootDir, title), async () => {
        ctx?.signal?.throwIfAborted();
        let raw: string;
        try {
          raw = await readFile(itineraryFile(rootDir, title), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return `未找到行程「${title}」。可用 list_itineraries 查看已保存的行程。`;
        }

        const budget = optionalNonNegativeNumber(args.budget_per_person_yuan, "budget_per_person_yuan");
        const { itinerary, report } = await inspectSavedItinerary(rootDir, parseItinerary(JSON.parse(raw)), budget === undefined ? {} : { budget_per_person_yuan: budget });
        if (args.scope !== undefined && args.scope !== "all" && args.scope !== "day") throw new Error("scope 必须为 all 或 day");
        const dayNo = args.day;
        if (args.scope === "day" && (typeof dayNo !== "number" || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > itinerary.days.length)) throw new Error("分日验收须指定有效 day");
        ctx?.onItinerary?.({ itinerary, report, file: itineraryFile(rootDir, title) });
        await atomicWrite(itineraryFile(rootDir, title).replace(/\.json$/, ".quality.json"), JSON.stringify(report, null, 2));
        await atomicWrite(itineraryFile(rootDir, title).replace(/\.json$/, ".quality.md"), renderQualityReport(report));
        const dayReport = args.scope === "day" ? report.daily?.find((day) => day.day === dayNo) : undefined;
        const pass = dayReport === undefined ? report.issue_count.P0 === 0 && report.issue_count.P1 === 0 : dayReport.strict_pass;
        const text = dayReport === undefined ? renderQualityReport(report) : [
          `Day ${dayNo} 日内验收：${pass ? "通过" : "未通过"}，${dayReport.score}分。`,
          ...dayReport.issues.map((item) => `[${item.level}] ${item.code}: ${item.message}`),
          ...report.issues.filter((item) => item.related_days?.includes(Number(dayNo)) && item.day !== dayNo).map((item) => `跨天关联：${item.message}`),
          `整体仍有 P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1}；最终需 scope=all，不能以分日验收替代。`,
        ].join("\n");
        if (args.strict === true && !pass) throw new Error(`行程质量校验未通过（strict）:\n${text}`);
        return text;
      }, ctx?.signal);
    },
  };
}

export function createListItinerariesTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "list_itineraries",
    description: "列出已保存的结构化行程单（标题、天数、条目数、质量摘要）。",
    parameters: { type: "object", properties: {} },
    async execute() {
      let names: string[];
      try {
        names = await readdir(join(rootDir, "plans"));
      } catch {
        return "还没有已保存的行程。";
      }

      const lines: string[] = [];
      for (const name of names.filter((item) => item.endsWith(".json") && !item.endsWith(".quality.json")).sort()) {
        try {
          const itinerary = parseItinerary(JSON.parse(await readFile(join(rootDir, "plans", name), "utf8")));
          const itemCount = itinerary.days.reduce((sum, day) => sum + day.items.length, 0);
          lines.push(`- ${itinerary.title}（${itinerary.days.length} 天 / ${itemCount} 项）plans/${name}`);
        } catch {
          // 跳过损坏或非行程的 JSON
        }
      }
      return lines.length > 0 ? `已保存的行程:\n${lines.join("\n")}` : "还没有已保存的行程。";
    },
  };
}

function outlineDayLabel(itinerary: Itinerary, day: NonNullable<Itinerary["outline"]>[number], index: number): string {
  return day.visits.map((visit) => visit.name).join("、") ||
    (itineraryDayRole(itinerary, itinerary.days.find((actual) => actual.date === day.date) ?? day, index) === "departure" ? "仅安排返程" : "待重新分配");
}

export function renderMarkdown(itinerary: Itinerary, budget?: import("./trip-budget.ts").TripBudgetReport): string {
  const lines = [`# ${itinerary.title}`, "", `费用口径：${itinerary.travelers ?? DEFAULT_TRAVELERS} 人，${itinerary.room_count ?? Math.ceil((itinerary.travelers ?? DEFAULT_TRAVELERS) / 2)} 间房；住宿按每房每晚计价，默认每间最多 2 人，末日不计住宿。`, ""];
  if (budget) lines.push(budgetResultText(budget), "");
  if (itinerary.planning_layers) lines.push(planningLayerSummary(itinerary.planning_layers), "", "基础安排与资料核验不是已完成的详细时间行程；待确认项见质量报告。", "");
  if (itinerary.required_visit_goals?.length) lines.push("## 必去目标", "", ...itinerary.required_visit_goals.map((goal) => `- ${requiredVisitGoalLabel(goal)}`), "", "地点核验仅指身份及包含关系；开放、预约、路线问题见质量报告。", "");
  if (itinerary.outline?.length) lines.push("## 全局粗排（预留不计完成）", "", ...itinerary.outline.map((day, index) => `- ${day.date}：${outlineDayLabel(itinerary, day, index)}`), "");
  if (itinerary.excluded_visits?.length) lines.push("本次明确排除：" + itinerary.excluded_visits.map((v) => `${v.name}（${v.reason}）`).join("；"), "");
  itinerary.days.forEach((day, index) => {
    const header = [`Day ${index + 1}`];
    if (itineraryDayRole(itinerary, day, index) === "departure") header.push("返程");
    if (day.theme !== undefined) header.push(day.theme);
    if (day.date !== undefined) header.push(`(${day.date})`);
    lines.push(`## ${header.join(" · ")}`, "");
    for (const item of day.items) {
      const parts = [item.time ?? "--:--", itemLabel(item), item.activity ? `${item.activity} · ${item.name}` : item.name];
      lines.push(`- ${parts.join(" · ")}${item.note !== undefined ? ` — ${item.note}` : ""}`);
      const details = itemDetails(item);
      if (details !== "") lines.push(`  - ${details}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function itemLabel(item: ItineraryItem): string {
  if (item.type === "visit") return "景点";
  if (item.type === "meal") return item.subtype === "breakfast" ? "早餐" : item.subtype === "lunch" ? "午餐" : item.subtype === "dinner" ? "晚餐" : "餐饮";
  if (item.type === "transport") return "交通";
  if (item.type === "rest") return "休息";
  if (item.type === "free_time") return "自由活动";
  if (item.type === "accommodation") return "住宿";
  return "备注";
}

function itemDetails(item: ItineraryItem): string {
  const details = [
    item.recommended_spots?.length ? `内部推荐 ${item.recommended_spots.join("、")}` : undefined,
    item.parent_visit ? `所属主景区 ${item.parent_visit.name}` : undefined,
    item.area_group ? `所属区域 ${item.area_group.name}` : undefined,
    item.opening_hours ? `开放 ${(item.opening_hours.intervals ?? [item.opening_hours]).map((r) => r.opens === "00:00" && r.closes === "24:00" ? "全天" : `${r.opens}-${r.closes}`).join("、")}${item.opening_hours.last_admission ? `，最后入场${item.opening_hours.last_admission}` : ""}` : undefined,
    item.opening_sessions?.length ? `表演场次 ${item.opening_sessions.map((s) => s.ends ? `${s.starts}-${s.ends}` : s.starts).join("、")}` : undefined,
    item.closed_dates?.length ? `公告闭馆日期 ${item.closed_dates.join("、")}` : undefined,
    item.place_type !== undefined ? `类型 ${item.place_type}` : undefined,
    item.end_time !== undefined ? `结束 ${item.end_time}` : undefined,
    item.planned_duration_min !== undefined ? `计划 ${item.planned_duration_min} 分钟` : undefined,
    item.transport_mode !== undefined ? `方式 ${item.transport_mode}` : undefined,
    item.room_price_per_night !== undefined ? `每房每晚 ¥${item.room_price_per_night}${item.stay_nights === undefined ? "" : ` / ${item.stay_nights} 晚`}` : undefined,
    item.cost_per_person !== undefined ? `人均 ¥${item.cost_per_person}` : undefined,
    item.ticket_price_per_person !== undefined ? `门票 ¥${item.ticket_price_per_person}` : undefined,
    item.source !== undefined ? `来源 ${item.source}` : undefined,
    item.evidence_observed_at === undefined ? undefined : `采集于 ${new Date(item.evidence_observed_at).toISOString()}`,
    item.confidence !== undefined ? `置信度 ${item.confidence}` : undefined,
  ].filter((detail): detail is string => detail !== undefined);
  return details.join(" / ");
}

function optionalNonNegativeNumber(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${field} 需要非负数字`);
  }
  return raw;
}

function itineraryFile(rootDir: string, title: string): string {
  return planFileFor(rootDir, "plans", title, "json");
}
