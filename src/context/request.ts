import type { Session } from "../core/session.ts";
import type { PromptMessage } from "../core/message.ts";
import type { ToolDefinition } from "../llm/provider.ts";

/** 完整输入的工作预算，并非模型宣称的上下文窗口容量。 */
export const DEFAULT_MAX_INPUT_TOKENS = 24_000;
import type { RequestContextMetrics } from "../core/usage.ts";
export type { RequestContextMetrics } from "../core/usage.ts";

export function measureRequestContext(
  session: Session,
  systemPrompt: string | undefined,
  history: readonly PromptMessage[],
  transient: readonly PromptMessage[],
  tools: readonly ToolDefinition[],
  inputLimit = DEFAULT_MAX_INPUT_TOKENS,
): RequestContextMetrics {
  const systemChars = systemPrompt?.length ?? 0;
  const historyChars = session.promptCharCount(history);
  const transientChars = session.promptCharCount(transient);
  const toolDefinitionChars = tools.length === 0 ? 0 : JSON.stringify(tools.map((tool) => ({ type: "function", function: tool }))).length;
  const totalChars = systemChars + historyChars + transientChars + toolDefinitionChars;
  return { systemChars, historyChars, transientChars, toolDefinitionChars, totalChars,
    estimatedInputTokens: Math.ceil(totalChars * session.calibrationFactor) + (history.length + transient.length + (systemChars ? 1 : 0)) * 4,
    inputLimit };
}

export class ContextInputLimitError extends Error {
  constructor(metrics: RequestContextMetrics) {
    super(`完整请求估算 ${metrics.estimatedInputTokens} tokens，超过输入预算 ${metrics.inputLimit}；历史压缩后仍过大，请缩小本次输入或调整 max_prompt_tokens。此阈值不是模型容量。`);
    this.name = "ContextInputLimitError";
  }
}
