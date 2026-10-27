import { createMessage, type Message } from "../core/message.ts";
import { compactToolCallArguments, type Session } from "../core/session.ts";
import { renderTravelState, type TravelState } from "../core/travel-state.ts";

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
  /**
   * 摘要器：把旧消息压缩成一段文字（通常由 LLM 完成）。
   * 必须带上被压缩的 session —— 后台会话压缩时要用它自己的模型配置，
   * 不能退化成"当前选中会话"（profile/key 不同会压缩失败甚至用错模型）。
   */
  readonly summarize: (session: Session, messages: readonly Message[]) => Promise<string>;
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
  return messages.reduce((sum, message) => {
    const toolCallChars = message.toolCalls?.reduce(
      (total, call) => total + call.id.length + call.name.length + call.arguments.length + 16,
      0,
    ) ?? 0;
    return sum + estimateTokens(message.content, factor) + Math.ceil(toolCallChars * factor) + 4;
  }, 0);
}

/**
 * 为摘要模型准备有界但覆盖全部消息的转录。
 * 不能直接对整个字符串 slice：长会话被切掉的恰好总是后半段，近期约束和
 * artifact 路径会静默消失。这里按角色权重给每条消息分配预算，并对正文做
 * 首尾/关键字段裁剪；结构化旅行状态另行完整保留。
 */
export function renderHistoryForSummary(
  messages: readonly Message[],
  travelState?: TravelState,
  maxChars: number = 24_000,
): string {
  if (maxChars <= 0) return "";
  const state = renderTravelState(travelState);
  const stateBlock = state === undefined
    ? ""
    : `【需要精确保留的结构化旅行状态】\n${state}`;
  if (messages.length === 0) return stateBlock.slice(0, maxChars);

  const transcriptHeader = "【历史转录（每条消息均已压缩，完整工具原文在 artifact 中）】";
  const fixedChars =
    stateBlock.length +
    (stateBlock === "" ? 0 : 2) +
    transcriptHeader.length +
    1;
  if (fixedChars >= maxChars) return stateBlock.slice(0, maxChars);

  const transcriptBudget = maxChars - fixedChars;
  const weighted = messages.map((message) => ({
    message,
    weight:
      (message.role === "user" ? 3 : message.role === "tool" ? 2 : 1) *
      (message.content.includes("artifact=") ? 4 : 1),
  }));
  // 最近的消息承载最新约束，给更强的权重；整体仍保持按原始顺序输出。
  const totalWeight = weighted.reduce(
    (sum, item, index) => sum + item.weight * recencyFactor(index, messages.length),
    0,
  );
  let remainingWeight = totalWeight;
  // 为消息之间的换行预留空间，避免大量短消息的 separators 突破硬上限。
  let remainingChars = Math.max(0, transcriptBudget - Math.min(messages.length - 1, transcriptBudget));
  const transcript = weighted.flatMap(({ message, weight }, index) => {
    const adjustedWeight = weight * recencyFactor(index, messages.length);
    const budget = Math.min(
      2_000,
      Math.floor((remainingChars * adjustedWeight) / Math.max(1, remainingWeight)),
    );
    remainingWeight -= adjustedWeight;
    if (budget <= 0) return [];
    const prefix = `[${index + 1}/${messages.length} ${message.role}` +
      `${message.toolName === undefined ? "" : ` ${message.toolName}`}] `;
    const clippedPrefix = prefix.length <= budget
      ? prefix
      : `${prefix.slice(0, Math.max(0, budget - 1))}…`;
    const clipped = previewMessage(message, Math.max(0, budget - clippedPrefix.length));
    const rendered = `${clippedPrefix}${clipped}`;
    remainingChars = Math.max(0, remainingChars - rendered.length);
    return rendered === "" ? [] : [rendered];
  });
  const renderedState = stateBlock === "" ? [] : [stateBlock, ""];
  const rendered = [...renderedState, transcriptHeader, ...transcript].join("\n");
  return rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars);
}

function recencyFactor(index: number, total: number): number {
  if (total <= 1) return 1.5;
  return 1 + (index / (total - 1)) * 0.5;
}

