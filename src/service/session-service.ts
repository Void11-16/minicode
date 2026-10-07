import { Session } from "../core/session.ts";
import { JsonFileSessionStore } from "../storage/session-store.ts";
import { ContextEpochManager, type CompactInfo } from "../context/epoch.ts";
import type { Message } from "../core/message.ts";

export interface SessionServiceOptions {
  /** 上下文压缩用的摘要器（通常走 LLM） */
  readonly summarize: (messages: readonly Message[]) => Promise<string>;
  /** resume 时历史超过该估算 token 数则自动压缩；0 = 永不压缩 */
  readonly resumeMaxTokens?: number;
  readonly keepRecent?: number;
}

export interface LoadResult {
  readonly session: Session;
  /** 压缩发生时的信息（未压缩为 undefined） */
  readonly compacted?: CompactInfo;
  /** 压缩失败的原因（此时返回未压缩的完整会话，不影响使用） */
  readonly compactionError?: string;
}

/**
 * 会话应用服务 —— 封装「加载 → 按需压缩 → 归档 → 回写」的业务编排。
 * CLI 命令层和未来的 HTTP API 都调用这一层，不各自实现。
 */
export class SessionService {
  private readonly store: JsonFileSessionStore;
  private readonly options: SessionServiceOptions;

  constructor(store: JsonFileSessionStore, options: SessionServiceOptions) {
    this.store = store;
    this.options = options;
  }

  get sessionStore(): JsonFileSessionStore {
    return this.store;
  }

  /** 加载会话；历史超过阈值时自动压缩为「摘要 + 最近消息」（归档原始数据） */
  async loadWithPrepare(id: string): Promise<LoadResult | null> {
    const session = await this.store.load(id);
    if (session === null) return null;

    const resumeMaxTokens = this.options.resumeMaxTokens ?? 8000;
    const messageCount = session.history.length;
    if (resumeMaxTokens <= 0 || session.estimateHistoryTokens() <= resumeMaxTokens || messageCount <= (this.options.keepRecent ?? 8)) {
      return { session };
    }

    try {
      const manager = new ContextEpochManager({
        maxPromptTokens: resumeMaxTokens,
        keepRecent: this.options.keepRecent ?? 8,
        summarize: this.options.summarize,
        archive: (target, epoch) => this.store.archive(target, epoch),
      });
      const compacted = await manager.maybeCompact(session);
      if (compacted !== null) {
        await this.store.save(session); // 压缩结果回写，下次恢复直接是轻量版
      }
      return { session, compacted: compacted ?? undefined };
    } catch (error) {
      // 摘要失败（如网络问题）→ 返回未压缩的完整会话，不影响使用
      return {
        session,
        compactionError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 持久化会话（轮次结束后调用） */
  async persist(session: Session): Promise<void> {
    await this.store.save(session);
  }
}
