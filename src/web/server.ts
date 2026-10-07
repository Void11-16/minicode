import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "../core/session.ts";
import { ChatAgent, TurnAbortedError } from "../agent/agent.ts";
import { BASE_SYSTEM_PROMPT, TRAVEL_SYSTEM_PROMPT } from "../agent/prompt.ts";
import { createProvider, createProviderFromProfile } from "../llm/factory.ts";
import type { AppConfig } from "../config/config.ts";
import { ConfigStore, maskSecret } from "../config/config.ts";
import { ModelProfileStore, newProfileId, type ModelProfile } from "../config/models.ts";
import { JsonFileSessionStore } from "../storage/session-store.ts";
import { SessionService } from "../service/session-service.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { ToolRegistry } from "../tools/tool.ts";
import { AgentRuntime } from "../runtime/runtime.ts";
import type { AgentRuntimeOptions } from "../runtime/runtime.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { formatUsage } from "../core/usage.ts";
import type { ChatProvider } from "../llm/provider.ts";
import type { Message } from "../core/message.ts";
import { STEERED_NOTE } from "../runtime/runtime.ts";

export interface WebServerOptions {
  /** 项目根目录（配置/会话/plans 落盘位置），默认源码根 */
  readonly rootDir?: string;
  /** 覆盖配置文件（测试注入 mock provider 等） */
  readonly configOverrides?: Partial<AppConfig>;
  /** 端口，默认 3000；传 0 自动分配 */
  readonly port?: number;
  /** 直接注入 Provider（测试用可控时序） */
  readonly providerOverride?: ChatProvider;
}

