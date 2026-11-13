import { executionStateOf, ToolExecutionError } from "./execution-state.ts";
/** 可供模型与调用方定位、修正的参数校验问题；path 使用工具参数路径。 */
export interface ToolValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly hint: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly date?: string;
  readonly item_id?: string;
  readonly item_name?: string;
}

export class ToolValidationError extends Error {
  readonly code: string;
  readonly issues: readonly ToolValidationIssue[];

  constructor(issues: readonly ToolValidationIssue[]) {
    super(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n") + "；未提交任何修改。");
    this.name = "ToolValidationError";
    this.code = issues.length === 1 ? issues[0]!.code : "TOOL_VALIDATION_FAILED";
    this.issues = issues;
  }
}

/** 保留既有 error 字符串字段，已知校验错误附加稳定类型、错误码和定位信息。 */
export function toolErrorPayload(error: unknown) {
  const state = executionStateOf(error);
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(state ? { execution_state: state, ...(error instanceof ToolValidationError ? {} : { error_type: "execution" as const, code: state.code }) } : {}),
    ...(error instanceof ToolValidationError ? { error_type: "validation" as const, code: error.code, issues: error.issues } : {}),
  };
}

/** Agent 与 MCP 使用相同错误正文；普通异常仍沿用已有文本格式。 */
export function toolErrorOutput(error: unknown): string {
  if (error instanceof ToolValidationError || error instanceof ToolExecutionError) return JSON.stringify(toolErrorPayload(error));
  const state = executionStateOf(error);
  return `工具执行失败: ${toolErrorPayload(error).error}${state ? `\nexecution_state: ${JSON.stringify(state)}` : ""}`;
}
