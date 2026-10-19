import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { planFileFor } from "./itinerary.ts";
import { loadProfile, mergeProfiles } from "./profiles.ts";

export interface TravelBrief {
  readonly title: string;
  readonly destination: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly travelers?: number;
  readonly budgetTotalYuan?: number;
  readonly budgetPerMealYuan?: number;
  readonly accommodation?: string;
  readonly pace?: string;
  readonly mustVisit?: readonly string[];
  readonly avoid?: readonly string[];
  readonly tastePreferences?: string;
  /** 同行人档案名字列表（与 profiles 合并后的约束见合并输出） */
  readonly travelerProfiles?: readonly string[];
  readonly notes?: string;
}

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
    description:
      "保存旅行需求单（结构化）。用户提供需求文本（模板或自由描述）后，解析成此结构保存，" +
      "并向用户列出解析结果与默认值做一次性确认；后续规划的所有工具参数从需求单取：" +
      "region/目的地=destination、餐厅 max_cost=budgetPerMealYuan、" +
      "天气=get_weather 按行程起止日期（start_date/end_date；超 16 天预报范围的部分拿不到）、" +
      "avoid_cuisines=avoid、口味=tastePreferences。用户补充/修改需求时更新保存。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题，例如：杭州两日游" },
        destination: { type: "string", description: "目的地城市/区域，例如：杭州" },
        startDate: { type: "string", description: "开始日期 YYYY-MM-DD，可选" },
        endDate: { type: "string", description: "结束日期 YYYY-MM-DD，可选" },
        travelers: { type: "number", description: "出行人数，可选" },
        budgetTotalYuan: { type: "number", description: "总预算（元），可选" },
        budgetPerMealYuan: { type: "number", description: "单餐人均预算（元），可选" },
        accommodation: { type: "string", description: "住宿偏好描述，可选" },
        pace: { type: "string", description: "行程节奏：慢 / 适中 / 紧凑，可选" },
        mustVisit: { type: "array", items: { type: "string" }, description: "必去地点列表，可选" },
        avoid: { type: "array", items: { type: "string" }, description: "要避开的地点/类型，可选" },
        tastePreferences: { type: "string", description: "本次出行口味偏好（优先于长期偏好），可选" },
        travelerProfiles: {
          type: "array",
          items: { type: "string" },
          description: "同行人档案名字列表（用户在页面勾选或提到时填写，如 [\"爸爸\",\"妈妈\"]），可选",
        },
        notes: { type: "string", description: "其他要求（带老人/孩子、摄影等），可选" },
      },
      required: ["title", "destination"],
    },
    async execute(args) {
      const brief = parseBrief(args);
      const file = planFileFor(rootDir, "plans/briefs", brief.title, "json");

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(brief, null, 2), "utf8");

      return `需求单已保存: ${file}\n${summarizeBrief(brief)}\n请向用户确认以上解析结果（空缺项将按默认处理），确认后即可一步到位生成规划。`;
    },
  };
}

export function createLoadTravelBriefTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "load_travel_brief",
    description:
      "读取已保存的旅行需求单。开始规划或用户补充需求前先调用它拿到当前版本，" +
      "更新后用 save_travel_brief 保存。需求单里若勾选了同行人档案，" +
      "输出会附上已合并的同行人约束（忌口取并集、辣度/节奏取最保守），规划必须遵守。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
      },
      required: ["title"],
    },
    async execute(args) {
      const title = requireString(args, "title");
      let raw: string;
      try {
        raw = await readFile(planFileFor(rootDir, "plans/briefs", title, "json"), "utf8");
      } catch {
        return `未找到需求单「${title}」。已保存的需求单在 plans/briefs/ 目录。`;
      }
      const brief = JSON.parse(raw) as TravelBrief;
      const names = Array.isArray(brief.travelerProfiles) ? brief.travelerProfiles : [];
      if (names.length === 0) return raw;
      const profiles = (await Promise.all(names.map((name) => loadProfile(rootDir, name)))).filter(
        (profile): profile is NonNullable<typeof profile> => profile !== null,
      );
      const missing = names.filter((name) => !profiles.some((profile) => profile.name === name || profile.id === name));
      const merged = mergeProfiles(profiles);
      const missingNote = missing.length > 0 ? `\n（注意：未找到档案 ${missing.join("、")}，可在页面 👥 里导入）` : "";
      return `${raw}${merged === "" ? "" : `\n\n${merged}`}${missingNote}`;
    },
  };
}

