import type { Session } from "../core/session.ts";
import { bashApprovalKey, matchesBashApprovalKey } from "../tools/bash.ts";
import type { Tool } from "../tools/tool.ts";

/**
 * 审批策略 —— CLI 与 Web 的单一事实来源。
 *
 * 两端只保留「怎么问」（终端提问 / SSE 弹窗），
 * 「允不允许、要不要问、记住什么」全部走 decidePermission。
 * 策略若要在两处各写一份，改动漏一处就会漂移（历史上确实发生过）。
 */

export type ApprovalMode = "ask" | "edits" | "trust";

/** 每个会话的审批记忆（两端都按会话 id 持有，语义一致） */
export interface PermissionMemory {
  /** 本会话「总是允许」的工具名 */
  readonly alwaysTools: Set<string>;
  /** 本会话批准过的 bash 命令前缀（匹配规则见 matchesBashApprovalKey） */
  readonly bashKeys: Set<string>;
}

export function createPermissionMemory(): PermissionMemory {
  return { alwaysTools: new Set<string>(), bashKeys: new Set<string>() };
}

/** 会话当前生效的审批模式：trust（内存标记）> 会话持久值（默认 edits） */
export function permissionModeOf(session: Session, trusted: boolean): ApprovalMode {
  if (trusted) return "trust";
  return session.approvalMode;
}

export interface PermissionDecision {
  readonly kind: "allow" | "ask";
  /** ask 时：用户选「总是允许命令」要记住的前缀（仅 bash；空串 = 不适用） */
  readonly commandKey: string;
  /** ask 时：是否提供「本次会话总是允许」选项（bash 等高风险工具为 false） */
  readonly canAlways: boolean;
}

export interface DecidePermissionInput {
  readonly toolName: string;
  /** 注册表里的工具定义；未注册时为 undefined，按静态信息降级判断 */
  readonly tool: Tool | undefined;
  /** LLM 给的原始 JSON 参数（用于提取 bash command） */
  readonly arguments: string | undefined;
  readonly mode: ApprovalMode;
  readonly memory: PermissionMemory;
}

/** 判断一次工具调用是否直接放行（调用方只在「需要确认」的工具上调用它） */
export function decidePermission(input: DecidePermissionInput): PermissionDecision {
  if (input.mode === "trust") return ALLOW;
  if (input.memory.alwaysTools.has(input.toolName)) return ALLOW;

  const command = bashCommandOf(input.arguments);
  if (
    input.toolName === "bash" &&
    command !== "" &&
    [...input.memory.bashKeys].some((key) => matchesBashApprovalKey(command, key))
  ) {
    return ALLOW;
  }

  // 自动编辑模式：工作区文件写入类工具免确认
  if (input.mode === "edits" && input.tool?.workspaceEdit === true) return ALLOW;

  const commandKey = input.toolName === "bash" && command !== "" ? bashApprovalKey(command) : "";
  const canAlways = input.toolName !== "bash" && input.tool?.sessionAlwaysAllowed !== false;
  return { kind: "ask", commandKey, canAlways };
}

const ALLOW: PermissionDecision = { kind: "allow", commandKey: "", canAlways: false };

/** 从原始参数里提取 bash command；非 JSON / 无 command 字段返回空串 */
function bashCommandOf(argsJson: string | undefined): string {
  if (argsJson === undefined || argsJson === "") return "";
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    return typeof args.command === "string" ? args.command : "";
  } catch {
    return "";
  }
}
