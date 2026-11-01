import type { ToolDefinition } from "../llm/provider.ts";
import type { Session } from "../core/session.ts";
import type { Tool, ToolCategory, ToolRegistry } from "./tool.ts";

export const TOOL_SEARCH_NAME = "find_tools";
export const TOOL_ACTIVATE_NAME = "activate_tools";
export const TOOL_DEACTIVATE_NAME = "deactivate_tools";
export const MAX_ACTIVE_TOOLS = 12;

export const TOOL_ACTIVATION_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_SEARCH_NAME,
    description:
      "按任务、关键词或分类查找尚未加载的工具。工具采用按需加载，先查目录再用 activate_tools 激活；返回名称、分类和用途。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "任务或关键词，例如：景点口碑、路线、保存行程、文件编辑。可选" },
        category: {
          type: "string",
          enum: ["workspace", "travel-basics", "discovery", "routing", "itinerary", "traveler"],
          description: "按分类筛选，可选",
        },
        limit: { type: "number", description: "最多返回多少个工具，默认 10，最大 20" },
      },
    },
  },
  {
    name: TOOL_ACTIVATE_NAME,
    description:
      "激活本次任务需要的工具，激活后下一轮模型请求会收到完整参数定义。优先按分类激活；每会话最多 12 个可选工具。",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description: "要激活的工具名",
        },
        categories: {
          type: "array",
          items: {
            type: "string",
            enum: ["workspace", "travel-basics", "discovery", "routing", "itinerary", "traveler"],
          },
          description: "要激活的工具分类",
        },
        max: {
          type: "number",
          description: `本次最多激活数量，默认 ${MAX_ACTIVE_TOOLS}，不能超过 ${MAX_ACTIVE_TOOLS}`,
        },
      },
    },
  },
  {
    name: TOOL_DEACTIVATE_NAME,
    description: "卸载不再需要的可选工具以缩小上下文。常驻工具和第三方未分类工具不能卸载。",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description: "要卸载的工具名",
        },
        categories: {
          type: "array",
          items: {
            type: "string",
            enum: ["workspace", "travel-basics", "discovery", "routing", "itinerary", "traveler"],
          },
          description: "要卸载的工具分类",
        },
      },
    },
  },
];

export function isActivationTool(name: string): boolean {
  return (
    name === TOOL_SEARCH_NAME ||
    name === TOOL_ACTIVATE_NAME ||
    name === TOOL_DEACTIVATE_NAME
  );
}

/** 未分类工具和显式 alwaysActive 工具不由目录状态控制 */
export function isAlwaysActiveTool(tool: Tool, session?: Session): boolean {
  return tool.alwaysActive === true || (tool.alwaysActive === "travel" && session?.travelMode === true) || (tool.alwaysActive !== "travel" && tool.category === undefined);
}

export function activeToolNames(registry: ToolRegistry, session: Session): ReadonlySet<string> {
  const names = new Set(activeOptionalToolNames(registry, session));
  for (const tool of registry.list()) {
    if (isAlwaysActiveTool(tool, session)) names.add(tool.name);
  }
  return names;
}

/** 模型直接调用未加载的可选工具时，自动激活以便后续轮次拿到完整定义。 */
export function activateToolForUse(
  tool: Tool,
  registry: ToolRegistry,
  session: Session,
): boolean {
  if (isAlwaysActiveTool(tool, session) || session.activeTools.includes(tool.name)) return true;
  const active = activeOptionalToolNames(registry, session);
  if (active.size >= MAX_ACTIVE_TOOLS) return false;
  session.setActiveTools([...active, tool.name]);
  return true;
}

export function executeToolCatalog(
  name: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
  session: Session,
): string {
  if (name === TOOL_SEARCH_NAME) return findTools(args, registry, session);
  if (name === TOOL_ACTIVATE_NAME) return activateTools(args, registry, session);
  return deactivateTools(args, registry, session);
}

export function toolLoadingGuide(registry: ToolRegistry, session: Session): string | undefined {
  const inactiveCount = registry.list().filter(
    (tool) => !isAlwaysActiveTool(tool, session) && !session.activeTools.includes(tool.name),
  ).length;
  if (inactiveCount === 0) return undefined;
  const active = [...activeToolNames(registry, session)];
  return (
    "【工具按需加载】完整工具定义只对已激活工具提供。" +
    `当前已激活：${active.join("、") || "无"}。` +
    "缺少能力时先调用 find_tools 查目录，再调用 activate_tools 激活；完成后可用 deactivate_tools 卸载。" +
    `每会话最多 ${MAX_ACTIVE_TOOLS} 个可选工具，不要激活与本任务无关的分类。`
  );
}

