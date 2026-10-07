import { createMessage, type Message } from "../core/message.ts";
import type { Session } from "../core/session.ts";

export interface CompactInfo {
  readonly sessionId: string;
  /** 压缩后进入的新纪元编号 */
  readonly epoch: number;
  readonly removedMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface EpochOptions {
  /** 触发压缩的估算 token 阈值，默认 24000 */
  readonly maxPromptTokens?: number;
  /** 压缩时保留最近 N 条消息不压缩，默认 8 */
  readonly keepRecent?: number;
  /** 摘要器：把旧消息压缩成一段文字（通常由 LLM 完成） */
  readonly summarize: (messages: readonly Message[]) => Promise<string>;
  /**
   * 压缩前归档回调：在历史被替换前保存原始会话。
   * 归档失败会中止压缩（数据安全优先，宁可不做压缩也不丢数据）。
   */
  readonly archive?: (session: Session, nextEpoch: number) => Promise<void>;
}

/** 粗略 token 估算：中文约 1 token/字，英文约 4 字符/token，默认按 0.7 系数 */
export function estimateTokens(text: string, factor: number = 0.7): number {
  return Math.ceil(text.length * factor);
}

export function estimateHistoryTokens(
  messages: readonly Message[],
  factor: number = 0.7,
): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content, factor) + 4, 0);
}

/**
 * Context Epoch 管理：
 * - 每轮开始前检查历史 token 估算值，超过阈值就把旧消息压缩成摘要
 * - 压缩后开启新纪元（epoch+1），新前缀保持稳定 → 服务端前缀缓存可命中
 *   （DeepSeek 自动缓存相同前缀，命中部分计费大幅下降）
 * - 旧消息不再随每次请求重复发送，防止 token 随对话变长而暴涨
 */
export class ContextEpochManager {
  private readonly maxPromptTokens: number;
  private readonly keepRecent: number;
  private readonly summarize: EpochOptions["summarize"];
  private readonly archive: EpochOptions["archive"];

  constructor(options: EpochOptions) {
    this.maxPromptTokens = options.maxPromptTokens ?? 24_000;
    this.keepRecent = options.keepRecent ?? 8;
    this.summarize = options.summarize;
    this.archive = options.archive;
  }

  async maybeCompact(session: Session): Promise<CompactInfo | null> {
    // 使用会话自身的校准系数（由真实 usage 持续修正）
    const tokensBefore = session.estimateHistoryTokens();
    if (tokensBefore <= this.maxPromptTokens) {
      return null;
    }
    if (session.history.length <= this.keepRecent) {
      return null; // 历史太短，压缩无意义
    }

    const oldMessages = session.history.slice(0, -this.keepRecent);
    const recent = session.history.slice(-this.keepRecent);

    const nextEpoch = session.epoch + 1;
    // 先归档原始历史（失败则中止，宁可不做压缩也不丢数据），再花 LLM 调用做摘要
    if (this.archive !== undefined) {
      await this.archive(session, nextEpoch);
    }

    const summary = await this.summarize(oldMessages);
    const summaryMessage = createMessage(
      "system",
      `【上下文摘要 | 第 ${nextEpoch} 纪元】以下是对本会话较早对话的压缩摘要，代替原始消息：\n${summary}`,
    );

    session.replaceHistory([summaryMessage, ...recent], nextEpoch);

    return {
      sessionId: session.id,
      epoch: nextEpoch,
      removedMessages: oldMessages.length,
      tokensBefore,
      tokensAfter: session.estimateHistoryTokens(),
    };
  }
}
