import { Session } from "../core/session.ts";
import { JsonFileSessionStore } from "../storage/session-store.ts";

/**
 * 会话应用服务 —— 持久化接缝（CLI 命令层与 HTTP API 共用）。
 * CLI 命令层和未来的 HTTP API 都调用这一层，不各自实现。
 *
 * 注意：恢复会话（/resume）刻意不做同步压缩——压缩会调用 LLM（数秒），
 * 放在切换路径上会让界面卡顿；上下文压缩统一交给 AgentRuntime 在轮次
 * 开始时执行（安全串行，且不阻塞界面操作）。
 */
export class SessionService {
  private readonly store: JsonFileSessionStore;

  constructor(store: JsonFileSessionStore) {
    this.store = store;
  }

  get sessionStore(): JsonFileSessionStore {
    return this.store;
  }

  /** 持久化会话（轮次结束后调用） */
  async persist(session: Session): Promise<void> {
    await this.store.save(session);
  }
}
