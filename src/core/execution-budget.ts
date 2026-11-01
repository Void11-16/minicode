import type { Session } from "./session.ts";
import { estimateCostYuan } from "./usage.ts";
import type { AppConfig } from "../config/config.ts";
import { resolvePricing, type ModelPricing } from "../config/pricing.ts";

export interface CumulativeToolBudget {
  rounds: number;
  calls: number;
  tokens: number;
  stagnantRounds?: number;
  blockedReason?: string;
  readonly maxRounds: number;
  readonly maxCalls: number;
  readonly maxTokens?: number;
  readonly costExceeded?: () => boolean;
}
export const DEFAULT_EXECUTION_LIMITS = { maxRounds: 150, maxCalls: 300, maxTokens: 2_000_000, taskBudgetYuan: 3 } as const;

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function money(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function executionInputLimit(config: Partial<AppConfig>): number { return positiveInteger(config.maxPromptTokens, 24_000); }

/** Web、CLI 和评测共用；自动续跑复用同一个对象，独立用户请求建立新任务预算。 */
export function createExecutionBudget(session: Session, config: Partial<AppConfig> = {}, pricing: ModelPricing = resolvePricing({ provider: "auto", ...config })): CumulativeToolBudget {
  const baseline = { ...session.usage };
  const cap = money(config.taskBudgetYuan, DEFAULT_EXECUTION_LIMITS.taskBudgetYuan);
  const sessionCap = money(config.budgetYuan, 0);
  const cost = (usage: typeof baseline) => estimateCostYuan(usage, pricing.inputPerM, pricing.outputPerM, pricing.cacheInputPerM);
  return { rounds: 0, calls: 0, tokens: 0,
    maxRounds: Math.min(150, positiveInteger(config.maxTaskRounds, DEFAULT_EXECUTION_LIMITS.maxRounds)),
    maxCalls: positiveInteger(config.maxToolCalls, DEFAULT_EXECUTION_LIMITS.maxCalls),
    maxTokens: positiveInteger(config.maxTaskTokens, DEFAULT_EXECUTION_LIMITS.maxTokens),
    costExceeded: () => {
      const task = { promptTokens: session.usage.promptTokens - baseline.promptTokens, completionTokens: session.usage.completionTokens - baseline.completionTokens,
        totalTokens: session.usage.totalTokens - baseline.totalTokens, cacheHitTokens: session.usage.cacheHitTokens - baseline.cacheHitTokens, requests: session.usage.requests - baseline.requests };
      return (cap > 0 && cost(task) >= cap) || (sessionCap > 0 && cost(session.usage) >= sessionCap);
    },
  };
}
