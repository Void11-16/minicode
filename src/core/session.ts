import { randomBytes } from "node:crypto";
import {
  createMessage,
  isCompactedToolArguments,
  type Message,
  type PromptMessage,
} from "./message.ts";
import { EMPTY_USAGE, type TokenUsage, type UsageSummary, type RequestContextMetrics, type RequestContextRecord } from "./usage.ts";
import { TokenEstimator } from "./token-estimator.ts";
import { normalizeTravelState, type TravelState } from "./travel-state.ts";

/** 工具已经执行完后，历史里只需保留调用语义；完整参数会以文件或工具结果为准 */
export const HISTORY_TOOL_ARGUMENT_MAX_CHARS = 1200;

/** 把超大工具参数替换成合法 JSON 占位，调用 id/name 保持不变以维持协议配对 */
export function compactToolCallArguments(
  argumentsJson: string,
  maxChars: number = HISTORY_TOOL_ARGUMENT_MAX_CHARS,
): string {
  if (argumentsJson.length <= maxChars) return argumentsJson;
  return JSON.stringify({
    _truncated: true,
    original_chars: argumentsJson.length,
    note: "历史参数占位符，禁止再次提交；如需修改，请重新读取当前数据并构造完整参数。",
  });
}

/**
 * 会话状态：维护消息历史。
 * 职责单一 —— 只管历史，不管 LLM 怎么调用。
 */
export class Session {
  readonly id: string;
  private messages: Message[] = [];
  private usageSummary: UsageSummary = EMPTY_USAGE;
  private requestContextsValue: RequestContextRecord[] = [];
  private epochNumber = 0;
  private titleValue: string | undefined;
  private modelProfileValue: string | undefined;
  private workspaceValue: string | undefined;
  private approvalModeValue: "ask" | "edits" | undefined;
  private activeToolsValue: string[] = [];
  private travelStateValue: TravelState | undefined;
  /** 宿主当前模式，不随历史摘要或磁盘会话恢复覆盖。 */
  private travelModeValue = false;
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

  get requestContexts(): readonly RequestContextRecord[] { return this.requestContextsValue.map((item) => ({ ...item })); }

  recordRequestContext(metrics: RequestContextMetrics): void {
    this.requestContextsValue.push({ ...metrics, at: Date.now() });
    this.requestContextsValue = this.requestContextsValue.slice(-200);
  }