export interface RunningWebServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Web 版：单页聊天界面 + SSE 流式输出 + 工具事件展示 + 权限确认。
 * 复用 CLI 的全部装配（config/provider/tools/runtime/persist），零运行时依赖。
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<RunningWebServer> {
  const rootDir = options.rootDir ?? join(import.meta.dirname, "..", "..");
  const config = {
    ...(await new ConfigStore(join(rootDir, ".minicode", "config.json")).load()),
    ...options.configOverrides,
  };
  setAmapKey(config.amapApiKey);

  let travelMode = false;

  function buildSystemPrompt(): string {
    if (config.systemPrompt !== undefined && config.systemPrompt !== "") return config.systemPrompt;
    if (!travelMode) return BASE_SYSTEM_PROMPT;
    const travel = `${BASE_SYSTEM_PROMPT}\n${TRAVEL_SYSTEM_PROMPT}`;
    return config.tastePreferences === undefined
      ? travel
      : `${travel}\n用户口味偏好（长期保存，直接遵循，不要重复询问）：${config.tastePreferences}`;
  }

  let provider = options.providerOverride ?? createProvider({ config, systemPrompt: buildSystemPrompt() });
  // 多模型配置：每个会话可独立选择（models.json，首次从旧单模型配置迁移）
  const profileStore = new ModelProfileStore(join(rootDir, ".minicode", "models.json"));
  let modelsFile = await profileStore.loadWithSeed(config);
  let profiles: readonly ModelProfile[] = modelsFile.profiles;
  let defaultProfileId: string | undefined = modelsFile.defaultProfile;
  /** profile + 提示词 → Provider 缓存（模式切换换 key，配置修改清空） */
  const providerCache = new Map<string, ChatProvider>();

  /** 会话 → Provider：会话选了模型用对应 profile，否则默认 profile / 旧配置回退 */
  function sessionProvider(session: Session): ChatProvider {
    const profile = profiles.find((p) => p.id === (session.modelProfile ?? defaultProfileId));
    if (profile === undefined) return provider;
    const key = `${profile.id}|${travelMode ? "travel" : "base"}|${config.systemPrompt ?? ""}`;
    let cached = providerCache.get(key);
    if (cached === undefined) {
      cached = createProviderFromProfile(profile, buildSystemPrompt());
      providerCache.set(key, cached);
    }
    return cached;
  }

  function registerSessionAgent(session: Session): void {
    runtime.registerAgent(session.id, new ChatAgent(session, sessionProvider(session), registry));
    registeredSessions.add(session.id);
  }

  function maskedProfiles() {
    return profiles.map((p) => ({ ...p, apiKey: maskSecret(p.apiKey) }));
  }

  const registry = createDefaultRegistry({ writeRoot: rootDir });
  const store = new JsonFileSessionStore(join(rootDir, ".minicode", "sessions"));
  const summarize = (messages: readonly Message[]): Promise<string> =>
    sessionProvider(currentSession).chat([
      {
        role: "user",
        content: `请把以下对话历史压缩成要点摘要（保留关键事实、决策、用户偏好、日期和数字），直接输出摘要本身：\n\n${messages
          .map((m) => `[${m.role}] ${m.content}`)
          .join("\n")
          .slice(0, 20_000)}`,
      },
    ]);
  const sessionService = new SessionService(store, {
    summarize,
    resumeMaxTokens: Number.parseInt(config.resumeMaxTokens ?? "8000", 10),
  });

  let currentSession = new Session();
  let indexHtml = await readFile(join(import.meta.dirname, "index.html"), "utf8");

  // 每个会话独立的 SSE 输出流：多会话可并行执行，切换查看不打断后台任务
  const streams = new Map<string, (event: Record<string, unknown>) => void>();
  const pendingPermissions = new Map<number, (allowed: boolean) => void>();
  let permissionCounter = 0;
  /** 已注册的会话集合：模式切换重建 Runtime 时全部重新注册，后台任务不丢 */
  const registeredSessions = new Set<string>();

  function buildRuntimeOptions(): AgentRuntimeOptions {
    const write = (sessionId: string, event: Record<string, unknown>) => {
      streams.get(sessionId)?.(event);
    };
    return {
      summarize,
      archive: (session, epoch) => store.archive(session, epoch),
      onEvent: (sessionId, event) => {
        write(sessionId, { type: event.type, name: event.name, arguments: event.arguments, error: event.error, output: event.output?.slice(0, 200) });
      },
      onPermission: (sessionId, request) => requestPermission(sessionId, request),
      onTurnStart: (sessionId) => {
        // 链式轮次（steer 续排/排队）开始时通知前端开新卡片
        write(sessionId, { type: "turn_start" });
      },
      onTextDelta: (sessionId, delta) => {
        write(sessionId, { type: "delta", text: delta });
      },
      onCompact: (sessionId, info) => {
        write(sessionId, { type: "compact", text: `♻️ 上下文压缩: 第 ${info.epoch} 纪元，移除 ${info.removedMessages} 条消息` });
      },
      onTurnEnd: (sessionId, reply) => {
        const agent = runtime.getAgent(sessionId);
        if (agent !== undefined) {
          // reply 事件：非流式 Provider 的兜底显示（流式时前端已有 delta，会忽略）
          write(sessionId, { type: "reply", text: reply });
          write(sessionId, { type: "usage", text: formatUsage(agent.session.usage, Number.parseFloat(config.priceIn ?? "2"), Number.parseFloat(config.priceOut ?? "3")) });
          void sessionService.persist(agent.session);
        }
      },
      onTurnAborted: (sessionId) => {
        write(sessionId, { type: "aborted", text: "已中断当前轮，会话状态已保留" });
      },
      onTurnError: (sessionId, error) => {
        write(sessionId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      },
    };
  }

  let runtime = new AgentRuntime(buildRuntimeOptions());
  registerSessionAgent(currentSession);

  /** 模式切换后重建 Provider/Runtime（系统提示词在 Provider 里），保留所有会话历史 */
  function rebuildRuntime(): void {
    const sessions = [...registeredSessions]
      .map((id) => runtime.getAgent(id)?.session)
      .filter((session): session is Session => session !== undefined);
    provider = options.providerOverride ?? createProvider({ config, systemPrompt: buildSystemPrompt() });
    runtime = new AgentRuntime(buildRuntimeOptions());
    for (const session of sessions) {
      runtime.registerAgent(session.id, new ChatAgent(session, sessionProvider(session), registry));
    }
    if (sessions.length === 0) registerSessionAgent(currentSession);
  }

  function newSession(): void {
    currentSession = new Session();
    registerSessionAgent(currentSession);
  }

  function requestPermission(sessionId: string, request: { tool: string; message: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = (permissionCounter += 1);
      pendingPermissions.set(id, resolve);
      streams.get(sessionId)?.({ type: "permission", id, sessionId, tool: request.tool, message: request.message });
      // 2 分钟无响应默认拒绝，避免请求悬挂
      setTimeout(() => {
        if (pendingPermissions.get(id) !== undefined) {
          pendingPermissions.delete(id);
          resolve(false);
        }
      }, 120_000);
    });
  }

  async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  }

  function stateJson(res: ServerResponse, body: Record<string, unknown>): void {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);
    // 直接双击打开 index.html（file://）时也能连上：放开 CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      stateJson(res, {
        provider: provider.name,
        tools: registry.size,
        title: currentSession.title,
        busy: streams.has(currentSession.id),
        travelMode,
        modelProfile: currentSession.modelProfile ?? defaultProfileId ?? null,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      stateJson(res, {
        profiles: maskedProfiles(),
        defaultProfile: defaultProfileId ?? null,
        current: currentSession.modelProfile ?? defaultProfileId ?? null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/models") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const kind = body.provider === "deepseek" || body.provider === "openai" || body.provider === "mock"
        ? body.provider
        : undefined;
      if (name === "" || kind === undefined) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "需要名称和 provider（deepseek/openai/mock）" }));
        return;
      }
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      const existing = profiles.find((p) => p.id === (typeof body.id === "string" ? body.id : ""));
      // 更新时留空 = 保留旧值（前端编辑表单不回传打码 Key）
      const merged: ModelProfile = {
        id: existing?.id ?? newProfileId(profiles),
        name,
        provider: kind,
        apiKey: apiKey !== "" ? apiKey : existing?.apiKey,
        baseUrl: baseUrl !== "" ? baseUrl : existing?.baseUrl,
        model: model !== "" ? model : existing?.model,
      };
      if (merged.provider !== "mock" && (merged.apiKey === undefined || merged.apiKey === "")) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "API Key 不能为空" }));
        return;
      }

      profiles = existing === undefined ? [...profiles, merged] : profiles.map((p) => (p.id === merged.id ? merged : p));
      if (defaultProfileId === undefined) defaultProfileId = merged.id;
      await profileStore.save({ profiles, defaultProfile: defaultProfileId });
      providerCache.clear();
      registerSessionAgent(currentSession);
      stateJson(res, { profiles: maskedProfiles(), defaultProfile: defaultProfileId ?? null, current: currentSession.modelProfile ?? defaultProfileId ?? null });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/models/delete") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      if (id === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少模型 id" }));
        return;
      }
      if ((currentSession.modelProfile ?? defaultProfileId) === id) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "当前会话正在使用该模型，请先切换到其他模型再删除" }));
        return;
      }
      const deleted = profiles.some((p) => p.id === id);
      profiles = profiles.filter((p) => p.id !== id);
      if (defaultProfileId === id) defaultProfileId = profiles[0]?.id;
      await profileStore.save({ profiles, defaultProfile: defaultProfileId });
      providerCache.clear();
      stateJson(res, { deleted, profiles: maskedProfiles(), defaultProfile: defaultProfileId ?? null });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/models/select") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      if (profiles.find((p) => p.id === id) === undefined) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "未找到该模型配置" }));
        return;
      }
      currentSession.setModelProfile(id);
      registerSessionAgent(currentSession);
      await sessionService.persist(currentSession);
      stateJson(res, { current: id });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/mode") {
      const body = await readJsonBody(req);
      if (typeof body.travel !== "boolean") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "travel 需要布尔值" }));
        return;
      }
      if (streams.size > 0) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "有会话正在执行，稍后再切换模式" }));
        return;
      }
      travelMode = body.travel;
      rebuildRuntime();
      stateJson(res, { travelMode });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      stateJson(res, { title: currentSession.title, messages: currentSession.history });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const persisted = await store.list();
      // 执行中/尚未落盘的会话（新建还没完成第一轮）也进列表：
      // 否则后台任务在侧栏不可见，违背多任务并行的初衷
      const persistedIds = new Set(persisted.map((meta) => meta.id));
      const live = [...registeredSessions]
        .filter((id) => !persistedIds.has(id))
        .map((id) => runtime.getAgent(id)?.session)
        .filter((session): session is Session => session !== undefined)
        .map((session) => ({
          id: session.id,
          messageCount: session.history.length,
          updatedAt: Date.now(),
          preview: "",
          title: session.title,
          epoch: session.epoch,
          current: session.id === currentSession.id,
          running: streams.has(session.id),
        }));
      stateJson(res, {
        currentId: currentSession.id,
        currentTitle: currentSession.title,
        currentRunning: streams.has(currentSession.id),
        sessions: [...live, ...persisted.map((meta) => ({
          ...meta,
          current: meta.id === currentSession.id,
          running: streams.has(meta.id),
        }))],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/new") {
      newSession();
      stateJson(res, { title: currentSession.title, id: currentSession.id });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/resume") {
      const body = await readJsonBody(req);
      if (typeof body.id !== "string" || body.id === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少会话 id" }));
        return;
      }
      const runningAgent = runtime.getAgent(body.id);
      if (streams.has(body.id) && runningAgent !== undefined) {
        currentSession = runningAgent.session;
        stateJson(res, {
          title: currentSession.title,
          id: currentSession.id,
          messages: currentSession.history,
          running: true,
        });
        return;
      }
      const result = await sessionService.loadWithPrepare(body.id);
      if (result === null) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到会话 ${body.id}` }));
        return;
      }
      currentSession = result.session;
      registerSessionAgent(currentSession);
      stateJson(res, {
        title: currentSession.title,
        id: currentSession.id,
        messages: currentSession.history,
        compacted: result.compacted ?? null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "number" ? body.id : -1;
      const allowed = body.allowed === true;
      const resolve = pendingPermissions.get(id);
      pendingPermissions.delete(id);
      resolve?.(allowed);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/queue") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (message === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "消息不能为空" }));
        return;
      }
      if (!streams.has(currentSession.id)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "当前会话没有执行中的轮次，直接发送即可" }));
        return;
      }
      // 排到当前轮之后执行；输出继续走已打开的 SSE 流（waitForIdle 会等它结束）
      runtime.send(currentSession.id, message, "queue").catch(() => {});
      stateJson(res, { queued: true, note: "已排队，将在当前轮结束后执行" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      stateJson(res, { stopped: runtime.abortActiveTurn(currentSession.id) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rename") {
      const body = await readJsonBody(req);
      if (typeof body.title !== "string" || body.title.trim() === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "标题不能为空" }));
        return;
      }
      try {
        currentSession.rename(body.title);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      // 执行中先不落盘，轮次结束的持久化会带上新标题
      if (!runtime.hasActiveTurn(currentSession.id)) {
        await sessionService.persist(currentSession);
      }
      stateJson(res, { title: currentSession.title });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      if (id === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少会话 id" }));
        return;
      }
      if (id === currentSession.id) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "不能删除当前会话，请先切换到其他会话" }));
        return;
      }
      if (runtime.hasActiveTurn(id)) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "该会话正在执行，稍后再删除" }));
        return;
      }
      const deleted = await store.delete(id);
      const archives = await store.deleteArchives(id);
      registeredSessions.delete(id);
      stateJson(res, { deleted, archives });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (message === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "消息不能为空" }));
        return;
      }
      // 本会话有进行中的轮次 → steer 注入（与 CLI 一致），立即返回；
      // 其他会话在后台跑不影响：每个会话有自己独立的流
      if (streams.has(currentSession.id)) {
        const note = await runtime.send(currentSession.id, message, "steer").catch(() => STEERED_NOTE);
        stateJson(res, { steered: true, note });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const turnSession = currentSession;
      streams.set(turnSession.id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
      try {
        await runtime.send(turnSession.id, message, "queue");
        // 等 steer 注入太晚而自动续排 / 显式排队的后续轮全部结束再关流。
        // 先让出一轮事件循环：链式任务此刻还在微任务队列里，未登记 activeTurns
        await new Promise((resolve) => setImmediate(resolve));
        while (runtime.hasActiveTurn(turnSession.id)) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        streams.get(turnSession.id)?.({ type: "done" });
      } catch (error) {
        // 中断已由 onTurnAborted 通知，不重复报错
        if (!(error instanceof TurnAbortedError)) {
          streams.get(turnSession.id)?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        streams.get(turnSession.id)?.({ type: "done" });
      } finally {
        streams.delete(turnSession.id);
        await sessionService.persist(turnSession).catch(() => {});
        res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  const port = options.port ?? 3000;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as { port: number }).port;

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections(); // 强制断开 keep-alive 连接，避免 close 悬挂
        server.close(() => resolve());
      }),
  };
}
