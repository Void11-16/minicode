import { formatRecommendationPolicy } from "./recommendation-policy.ts";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import type { Tool, ToolContext, ItinerarySnapshot } from "./tool.ts";
import { requireString } from "./tool.ts";
import { TravelEvidenceStore, evidenceId } from "./travel-evidence.ts";
import { DEFAULT_TRAVELERS, loadBriefForTitle } from "./brief.ts";
import { atomicWrite, commitPlanFiles, planFileFor, withPlanLock } from "./plan-files.ts";
export { planFileFor } from "./plan-files.ts";
import {
  parseItinerary,
  ITINERARY_ITEM_TYPES,
  type Itinerary,
  type ItineraryItem,
} from "./itinerary-schema.ts";
import {
  expectedDaysFromTitle,
  renderQualityReport,
  validateItinerary,
} from "./itinerary-validator.ts";

/**
 * 结构化行程单：JSON 持久化 + 可读 Markdown + 质量报告。
 * 修改行程时模型先 load → 只改受影响条目 → save，
 * 不需要重新生成整份行程（增量修改工作流）。
 */
export function createSaveItineraryTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "save_itinerary",
    alwaysActive: "travel",
    description:
      "保存行程 JSON、Markdown 和质量报告，返回版本及主要问题。P0 拒绝保存；strict=true 同时拒绝 P1。" +
      "分天保存用 merge=true，按日期和稳定 id 更新、保留未提交条目；merge_mode=replace_day 才删除当天未提交项。" +
      "地点/路线引用 evidence_id/route_evidence_id，程序回填核验数据。保存后按返回问题修订，无需立即重复校验；完整行程最终调用 validate_itinerary(strict=true)。",
    parameters: {
      type: "object",
      properties: {
        recommendation_policy: { type: "object", description: "餐饮默认只建议，目标2家/餐；strict 才阻断整体验收，off 不检查推荐质量。设置后随行程保存。", properties: {
          mode: { type: "string", enum: ["advisory", "strict", "off"] }, min_candidates: { type: "integer", minimum: 1, maximum: 20 }, min_evidence_rate: { type: "number", minimum: 0, maximum: 1 },
        } },
        expected_revision: { type: "integer", description: "可选，提交前读取的版本号；不匹配时拒绝覆盖" },
        travelers: { type: "integer", description: "出行人数，缺省 2 人" },
        room_count: { type: "integer", description: "住宿房间数，缺省按每间 2 人估算" },
        title: { type: "string", description: "与需求单一致的标题" },
        strict: { type: "boolean", description: "默认 false；true 时 P0/P1 问题都会拒绝保存" },
        merge: {
          type: "boolean",
          description:
            "false 整体覆盖；true 按日期/id 更新，未匹配日期追加",
        },
        merge_mode: { type: "string", enum: ["patch_items", "replace_day"], description: "merge=true 时默认 patch_items；replace_day 明确删除当天未提交的条目" },
        budget_per_person_yuan: { type: "number", description: "人均总预算（元），可选；用于质量核验" },
        days: {
          type: "array",
          description: "按天组织的行程",
          items: {
            type: "object",
            properties: {
              day_type: { type: "string", enum: ["full", "arrival", "departure", "transfer"], description: "默认full；按已知到离时间或转场安排填写，不能为绕过校验随意降级" },
              available_start: { type: "string", description: "当天已知可用开始 HH:MM" },
              available_end: { type: "string", description: "当天已知可用结束 HH:MM" },
              date: { type: "string", description: "日期 YYYY-MM-DD" },
              theme: { type: "string", description: "当天主题" },
              items: {
                type: "array",
                description: "当天时间线（按时间排序）",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "稳定条目 ID；省略则生成" },
                    evidence_id: { type: "string", description: "搜索证据 ID，自动回填地点数据" },
                    route_evidence_id: { type: "string", description: "路线证据 ID，配合 from/to/transport_mode" },
                    time: { type: "string", description: "开始 HH:MM" },
                    end_time: { type: "string", description: "结束时间 HH:MM，必须晚于 time" },
                    type: {
                      type: "string",
                      enum: [...ITINERARY_ITEM_TYPES],
                      description: "条目类型",
                    },
                    subtype: {
                      type: "string",
                      enum: ["breakfast", "lunch", "dinner", "snack"],
                      description: "meal 的餐段",
                    },
                    place_type: {
                      type: "string",
                      description:
                        "visit 用搜索返回类型；meal 可用菜系",
                    },
                    name: { type: "string", description: "地点或事项名" },
                    location: {
                      type: "object",
                      description: "结构化位置，用于空间核验",
                      properties: {
                        name: { type: "string" },
                        address: { type: "string" },
                        latitude: { type: "number" },
                        longitude: { type: "number" },
                        crs: { type: "string", enum: ["gcj02", "wgs84"], description: "坐标系；高德 gcj02，OSM wgs84" },
                        source: { type: "string" },
                      },
                    },
                    planned_duration_min: { type: "number", description: "计划停留或耗时（分钟），正数" },
                    transport_mode: {
                      type: "string",
                      enum: ["walking", "transit", "driving", "cycling", "taxi"],
                      description: "transport 条目的交通方式",
                    },
                    from: { type: "string", description: "transport 起点" },
                    to: { type: "string", description: "transport 终点" },
                    distance_km: { type: "number", description: "transport 距离（公里），正数" },
                    room_price_per_night: { type: "number", description: "住宿每房每晚参考价（元），不要填写为人均价格" },
                    room_count: { type: "integer", description: "本次住宿订房数，默认使用行程房间数" },
                    stay_nights: { type: "integer", description: "晚数：0 不收费；默认末日 0、其余 1，同日同酒店去重" },
                    cost_per_person: { type: "number", description: "人均消费（元），非负数" },
                    ticket_price_per_person: { type: "number", description: "人均门票（元），非负数" },
                    opening_hours: {
                      type: "object",
                      description: "营业/开放时间，用于核验条目开始时间",
                      properties: {
                        intervals: { type: "array", items: { type: "object", properties: { opens: { type: "string" }, closes: { type: "string" } }, required: ["opens", "closes"] }, description: "分段开放时间；停留必须完整落在同一段内" },
                        opens: { type: "string", description: "开放时间 HH:MM" },
                        last_admission: { type: "string", description: "最后入场时间 HH:MM，有官方依据时填写" },
                        closes: { type: "string", description: "关闭时间 HH:MM" },
                        source: { type: "string" },
                      },
                      required: ["opens", "closes"],
                    },
                    closed_on: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
                      },
                      description: "闭馆/闭店星期，可选",
                    },
                    reservation_required: { type: "boolean", description: "是否需要预约" },
                    cuisine: { type: "string", description: "餐厅菜系" },
                    source: { type: "string", description: "数据来源" },
                    confidence: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                      description: "数据置信度",
                    },
                    note: { type: "string", description: "给用户看的补充说明" },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["items"],
          },
        },
      },
      required: ["title", "days"],
    },
    async execute(args, ctx) {
      const file = itineraryFile(rootDir, requireString(args, "title"));
      return withPlanLock(file, () => saveItineraryUnlocked(rootDir, args, ctx), ctx?.signal);
    },
  };
}