  completeRequestContext(usage: TokenUsage): void {
    const index = this.requestContextsValue.length - 1;
    if (index >= 0) this.requestContextsValue[index] = { ...this.requestContextsValue[index]!, actualPromptTokens: usage.promptTokens, cacheHitTokens: usage.promptCacheHitTokens ?? 0 };
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

  /** 本会话的工作区（文件读写与命令执行的根目录；undefined = 装配默认） */
  get workspace(): string | undefined {
    return this.workspaceValue;
  }

  setWorkspace(path: string | undefined): void {
    this.workspaceValue = path;
  }

  /**
   * 审批模式（会话级）：ask=逐条确认 / edits=自动编辑（工作区文件写入免确认）/ trust=信任会话。
   * trust 仅内存有效（不持久化，重启/恢复后回到 ask|edits）。
   */
  get approvalMode(): "ask" | "edits" {
    return this.approvalModeValue ?? "edits";
  }

  setApprovalMode(mode: "ask" | "edits"): void {
    this.approvalModeValue = mode;
  }

  get travelMode(): boolean { return this.travelModeValue; }

  setTravelMode(enabled: boolean): void { this.travelModeValue = enabled; }

  /** 本会话已按需激活的可选工具；常驻/未分类工具不记录在这里 */
  get activeTools(): readonly string[] {
    return this.activeToolsValue;
  }

  setActiveTools(names: readonly string[]): void {
    this.activeToolsValue = [...new Set(
      names.flatMap((name) => {
        const trimmed = name.trim();
        return trimmed === "" ? [] : [trimmed];
      }),
    )];
  }

  /** 跨请求保留的精简旅行事实，不依赖易被裁剪的原始工具输出 */
  get travelState(): TravelState | undefined {
    return this.travelStateValue;
  }

  setTravelState(state: TravelState | undefined): void {
    this.travelStateValue = state === undefined ? undefined : normalizeTravelState(state);
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
    const prompt = this.toPrompt();
    const charCount = prompt.reduce(
      (sum, message) =>
        sum +
        message.content.length +
        toolCallChars(message) +
        (message.toolCallId?.length ?? 0) +
        (message.toolName?.length ?? 0),
      0,
    );
    return this.estimator.estimateMessages(charCount, prompt.length);
  }

  /**
   * 与真实请求对齐的字符量（用于 token 校准）。
   * tool_calls 的参数经常比正文大一个数量级，漏算会让压缩阈值严重失真。
   */
  promptCharCount(messages: readonly PromptMessage[] = this.toPrompt()): number {
    return messages.reduce((sum, message) => {
      const calls = message.toolCalls?.reduce(
        (total, call) => total + call.id.length + call.name.length + call.arguments.length + 16,
        0,
      ) ?? 0;
      return (
        sum +
        message.content.length +
        calls +
        (message.toolCallId?.length ?? 0) +
        (message.toolName?.length ?? 0) +
        8
      );
    }, 0);
  }

  add(role: Message["role"], content: string, extra: Parameters<typeof createMessage>[2] = {}): Message {
    if (role === "user" && this.titleValue === undefined) {
      this.titleValue = content.replace(/\s+/g, " ").trim().slice(0, 40);
    }
    const message = createMessage(role, content, extra);
    this.messages.push(message);
    return message;
  }

  /**
   * 一批工具执行完成后立即压缩调用参数。
   * 工具安全边界先移除旧组，完整输入检查再决定是否需要摘要，
   * 避免在每次模型请求里重复发送多 KB 行程参数。
   * 最近一轮保留完整参数：模型修改行程时应参考真实的上一次调用，而不是复制压缩占位符。
   */
  compactCompletedToolCalls(
    maxChars: number = HISTORY_TOOL_ARGUMENT_MAX_CHARS,
    keepRecentToolRounds: number = 1,
  ): number {
    let compacted = 0;
    const toolCallMessageIndexes = this.messages.flatMap(
      (message, index) => message.toolCalls === undefined ? [] : [index],
    );
    const recent = new Set(
      keepRecentToolRounds <= 0
        ? []
        : toolCallMessageIndexes.slice(-keepRecentToolRounds),
    );
    this.messages = this.messages.map((message, index) => {
      if (message.toolCalls === undefined || recent.has(index)) return message;
      // 即使这轮参数很短，也归档整个旧工具轮次。否则几十次搜索的小参数与
      // 每条数千字符的结果会在整轮规划中不断累积，批次上限只限制了单轮大小。
      const toolCalls = message.toolCalls.map((call) => {
        const argumentsJson = compactToolCallArguments(call.arguments, maxChars);
        if (argumentsJson === call.arguments) return call;
        compacted += 1;
        return { ...call, arguments: argumentsJson };
      });
      return {
        ...message,
        toolCalls,
        archivedToolCalls: message.archivedToolCalls ?? message.toolCalls,
      };
    });
    return compacted;
  }

  /**
   * 供 LLM 调用：导出为干净的 API 消息格式。
   * 已完成且参数被压缩的工具轮次只保留在本地审计历史里，不再把占位 JSON
   * 发给模型；否则模型会把占位符当成上一版参数模板并原样重试。
   */
  toPrompt(): PromptMessage[] {
    const omittedToolCallIds = new Set(
      this.messages.flatMap((message) => [
        ...(message.archivedToolCalls ?? []).map((call) => call.id),
        ...(message.toolCalls ?? [])
          .filter((call) => isCompactedToolArguments(call.arguments))
          .map((call) => call.id),
      ]),
    );
    return this.messages.flatMap((m) => {
      if (m.role === "tool" && m.toolCallId !== undefined && omittedToolCallIds.has(m.toolCallId)) {
        return [];
      }
      const toolCalls = m.toolCalls?.filter((call) => !omittedToolCallIds.has(call.id));
      if (m.toolCalls !== undefined && toolCalls?.length === 0 && m.content.trim() === "") {
        return [];
      }
      return {
        role: m.role,
        content: m.content,
        ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
      };
    });
  }

  reset(): void {
    this.messages = [];
    this.activeToolsValue = [];
    this.travelStateValue = undefined;
    this.requestContextsValue = [];
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
      ...(this.requestContextsValue.length === 0 ? {} : { requestContexts: this.requestContexts }),
      epoch: this.epochNumber,
      title: this.titleValue,
      calibration: this.estimator.calibrationFactor,
      modelProfile: this.modelProfileValue,
      workspace: this.workspaceValue,
      approvalMode: this.approvalModeValue,
      activeTools: [...this.activeToolsValue],
      travelState: this.travelStateValue,
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
    if (data.workspace !== undefined && data.workspace !== "") {
      session.workspaceValue = data.workspace;
    }
    if (data.approvalMode === "ask" || data.approvalMode === "edits") {
      session.approvalModeValue = data.approvalMode;
    }
    if (Array.isArray(data.activeTools)) {
      session.setActiveTools(data.activeTools.filter((name): name is string => typeof name === "string"));
    }
    if (Array.isArray(data.requestContexts)) {
      const required = ["systemChars", "historyChars", "transientChars", "toolDefinitionChars", "totalChars", "estimatedInputTokens", "inputLimit", "at"];
      const allowed = new Set([...required, "actualPromptTokens", "cacheHitTokens"]);
      session.requestContextsValue = data.requestContexts.filter((record) => record && typeof record === "object" &&
        required.every((key) => Object.hasOwn(record, key)) && Object.entries(record).every(([key, value]) => allowed.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)).slice(-200).map((record) => ({ ...record }));
    }
    session.travelStateValue = normalizeTravelState(data.travelState);
    return session;
  }
}

export interface SessionData {
  readonly id: string;
  readonly messages: readonly Message[];
  readonly usage?: UsageSummary;
  readonly requestContexts?: readonly RequestContextRecord[];
  readonly epoch?: number;
  readonly title?: string;
  readonly calibration?: number;
  /** 本会话选择的模型配置 id */
  readonly modelProfile?: string;
  /** 本会话的工作区目录（绝对路径） */
  readonly workspace?: string;
  /** 审批模式（trust 不持久化，仅 ask/edits 落盘） */
  readonly approvalMode?: "ask" | "edits";
  /** 本会话按需激活的可选工具（旧会话缺省为空） */
  readonly activeTools?: readonly string[];
  /** 从旅行工具提取的稳定结构化事实（旧会话缺省为空） */
  readonly travelState?: TravelState;
}

function defaultSessionId(): string {
  // 随机后缀防碰撞：同一毫秒内连开两个会话（快速点"新会话"）不会共用文件
  return `sess_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/** 工具名、参数与协议字段都会进入 prompt，但本地消息正文不一定包含它们 */
function toolCallChars(message: Pick<PromptMessage, "toolCalls">): number {
  return message.toolCalls?.reduce(
    (sum, call) => sum + call.id.length + call.name.length + call.arguments.length + 16,
    0,
  ) ?? 0;
}
