import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import {
  parseItinerary,
  ITINERARY_ITEM_TYPES,
  type Itinerary,
  type ItineraryItem,
} from "./itinerary-schema.ts";
import {
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
    description:
      "保存结构化行程单（JSON + Markdown + 质量报告）。保存前执行基础质量核验：P0 拒绝保存，" +
      "P1/P2 会写入质量报告；strict=true 时 P0/P1 都拒绝。生成完整行程后应调用 validate_itinerary " +
      "并以 strict=true 通过后再向用户交付。修改行程时先 load_itinerary 读取当前版本，只改动用户要求的部分。" +
      "餐饮条目为沿途候选餐厅（可无 time；午餐/晚餐建议各 4-6 个候选、覆盖不同价位与菜系），不参与景点路线规划。" +
      "条目较多（每天 10 条以上）时用 merge=true 按天分批保存：每次只提交 1 天的内容，按 date 替换已有的同一天、" +
      "其余天原样保留；避免一次输出全部条目导致工具参数超出模型单次输出上限而被截断。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题，例如：杭州两日游" },
        strict: { type: "boolean", description: "默认 false；true 时 P0/P1 问题都会拒绝保存" },
        merge: {
          type: "boolean",
          description:
            "默认 false（整体覆盖保存）；true 时与已保存的同名行程合并：按 date 用本次提交的天替换已有天，" +
            "匹配不到或没有 date 的天追加，其余天保留。分天保存大行程时使用。",
        },
        budget_per_person_yuan: { type: "number", description: "人均总预算（元），可选；用于质量核验" },
        days: {
          type: "array",
          description: "按天组织的行程",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "日期，例如 2026-10-01，可选" },
              theme: { type: "string", description: "当天主题，例如 西湖环线，可选" },
              items: {
                type: "array",
                description: "当天时间线（按时间排序）",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "稳定条目 ID；缺省时自动生成" },
                    time: { type: "string", description: "开始时间 HH:MM，例如 09:00" },
                    end_time: { type: "string", description: "结束时间 HH:MM，必须晚于 time" },
                    type: {
                      type: "string",
                      enum: [...ITINERARY_ITEM_TYPES],
                      description: "visit / meal / transport / rest / free_time / accommodation / note",
                    },
                    subtype: {
                      type: "string",
                      enum: ["breakfast", "lunch", "dinner", "snack"],
                      description: "meal 条目的餐段",
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
                    cost_per_person: { type: "number", description: "人均消费（元），非负数" },
                    ticket_price_per_person: { type: "number", description: "人均门票（元），非负数" },
                    opening_hours: {
                      type: "object",
                      description: "营业/开放时间，用于核验条目开始时间",
                      properties: {
                        opens: { type: "string", description: "开放时间 HH:MM" },
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
                    source: { type: "string", description: "数据来源，例如 amap / official / search" },
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
    async execute(args) {
      const title = requireString(args, "title");
      const incoming = parseItinerary(args);
      const merge = args.merge === true;
      const file = itineraryFile(rootDir, title);
      const itinerary = merge ? await mergeSavedItinerary(file, incoming) : incoming;
      const budget = optionalNonNegativeNumber(args.budget_per_person_yuan, "budget_per_person_yuan");
      const strict = args.strict === true;
      const report = validateItinerary(itinerary, budget === undefined ? {} : { budget_per_person_yuan: budget });
      if (report.issue_count.P0 > 0 || (strict && report.issue_count.P1 > 0)) {
        throw new Error(`行程质量校验未通过:\n${renderQualityReport(report)}`);
      }

      const base = file.slice(0, -5);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(itinerary, null, 2), "utf8");
      await writeFile(`${base}.md`, renderMarkdown(itinerary), "utf8");
      await writeFile(`${base}.quality.json`, JSON.stringify(report, null, 2), "utf8");
      await writeFile(`${base}.quality.md`, renderQualityReport(report), "utf8");

      const itemCount = itinerary.days.reduce((sum, day) => sum + day.items.length, 0);
      const savedLabel = merge
        ? `已保存「${title}」（合并保存 ${incoming.days.length} 天，共 ${itinerary.days.length} 天 / ${itemCount} 项）:`
        : `已保存「${title}」（${itinerary.days.length} 天 / ${itemCount} 项）:`;
      return [
        savedLabel,
        `质量: ${report.score} / 100（P0 ${report.issue_count.P0} / P1 ${report.issue_count.P1} / P2 ${report.issue_count.P2}）`,
        ...(report.meal_notes.length > 0 ? [`餐饮建议 ${report.meal_notes.length} 条（仅供参考，不影响评分）`] : []),
        `${file}（结构化数据）`,
        `${base}.md（可读版本）`,
        `${base}.quality.md（质量报告）`,
      ].join("\n");
    },
  };
}

