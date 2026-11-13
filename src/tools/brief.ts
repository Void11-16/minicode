import { createHash } from "node:crypto";
import { annotateToolCall } from "../core/tool-diagnostics.ts";
import { parseRequirements, validTravelDate, type TravelRequirements } from "./travel-requirements.ts";
import { ToolValidationError } from "../core/tool-error.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { planFileFor, withTripTitleLock } from "./plan-files.ts";
import { managedOperationTarget, runManagedOperation } from "../storage/managed-operation.ts";
import { loadProfile, mergeProfiles } from "./profiles.ts";
import { allocateTripBudget, BUDGET_OVERRUN, budgetPlanText } from "./trip-budget.ts";
import type { UserRequest } from "./repeat-visit-policy.ts";

export const DEFAULT_TRAVELERS = 2;

export interface TravelBrief {
  readonly durationDays?: number;
  readonly title: string;
  readonly requestedTitle?: string;
  readonly destination: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly travelers?: number;
  readonly roomCount?: number;
  readonly budgetTotalYuan?: number;
  readonly budgetPerMealYuan?: number;
  readonly budgetOverrunRatio?: number;
  readonly accommodation?: string;
  readonly requireAccommodation?: boolean;
  readonly returnLastDay?: boolean;
  readonly allowHotelChanges?: boolean;
  readonly pace?: string;
  readonly mustVisit?: readonly string[];
  readonly avoid?: readonly string[];
  readonly tastePreferences?: string;
  /** 同行人档案名字列表（与 profiles 合并后的约束见合并输出） */
  readonly travelerProfiles?: readonly string[];
  readonly notes?: string;
  readonly requirements?: TravelRequirements;
  readonly requirementVersion?: string;
  readonly travelerConstraints?: string;
  readonly missingTravelerProfiles?: readonly string[];
}

const clockSchema = { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" };
const timeWindowProperties = { start: clockSchema, end: clockSchema };
const requirementsSchema = {
  type: "object", additionalProperties: false,
  description: "用户明确的硬要求；软偏好保留在 avoid/pace/notes。每日上限按主景点计，day 从1开始。",
  properties: {
    dates: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 90 },
    forbidden_visits: { type: "array", items: { type: "string" }, minItems: 1 },
    max_visits_per_day: { type: "integer", minimum: 1 },
    daily_window: { type: "object", required: ["start", "end"], additionalProperties: false, properties: timeWindowProperties },
    day_windows: { type: "array", minItems: 1, items: {
      type: "object", required: ["day", "start", "end"], additionalProperties: false,
      properties: { ...timeWindowProperties, day: { type: "integer", minimum: 1, maximum: 90 } },
    } },
    travelers: { type: "integer", minimum: 1 },
    room_count: { type: "integer", minimum: 1 },
    fixed_stay: { type: "boolean" },
  },
};

/** 可填写的需求模板：用户复制填写后一次性粘贴，模型解析为结构化需求单 */
export const BRIEF_TEMPLATE = [
  "【旅行需求单】复制后填写，不确定的项留空即可（也可以直接发自由文本，我会自动解析）:",
  "",
  "目的地:（城市，如：杭州）",
  "出行日期:（如：2026-10-01 至 2026-10-03）",
  "人数:（如：2）",
  "总预算:（如：3000 元）",
  "单餐人均:（如：100 元）",
  "口味偏好:（如：不吃辣、想尝试本地特色）",
  "住宿偏好:（如：靠近西湖、500 元内）",
  "节奏:（慢 / 适中 / 紧凑）",
  "必去:（逗号分隔，如：灵隐寺、西湖）",
  "避开:（如：人多的网红店）",
  "其他:（带老人/孩子、摄影、亲子等）",
].join("\n");

/**
 * 旅行需求单：把用户的一次性输入（模板或自由文本）规格化为结构化数据，
 * 后续所有规划工具的参数都从这里取（region / max_cost / 天气天数 / avoid），
 * 避免逐项反复询问。
 */