/** 调用者持有行程锁；Web 编辑与工具保存复用相同校验和提交逻辑。 */
async function saveItineraryUnlocked(rootDir: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const title = requireString(args, "title");
  // Incremental chunks must not all reuse the generated day-1-item-N IDs.
  const incoming = parseItinerary(args.merge === true ? stableIncrementalIds(args) : args);
  const merge = args.merge === true;
  const file = itineraryFile(rootDir, title);
  const saved = await readSaved(file);
  if (args.expected_revision !== undefined && args.expected_revision !== (saved?.revision ?? 0)) throw new Error("行程版本冲突，请重新读取后再提交");
  const merged = merge ? mergeSavedItinerary(saved, incoming, args.merge_mode === "replace_day") : incoming;
  const brief = await loadBriefForTitle(rootDir, title) ?? (ctx?.brief?.title === title ? ctx.brief : undefined);
  const travelers = brief === undefined ? incoming.travelers ?? saved?.travelers ?? DEFAULT_TRAVELERS : brief.travelers ?? DEFAULT_TRAVELERS;
  const rooms = brief?.roomCount ?? incoming.room_count ?? saved?.room_count;
  const explicit = optionalNonNegativeNumber(args.budget_per_person_yuan, "budget_per_person_yuan");
  const briefBudget = brief?.budgetTotalYuan === undefined ? undefined : brief.budgetTotalYuan / travelers;
  const budgetSource = explicit !== undefined && args.budget_source !== "brief" ? "explicit"
    : saved?.budget_source === "explicit" || (saved?.budget_source === undefined && saved?.budget_per_person_yuan !== undefined) ? "explicit"
    : briefBudget !== undefined ? "brief" : saved?.budget_source;
  const budget = budgetSource === "explicit" ? explicit ?? saved?.budget_per_person_yuan : brief === undefined ? saved?.budget_per_person_yuan : briefBudget;
  const evidence = ctx?.evidence ?? new TravelEvidenceStore(rootDir);
  await evidence.load();
  await evidence.refresh();
  const policy = args.recommendation_policy;
  if (policy !== undefined && (policy === null || typeof policy !== "object" || Array.isArray(policy))) throw new Error("recommendation_policy 必须为对象");
  const recommendation = policy as { mode?: unknown; min_candidates?: unknown; min_evidence_rate?: unknown } | undefined;
  const constraints = { ...incoming.constraints, ...saved?.constraints,
    ...(brief === undefined ? {} : {
      destination: brief.destination, start_date: brief.startDate, end_date: brief.endDate,
      expected_days: brief.startDate !== undefined && brief.endDate !== undefined
        ? Math.round((Date.parse(brief.endDate) - Date.parse(brief.startDate)) / 86400000) + 1
        : expectedDaysFromTitle(title),
      day_start: "10:00", day_end: "18:00", require_accommodation: true,
      require_routes: true, require_place_evidence: true, recommendations: true,
    }),
    ...(recommendation?.mode === undefined ? {} : { recommendation_mode: recommendation.mode }),
    ...(recommendation?.min_candidates === undefined ? {} : { meal_candidates_target: recommendation.min_candidates }),
    ...(recommendation?.min_evidence_rate === undefined ? {} : { meal_evidence_target: recommendation.min_evidence_rate }),
  };
  const itinerary: Itinerary = parseItinerary({ ...merged,
    itinerary_id: saved?.itinerary_id ?? evidenceId([resolve(rootDir), title]),
    revision: (saved?.revision ?? 0) + 1,
    travelers, ...(rooms === undefined ? {} : { room_count: rooms }),
    ...(budgetSource === undefined ? {} : { budget_source: budgetSource }),
    budget_per_person_yuan: budget,
    ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
    days: merged.days.map((day) => ({ ...day, items: day.items.map((item) => {
      const untrusted = { ...item, evidence_verified: false, closure_verified: false, route_verified: false, route_duration_min: undefined };
      return evidence.bind(untrusted, constraints.destination);
    }) })),
  });
  const strict = args.strict === true;
  const changedDays = itinerary.days.flatMap((day, index) => {
    const before = day.date === undefined ? saved?.days[index] : saved?.days.find((old) => old.date === day.date);
    return JSON.stringify(before) === JSON.stringify(day) ? [] : [index + 1];
  });
  const constraintChange = JSON.stringify(saved?.constraints) !== JSON.stringify(itinerary.constraints);
  const report = validateItinerary(itinerary, { ...(budget === undefined ? {} : { budget_per_person_yuan: budget }), changed_days: constraintChange ? itinerary.days.map((_, index) => index + 1) : changedDays });
  if (report.issue_count.P0 > 0 || (strict && report.issue_count.P1 > 0)) {
    throw new Error(`行程质量校验未通过:\n${renderQualityReport(report)}`);
  }

  const base = file.slice(0, -5);
  await mkdir(dirname(file), { recursive: true });
  ctx?.signal?.throwIfAborted();
  await commitPlanFiles([
    [`${base}.md`, renderMarkdown(itinerary)],
    [`${base}.quality.json`, JSON.stringify(report, null, 2)],
    [`${base}.quality.md`, renderQualityReport(report)],
    [file, JSON.stringify(itinerary, null, 2)],
  ]);
  ctx?.onItinerary?.({ itinerary, report, file });

  const itemCount = itinerary.days.reduce((sum, day) => sum + day.items.length, 0);
  const savedLabel = merge
    ? `已保存「${title}」（合并保存 ${incoming.days.length} 天，共 ${itinerary.days.length} 天 / ${itemCount} 项）:`
    : `已保存「${title}」（${itinerary.days.length} 天 / ${itemCount} 项）:`;
  const targetDays = expectedDaysFromTitle(title);
  return [
    savedLabel,
    `版本: ${itinerary.itinerary_id}@${itinerary.revision}；可读交付以 ${base}.md 为准`,
    ...(merge && args.merge_mode === "replace_day" ? [`显式整天替换：原条目 ${saved?.days.reduce((sum, day) => sum + day.items.length, 0) ?? 0}，现条目 ${itemCount}；未提交的当天条目已删除`] : []),
    `分日验收: ${(report.daily ?? []).filter((day) => report.changed_days?.includes(day.day)).map((day) => `D${day.day} ${day.strict_pass ? "日内通过" : day.status === "needs_confirmation" ? "资料待确认" : "待修改"}`).join("；") || "本次未改变日期内容"}`,
    ...(report.repair_days?.length ? [`局部修复日期: ${report.repair_days.join("、")}；跨天冲突优先改本次变动日期，不必重写其他已通过日期`] : []),
    ...(report.recommendation_policy === undefined ? [] : [`餐饮策略: ${formatRecommendationPolicy(report.recommendation_policy)}`]),
    `质量: ${report.score} / 100（P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1} / P2 ${report.issue_count.P2}）`,
    ...(targetDays === undefined || targetDays === itinerary.days.length
      ? []
      : [`完整性: ${itinerary.days.length}/${targetDays} 天，尚未完成，不能按完整行程交付`]),
    `strict: ${report.issue_count.P0 === 0 && report.issue_count.P1 === 0 ? "通过" : "未通过"}（整体验收，包含跨天重复和缺失日期；分日通过不代表整体已完成）`,
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
  return withPlanLock(file, async () => {
    const saved = await readSaved(file);
    if (saved === null) throw new Error(`未找到行程「${title}」`);
    const plan = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
    await edit(plan);
    // 当前预算来源由保存核心处理，编辑全文不构成新的显式预算覆盖。
    delete plan.budget_per_person_yuan;
    let snapshot: ItinerarySnapshot | undefined;
    await saveItineraryUnlocked(rootDir, { ...plan, title }, { workspace: rootDir, ...ctx, onItinerary: (value) => { snapshot = value; ctx?.onItinerary?.(value); } });
    return snapshot!;
  }, ctx?.signal);
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

function stableIncrementalIds(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.days)) return args;
  return { ...args, days: args.days.map((day) => ({ ...day, items: Array.isArray(day.items) ? day.items.map((item: Record<string, unknown>) => ({ ...item, id: item.id ?? `item-${evidenceId([day.date, item.type, item.name, item.time])}` })) : day.items })) };
}

