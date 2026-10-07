import { randomBytes } from "node:crypto";
import { createMessage, type Message, type PromptMessage } from "./message.ts";
import { EMPTY_USAGE, type TokenUsage, type UsageSummary } from "./usage.ts";
import { TokenEstimator } from "./token-estimator.ts";

/**
 * 会话状态：维护消息历史。
 * 职责单一 —— 只管历史，不管 LLM 怎么调用。
 */
export class Session {
  readonly id: string;
  private messages: Message[] = [];
  private usageSummary: UsageSummary = EMPTY_USAGE;
  private epochNumber = 0;
  private titleValue: string | undefined;
  private modelProfileValue: string | undefined;
  private readonly estimator = new TokenEstimator();

  constructor(id: string = defaultSessionId(), initialMessages: readonly Message[] = []) {
    this.id = id;
    this.messages = [...initialMessages];
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  get usage(): UsageSummary {
    return this.usageSummary;
  }

  /** 当前上下文纪元编号（每次压缩 +1，随会话持久化） */
  get epoch(): number {
    return this.epochNumber;
  }

  /** 会话标题：自动取第一条用户消息（Epoch 压缩后仍保持稳定） */
  get title(): string {
    return this.titleValue ?? "(空会话)";
  }

  /** 手动重命名（/rename 命令用） */
  rename(title: string): void {
    const trimmed = title.replace(/\s+/g, " ").trim().slice(0, 40);
    if (trimmed === "") {
      throw new Error("标题不能为空");
    }
    this.titleValue = trimmed;
  }

  /** 本会话使用的模型配置 id（多模型按会话选择；undefined = 默认） */
  get modelProfile(): string | undefined {
    return this.modelProfileValue;
  }

  setModelProfile(id: string | undefined): void {
    this.modelProfileValue = id;
  }

  /** 当前校准系数（透明度/调试用） */
  get calibrationFactor(): number {
    return this.estimator.calibrationFactor;
  }

  addUsage(usage: TokenUsage): void {
    this.usageSummary = {
      promptTokens: this.usageSummary.promptTokens + usage.promptTokens,
      completionTokens: this.usageSummary.completionTokens + usage.completionTokens,
      totalTokens: this.usageSummary.totalTokens + usage.totalTokens,
      requests: this.usageSummary.requests + 1,
      cacheHitTokens: this.usageSummary.cacheHitTokens + (usage.promptCacheHitTokens ?? 0),
    };
  }

  /**
   * 用真实 API 返回的 prompt_tokens 校准估算系数（EMA）。
   * 每次请求后调用：真实值与估算值的偏差会逐步收敛。
   */
  calibrateTokens(realPromptTokens: number, requestCharCount: number): void {
    this.estimator.calibrate(realPromptTokens, requestCharCount);
  }

  /** 按当前校准系数估算历史 token 数 */
  estimateHistoryTokens(): number {
    const charCount = this.messages.reduce((sum, message) => sum + message.content.length, 0);
    return this.estimator.estimateMessages(charCount, this.messages.length);
  }

  add(role: Message["role"], content: string, extra: Parameters<typeof createMessage>[2] = {}): Message {
    if (role === "user" && this.titleValue === undefined) {
      this.titleValue = content.replace(/\s+/g, " ").trim().slice(0, 40);
    }
    const message = createMessage(role, content, extra);
    this.messages.push(message);
    return message;
  }

  /** 供 LLM 调用：导出为干净的 API 消息格式 */
  toPrompt(): PromptMessage[] {
    return this.messages.map((m) => {
      return {
        role: m.role,
        content: m.content,
        ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
      };
    });
  }

  reset(): void {
    this.messages = [];
  }

  /**
   * 用压缩后的历史替换当前历史（Context Epoch 压缩时调用）。
   * epoch 号 +1 表示开启新纪元：新前缀从此稳定，利于服务端前缀缓存命中。
   */
  replaceHistory(messages: readonly Message[], epoch: number): void {
    this.messages = [...messages];
    this.epochNumber = epoch;
  }

  /** 序列化：用于持久化存储 */
  toData(): SessionData {
    return {
      id: this.id,
      messages: this.messages.map((m) => ({ ...m })),
      usage: this.usageSummary,
      epoch: this.epochNumber,
      title: this.titleValue,
      calibration: this.estimator.calibrationFactor,
      modelProfile: this.modelProfileValue,
    };
  }

  /** 反序列化：从存储恢复会话 */
  static fromData(data: SessionData): Session {
    const session = new Session(data.id, data.messages);
    if (data.usage !== undefined) {
      session.usageSummary = data.usage;
    }
    if (data.epoch !== undefined) {
      session.epochNumber = data.epoch;
    }
    if (data.calibration !== undefined && data.calibration > 0) {
      session.estimator.setFactor(data.calibration);
    }
    if (data.title !== undefined) {
      session.titleValue = data.title;
    } else {
      // 旧格式会话文件没有 title 字段：从第一条用户消息推导
      const firstUser = data.messages.find((m) => m.role === "user");
      if (firstUser !== undefined) {
        session.titleValue = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 40);
      }
    }
    if (data.modelProfile !== undefined && data.modelProfile !== "") {
      session.modelProfileValue = data.modelProfile;
    }
    return session;
  }
}

export interface SessionData {
  readonly id: string;
  readonly messages: readonly Message[];
  readonly usage?: UsageSummary;
  readonly epoch?: number;
  readonly title?: string;
  readonly calibration?: number;
  /** 本会话选择的模型配置 id */
  readonly modelProfile?: string;
}

function defaultSessionId(): string {
  // 随机后缀防碰撞：同一毫秒内连开两个会话（快速点"新会话"）不会共用文件
  return `sess_${Date.now()}_${randomBytes(4).toString("hex")}`;
}
