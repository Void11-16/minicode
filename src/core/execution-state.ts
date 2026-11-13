/** 执行结果与业务提交结果分开：取消/超时不代表外部修改已撤销。 */
export interface ToolExecutionState {
  readonly execution_status: "succeeded" | "failed" | "cancelled";
  readonly effect_status: "none" | "not_committed" | "committed" | "partial" | "unknown";
  readonly recovery_action: "none" | "fix_arguments" | "reread" | "retry" | "reconcile" | "manual_review" | "rebuild_exports";
  readonly operation_id?: string;
  readonly blocked_by_operation_id?: string;
  readonly code?: string;
  readonly message?: string;
  readonly replayed?: boolean;
  readonly exports_pending?: boolean;
}

export interface ExecutionContext {
  /** 宿主生成，重试同一操作时沿用；新意图使用新 ID，不能只按参数去重。 */
  readonly operationId?: string;
  /** Web 等回调型写入口提供原始业务参数，用于操作 ID 一致性核对。 */
  readonly operationRequest?: unknown;
  readonly onExecution?: (state: ToolExecutionState) => void;
}

/** 状态观察回调不能改变已经发生的提交，也不能掩盖原始失败。 */
export function reportExecution(context: ExecutionContext | undefined, state: ToolExecutionState): void {
  try { context?.onExecution?.(state); } catch { /* 观察失败不重做业务操作。 */ }
}

const states = new WeakMap<object, ToolExecutionState>();
export function attachExecutionState(error: unknown, state: ToolExecutionState): void {
  if (error && typeof error === "object") states.set(error, state);
}
export function executionStateOf(error: unknown): ToolExecutionState | undefined {
  return error && typeof error === "object" ? states.get(error) : undefined;
}
export class ToolExecutionError extends Error {
  constructor(state: ToolExecutionState) {
    super(state.message ?? state.code ?? "工具执行失败");
    this.name = "ToolExecutionError";
    attachExecutionState(this, state);
  }
}