function findTools(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  session: Session,
): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const category = validCategory(args.category);
  const limit = clamp(Math.floor(typeof args.limit === "number" ? args.limit : 10), 1, 20);
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const matches = registry.list()
    .filter((tool) => category === undefined || tool.category === category)
    .map((tool) => ({ tool, score: toolScore(tool, terms, session.activeTools.includes(tool.name)) }))
    .filter((entry) => query === "" || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  if (matches.length === 0) {
    return `没有找到匹配工具${query === "" ? "" : `：${query}`}。可改用更短关键词或指定 category。`;
  }

  const visible = matches.slice(0, limit);
  const categories = [...new Set(registry.list().flatMap((tool) => tool.category === undefined ? [] : [tool.category]))];
  return [
    `工具目录（显示 ${visible.length}/${matches.length}，共 ${registry.size} 个）：`,
    ...visible.map(({ tool }) => {
      const state = session.activeTools.includes(tool.name) ? "已激活" : isAlwaysActiveTool(tool, session) ? "常驻" : "未激活";
      return (
        `- ${tool.name} [${tool.category ?? "extension"} / ${state} / ` +
        `${tool.outputKind ?? "generic"}] ${tool.description.slice(0, 100)}`
      );
    }),
    `可激活分类：${categories.join("、") || "无"}。`,
  ].join("\n");
}

function activateTools(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  session: Session,
): string {
  const max = clamp(Math.floor(typeof args.max === "number" ? args.max : MAX_ACTIVE_TOOLS), 1, MAX_ACTIVE_TOOLS);
  const requestedNames = stringArray(args.tools);
  const requestedCategories = new Set(arrayValue(args.categories).flatMap((value) => {
    const category = validCategory(value);
    return category === undefined ? [] : [category];
  }));
  const candidates = registry.list().filter((tool) =>
    !isAlwaysActiveTool(tool, session) && (
      requestedNames.includes(tool.name) ||
      (tool.category !== undefined && requestedCategories.has(tool.category))
    )
  );
  if (candidates.length === 0) {
    return "没有找到要激活的工具。请先调用 find_tools 获取准确的工具名或分类。";
  }

  const activeNames = activeOptionalToolNames(registry, session);
  const alreadyActive = candidates.filter((tool) => activeNames.has(tool.name));
  const activatable = candidates.filter((tool) => !activeNames.has(tool.name));
  const capacity = Math.max(0, MAX_ACTIVE_TOOLS - activeNames.size);
  const selected = activatable.slice(0, Math.min(max, capacity));
  const actual = [...alreadyActive, ...selected];
  session.setActiveTools([...new Set([...activeNames, ...selected.map((tool) => tool.name)])]);
  const omitted = activatable.slice(selected.length);
  return [
    actual.length === 0
      ? `可选工具已达上限 ${MAX_ACTIVE_TOOLS} 个，请先用 deactivate_tools 卸载不用的工具。`
      : `已激活 ${actual.map((tool) => tool.name).join("、")}；下一轮请求起提供完整参数定义。`,
    ...(omitted.length > 0
      ? [`另有 ${omitted.length} 个工具未激活：${omitted.map((tool) => tool.name).join("、")}。`]
      : []),
    `当前会话可选工具 ${activeNames.size + selected.length}/${MAX_ACTIVE_TOOLS} 个。`,
  ].join("\n");
}

function deactivateTools(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  session: Session,
): string {
  const names = new Set(stringArray(args.tools));
  const categories = new Set(arrayValue(args.categories).flatMap((value) => {
    const category = validCategory(value);
    return category === undefined ? [] : [category];
  }));
  const removable = registry.list()
    .filter((tool) => !isAlwaysActiveTool(tool, session))
    .filter((tool) => names.has(tool.name) || (tool.category !== undefined && categories.has(tool.category)))
    .map((tool) => tool.name);
  if (removable.length === 0) return "没有可卸载的匹配工具。";
  const removed = new Set(removable);
  session.setActiveTools(session.activeTools.filter((name) => !removed.has(name)));
  const activeCount = activeOptionalToolNames(registry, session).size;
  return `已卸载：${removable.join("、")}。当前会话可选工具 ${activeCount}/${MAX_ACTIVE_TOOLS} 个。`;
}

function activeOptionalToolNames(registry: ToolRegistry, session: Session): Set<string> {
  const names = new Set<string>();
  for (const name of session.activeTools) {
    const tool = registry.get(name);
    if (tool === undefined || isAlwaysActiveTool(tool, session) || names.has(name)) continue;
    names.add(name);
    if (names.size >= MAX_ACTIVE_TOOLS) break;
  }
  return names;
}

function toolScore(tool: Tool, terms: readonly string[], active: boolean): number {
  if (terms.length === 0) return active ? 1 : 0;
  const name = tool.name.toLowerCase();
  const haystack = [
    tool.name,
    tool.description,
    tool.category ?? "",
    ...(tool.keywords ?? []),
  ].join(" ").toLowerCase();
  return terms.reduce((score, term) => {
    if (name === term) return score + 20;
    if (name.includes(term)) return score + 8;
    if ((tool.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(term))) return score + 5;
    if (haystack.includes(term)) return score + 2;
    return score;
  }, active ? 1 : 0);
}

function validCategory(value: unknown): ToolCategory | undefined {
  return value === "workspace" ||
    value === "travel-basics" ||
    value === "discovery" ||
    value === "routing" ||
    value === "itinerary" ||
    value === "traveler"
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