function mergeSavedItinerary(saved: Itinerary | null, incoming: Itinerary, replaceDay: boolean): Itinerary {
  if (saved === null) return incoming;
  const days = [...saved.days];
  for (const day of incoming.days) {
    const index = day.date === undefined ? -1 : days.findIndex((savedDay) => savedDay.date === day.date);
    if (index >= 0) {
      const items = [...days[index].items];
      for (const item of day.items) {
        const found = items.findIndex((old) => old.id === item.id || (old.name === item.name && old.type === item.type && old.time === item.time));
        if (found < 0) items.push(item);
        else items[found] = item;
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
      "读取已保存的行程。先传 summary=true 查看各天/条目摘要；修改某天时再传 day=N 只读取那一天，" +
      "避免整份 JSON 重复进入上下文。用户要求修改行程时必须先读取当前版本，改完受影响的条目后保存。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
        summary: {
          type: "boolean",
          description: "只返回每天主题、条目 ID/时间/类型/名称/坐标摘要，不返回完整 JSON",
        },
        day: {
          type: "number",
          description: "从 1 开始的单日序号；只返回这一天的完整 JSON，可与 summary 同时使用",
        },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      const title = requireString(args, "title");
      const day = args.day === undefined ? undefined : Math.floor(args.day as number);
      if (
        day !== undefined &&
        (!Number.isFinite(day) || day < 1)
      ) {
        throw new Error("day 必须是大于等于 1 的整数");
      }
      try {
        const itinerary = parseItinerary(JSON.parse(await readFile(itineraryFile(rootDir, title), "utf8")));
        ctx?.onItinerary?.({ itinerary, report: validateItinerary(itinerary), file: itineraryFile(rootDir, title) });
        if (day !== undefined && day > itinerary.days.length) {
          return `行程「${title}」只有 ${itinerary.days.length} 天，不存在 Day ${day}。`;
        }
        if (args.summary === true) {
          return renderItinerarySummary(itinerary, day);
        }
        if (day !== undefined) {
          return JSON.stringify({ title: itinerary.title, days: [itinerary.days[day - 1]] }, null, 2);
        }
        return JSON.stringify(itinerary, null, 2);
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
  const itemCount = itinerary.days.reduce((sum, day) => sum + day.items.length, 0);
  const lines = [
    `${itinerary.title}（${itinerary.days.length} 天 / ${itemCount} 项）`,
    "读取单日完整数据：load_itinerary({ title, day: N })；修改后只保存受影响的日期。",
  ];
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
        `- ${item.time ?? "--:--"} [${type}] ${item.name}` +
        ` | id=${item.id}${coordinate}`,
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
        const itinerary = parseItinerary(JSON.parse(raw));
        if (args.scope !== undefined && args.scope !== "all" && args.scope !== "day") throw new Error("scope 必须为 all 或 day");
        const dayNo = args.day;
        if (args.scope === "day" && (typeof dayNo !== "number" || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > itinerary.days.length)) throw new Error("分日验收须指定有效 day");
        const report = validateItinerary(
          itinerary,
          budget === undefined ? {} : { budget_per_person_yuan: budget },
        );
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

export function renderMarkdown(itinerary: Itinerary): string {
  const lines = [`# ${itinerary.title}`, "", `费用口径：${itinerary.travelers ?? DEFAULT_TRAVELERS} 人，${itinerary.room_count ?? Math.ceil((itinerary.travelers ?? DEFAULT_TRAVELERS) / 2)} 间房；住宿按每房每晚计价，默认每间最多 2 人，末日不计住宿。`, ""];
  itinerary.days.forEach((day, index) => {
    const header = [`Day ${index + 1}`];
    if (day.theme !== undefined) header.push(day.theme);
    if (day.date !== undefined) header.push(`(${day.date})`);
    lines.push(`## ${header.join(" · ")}`, "");
    for (const item of day.items) {
      const parts = [item.time ?? "--:--", itemLabel(item), item.name];
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
