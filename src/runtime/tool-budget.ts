import { opportunityScore } from "../tools/itinerary-assessment.ts";
import { evidenceId } from "../tools/travel-evidence.ts";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Session } from "../core/session.ts";
import { parseItinerary, type Itinerary } from "../tools/itinerary-schema.ts";
import {
  validateItinerary,
  expectedDaysFromTitle,
  type ItineraryQualityReport,
  type QualityIssue,
  type QualityIssueLevel,
} from "../tools/itinerary-validator.ts";

type RepairCategory = "tool" | "edit" | "uncertain";

export interface BudgetIssueAdvice {
  readonly level: QualityIssueLevel;
  readonly code: string;
  readonly message: string;
  readonly day?: number;
  readonly item_id?: string;
  readonly category: RepairCategory;
  /** 用户可读的下一步，明确本轮额外预算能做什么 */
  readonly action: string;
}

export interface ToolBudgetAssessment {
  readonly fingerprint?: string;
  readonly initialLimit: number;
  readonly currentLimit: number;
  readonly usedRounds: number;
  readonly ceiling: number;
  readonly canContinue: boolean;
  readonly suggestedAdditionalRounds: number;
  /** 为什么轮次会用完，以及继续调用的成本 */
  readonly explanation: string;
  readonly quality: {
    readonly available: boolean;
    readonly title?: string;
    readonly status?: ItineraryQualityReport["status"];
    readonly score?: number;
    readonly issue_count?: ItineraryQualityReport["issue_count"];
    /** strict 验收只拦截 P0/P1；P2 提示会拉低完整度分，但不阻断交付 */
    readonly strict_pass?: boolean;
    readonly meal_note_count: number;
    /** 按同一评分口径移除当前可修复问题后的估算分；未补齐日期仍保留完整度折减 */
    readonly potential_score?: number;
    readonly unavailable_reason?: string;
  };
  readonly repair: {
    readonly canImprove: boolean;
    readonly summary: string;
    readonly items: readonly BudgetIssueAdvice[];
  };
}

export interface BudgetAssessmentOptions {
  readonly rootDir: string;
  readonly previousFingerprint?: string;
  readonly session: Session;
  readonly initialLimit: number;
  readonly currentLimit: number;
  readonly ceiling: number;
  readonly extensionStep: number;
}

interface RepairRule {
  readonly category: RepairCategory;
  readonly action: string;
}

/**
 * 轮次用尽时的统一评估：
 * 1. 从本会话最近的 save_itinerary 结果里找到真正落盘的行程；
 * 2. 重新跑一遍质量校验（不信任模型的自述）；
 * 3. 按问题类型判断追加工具轮次能修什么、什么依赖外部信息。
 */
