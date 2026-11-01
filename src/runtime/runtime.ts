import { createExecutionBudget, type CumulativeToolBudget } from "../core/execution-budget.ts";
import type { RequestContextMetrics } from "../context/request.ts";
import { SessionScheduler } from "./scheduler.ts";
import { ContextEpochManager, type CompactInfo } from "../context/epoch.ts";
import {
  TurnAbortedError,
  type AgentEvent,
  type BudgetExhaustedDecision,
  type ChatAgent,
  type PermissionRequest,
} from "../agent/agent.ts";
import type { Message } from "../core/message.ts";
import type { Session } from "../core/session.ts";
import { debugLog } from "../util/logger.ts";
import { assessToolBudget, budgetGuidance, type ToolBudgetAssessment } from "./tool-budget.ts";

export type DeliveryMode = "steer" | "queue";

/** steer 注入立即返回的提示（消息本身在当前轮内被处理） */
export const STEERED_NOTE = "↪ 已注入当前执行轮";

/** 工具轮次默认预算（未按会话解析时） */
const DEFAULT_MAX_TOOL_ROUNDS = 30;
/**
 * 预算用尽后的续期步长与绝对上限（防止模型无限刷轮次）。
 * 长线行程（10 天以上）逐日搜索+保存+校验实测能用到 80+ 轮，
 * 所以上限放到 150：真不够时由用户逐次授权追加（至少 +15 轮）。
 */
const BUDGET_EXTENSION_STEP = 15;

export interface AgentRuntimeOptions {
  /** 上下文压缩用的摘要器（通常走 LLM）；session 是被压缩的会话，用于选对模型 */
  readonly summarize: (session: Session, messages: readonly Message[]) => Promise<string>;
  readonly maxPromptTokens?: number;
  readonly keepRecent?: number;
  readonly createBudget?: (session: Session) => CumulativeToolBudget;
  readonly onRequestContext?: (sessionId: string, metrics: RequestContextMetrics) => void;
  /**
   * 每轮的工具调用预算：固定值或按会话解析（可异步读需求单，按行程天数调整；
   * input 是本轮用户输入，首轮需求单还没落盘时可据此匹配已有需求单）。
   * 未提供时默认 30。
   */
  readonly maxToolRounds?: number | ((session: Session, input: string) => number | Promise<number>);
  /**
   * 工具预算用尽时交给宿主询问用户。
   * assessment 已包含当前已保存行程的质量报告、可修复性与建议追加轮数。
   * 返回 continue=true 后运行时按 assessment.suggestedAdditionalRounds 追加预算。
   */
  readonly onToolBudgetExhausted?: (
    sessionId: string,
    assessment: ToolBudgetAssessment,
  ) => BudgetExhaustedDecision | Promise<BudgetExhaustedDecision>;
  /** plans/ 与需求单所在目录；默认进程工作目录 */
  readonly rootDir?: string;
  /** 压缩前归档原始会话（数据安全） */
  readonly archive?: (session: Session, nextEpoch: number) => Promise<void>;
  /** 持久化检查点：会话历史在安全边界落盘（崩溃时最多丢进行中的半步） */
  readonly onCheckpoint?: (sessionId: string) => void | Promise<void>;
  readonly onEvent?: (sessionId: string, event: AgentEvent) => void;
  readonly onPermission?: (sessionId: string, request: PermissionRequest) => Promise<boolean>;
  readonly onTextDelta?: (sessionId: string, delta: string) => void;
  readonly onTurnStart?: (sessionId: string, input: string) => void;
  readonly onCompact?: (sessionId: string, info: CompactInfo) => void;
  readonly onTurnEnd?: (sessionId: string, reply: string) => void;
  readonly onTurnAborted?: (sessionId: string) => void;
  readonly onTurnError?: (sessionId: string, error: unknown) => void;
}

/**
 * Agent 运行时 —— 多会话并发执行的核心：
 *
 * - 不同 session：任务并发执行，各自的 Agent/Session 完全隔离
 * - 同一 session：任务串行合并（排队），历史写入不会交错损坏
 * - 投递模式:
 *   - queue  排队为下一个轮次（默认）
 *   - steer  注入当前正在执行的轮次 —— 在工具轮之间被模型看到，实时改变方向
 *     （若当前没有执行中的轮次，等同于 queue）
 * - 每次模型请求前按完整输入做 Context Epoch 检查
 */