export function createSaveTravelBriefTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "save_travel_brief",
    effect: "managed_write",
    operationRoot: rootDir,
    description:
      "保存旅行需求单（结构化）。用户提供需求文本（模板或自由描述）后，解析成此结构保存，" +
      "需求信息足够时只保存一次并立即进入规划，不等待用户二次确认；后续规划的所有工具参数从需求单取：" +
      "region/目的地=destination、餐厅 max_cost=budgetPerMealYuan、" +
      "天气=get_weather 按行程起止日期（start_date/end_date；超 16 天预报范围的部分拿不到）、" +
      "avoid_cuisines=avoid、口味=tastePreferences。用户补充/修改需求时更新保存。",
    parameters: {
      type: "object",
      properties: {
        durationDays: { type: "integer", minimum: 1, maximum: 90, description: "用户要求的旅行天数；日期未定也填写，不能凭局部粗排缩短总天数" },
        title: { type: "string", description: "行程标题，例如：杭州两日游" },
        destination: { type: "string", description: "目的地城市/区域，例如：杭州" },
        startDate: { type: "string", description: "开始日期 YYYY-MM-DD，可选" },
        endDate: { type: "string", description: "结束日期 YYYY-MM-DD，可选" },
        roomCount: { type: "integer", description: "住宿房间数；缺省按每间最多 2 人估算" },
        travelers: { type: "number", description: "出行人数，可选" },
        budgetTotalYuan: { type: "number", description: "总预算（元），可选" },
        budgetPerMealYuan: { type: "number", description: "单餐人均预算（元），可选" },
        budgetOverrunRatio: { type: "number", minimum: 0, maximum: BUDGET_OVERRUN, description: "总预算允许的超支比例，默认0.2；用户明确不可超支时填0。" },
        allowHotelChanges: { type: "boolean", description: "默认省略：同区域优先连住，后续行程转到另一片区域时可按通勤和行李安排换宿，不设固定距离门槛。仅用户明确要求全程不换酒店时填false；明确允许换宿时填true。" },
        accommodation: { type: "string", description: "住宿偏好描述，可选" },
        requireAccommodation: { type: "boolean", description: "用户明确不住宿/当天往返填 false；明确需要过夜填 true。省略时一日游不强制住宿，多日游检查住宿。" },
        returnLastDay: { type: "boolean", description: "多日游默认末日返程。仅用户明确末日留在当地继续游玩或另日返程时填false。" },
        pace: { type: "string", description: "行程节奏：慢 / 适中 / 紧凑，可选" },
        mustVisit: { type: "array", items: { type: "string" }, description: "必去地点列表，可选" },
        avoid: { type: "array", items: { type: "string" }, description: "要避开的地点/类型，可选" },
        tastePreferences: { type: "string", description: "本次出行口味偏好（优先于长期偏好），可选" },
        travelerProfiles: {
          type: "array",
          items: { type: "string" },
          description: "同行人档案名字列表（用户在页面勾选或提到时填写，如 [\"爸爸\",\"妈妈\"]），可选",
        },
        requirements: requirementsSchema,
        notes: { type: "string", description: "其他要求（带老人/孩子、摄影等），可选" },
      },
      required: ["title", "destination"],
    },
    async execute(args, ctx) {
      let parsed: TravelBrief;
      try {
        parsed = parseBrief(args);
      } catch (error) {
        throw new ToolValidationError([{ code: "TRAVEL_BRIEF_INVALID", path: "brief", message: error instanceof Error ? error.message : String(error), hint: "按参数定义修正后重试；mustVisit/avoid须传字符串数组，而不是JSON字符串。当前尚未进入任何写入。" }]);
      }
      // 标题分配和需求单提交使用同一把工作区锁，并行会话不能同时占用同一路径。
      return withTripTitleLock(rootDir, async () => {
        const operationTarget = ctx?.operationId ? await managedOperationTarget(rootDir, ctx.operationId, "save_travel_brief", args) : null;
        const isolate = operationTarget !== null || ctx?.newTravelPlan || (ctx?.isolateDisjointTripDates && await hasDisjointItineraryDates(rootDir, parsed));
        const title = isolate ? await availableBriefTitle(rootDir, parsed, operationTarget) : parsed.title;
        const file = planFileFor(rootDir, "plans/briefs", title, "json");
        const current = ctx?.brief?.title === title ? ctx.brief : ctx?.newTravelPlan ? undefined : await loadBriefForTitle(rootDir, title);
        const requestedTitle = title !== parsed.title ? parsed.title : current?.requestedTitle;
        const savedRatio = ctx?.brief?.title === title ? ctx.brief.budgetOverrunRatio : undefined;
        const budgetOverrunRatio = ctx?.userRequests?.length ? userBudgetOverrun(ctx.userRequests) ?? savedRatio : parsed.budgetOverrunRatio;
        const brief = await resolveBrief(rootDir, { ...parsed, title, requestedTitle, budgetOverrunRatio });
        return runManagedOperation({ root: rootDir, file, tool: "save_travel_brief", request: args, ...ctx,
          onReplay: async () => {
            const saved = await loadBriefForTitle(rootDir, title);
            if (saved) ctx?.onBrief?.(saved);
          },
        }, async (commit) => {
          await commit.commit(JSON.stringify(brief, null, 2));
          ctx?.onBrief?.(brief);
          const assigned = title === parsed.title ? "" : `同名行程已存在，本次独立标题为「${title}」。后续行程工具使用该标题。\n`;
          return `需求单已保存: ${file}\n${assigned}${summarizeBrief(brief)}\n` +
            "空缺项按默认值处理。不要再保存第二份需求单，先用少量候选保存覆盖全部日期、无跨日重复的outline基础安排，再逐日核验和细排；" +
            "后续保存行程沿用本次标题。";
        });
      }, ctx?.signal);
    },
  };
}