export async function assessToolBudget(options: BudgetAssessmentOptions): Promise<ToolBudgetAssessment> {
  const canContinue = options.currentLimit < options.ceiling;
  const suggestedAdditionalRounds = canContinue
    ? Math.max(1, Math.min(options.extensionStep, options.ceiling - options.currentLimit))
    : 0;
  const explanation =
    `本轮按行程工作量分配的动态工具预算为 ${options.initialLimit} 轮，` +
    `目前已执行 ${options.currentLimit} 轮并达到上限` +
    (options.currentLimit > options.initialLimit
      ? `（此前已追加 ${options.currentLimit - options.initialLimit} 轮）`
      : "") +
    "。这些轮次用于地点检索、坐标/口碑/开放时间核验、路线计算、保存与质量复验；" +
    "继续会增加耗时以及模型/地图 API 的用量。";

  const saved = latestSavedItinerary(options.session, options.rootDir);
  if (saved === null) {
    return {
      initialLimit: options.initialLimit,
      currentLimit: options.currentLimit,
      usedRounds: options.currentLimit,
      ceiling: options.ceiling,
      canContinue,
      suggestedAdditionalRounds,
      explanation,
      quality: {
        available: false,
        meal_note_count: 0,
        unavailable_reason: "本会话还没有成功落盘的行程，无法给出可靠的质量评分。",
      },
      repair: {
        canImprove: true,
        summary:
          "当前没有可评估的已保存版本。追加轮次可以继续生成、保存并校验行程，" +
          "但在真正完成 strict 验收前，不能保证一定通过。",
        items: [],
      },
    };
  }

  let report: ItineraryQualityReport;
  let itinerary: Itinerary;
  let fingerprint: string;
  try {
    itinerary = parseItinerary(JSON.parse(await readFile(saved.path, "utf8")));
    const { revision: _revision, ...content } = itinerary;
    fingerprint = evidenceId(content);
    report = validateItinerary(
      itinerary,
      saved.budgetPerPersonYuan === undefined ? {} : { budget_per_person_yuan: saved.budgetPerPersonYuan },
    );
  } catch (error) {
    return {
      initialLimit: options.initialLimit,
      currentLimit: options.currentLimit,
      usedRounds: options.currentLimit,
      ceiling: options.ceiling,
      canContinue,
      suggestedAdditionalRounds,
      explanation,
      quality: {
        available: false,
        meal_note_count: 0,
        unavailable_reason:
          `已保存的行程无法读取或解析：${error instanceof Error ? error.message : String(error)}。` +
          "追加轮次应先修复这份文件，再重新评估。",
      },
      repair: {
        canImprove: true,
        summary: "当前落盘文件不可评估；追加轮次可先重新保存一份结构合法、可校验的行程。",
        items: [],
      },
    };
  }

  const items = report.issues.map(adviseIssue);
  const uncertain = report.issues.filter((item) => adviceFor(item).category === "uncertain");
  const fixable = items.filter((item) => item.category !== "uncertain");
  const strictPass = report.issue_count.P0 === 0 && report.issue_count.P1 === 0;
  const potentialScore = opportunityScore(itinerary, uncertain, itinerary.constraints?.expected_days ?? expectedDaysFromTitle(itinerary.title)).score;
  const unchanged = options.previousFingerprint !== undefined && fingerprint === options.previousFingerprint;
  const canImprove = !strictPass && !unchanged && fixable.length > 0;
  const summary = unchanged ? "上次追加后已保存内容没有变化，停止自动续期；请先处理未完成的质量项。" : repairSummary(report, fixable.length, uncertain.length, canImprove, potentialScore);

  return {
    fingerprint,
    initialLimit: options.initialLimit,
    currentLimit: options.currentLimit,
    usedRounds: options.currentLimit,
    ceiling: options.ceiling,
    canContinue,
    suggestedAdditionalRounds,
    explanation,
    quality: {
      available: true,
      title: report.title,
      status: report.status,
      score: report.score,
      issue_count: report.issue_count,
      strict_pass: strictPass,
      meal_note_count: report.meal_notes.length,
      potential_score: potentialScore,
    },
    repair: {
      canImprove,
      summary,
      items,
    },
  };
}

/** 给续期后的模型一条临时指令：只修已识别的问题，避免重复搜索已拿到的数据 */
export function budgetGuidance(assessment: ToolBudgetAssessment): string {
  const quality = assessment.quality.available
    ? `当前已保存版本「${assessment.quality.title ?? "未命名"}」评分 ${assessment.quality.score}/100，` +
      `P0 ${assessment.quality.issue_count?.P0 ?? 0} / P1 ${assessment.quality.issue_count?.P1 ?? 0} / P2 ${assessment.quality.issue_count?.P2 ?? 0}；` +
      `${assessment.quality.strict_pass === true ? "strict 已通过" : "strict 未通过"}。`
    : `当前没有可评估的已保存行程。${assessment.quality.unavailable_reason ?? ""}`;
  const priorities = assessment.repair.items
    .filter((item) => item.category !== "uncertain")
    .slice(0, 8)
    .map((item, index) => `${index + 1}. [${item.level}] ${item.action}（${item.code}）`);
  return [
    "【用户已授权追加工具轮次】",
    quality,
    assessment.repair.summary,
    ...(priorities.length > 0 ? ["优先处理：", ...priorities] : []),
    "复用本轮已经获得的搜索结果与坐标，不要重复查询；先修 P0/P1，再处理 P2。",
    "修改后必须 save_itinerary 落盘，并再次 validate_itinerary；只有 strict=true 通过后才能声称交付合格。",
  ].join("\n");
}

