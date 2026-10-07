/**
 * token 估算器：chars → tokens 的校准系数由真实 API usage
 * 指数移动平均（EMA）持续修正，随会话持久化。
 */
export class TokenEstimator {
  private factor: number;

  constructor(initialFactor: number = 0.7) {
    this.factor = initialFactor;
  }

  get calibrationFactor(): number {
    return this.factor;
  }

  setFactor(factor: number): void {
    this.factor = factor;
  }

  /** 用真实 prompt_tokens 校准系数（EMA，新观测占 20%） */
  calibrate(realPromptTokens: number, requestCharCount: number): void {
    if (requestCharCount <= 0 || realPromptTokens <= 0) return;
    const observed = realPromptTokens / requestCharCount;
    const alpha = 0.2;
    this.factor = Math.min(2, Math.max(0.2, this.factor * (1 - alpha) + observed * alpha));
  }

  estimate(text: string): number {
    return Math.ceil(text.length * this.factor);
  }

  estimateMessages(charCount: number, messageCount: number): number {
    // 每条消息固定开销按 4 token 估
    return Math.ceil(charCount * this.factor) + messageCount * 4;
  }
}