async function hasDisjointItineraryDates(root: string, brief: TravelBrief): Promise<boolean> {
  if (!brief.startDate && !brief.endDate) return false;
  const file = planFileFor(root, "plans", brief.title, "json");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (raw === null) return false;
  try {
    const saved = JSON.parse(raw);
    if (saved === null || typeof saved !== "object" || !Array.isArray(saved.days)) return true;
    const dates = [...saved.days, ...(Array.isArray(saved.outline) ? saved.outline : [])].map((day) => day?.date).filter(validTravelDate).sort();
    if (dates.length === 0) return false;
    return (brief.startDate !== undefined && brief.startDate > dates.at(-1)!) || (brief.endDate !== undefined && brief.endDate < dates[0]!);
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
}

async function availableBriefTitle(root: string, brief: TravelBrief, target: string | null): Promise<string> {
  const alternate = `${brief.title}（${brief.startDate ? `${brief.startDate} 出发` : "新行程"}）`;
  for (let suffix = 0; suffix < 1000; suffix++) {
    const title = suffix === 0 ? brief.title : suffix === 1 ? alternate : `${alternate} ${suffix}`;
    const file = planFileFor(root, "plans/briefs", title, "json");
    if (target) { if (target === file) return title; continue; }
    const occupied = await Promise.all([file, planFileFor(root, "plans", title, "json")].map(async (path) => {
      try { await stat(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }));
    if (!occupied.some(Boolean)) return title;
  }
  throw new Error("无法为本次行程分配独立标题，请检查行程目录或使用其他标题");
}

function userBudgetOverrun(requests: readonly UserRequest[]): number | undefined {
  let ratio: number | undefined;
  for (const { content } of requests) for (const clause of content.split(/[。！？，,；;\n]/)) {
    if (/(?:禁止|不(?:能|得|可|要|允许|接受))\s*(?:超支|超出(?:总)?预算)|(?:预算|花费|费用|支出|总价|人均).{0,8}(?:不超过|不得超过|严格控制在).{0,15}(?:元|块)/.test(clause)) ratio = 0;
    const allowed = /(?:超支|超出(?:总)?预算)\s*(?:不超过|最多|可以|允许|控制在)?\s*(\d{1,2}(?:\.\d+)?)\s*[%％]/.exec(clause);
    if (allowed) ratio = Math.min(BUDGET_OVERRUN, Number(allowed[1]) / 100);
  }
  return ratio;
}

export function createLoadTravelBriefTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "load_travel_brief",
    description:
      "从磁盘恢复已保存的需求单，含已合并的同行人约束。状态卡已有同标题需求版本时直接复用，无需读取。用户补充需求后用 save_travel_brief 保存新版本。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      const title = requireString(args, "title");
      if (ctx?.brief?.title === title && ctx.brief.requirementVersion) {
        annotateToolCall({ execution: "cache_hit" });
        return `需求单「${title}」版本 ${ctx.brief.requirementVersion} 已在状态卡，直接复用。`;
      }
      const brief = await loadBriefForTitle(rootDir, title);
      if (brief === null) return `未找到需求单「${title}」。已保存的需求单在 plans/briefs/ 目录。`;
      ctx?.onBrief?.(brief);
      const missing = brief.missingTravelerProfiles?.join("、");
      return JSON.stringify(brief, null, 2) + (missing ? `\n（注意：未找到档案 ${missing}，可在页面 👥 里导入）` : "");
    },
  };
}