export class AgentRuntime {
  private readonly scheduler = new SessionScheduler();
  private readonly agents = new Map<string, ChatAgent>();
  private readonly steerBuffers = new Map<string, string[]>();
  private readonly activeTurns = new Set<string>();
  private readonly epoch: ContextEpochManager;
  private readonly options: AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
    this.epoch = new ContextEpochManager({
      summarize: options.summarize,
      maxPromptTokens: options.maxPromptTokens,
      keepRecent: options.keepRecent,
      archive: options.archive,
    });
  }

  registerAgent(sessionId: string, agent: ChatAgent): void {
    this.agents.set(sessionId, agent);
  }

  getAgent(sessionId: string): ChatAgent | undefined {
    return this.agents.get(sessionId);
  }

  /** 会话被删除时移除其 Agent 与 steer 缓冲（删除前调用方已拦截执行中的会话） */
  unregisterAgent(sessionId: string): void {
    this.agents.delete(sessionId);
    this.steerBuffers.delete(sessionId);
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  /** 中断某会话正在执行的轮次；返回是否有可中断的轮次 */
  abortActiveTurn(sessionId: string): boolean {
    if (!this.activeTurns.has(sessionId)) return false;
    this.agents.get(sessionId)?.abort();
    return true;
  }

  send(sessionId: string, input: string, mode: DeliveryMode = "queue"): Promise<string> {
    const trimmed = input.trim();
    if (trimmed === "") {
      return Promise.reject(new Error("输入不能为空"));
    }

    // steer：当前轮正在执行 → 注入 steer 缓冲，本轮内生效
    if (mode === "steer" && this.activeTurns.has(sessionId)) {
      this.steerBuffer(sessionId).push(trimmed);
      return Promise.resolve(STEERED_NOTE);
    }

    // queue（或空闲时的 steer）：通过调度器排队执行
    return this.scheduler.submit(sessionId, () => this.runTurn(sessionId, trimmed));
  }

  private steerBuffer(sessionId: string): string[] {
    let buffer = this.steerBuffers.get(sessionId);
    if (buffer === undefined) {
      buffer = [];
      this.steerBuffers.set(sessionId, buffer);
    }
    return buffer;
  }

  private drainSteered(sessionId: string): string[] {
    const buffer = this.steerBuffers.get(sessionId);
    if (buffer === undefined || buffer.length === 0) return [];
    const drained = [...buffer];
    buffer.length = 0;
    return drained;
  }

  /** 解析本轮的工具轮次预算：支持按会话动态计算（如按需求单的行程天数） */
  private async resolveRoundLimit(session: Session, input: string): Promise<number> {
    const configured = this.options.maxToolRounds;
    if (configured === undefined) return DEFAULT_MAX_TOOL_ROUNDS;
    // 解析失败（需求单损坏等）按默认预算走，不能因为预算算不出来就让整轮报错
    try {
      const limit = typeof configured === "function" ? await configured(session, input) : configured;
      if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_MAX_TOOL_ROUNDS;
      return Math.floor(limit);
    } catch (error) {
      debugLog("runtime", `工具轮次预算解析失败，用默认 ${DEFAULT_MAX_TOOL_ROUNDS}: ${error instanceof Error ? error.message : String(error)}`);
      return DEFAULT_MAX_TOOL_ROUNDS;
    }
  }

  private async runTurn(sessionId: string, input: string, taskBudget?: CumulativeToolBudget): Promise<string> {
    debugLog("runtime", `turn 开始 session=${sessionId} input="${input.slice(0, 50)}"`);
    const agent = this.agents.get(sessionId);
    if (agent === undefined) {
      throw new Error(`会话 ${sessionId} 未注册 Agent`);
    }

    this.activeTurns.add(sessionId);
    try {
      this.options.onTurnStart?.(sessionId, input);
      // 由 Agent 在每次模型请求前按完整输入检查，而非仅在用户轮次开始时检查历史。

      // 工具轮次预算：先按会话需求解析（例如 7 天行程给更多轮）；
      // 用尽后暂停并让用户基于当前质量决定是否继续追加，绝对上限 150 轮
      taskBudget ??= this.options.createBudget?.(agent.session) ?? createExecutionBudget(agent.session);
      const resolvedLimit = Math.min(taskBudget.maxRounds, await this.resolveRoundLimit(agent.session, input));
      let limit = resolvedLimit;
      let previousFingerprint: string | undefined;
      const reply = await agent.run(input, {
        // 通用 agent 场景（读文件→改代码→跑测试→修）需要更多轮次；上限保护仍在
        maxToolRounds: () => limit,
        cumulativeBudget: taskBudget,
        onRequestContext: (metrics) => this.options.onRequestContext?.(sessionId, metrics),
        maxPromptTokens: this.options.maxPromptTokens,
        compactContext: async (tokens) => {
          const compact = await this.epoch.maybeCompact(agent.session, tokens);
          if (compact !== null) this.options.onCompact?.(sessionId, compact);
        },
        onBudgetExhausted: async (current) => {
          // 需求单可能在本次轮次里才落盘：重新解析一次，让续跑量跟得上真实行程工作量
          const refreshedLimit = await this.resolveRoundLimit(agent.session, input);
          const extensionStep = Math.max(BUDGET_EXTENSION_STEP, refreshedLimit - current);
          const assessment = await assessToolBudget({
            rootDir: this.options.rootDir ?? process.cwd(),
            session: agent.session,
            initialLimit: resolvedLimit,
            currentLimit: current,
            ceiling: taskBudget!.maxRounds,
            extensionStep,
            previousFingerprint,
          });
          previousFingerprint = assessment.fingerprint;
          const decision = this.options.onToolBudgetExhausted === undefined
            ? { continue: false }
            : await this.options.onToolBudgetExhausted(sessionId, assessment);
          if (!decision.continue || assessment.suggestedAdditionalRounds <= 0) {
            return {
              ...decision,
              continue: false,
              guidance:
                decision.guidance ??
                (assessment.canContinue
                  ? "用户选择按当前结果交付。请明确当前已保存到哪一步、质量评分和仍未关闭的问题；" +
                    "不要声称 strict 校验已通过，也不要再请求调用工具。"
                  : `已达到 ${assessment.ceiling} 轮工具调用硬上限，系统将按当前结果交付。` +
                    "请明确当前已保存到哪一步、质量评分和仍未关闭的问题；" +
                    "不要声称 strict 校验已通过，也不要再请求调用工具。"),
            };
          }
          const next = Math.min(
            taskBudget!.maxRounds,
            current + assessment.suggestedAdditionalRounds,
          );
          if (next <= current) return { continue: false };
          limit = next;
          return {
            continue: true,
            guidance:
              `${budgetGuidance(assessment)}\n\n` +
              `用户已授权把工具预算从 ${current} 轮追加到 ${next} 轮。`,
          };
        },
        onCheckpoint: () => this.options.onCheckpoint?.(sessionId),
        onEvent: (event) => this.options.onEvent?.(sessionId, event),
        onPermission: (request) =>
          this.options.onPermission?.(sessionId, request) ?? Promise.resolve(true),
        onTextDelta: (delta) => this.options.onTextDelta?.(sessionId, delta),
        takeSteeredMessages: () => this.drainSteered(sessionId),
      });

      // steer 消息到达太晚（模型已给出最终回复）→ 自动转为下一轮排队执行
      const leftover = this.drainSteered(sessionId);
      if (leftover.length > 0) {
        this.scheduler
          .submit(sessionId, () => this.runTurn(sessionId, leftover.join("\n"), taskBudget))
          .catch(() => {
            // 错误已通过 onTurnError 上报，这里避免未处理的 rejection
          });
      }

      this.options.onTurnEnd?.(sessionId, reply);
      debugLog("runtime", `turn 完成 session=${sessionId}`);
      return reply;
    } catch (error) {
      debugLog("runtime", `turn 失败 session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof TurnAbortedError) {
        // 中断时丢弃残留的 steer 消息，避免自动触发下一轮（与本轮意图矛盾）
        this.drainSteered(sessionId);
        this.options.onTurnAborted?.(sessionId);
        throw error;
      }
      this.options.onTurnError?.(sessionId, error);
      throw error;
    } finally {
      this.activeTurns.delete(sessionId);
    }
  }
}
