import * as readline from "node:readline";
import { join } from "node:path";
import { Session } from "../core/session.ts";
import { ChatAgent, type AgentEvent } from "../agent/agent.ts";
import { composeSystemPrompt, readWorkspaceRules } from "../agent/prompt.ts";
import { createProvider, createProviderFromProfile } from "../llm/factory.ts";
import type { ChatProvider } from "../llm/provider.ts";
import { JsonFileSessionStore } from "../storage/session-store.ts";
import { ConfigStore, type AppConfig } from "../config/config.ts";
import { ModelProfileStore, type ModelProfile } from "../config/models.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { ToolRegistry } from "../tools/tool.ts";
import { estimateCostYuan, formatUsage, isOverBudget } from "../core/usage.ts";
import { AgentRuntime, STEERED_NOTE } from "../runtime/runtime.ts";
import type { Message } from "../core/message.ts";
import { LineQueue } from "./line-queue.ts";
import { printBanner, StreamPrinter } from "./ui.ts";
import { handleCommand, executeSimpleCommand } from "./commands.ts";
import { SessionService } from "../service/session-service.ts";
import { debugLog } from "../util/logger.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { briefForSessionTitle, toolRoundsForBrief } from "../tools/brief.ts";
import { createPermissionMemory, decidePermission, permissionModeOf } from "../service/permission-policy.ts";
import type { PermissionMemory } from "../service/permission-policy.ts";
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";


/**
 * CLI 应用：负责装配（config/provider/store/runtime）与主循环。
 * 展示逻辑在 ui.ts，命令路由在 commands.ts，这里只做接线。
 */
export class CliApp {
  readonly lines = new LineQueue();
  readonly store: JsonFileSessionStore;
  registry!: ToolRegistry;
  readonly configStore: ConfigStore;
  readonly configFile: string;
  readonly debug: boolean;
  readonly modelStore: ModelProfileStore;