function parseBrief(args: Record<string, unknown>): TravelBrief {
  if (args.durationDays !== undefined && (!Number.isInteger(args.durationDays) || Number(args.durationDays) < 1 || Number(args.durationDays) > 90)) throw new Error("durationDays需要1—90整数");
  const title = requireString(args, "title");
  const destination = requireString(args, "destination");

  const startDate = args.startDate;
  const endDate = args.endDate;
  for (const [key, value] of Object.entries({ startDate, endDate })) {
    if (value !== undefined && !validTravelDate(value)) throw new Error(`${key} 需要有效日期 YYYY-MM-DD`);
  }
  const span = validTravelDate(startDate) && validTravelDate(endDate)
    ? (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1 : undefined;
  if (span !== undefined && (span < 1 || span > 90)) throw new Error("起止日期需递增且跨度为1—90天");
  if (span !== undefined && args.durationDays !== undefined && span !== args.durationDays) throw new Error("durationDays与起止日期跨度不一致，请先统一用户要求的天数和日期");
  const requirements = args.requirements === undefined ? undefined : parseRequirements(args.requirements, span ?? (args.durationDays as number | undefined), title);
  const dates = requirements?.dates;
  const travelers = args.travelers ?? requirements?.travelers;
  const roomCount = args.roomCount ?? requirements?.room_count;
  const allowHotelChanges = args.allowHotelChanges ?? (requirements?.fixed_stay === true ? false : undefined);
  for (const [key, value, expected] of [
    ["startDate", startDate, dates?.[0]], ["endDate", endDate, dates?.at(-1)],
    ["travelers", args.travelers, requirements?.travelers], ["roomCount", args.roomCount, requirements?.room_count],
    ["allowHotelChanges", args.allowHotelChanges, requirements?.fixed_stay === true ? false : undefined],
  ]) {
    if (value !== undefined && expected !== undefined && value !== expected) throw new Error(`${key} 与 requirements 不一致`);
  }
  if (args.allowHotelChanges !== undefined && typeof args.allowHotelChanges !== "boolean") throw new Error("allowHotelChanges 必须为布尔值");
  if (args.requireAccommodation !== undefined && typeof args.requireAccommodation !== "boolean") throw new Error("requireAccommodation 必须为布尔值");
  if (args.returnLastDay !== undefined && typeof args.returnLastDay !== "boolean") throw new Error("returnLastDay 必须为布尔值");
  for (const key of ["travelers", "roomCount"]) {
    if (args[key] !== undefined && !Number.isSafeInteger(args[key])) throw new Error(`${key} 需要正整数`);
  }
  for (const key of ["travelers", "roomCount", "budgetTotalYuan", "budgetPerMealYuan"]) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`${key} 需要正数`);
    }
  }
  if (args.budgetOverrunRatio !== undefined && (typeof args.budgetOverrunRatio !== "number" || !Number.isFinite(args.budgetOverrunRatio)
    || args.budgetOverrunRatio < 0 || args.budgetOverrunRatio > BUDGET_OVERRUN)) throw new Error("budgetOverrunRatio 须在 0 至 0.2 之间");
  for (const key of ["mustVisit", "avoid"]) {
    const value = args[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new Error(`${key} 需要字符串数组`);
    }
  }
  {
    const value = args.travelerProfiles;
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === ""))) {
      throw new Error("travelerProfiles 需要非空字符串数组");
    }
  }

  const durationDays = span ?? (args.durationDays as number | undefined) ?? dates?.length;
  const effectiveStart = startDate ?? dates?.[0];
  const effectiveEnd = endDate ?? dates?.at(-1) ?? (durationDays && validTravelDate(effectiveStart)
    ? new Date(Date.parse(effectiveStart) + (durationDays - 1) * 86_400_000).toISOString().slice(0, 10) : undefined);
  return {
    ...(durationDays === undefined ? {} : { durationDays }),
    title,
    destination,
    ...(typeof effectiveStart === "string" ? { startDate: effectiveStart } : {}),
    ...(typeof effectiveEnd === "string" ? { endDate: effectiveEnd } : {}),
    ...(typeof roomCount === "number" ? { roomCount } : {}),
    ...(typeof travelers === "number" ? { travelers } : {}),
    ...(typeof args.budgetTotalYuan === "number" ? { budgetTotalYuan: args.budgetTotalYuan } : {}),
    ...(typeof args.budgetPerMealYuan === "number" ? { budgetPerMealYuan: args.budgetPerMealYuan } : {}),
    ...(typeof args.budgetOverrunRatio === "number" ? { budgetOverrunRatio: args.budgetOverrunRatio } : {}),
    ...(typeof allowHotelChanges === "boolean" ? { allowHotelChanges } : {}),
    ...(typeof args.accommodation === "string" ? { accommodation: args.accommodation } : {}),
    ...(typeof args.requireAccommodation === "boolean" ? { requireAccommodation: args.requireAccommodation } : {}),
    ...(typeof args.returnLastDay === "boolean" ? { returnLastDay: args.returnLastDay } : {}),
    ...(typeof args.pace === "string" ? { pace: args.pace } : {}),
    ...(Array.isArray(args.mustVisit) ? { mustVisit: args.mustVisit as string[] } : {}),
    ...(Array.isArray(args.avoid) ? { avoid: args.avoid as string[] } : {}),
    ...(typeof args.tastePreferences === "string" ? { tastePreferences: args.tastePreferences } : {}),
    ...(Array.isArray(args.travelerProfiles) ? { travelerProfiles: args.travelerProfiles as string[] } : {}),
    ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
    ...(requirements === undefined ? {} : { requirements }),
  };
}