/**
 * 合并保存：按 date 用本次提交的天替换已保存的同名天（匹配不到或没有 date 则追加），其余天保留。
 * 供条目多时按天分批保存，避免单次工具调用输出超出模型上限。
 */
async function mergeSavedItinerary(file: string, incoming: Itinerary): Promise<Itinerary> {
  let saved: Itinerary | null = null;
  try {
    saved = parseItinerary(JSON.parse(await readFile(file, "utf8")));
  } catch {
    saved = null; // 文件不存在或损坏 → 等价全新保存
  }
  if (saved === null) return incoming;
  const days = [...saved.days];
  for (const day of incoming.days) {
    const index = day.date === undefined ? -1 : days.findIndex((savedDay) => savedDay.date === day.date);
    if (index >= 0) days[index] = day;
    else days.push(day);
  }
  return { title: incoming.title, days };
}

export function createLoadItineraryTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "load_itinerary",
    description:
      "读取已保存的结构化行程单（JSON）。用户要求修改行程时必须先调用它拿到当前版本，" +
      "改完受影响的条目后用 save_itinerary 保存，不要凭记忆重写。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
      },
      required: ["title"],
    },
    async execute(args) {
      const title = requireString(args, "title");
      try {
        return await readFile(itineraryFile(rootDir, title), "utf8");
      } catch {
        return `未找到行程「${title}」。可用 list_itineraries 查看已保存的行程。`;
      }
    },
  };
}

export function createValidateItineraryTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "validate_itinerary",
    description:
      "核验已保存的行程：时间顺序与重叠、时间线空档、赶路时间、游玩时长、过长交通、当日总时长、景点路线折返、跨天重复、闭馆、预算、数据置信度。" +
      "餐饮项单独列为「餐饮参考」——只做提示（如某餐段没有推荐），不参与状态/评分。" +
      "生成或修改行程后必须调用；strict=true 时行程类 P0/P1 问题会抛错，要求模型修正后重试（餐饮建议不影响通过）。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "行程标题（保存时的标题）" },
        strict: { type: "boolean", description: "默认 false；true 时行程类 P0/P1 问题会失败（餐饮建议不影响）" },
        budget_per_person_yuan: { type: "number", description: "人均总预算（元），可选" },
      },
      required: ["title"],
    },
    async execute(args) {
      const title = requireString(args, "title");
      let raw: string;
      try {
        raw = await readFile(itineraryFile(rootDir, title), "utf8");
      } catch {
        return `未找到行程「${title}」。可用 list_itineraries 查看已保存的行程。`;
      }

      const budget = optionalNonNegativeNumber(args.budget_per_person_yuan, "budget_per_person_yuan");
      const report = validateItinerary(
        parseItinerary(JSON.parse(raw)),
        budget === undefined ? {} : { budget_per_person_yuan: budget },
      );
      if (args.strict === true && (report.issue_count.P0 > 0 || report.issue_count.P1 > 0)) {
        throw new Error(`行程质量校验未通过（strict）:\n${renderQualityReport(report)}`);
      }
      return renderQualityReport(report);
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

function renderMarkdown(itinerary: Itinerary): string {
  const lines = [`# ${itinerary.title}`, ""];
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
    item.end_time !== undefined ? `结束 ${item.end_time}` : undefined,
    item.planned_duration_min !== undefined ? `计划 ${item.planned_duration_min} 分钟` : undefined,
    item.transport_mode !== undefined ? `方式 ${item.transport_mode}` : undefined,
    item.cost_per_person !== undefined ? `人均 ¥${item.cost_per_person}` : undefined,
    item.ticket_price_per_person !== undefined ? `门票 ¥${item.ticket_price_per_person}` : undefined,
    item.source !== undefined ? `来源 ${item.source}` : undefined,
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

/** 标题 → 安全文件名（保留中文/字母/数字），并校验不越出 root 目录 */
export function planFileFor(rootDir: string, subDir: string, title: string, extension: string): string {
  const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-");
  const fileName = safe === "" ? "未命名" : safe;
  const root = resolve(rootDir);
  const file = resolve(join(root, subDir, `${fileName}.${extension}`));
  const rel = relative(root, file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("标题不合法");
  }
  return file;
}

function itineraryFile(rootDir: string, title: string): string {
  return planFileFor(rootDir, "plans", title, "json");
}