function parseBrief(args: Record<string, unknown>): TravelBrief {
  const title = requireString(args, "title");
  const destination = requireString(args, "destination");

  for (const key of ["startDate", "endDate"]) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      throw new Error(`${key} 需要 YYYY-MM-DD 格式`);
    }
  }
  for (const key of ["travelers", "budgetTotalYuan", "budgetPerMealYuan"]) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`${key} 需要正数`);
    }
  }
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

  return {
    title,
    destination,
    ...(typeof args.startDate === "string" ? { startDate: args.startDate } : {}),
    ...(typeof args.endDate === "string" ? { endDate: args.endDate } : {}),
    ...(typeof args.travelers === "number" ? { travelers: args.travelers } : {}),
    ...(typeof args.budgetTotalYuan === "number" ? { budgetTotalYuan: args.budgetTotalYuan } : {}),
    ...(typeof args.budgetPerMealYuan === "number" ? { budgetPerMealYuan: args.budgetPerMealYuan } : {}),
    ...(typeof args.accommodation === "string" ? { accommodation: args.accommodation } : {}),
    ...(typeof args.pace === "string" ? { pace: args.pace } : {}),
    ...(Array.isArray(args.mustVisit) ? { mustVisit: args.mustVisit as string[] } : {}),
    ...(Array.isArray(args.avoid) ? { avoid: args.avoid as string[] } : {}),
    ...(typeof args.tastePreferences === "string" ? { tastePreferences: args.tastePreferences } : {}),
    ...(Array.isArray(args.travelerProfiles) ? { travelerProfiles: args.travelerProfiles as string[] } : {}),
    ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
  };
}

function summarizeBrief(brief: TravelBrief): string {
  const rows: Array<[string, string]> = [
    ["目的地", brief.destination],
    ["日期", brief.startDate === undefined ? "未定（按当天推算）" : `${brief.startDate} 至 ${brief.endDate ?? brief.startDate}`],
    ["人数", brief.travelers === undefined ? "未填（按 2 人）" : `${brief.travelers} 人`],
    ["总预算", brief.budgetTotalYuan === undefined ? "未填" : `¥${brief.budgetTotalYuan}`],
    ["单餐人均", brief.budgetPerMealYuan === undefined ? "未填（不限制）" : `¥${brief.budgetPerMealYuan}`],
    ["口味", brief.tastePreferences ?? "未填（用长期偏好或询问）"],
    ["住宿", brief.accommodation ?? "未填"],
    ["节奏", brief.pace ?? "适中"],
    ["必去", brief.mustVisit?.join("、") ?? "无"],
    ["避开", brief.avoid?.join("、") ?? "无"],
    ["同行人档案", brief.travelerProfiles?.join("、") ?? "无"],
  ];
  return rows.map(([key, value]) => `- ${key}: ${value}`).join("\n");
}

/** 行程天数（含首尾）；日期缺失或非法时返回 undefined（无法据此估算工作量） */
export function briefDays(brief: TravelBrief): number | undefined {
  if (brief.startDate === undefined || brief.endDate === undefined) return undefined;
  const start = Date.parse(`${brief.startDate}T00:00:00Z`);
  const end = Date.parse(`${brief.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round((end - start) / 86_400_000) + 1;
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
  return raw === null ? null : parseBriefJson(raw);
}

/**
 * 按会话文本匹配需求单：先看标题、再看目的地（一次会话通常只规划一个行程），
 * 都不匹配时退回最近保存的需求单；没有需求单返回 null。
 */
export async function briefForSessionTitle(rootDir: string, sessionText: string): Promise<TravelBrief | null> {
  const briefs = await listTravelBriefs(rootDir);
  return (
    briefs.find((brief) => sessionText.includes(brief.title)) ??
    briefs.find((brief) => sessionText.includes(brief.destination)) ??
    briefs[0] ??
    null
  );
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