/** CLI 的可读版本；Web 使用结构化字段自行排版 */
export function renderToolBudgetAssessment(assessment: ToolBudgetAssessment): string {
  const lines = ["工具轮次已用尽", assessment.explanation, ""];
  if (assessment.quality.available) {
    lines.push(
      `当前质量：「${assessment.quality.title ?? "未命名"}」${statusLabel(assessment.quality.status)} · ` +
      `${assessment.quality.score ?? 0}/100`,
      `问题统计：P0 ${assessment.quality.issue_count?.P0 ?? 0} / ` +
      `P1 ${assessment.quality.issue_count?.P1 ?? 0} / ` +
      `P2 ${assessment.quality.issue_count?.P2 ?? 0}` +
      `；strict ${assessment.quality.strict_pass === true ? "已通过" : "未通过"}` +
      (assessment.quality.meal_note_count > 0
        ? `；餐饮参考 ${assessment.quality.meal_note_count} 条（不参与评分）`
        : ""),
    );
  } else {
    lines.push(`当前质量：无法评估。${assessment.quality.unavailable_reason ?? ""}`);
  }
  lines.push("", `继续调用能否改善：${assessment.repair.summary}`);
  if (assessment.repair.items.length > 0) {
    lines.push("", "主要缺口：");
    for (const item of assessment.repair.items.slice(0, 8)) {
      const location = item.day === undefined ? "" : `Day ${item.day} · `;
      lines.push(`- ${location}[${item.level}] ${item.message} → ${item.action}`);
    }
    if (assessment.repair.items.length > 8) {
      lines.push(`- 另有 ${assessment.repair.items.length - 8} 项，见质量报告。`);
    }
  }
  if (assessment.canContinue) {
    lines.push(
      "",
      `建议追加：${assessment.suggestedAdditionalRounds} 轮（硬上限 ${assessment.ceiling} 轮，当前 ${assessment.currentLimit} 轮）`,
    );
  } else {
    lines.push("", `已达到 ${assessment.ceiling} 轮硬上限，无法继续追加。`);
  }
  return lines.join("\n");
}

function latestSavedItinerary(
  session: Session,
  rootDir: string,
): { readonly path: string; readonly budgetPerPersonYuan?: number } | null {
  const plansRoot = resolve(rootDir, "plans");
  const history = session.history;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message.role !== "tool" ||
      message.toolName !== "save_itinerary" ||
      message.content.startsWith("工具执行失败")
    ) {
      continue;
    }
    const match = /^(.+\/plans\/[^\n]+\.json)（结构化数据）$/m.exec(message.content);
    if (match === null) continue;
    const path = resolve(match[1]);
    const rel = relative(plansRoot, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) continue;

    let budgetPerPersonYuan: number | undefined;
    const call = message.toolCallId === undefined
      ? undefined
      : history.find(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.toolCalls?.some((toolCall) => toolCall.id === message.toolCallId),
        );
    const toolCall =
      call?.archivedToolCalls?.find((candidate) => candidate.id === message.toolCallId) ??
      call?.toolCalls?.find((candidate) => candidate.id === message.toolCallId);
    if (toolCall !== undefined) {
      try {
        const args = JSON.parse(toolCall.arguments === "" ? "{}" : toolCall.arguments) as Record<string, unknown>;
        if (typeof args.budget_per_person_yuan === "number" && Number.isFinite(args.budget_per_person_yuan)) {
          budgetPerPersonYuan = args.budget_per_person_yuan;
        }
      } catch {
        // 历史里的参数损坏不影响质量评估，只是不带预算口径
      }
    }
    return { path, ...(budgetPerPersonYuan === undefined ? {} : { budgetPerPersonYuan }) };
  }
  return null;
}

function adviseIssue(issue: QualityIssue): BudgetIssueAdvice {
  const advice = adviceFor(issue);
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(issue.day === undefined ? {} : { day: issue.day }),
    ...(issue.item_id === undefined ? {} : { item_id: issue.item_id }),
    category: advice.category,
    action: advice.action,
  };
}

function adviceFor(issue: QualityIssue): RepairRule {
  return REPAIR_RULES[issue.code] ?? {
    category: "edit",
    action: "按质量报告调整对应条目，重新保存后再做 strict 校验",
  };
}