async function resolveBrief(rootDir: string, brief: TravelBrief): Promise<TravelBrief> {
  if (brief.requirementVersion) return brief;
  const names = Array.isArray(brief.travelerProfiles) ? brief.travelerProfiles.filter((name) => typeof name === "string") : [];
  const loaded = await Promise.all(names.map((name) => loadProfile(rootDir, name)));
  const profiles = loaded.filter((profile) => profile !== null);
  const missing = names.filter((_, index) => loaded[index] === null);
  const travelerConstraints = mergeProfiles(profiles);
  const effective = {
    ...brief,
    ...(travelerConstraints ? { travelerConstraints } : {}),
    ...(missing.length ? { missingTravelerProfiles: missing } : {}),
  };
  const canonical = JSON.stringify(effective, (_, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const requirementVersion = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  return { ...effective, requirementVersion };
}

function summarizeBrief(brief: TravelBrief): string {
  const rows: Array<[string, string]> = [
    ["目的地", brief.destination],
    ["天数", brief.durationDays === undefined ? "按日期/标题确定" : `${brief.durationDays}天`],
    ["日期", brief.startDate === undefined ? "未定（按当天推算）" : `${brief.startDate} 至 ${brief.endDate ?? brief.startDate}`],
    ["人数", brief.travelers === undefined ? "未填（按 2 人）" : `${brief.travelers} 人`],
    ["酒店策略", brief.allowHotelChanges === false ? "用户要求全程同一家酒店" : brief.allowHotelChanges === true ? "允许换酒店，同区域优先连住" : "同区域优先连住，后续行程跨区域时可转场换宿"],
    ["房数", brief.roomCount === undefined ? `未填（按每间 2 人，${Math.ceil((brief.travelers ?? DEFAULT_TRAVELERS) / 2)} 间）` : `${brief.roomCount} 间`],
    ["总预算", brief.budgetTotalYuan === undefined ? "未填" : `¥${brief.budgetTotalYuan}`],
    ["单餐人均", brief.budgetPerMealYuan === undefined ? "未填（不限制）" : `¥${brief.budgetPerMealYuan}`],
    ["口味", brief.tastePreferences ?? "未填（用长期偏好或询问）"],
    ["住宿", brief.accommodation ?? "未填"],
    ["过夜要求", brief.requireAccommodation === false ? "不要求住宿" : brief.requireAccommodation === true ? "需要住宿" : "一日游不默认过夜，多日游检查住宿"],
    ["节奏", brief.pace ?? "适中"],
    ["必去", brief.mustVisit?.join("、") ?? "无"],
    ["避开", brief.avoid?.join("、") ?? "无"],
    ["同行人档案", brief.travelerProfiles?.join("、") ?? "无"],
  ];
  const allocation = briefBudgetPlan(brief);
  return [...rows.map(([key, value]) => `- ${key}: ${value}`), ...(allocation ? [budgetPlanText(allocation)] : [])].join("\n");
}

/** 行程天数（含首尾）；日期缺失或非法时返回 undefined（无法据此估算工作量） */
export function briefDays(brief: TravelBrief): number | undefined {
  if (!validTravelDate(brief.startDate) || !validTravelDate(brief.endDate)) return brief.durationDays;
  const start = Date.parse(`${brief.startDate}T00:00:00Z`);
  const end = Date.parse(`${brief.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function briefBudgetPlan(brief: TravelBrief) {
  const days = briefDays(brief) ?? daysFromText(brief.title), target = brief.budgetTotalYuan, travelers = brief.travelers ?? DEFAULT_TRAVELERS;
  if (!days || !target) return undefined;
  return allocateTripBudget(target, days, travelers, brief.roomCount ?? Math.ceil(travelers / 2), brief.requireAccommodation !== false, brief.budgetOverrunRatio);
}

/**
 * 按需求单换算工具轮次预算：天数越多越费轮次（每天要搜索+口碑+餐饮+保存+校验）。
 * 天数取需求单日期与会话文本（「7日游/七天」）里的较大值：需求单还没落盘的首轮也能估准，
 * 预算是上限不是配额，估宽只会让长行程不至于中途断供。认不出天数返回 fallback。
 * 结果夹在 [12, 120]——再多由运行时续期兜底。
 */
export function toolRoundsForBrief(brief: TravelBrief | null, fallback: number, text?: string): number {
  const fromBrief = brief === null ? undefined : briefDays(brief);
  const fromText = text === undefined ? undefined : daysFromText(text);
  if (fromBrief === undefined) {
    // 需求单没落盘（新会话首轮）：文本估算只用来抬高预算，不该压低默认值
    return fromText === undefined ? fallback : Math.max(fallback, roundsForDays(fromText, brief));
  }
  return roundsForDays(Math.max(fromBrief, fromText ?? 0), brief);
}

/** 天数 → 轮次：10 轮打底 + 每天 6 轮（搜索/口碑/餐饮/交通/保存/校验），按节奏与其他要求微调 */
function roundsForDays(days: number, brief: TravelBrief | null): number {
  const pace = brief?.pace ?? "";
  const notes = brief?.notes ?? "";
  const budget =
    10 +
    6 * days +
    (pace.includes("紧凑") ? 8 : pace.includes("慢") ? -4 : 0) +
    (/自驾|包车|远郊|长线|徒步/.test(notes) ? 6 : 0) +
    // 每个必去点都要单独核实坐标/口碑再插进某一天，按 2 轮计，封顶 8
    Math.min(8, (brief?.mustVisit?.length ?? 0) * 2);
  return Math.max(12, Math.min(120, budget));
}

/**
 * 从会话文本里认出行天数：先认日期区间（「10月20日至10月27日」「10-20 至 10-27」——需求单模板的写法），
 * 再认天数（「7日游 / 7天 / 七天 / 十日游」）；认不出返回 undefined。
 */
function daysFromText(text: string): number | undefined {
  const range = /(\d{1,2})[月/-](\d{1,2})日?\s*[至到~—–-]\s*(\d{1,2})[月/-](\d{1,2})日?/.exec(text);
  if (range !== null) {
    // 跨月按每月 31 天粗算：预算是上限，差一天不影响用途
    const days = (Number(range[3]) - Number(range[1])) * 31 + Number(range[4]) - Number(range[2]) + 1;
    if (days >= 1 && days <= 60) return days;
  }
  // 「月」后面的数字是日期不是天数（10月20日 ≠ 20 天），用后顾断言排除
  const match = /(?<![\d月])(\d{1,2}|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])\s*(?:日|天)/.exec(text);
  if (match === null) return undefined;
  const days = /^\d+$/.test(match[1]) ? Number(match[1]) : chineseNumber(match[1]);
  if (days === undefined || days < 1 || days > 30) return undefined;
  return days;
}

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字（一~九十九）转阿拉伯数字；「一三」这类无意义组合返回 undefined */
function chineseNumber(text: string): number | undefined {
  const match = /^([一二两三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(text);
  if (match === null) return undefined;
  const high = match[1] === "" ? undefined : CN_DIGITS[match[1]];
  const low = match[3] === "" ? undefined : CN_DIGITS[match[3]];
  if (match[2] === "") return high === undefined || low !== undefined ? undefined : high;
  return (high ?? 1) * 10 + (low ?? 0);
}

/** 已保存的需求单，按修改时间从新到旧；损坏或缺少目的地的文件跳过 */
export async function listTravelBriefs(rootDir: string): Promise<TravelBrief[]> {
  const dir = join(rootDir, "plans", "briefs");
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readBriefFile(join(dir, name))),
  );
  return entries
    .filter((entry): entry is { brief: TravelBrief; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.brief);
}

/** 读取指定标题的需求单；不存在或损坏返回 null */
export async function loadBriefForTitle(rootDir: string, title: string): Promise<TravelBrief | null> {
  const raw = await readFile(planFileFor(rootDir, "plans/briefs", title, "json"), "utf8").catch(() => null);
  const brief = raw === null ? null : parseBriefJson(raw);
  return brief === null ? null : resolveBrief(rootDir, brief);
}

/**
 * 按会话文本匹配需求单：先看标题、再看目的地（一次会话通常只规划一个行程），
 * 都不匹配时退回最近保存的需求单；没有需求单返回 null。
 */
export async function briefForSessionTitle(rootDir: string, sessionText: string): Promise<TravelBrief | null> {
  const briefs = await listTravelBriefs(rootDir);
  const selected = briefs.find((brief) => sessionText.includes(brief.title))
    ?? briefs.find((brief) => sessionText.includes(brief.destination))
    ?? briefs[0];
  return selected ?? null;
}

async function readBriefFile(file: string): Promise<{ brief: TravelBrief; mtimeMs: number } | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  const brief = raw === null ? null : parseBriefJson(raw);
  if (brief === null) return null;
  const mtimeMs = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
  return { brief, mtimeMs };
}

/** 宽松解析已落盘的需求单：只要求 title/destination 为非空字符串，损坏时返回 null */
function parseBriefJson(raw: string): TravelBrief | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TravelBrief>;
    if (typeof parsed.title !== "string" || parsed.title === "") return null;
    if (typeof parsed.destination !== "string" || parsed.destination === "") return null;
    return parsed as TravelBrief;
  } catch {
    return null;
  }
}
