import { SessionScheduler } from "./scheduler.ts";
import { ContextEpochManager, type CompactInfo } from "../context/epoch.ts";
import { TurnAbortedError, type AgentEvent, type ChatAgent, type PermissionRequest } from "../agent/agent.ts";
import type { Message } from "../core/message.ts";
import type { Session } from "../core/session.ts";
import { debugLog } from "../util/logger.ts";

export type DeliveryMode = "steer" | "queue";

/** steer 注入立即返回的提示（消息本身在当前轮内被处理） */
export const STEERED_NOTE = "↪ 已注入当前执行轮";

export interface AgentRuntimeOptions {
  /** 上下文压缩用的摘要器（通常走 LLM） */
  readonly summarize: (messages: readonly Message[]) => Promise<string>;
  readonly maxPromptTokens?: number;
  readonly keepRecent?: number;
  readonly maxToolRounds?: number;
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
 * - 每轮开始前做 Context Epoch 检查，历史过大时自动压缩
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

  private async runTurn(sessionId: string, input: string): Promise<string> {
    debugLog("runtime", `turn 开始 session=${sessionId} input="${input.slice(0, 50)}"`);
    const agent = this.agents.get(sessionId);
    if (agent === undefined) {
      throw new Error(`会话 ${sessionId} 未注册 Agent`);
    }

    this.activeTurns.add(sessionId);
    try {
      this.options.onTurnStart?.(sessionId, input);
      // Context Epoch：历史过大时先压缩再开跑
      const compact = await this.epoch.maybeCompact(agent.session);
      if (compact !== null) {
        this.options.onCompact?.(sessionId, compact);
      }

      const reply = await agent.run(input, {
        // 通用 agent 场景（读文件→改代码→跑测试→修）需要更多轮次；上限保护仍在
        maxToolRounds: this.options.maxToolRounds ?? 30,
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
          .submit(sessionId, () => this.runTurn(sessionId, leftover.join("\n")))
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