function previewMessage(message: Message, budget: number): string {
  const calls = message.toolCalls === undefined
    ? ""
    : `（调用 ${message.toolCalls.map((call) => call.name).join("、")}）`;
  const text = `${message.content}${calls}`;
  if (text.length <= budget) return text;
  if (budget <= 0) return "";

  const lines = text.split("\n");
  const important = lines.filter((line) =>
    /artifact=|P[012]|质量|评分|预算|日期|时间|坐标|类型|用户|必须|不要|偏好|已保存|行程|地点/i.test(line),
  );
  const head = lines.slice(0, 8);
  const tail = lines.slice(-6);
  const candidates = [...important.slice(0, 24), ...head, ...tail];
  const unique = [...new Set(candidates)];
  let result = "";
  for (const line of unique) {
    const next = result === "" ? line : `${result}\n${line}`;
    if (next.length > budget) {
      // 关键行即使单行超预算，也要保留可识别的头部（例如 artifact 路径），
      // 不能因为前面的“开头摘要”塞满预算而静默丢掉它。
      if (result === "" && important.includes(line)) return clipLine(line, budget);
      continue;
    }
    result = next;
  }
  if (result !== "") return result;
  if (budget < 20) return text.slice(0, budget);
  const half = Math.floor((budget - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

function clipLine(line: string, budget: number): string {
  if (line.length <= budget) return line;
  return `${line.slice(0, Math.max(0, budget - 1))}…`;
}

/**
 * Context Epoch 管理：
 * - 每轮开始前检查历史 token 估算值，超过阈值就把旧消息压缩成摘要
 * - 压缩后开启新纪元（epoch+1），新前缀保持稳定 → 服务端前缀缓存可命中
 *   （DeepSeek 自动缓存相同前缀，命中部分计费大幅下降）
 * - 旧消息不再随每次请求重复发送，防止 token 随对话变长而暴涨
 */
/** 压缩后保留的工具消息单条上限（字符） */
const KEPT_TOOL_MAX_CHARS = 3000;

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

    // 压缩边界不能拆散"工具调用组"：若保留窗口以 tool 消息开头，其配对的
    // assistant(tool_calls) 已被摘要替换，续聊时该 tool 会被 API 判为孤儿而整轮 400。
    // 边界前移到组起点，把整组工具调用完整保留。
    let keepFrom = session.history.length - this.keepRecent;
    while (keepFrom > 0 && session.history[keepFrom].role === "tool") {
      keepFrom -= 1;
    }
    if (keepFrom === 0) return null; // 边界一直退到起点，没有可压缩的历史
    // 摘要器拿到压缩前的原始消息，才能按重要性保留坐标、类型、artifact 路径等
    // 零散但关键的事实；截断只发生在最终写回历史时。
    const oldMessages = session.history.slice(0, keepFrom);
    // 保留的最近消息里，超长工具结果截断（搜索结果动辄数 KB，不截断会导致
    // 压缩后仍超阈值 → 每轮重复压缩，白烧 LLM 调用）；save_itinerary 等
    // 工具参数也可能有 7KB+，同样要结构化截断，否则压缩后的窗口仍会持续膨胀。
    const recent = session.history.slice(keepFrom).map(compactHistoricalMessage);

    const nextEpoch = session.epoch + 1;
    // 先归档原始历史（失败则中止，宁可不做压缩也不丢数据），再花 LLM 调用做摘要
    if (this.archive !== undefined) {
      await this.archive(session, nextEpoch);
    }

    const summary = await this.summarize(session, oldMessages);
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

function compactHistoricalMessage(message: Message): Message {
  const content =
    message.role === "tool" && message.content.length > KEPT_TOOL_MAX_CHARS
      ? `${message.content.slice(0, KEPT_TOOL_MAX_CHARS)}\n…（历史工具结果过长，已截断）`
      : message.content;
  const toolCalls = message.toolCalls?.map((call) =>
    ({ ...call, arguments: compactToolCallArguments(call.arguments) }),
  );
  return {
    ...message,
    content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}
