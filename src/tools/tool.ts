import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolParameters } from "../llm/provider.ts";
import { isCompactedToolArguments } from "../core/message.ts";
import { TravelEvidenceStore, evidenceId } from "./travel-evidence.ts";
import type { Itinerary } from "./itinerary-schema.ts";
import type { ItineraryQualityReport } from "./itinerary-validator.ts";

export interface ItinerarySnapshot {
  readonly itinerary: Itinerary;
  readonly report: ItineraryQualityReport;
  readonly file: string;
}

export type { ToolParameters };
export type { ToolDefinition };
export { isCompactedToolArguments };

/** 参数校验：要求非空字符串 */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少或非法参数 ${key}（需要非空字符串）`);
  }
  return value.trim();
}

/** 参数校验：要求有效数字 */
export function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`缺少或非法参数 ${key}（需要数字）`);
  }
  return value;
}

/** 校验 absolute 路径在 rootDir 内（relative 判断，防 /root 与 /root-evil 前缀绕过） */
export function assertInsideRoot(rootDir: string, absolute: string): void {
  const root = resolve(rootDir);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`安全限制: 只能访问 ${root} 目录内的路径`);
  }
}

/** 单次工具调用的运行上下文：工作区（文件/命令的根）与中断信号 */
export interface ToolContext {
  /** 本次调用所属会话的工作区；文件类工具与 bash 以此为根 */
  readonly workspace: string;
  /** 中断信号（/stop）：长任务（如 bash）应立即终止 */
  readonly signal?: AbortSignal;
  readonly destination?: string;
  readonly brief?: import("../core/travel-state.ts").TravelBriefState;
  readonly evidence?: TravelEvidenceStore;
  readonly onItinerary?: (snapshot: ItinerarySnapshot) => void;
}

export interface Tool {
  readonly recordsPlaceEvidence?: boolean;
  readonly name: string;
  /** 给 LLM 看的描述：决定模型何时、如何使用这个工具 */
  readonly description: string;
  readonly parameters: ToolParameters;
  /** 工具目录分类；未分类的第三方工具会被视为常驻，兼容现有扩展 */
  readonly category?: ToolCategory;
  /** 目录检索词；不要用它们替代 description */
  readonly keywords?: readonly string[];
  /** 常驻工具：每个请求都发送完整定义，只用于极小且高频的核心能力 */
  readonly alwaysActive?: boolean;
  /** 返回结果类型，供裁剪结果和模型快速判断数据结构 */
  readonly outputKind?: ToolOutputKind;
  /** 执行工具，返回 LLM 可读的文本结果（出错时 throw，由 Agent 捕获回传） */
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string>;

  /** 执行前需要用户确认（写文件、读敏感文件等有副作用的操作） */
  readonly requiresConfirmation?: boolean;

  /**
   * 动态确认判断（按参数决定，如 bash 只读命令免确认）。
   * 存在时优先于 requiresConfirmation；返回 true 表示需要用户确认。
   */
  needsConfirmation?(args: Record<string, unknown>): boolean;

  /** 是否允许「本次会话总是允许」选项（bash 等高风险工具应设 false，保持逐条确认） */
  readonly sessionAlwaysAllowed?: boolean;

  /** 工作区内文件写入类工具：审批模式为「自动编辑」时免确认 */
  readonly workspaceEdit?: boolean;

  /** 确认时展示给用户看的人类可读描述 */
  confirmationMessage?(args: Record<string, unknown>): string;
}

export type ToolCategory =
  | "workspace"
  | "travel-basics"
  | "discovery"
  | "routing"
  | "itinerary"
  | "traveler";

export type ToolOutputKind =
  | "file"
  | "command"
  | "place-list"
  | "route"
  | "itinerary"
  | "validation"
  | "weather"
  | "profile"
  | "generic";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  readonly evidence: TravelEvidenceStore;
  private readonly defaultWorkspace: string;
  constructor(root?: string, workspace?: string) { this.evidence = new TravelEvidenceStore(root); this.defaultWorkspace = workspace ?? root ?? process.cwd(); }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  /** 导出为 LLM API 的 tools 参数；省略 names 时导出全部（MCP 等场景） */
  definitions(names?: ReadonlySet<string>): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => names === undefined || names.has(tool.name))
      .map(({ name, description, parameters }) => ({
        name,
        description: toolOutputDescription(description, this.tools.get(name)),
        parameters,
      }));
  }

  /**
   * 按名称执行工具。参数是 LLM 给的原始 JSON 字符串。
   * 工具不存在或参数非法都会抛错——Agent 会把错误文本回传给模型。
   */
  async execute(name: string, argsJson: string, ctx?: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`工具不存在: ${name}（可用: ${[...this.tools.keys()].join(", ")}）`);
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson === "" ? "{}" : argsJson) as Record<string, unknown>;
    } catch {
      throw new Error(`参数不是合法 JSON: ${argsJson.slice(0, 200)}`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("参数必须是 JSON 对象");
    }
    if (args._truncated === true) {
      throw new Error(
        "参数是会话历史压缩占位符（_truncated），工具未执行；" +
        "请重新读取当前数据并按工具 schema 构造完整参数，不要把占位符原样再次提交",
      );
    }

    ctx?.signal?.throwIfAborted();
    const context = { workspace: ctx?.workspace ?? this.defaultWorkspace, ...ctx, evidence: ctx?.evidence ?? this.evidence };
    const destination = context.destination;
    if (destination !== undefined) {
      if (name === "search_attractions" || name === "get_place_reviews") args.city = destination;
      if (name === "search_stays" || name === "search_restaurants") args.region = destination;
      if (name === "geocode" || name === "plan_day_routes" || name === "get_weather") args.city = destination;
    }
    const cacheable = ["search_attractions", "search_stays", "search_restaurants", "get_place_reviews", "get_weather", "plan_day_routes"].includes(name);
    const key = evidenceId([name, Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))]);
    const cached = cacheable ? context.evidence.cached(key) : undefined;
    if (cached !== undefined) return cached;
    let output = await tool.execute(args, context);
    context.signal?.throwIfAborted();
    if (!tool.recordsPlaceEvidence && ["search_attractions", "search_stays", "search_restaurants"].includes(name)) {
      const city = String(args.region ?? (name === "search_attractions" ? args.city : destination) ?? args.city ?? args.location ?? "");
      output = await context.evidence.observePlaces(name, city, output);
    }
    if (name === "get_place_reviews" && typeof args.city === "string" && typeof args.place === "string") output = await context.evidence.observeClosure(args.city, args.place, output);
    if (cacheable && !/未找到|失败|不可用|没有.*(?:餐厅|景点)/.test(output)) context.evidence.cache(key, output);
    return output;
  }
}

function toolOutputDescription(description: string, tool: Tool | undefined): string {
  if (tool?.outputKind === undefined) return description;
  return `${description}\n返回结构类型：${tool.outputKind}`;
}