const REPAIR_RULES: Record<string, RepairRule> = {
  "missing-location": { category: "tool", action: "用 geocode / search_attractions 补地点与坐标" },
  "missing-coordinates": { category: "tool", action: "从搜索工具返回结果逐字补齐经纬度" },
  "unverified-coordinates": {
    category: "uncertain",
    action: "坐标已标记待核实；若数据源仍查不到，追加轮次也无法保证解决",
  },
  "missing-source": { category: "tool", action: "补充实际使用的数据来源（如 amap / official）" },
  "missing-confidence": { category: "tool", action: "按搜索与交叉核验结果补置信度" },
  "missing-opening-hours": { category: "tool", action: "查询景点/餐厅开放时间并写入条目" },
  "outside-opening-hours": { category: "edit", action: "调整到开放时段内，或换同区域替代地点" },
  "closed-on-date": { category: "edit", action: "避开闭馆日，调整日期或替换景点" },
  "reservation-required": {
    category: "uncertain",
    action: "预约状态需要官方确认；继续搜索也未必能替用户完成预约",
  },
  "missing-time": { category: "edit", action: "补开始时间并重排当天时间线" },
  "timeline-gap": { category: "tool", action: "补交通/用餐/休息条目，或重排相邻活动" },
  "day-too-long": { category: "edit", action: "减少当天活动或拆分到其他天" },
  "remote-day-overpacked": {
    category: "edit",
    action: "按远郊日模板只保留 1 个主景点，最多增加主景点 20 公里内的 1 个轻量活动；返回市区后不再加景点",
  },
  "time-out-of-order": { category: "edit", action: "按实际时间重排条目" },
  "time-overlap": { category: "edit", action: "顺延或缩短冲突条目" },
  "missing-duration": { category: "edit", action: "补停留/交通时长并复核当天总时长" },
  "transfer-too-tight": { category: "tool", action: "用路线工具核对通勤时间并留足余量" },
  "long-transport": {
    category: "tool",
    action: "确认远郊/跨区路线耗时已留出缓冲；超过 150 分钟再拆分行程、换交通方式或更换住宿",
  },
  "spatial-gap": { category: "tool", action: "补交通段或按地理聚类重排当天景点" },
  "route-backtracking": { category: "tool", action: "结合路线核验按区域重排景点顺序" },
  "missing-transport-endpoints": { category: "edit", action: "补交通段的 from / to" },
  "cross-day-duplicate": { category: "edit", action: "把重复景点调整到单日，或注明重游理由" },
  "duplicate-place": { category: "edit", action: "合并或替换当天重复条目" },
  "no-activity": { category: "edit", action: "补当天游览安排，或压缩空壳行程日" },
  "title-day-mismatch": {
    category: "edit",
    action: "补齐缺失日期；仅在用户明确缩短行程时，才同步修改标题天数",
  },
  "budget-exceeded": { category: "edit", action: "下调门票/餐饮/住宿成本或替换高价项目" },
  "low-rating-visit": { category: "tool", action: "用口碑工具核对同区域更高分替代" },
};

function repairSummary(
  report: ItineraryQualityReport,
  fixableCount: number,
  uncertainCount: number,
  canImprove: boolean,
  potentialScore: number,
): string {
  const strictPass = report.issue_count.P0 === 0 && report.issue_count.P1 === 0;
  if (strictPass) {
    if (report.issue_count.P2 > 0) {
      return (
        `当前版本已通过 strict（P0/P1 为 0），仍有 ${report.issue_count.P2} 项 P2 提示，` +
        (canImprove
          ? `其中 ${fixableCount} 项可继续补全，理论上限约 ${potentialScore}/100；`
          : "这些提示主要依赖外部信息或人工确认；") +
        (canImprove && uncertainCount > 0
          ? `另有 ${uncertainCount} 项依赖外部确认；`
          : "") +
        "继续调用不是交付前置条件。"
      );
    }
    return report.meal_notes.length === 0
      ? "当前版本已通过质量校验，追加轮次不会提高硬性质量分，只会增加耗时与调用成本。"
      : `当前版本已通过质量校验；还有 ${report.meal_notes.length} 条餐饮参考可丰富，但不影响通过与否。`;
  }
  if (!canImprove) {
    return uncertainCount === 0
      ? "当前问题未必能通过重复调用工具改善，建议先由用户确认取舍。"
      : `剩余 ${uncertainCount} 项依赖外部信息或人工确认，额外调用工具未必能继续提高评分。`;
  }
  const uncertainNote =
    uncertainCount === 0
      ? ""
      : `；另有 ${uncertainCount} 项依赖外部信息或人工确认，追加轮次不保证解决`;
  return (
    `有 ${fixableCount} 项可通过工具补数据或重新排版修复，` +
    `理论上可把评分提升到约 ${potentialScore} / 100${uncertainNote}。`
  );
}

function statusLabel(status: ItineraryQualityReport["status"] | undefined): string {
  if (status === "ok") return "通过";
  if (status === "needs_confirmation") return "需人工确认";
  if (status === "needs_revision") return "需修改";
  if (status === "invalid") return "不可用";
  return "未知";
}
