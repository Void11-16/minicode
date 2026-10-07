import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolParameters } from "../llm/provider.ts";

export type { ToolParameters };
export type { ToolDefinition };

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

export interface Tool {
  readonly name: string;
  /** 给 LLM 看的描述：决定模型何时、如何使用这个工具 */
  readonly description: string;
  readonly parameters: ToolParameters;
  /** 执行工具，返回 LLM 可读的文本结果（出错时 throw，由 Agent 捕获回传） */
  execute(args: Record<string, unknown>): Promise<string>;

  /** 执行前需要用户确认（写文件、读敏感文件等有副作用的操作） */
  readonly requiresConfirmation?: boolean;

  /** 确认时展示给用户看的人类可读描述 */
  confirmationMessage?(args: Record<string, unknown>): string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

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

  /** 导出为 LLM API 的 tools 参数 */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /**
   * 按名称执行工具。参数是 LLM 给的原始 JSON 字符串。
   * 工具不存在或参数非法都会抛错——Agent 会把错误文本回传给模型。
   */
  async execute(name: string, argsJson: string): Promise<string> {
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

    return tool.execute(args);
  }
}