  config!: AppConfig;
  provider!: ChatProvider;
  /** 多模型配置（与 Web 共享 .minicode/models.json） */
  profiles: ModelProfile[] = [];
  defaultProfileId: string | undefined;
  /** 旅行规划能力开关；CLI 默认开启（保持既有行为） */
  travelMode = true;
  runtime!: AgentRuntime;
  sessionService!: SessionService;
  currentSessionId = "";
  running = true;
  private readonly streamPrinter = new StreamPrinter((sessionId) => sessionId === this.currentSessionId);
  /** 会话级审批记忆（总是允许的工具 / bash 命令前缀）——策略见 service/permission-policy */
  private readonly permissionMemories = new Map<string, PermissionMemory>();
  /** 信任会话（仅内存）：本进程内该会话全部确认放行 */
  private readonly trustedSessions = new Set<string>();
  private rl: readline.Interface;
  private readonly historyFile = join(process.cwd(), ".minicode", "history.txt");

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug === true;
    this.configFile = join(process.cwd(), ".minicode", "config.json");
    this.configStore = new ConfigStore(this.configFile);
    this.modelStore = new ModelProfileStore(join(process.cwd(), ".minicode", "models.json"));
    this.store = new JsonFileSessionStore(join(process.cwd(), ".minicode", "sessions"));
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      history: this.loadHistorySync(),
      historySize: 200,
    });
    this.rl.on("line", (line: string) => {
      this.lines.push(line);
      this.recordHistory(line);
    });
    this.rl.on("close", () => this.lines.push(null));
  }

  get priceIn(): number {
    return Number.parseFloat(this.config.priceIn ?? "2");
  }

  get priceOut(): number {
    return Number.parseFloat(this.config.priceOut ?? "3");
  }

  /** 会话级系统提示词：模式基线 + 日期/工作区 + 规则文件 + 口味偏好 */
  systemPromptFor(session: Session): string {
    const workspace = session.workspace ?? process.cwd();
    return composeSystemPrompt({
      travelMode: this.travelMode,
      workspace,
      customPrompt: this.config.systemPrompt,
      tastePreferences: this.config.tastePreferences,
      rulesContent: readWorkspaceRules(workspace),
    });
  }

  get budgetYuan(): number {
    return Number.parseFloat(this.config.budgetYuan ?? "0");
  }

  currentAgent(): ChatAgent {
    const agent = this.runtime.getAgent(this.currentSessionId);
    if (agent === undefined) {
      throw new Error(`会话 ${this.currentSessionId} 未注册`);
    }
    return agent;
  }

  /** 会话 → Provider：会话选了模型用对应配置，否则默认配置 / 旧单模型配置回退 */
  providerForSession(session: Session): ChatProvider {
    const profile = this.profiles.find((p) => p.id === (session.modelProfile ?? this.defaultProfileId));
    if (profile === undefined) return this.provider;
    return createProviderFromProfile(profile, this.systemPromptFor(session));
  }

  /** 新增/更新模型配置（models.json 与 Web 共享）；当前会话若受影响立即换 Provider */
  async saveModelProfile(profile: ModelProfile): Promise<void> {
    const exists = this.profiles.some((p) => p.id === profile.id);
    this.profiles = exists
      ? this.profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...this.profiles, profile];
    if (this.defaultProfileId === undefined) this.defaultProfileId = profile.id;
    await this.modelStore.save({ profiles: this.profiles, defaultProfile: this.defaultProfileId });
    this.switchSession(this.currentAgent().session);
  }

  /** 删除模型配置；正在被当前会话使用时返回 false */
  async deleteModelProfile(id: string): Promise<boolean> {
    const deleted = this.profiles.some((p) => p.id === id);
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.defaultProfileId === id) this.defaultProfileId = this.profiles[0]?.id;
    await this.modelStore.save({ profiles: this.profiles, defaultProfile: this.defaultProfileId });
    return deleted;
  }

  /** 设默认模型（新会话使用）；当前会话未显式选择时也随之切换 */
  async setDefaultModelProfile(id: string): Promise<void> {
    this.defaultProfileId = id;
    await this.modelStore.save({ profiles: this.profiles, defaultProfile: id });
    this.switchSession(this.currentAgent().session);
  }

  // 摘要走被压缩会话自己的 Provider：后台会话触发压缩时不能借当前选中会话的模型
  summarizeForCompact = async (session: Session, messages: readonly Message[]): Promise<string> => {
    const transcript = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n")
      .slice(0, 20_000);
    return this.providerForSession(session).chat([
      { role: "user", content: `请把以下对话历史压缩成要点摘要（保留关键事实、决策、用户偏好、日期和数字），直接输出摘要本身：\n\n${transcript}` },
    ]);
  };

  /** /config 变更后重建 provider 与当前 agent（保留会话历史） */
  applyConfig(next: AppConfig): void {
    this.config = next;
    // 运行中修改 amap_key 立即生效（工具读全局客户端）
    setAmapKey(next.amapApiKey);
    const currentSession = this.currentAgent().session;
    this.rebuildRuntime(currentSession);
  }

  switchSession(session: Session): ChatAgent {
    this.currentSessionId = session.id;
    const agent = new ChatAgent(session, this.providerForSession(session), this.registry, process.cwd());
    this.runtime.registerAgent(session.id, agent);
    return agent;
  }

  /** 当前会话生效的审批模式：trust（内存）> 会话持久值 > 默认 edits */
  currentApprovalMode(): "ask" | "edits" | "trust" {
    return permissionModeOf(this.currentAgent().session, this.trustedSessions.has(this.currentSessionId));
  }

  /** 切换审批模式；trust 仅本进程有效，ask/edits 随会话持久化 */
  async setApprovalMode(mode: "ask" | "edits" | "trust"): Promise<"ask" | "edits" | "trust"> {
    if (mode === "trust") {
      this.trustedSessions.add(this.currentSessionId);
      return "trust";
    }
    this.trustedSessions.delete(this.currentSessionId);
    const session = this.currentAgent().session;
    session.setApprovalMode(mode);
    await this.sessionService.persist(session);
    return mode;
  }

  rebuildRuntime(currentSession: Session): void {
    this.provider = createProvider({ config: this.config, systemPrompt: this.systemPromptFor(currentSession) });
    this.sessionService = new SessionService(this.store);
    this.runtime = new AgentRuntime({
      summarize: this.summarizeForCompact,
      archive: (session, epoch) => this.store.archive(session, epoch),
      // 工具轮次按行程需求动态给：多天行程的搜索/口碑/餐饮/逐日保存+校验远超默认 30 轮；
      // 需求单还没落盘的首轮按会话文本里的天数估算
      maxToolRounds: async (session, input) => {
        const text = `${session.title}\n${input}`;
        return toolRoundsForBrief(await briefForSessionTitle(process.cwd(), text), 30, text);
      },
      onBudgetExtended: (sessionId, info) => {
        if (sessionId !== this.currentSessionId) return;
        console.log(`⚙️ 工具轮次不够用，预算从 ${info.from} 提到 ${info.to} 轮继续（按行程需求自动续期）\n`);
      },
      onCheckpoint: (sessionId) => {
        const checkpointAgent = this.runtime.getAgent(sessionId);
        if (checkpointAgent === undefined) return;
        return this.sessionService.persist(checkpointAgent.session);
      },
      onEvent: (_sessionId, event) => this.printEvent(event),
      onPermission: async (sessionId, request) => this.askPermission(sessionId, request),
      onTextDelta: (sessionId, delta) => this.printDelta(sessionId, delta),
      onCompact: (sessionId, info) => {
        if (sessionId !== this.currentSessionId) return;
        console.log(
          `♻️ 上下文压缩: 第 ${info.epoch} 纪元，移除 ${info.removedMessages} 条消息 ` +
          `(估算 ${info.tokensBefore} → ${info.tokensAfter} tokens)\n`,
        );
      },
      onTurnEnd: (sessionId, reply) => this.printTurnEnd(sessionId, reply),
      onTurnAborted: (sessionId) => {
        if (sessionId !== this.currentSessionId) return;
        this.streamPrinter.endLine();
        console.log("(已中断当前轮，会话状态已保留)\n");
      },
      onTurnError: (sessionId, error) => {
        if (sessionId !== this.currentSessionId) return;
        console.error(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    });
    const agent = new ChatAgent(currentSession, this.providerForSession(currentSession), this.registry, process.cwd());
    this.runtime.registerAgent(this.currentSessionId, agent);
  }

  async start(): Promise<void> {
    this.config = await this.configStore.load();
    const modelsFile = await this.modelStore.loadWithSeed(this.config);
    this.profiles = [...modelsFile.profiles];
    this.defaultProfileId = modelsFile.defaultProfile;
    setAmapKey(this.config.amapApiKey);
    this.registry = createDefaultRegistry();
    const initialSession = new Session();
    this.rebuildRuntime(initialSession);
    this.switchSession(initialSession);

    const approvalLabels: Record<string, string> = { ask: "🔒 逐条确认", edits: "✏️ 自动编辑", trust: "⚡ 信任会话" };
    printBanner(this.provider.name, this.registry.size, this.currentSessionId, this.currentAgent().workspace, approvalLabels[this.currentApprovalMode()], this.configFile, this.debug);

    while (this.running) {
      const prompt = this.runtime.hasActiveTurn(this.currentSessionId) ? "steer> " : "you> ";
      process.stdout.write(prompt);
      const input = await this.lines.next();
      if (input === null) break; // stdin 关闭（EOF）
      const line = input.trim();
      if (line === "") continue;

      if (await executeSimpleCommand(this, line)) continue;
      if (await handleCommand(this, line)) continue;

      // —— 消息投递 ——
      // 预算守卫：单会话估算花费达到上限时暂停发送（/new 或调预算后继续）
      if (isOverBudget(this.currentAgent().session.usage, this.priceIn, this.priceOut, this.budgetYuan)) {
        const cost = estimateCostYuan(this.currentAgent().session.usage, this.priceIn, this.priceOut);
        console.log(
          `⛔ 本会话估算花费已达 ¥${cost.toFixed(4)}，超过预算 ¥${this.budgetYuan}。` +
          `可 /config set budget_yuan <新值> 调整，或 /new 开始新会话（预算按会话计算）。\n`,
        );
        continue;
      }

      if (this.runtime.hasActiveTurn(this.currentSessionId)) {
        const note = await this.runtime.send(this.currentSessionId, line, "steer").catch(() => STEERED_NOTE);
        console.log(`${note}\n`);
      } else {
        debugLog("cli", `发送消息: ${line.slice(0, 50)}`);
        this.runtime.send(this.currentSessionId, line, "queue").catch(() => {});
      }
    }
    this.rl.close();
  }

  /** 输入历史：启动时同步加载（↑/↓ 翻阅），跨进程持久化 */
  private loadHistorySync(): string[] {
    try {
      const raw = readFileSync(this.historyFile, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "").slice(-200);
      return [...lines].reverse(); // readline 索引 0 = 最近一条
    } catch {
      return [];
    }
  }

  private lastAppended = "";

  private recordHistory(line: string): void {
    const trimmed = line.trim();
    // 命令和空行不进历史；连续重复不重复写文件
    // （内存中的 ↑/↓ 历史由 readline 自动管理）
    if (trimmed === "" || trimmed.startsWith("/")) return;
    if (trimmed === this.lastAppended) return;
    this.lastAppended = trimmed;
    void mkdir(join(this.historyFile, ".."), { recursive: true })
      .then(() => appendFile(this.historyFile, `${trimmed}\n`, "utf8"))
      .catch(() => {});
  }

  // —— 展示协调（流式输出与工具事件的换行处理） ——

  private printEvent(event: AgentEvent): void {
    if (event.type === "tool_start") {
      this.streamPrinter.endLine();
      console.log(`⚡ ${event.name}(${event.arguments ?? "{}"})`);
    } else if (
      event.type === "tool_end" &&
      (event.name === "save_itinerary" || event.name === "validate_itinerary")
    ) {
      this.streamPrinter.endLine();
      console.log(`✓ ${event.name}:\n${event.output}\n`);
    } else if (event.type === "tool_error") {
      this.streamPrinter.endLine();
      console.log(`✗ ${event.name}: ${event.error}`);
    }
  }

  private printDelta(sessionId: string, delta: string): void {
    this.streamPrinter.delta(sessionId, delta);
  }

  private printTurnEnd(sessionId: string, reply: string): void {
    if (sessionId !== this.currentSessionId) return;
    if (!this.streamPrinter.finishTurn()) {
      console.log(`ai> ${reply}\n`);
    }
    const agent = this.runtime.getAgent(sessionId);
    if (agent !== undefined) {
      console.log(`📊 ${formatUsage(agent.session.usage, this.priceIn, this.priceOut)} | 纪元 ${agent.session.epoch}\n`);
      void this.sessionService.persist(agent.session);
    }
  }

  private async askPermission(sessionId: string, request: { tool: string; message: string; arguments?: string }): Promise<boolean> {
    // CLI 只有一个前台会话：后台会话的请求无法交互，直接拒绝（Web 端支持多会话并发审批）
    if (sessionId !== this.currentSessionId) return false;
    const memory = this.permissionMemoryFor(sessionId);
    const decision = decidePermission({
      toolName: request.tool,
      tool: this.registry.get(request.tool),
      arguments: request.arguments,
      mode: this.currentApprovalMode(),
      memory,
    });
    if (decision.kind === "allow") return true;

    this.streamPrinter.endLine();
    console.log(`\n🔒 权限请求: ${request.tool} —— ${request.message}`);
    const hint = decision.commandKey !== ""
      ? `允许执行? (y=本次 / a=总是允许「${decision.commandKey}」 / n=拒绝) `
      : decision.canAlways
        ? "允许执行? (y=本次 / a=本次会话总是 / n=拒绝) "
        : "允许执行? (y=本次 / n=拒绝) ";
    process.stdout.write(hint);
    const answer = (await this.lines.next()) ?? "n";
    const choice = answer.trim().toLowerCase();
    console.log("");
    if (choice === "a" && decision.commandKey !== "") {
      memory.bashKeys.add(decision.commandKey);
    } else if (choice === "a" && decision.canAlways) {
      memory.alwaysTools.add(request.tool);
    }
    return choice === "y" || (choice === "a" && (decision.commandKey !== "" || decision.canAlways));
  }

  private permissionMemoryFor(sessionId: string): PermissionMemory {
    let memory = this.permissionMemories.get(sessionId);
    if (memory === undefined) {
      memory = createPermissionMemory();
      this.permissionMemories.set(sessionId, memory);
    }
    return memory;
  }
}
