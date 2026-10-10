import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { Session } from "../core/session.ts";
import { ChatAgent, TurnAbortedError } from "../agent/agent.ts";
import { composeSystemPrompt, readWorkspaceRules } from "../agent/prompt.ts";
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
import { getAmapClient, setAmapKey } from "../tools/amap-access.ts";
import { createPermissionMemory, decidePermission, permissionModeOf } from "../service/permission-policy.ts";
import type { ApprovalMode, PermissionMemory } from "../service/permission-policy.ts";
import type { AmapClient, RouteGeometry } from "../tools/amap.ts";
import { haversineKm } from "../tools/geo.ts";
import { resolvePlanCoordinates, type PlanJson } from "./plan-coords.ts";
import { applyPlanEdit, suggestPlanOptions } from "./plan-edit.ts";
import { deleteProfile, listProfiles, parseProfileDocument, profileSummary, saveProfile } from "../tools/profiles.ts";
import type { ProfileFieldId } from "../tools/profiles.ts";
import { PhotoCache } from "./photo-cache.ts";
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

  /** 会话工作区：会话指定 > 装配默认（rootDir） */
  function workspaceOf(session: Session): string {
    return session.workspace ?? rootDir;
  }

  function buildSystemPrompt(session: Session): string {
    const workspace = workspaceOf(session);
    return composeSystemPrompt({
      travelMode,
      workspace,
      customPrompt: config.systemPrompt,
      tastePreferences: config.tastePreferences,
      rulesContent: readWorkspaceRules(workspace),
    });
  }

  let provider = options.providerOverride ?? createProvider({ config, systemPrompt: buildSystemPrompt(new Session()) });
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
    // 缓存键 = 完整系统提示词（工作区/规则/日期/模式任一变化都会自然切换）
    const systemPrompt = buildSystemPrompt(session);
    const key = `${profile.id}|${systemPrompt}`;
    let cached = providerCache.get(key);
    if (cached === undefined) {
      cached = createProviderFromProfile(profile, systemPrompt);
      providerCache.set(key, cached);
    }
    return cached;
  }

  function registerSessionAgent(session: Session): void {
    runtime.registerAgent(session.id, new ChatAgent(session, sessionProvider(session), registry, rootDir));
    registeredSessions.add(session.id);
  }

  function maskedProfiles() {
    return profiles.map((p) => ({ ...p, apiKey: maskSecret(p.apiKey) }));
  }

  const registry = createDefaultRegistry({ writeRoot: rootDir, workspace: rootDir });
  const store = new JsonFileSessionStore(join(rootDir, ".minicode", "sessions"));
  const photoCache = new PhotoCache(join(rootDir, ".minicode", "photo-cache.json"));
  await photoCache.load();
  // 高德 POI 搜索并发上限很低：照片请求必须串行限速（实测 12 个并发约 1/3 被限流），
  // 同时合并同一地点的在途请求，避免重复消耗配额
  const photoInflight = new Map<string, Promise<string[]>>();
  let photoChain: Promise<void> = Promise.resolve();
  const PHOTO_QUERY_INTERVAL_MS = 200;
  function pacedPhotoQuery(key: string, run: () => Promise<string[]>): Promise<string[]> {
    const existing = photoInflight.get(key);
    if (existing !== undefined) return existing;
    const task = photoChain
      .then(() => new Promise((resolve) => setTimeout(resolve, PHOTO_QUERY_INTERVAL_MS)))
      .then(run)
      .finally(() => {
        photoInflight.delete(key);
      });
    photoInflight.set(key, task);
    photoChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
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
  const sessionService = new SessionService(store);

  // 启动时恢复最近更新的已落盘会话：否则每次重启当前位都是全新空白会话，
  // 用户切走后它就成了"打不开也删不掉"的空会话幽灵（从未落盘，无法恢复）
  const latestMeta = (await store.list())[0];
  let currentSession = latestMeta === undefined ? new Session() : ((await store.load(latestMeta.id)) ?? new Session());
  let indexHtml = await readFile(join(import.meta.dirname, "index.html"), "utf8");

  // 每个会话独立的 SSE 输出流：多会话可并行执行，切换查看不打断后台任务
  const streams = new Map<string, (event: Record<string, unknown>) => void>();
  const pendingPermissions = new Map<number, { sessionId: string; tool: string; commandKey: string; resolve: (allowed: boolean) => void }>();
  /** 会话级审批记忆（总是允许的工具 / bash 命令前缀）——策略见 service/permission-policy */
  const permissionMemories = new Map<string, PermissionMemory>();
  /** 信任会话（仅内存，不持久化）：本会话内所有确认直接放行 */
  const trustedSessions = new Set<string>();
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
      onCheckpoint: (sessionId) => {
        const agent = runtime.getAgent(sessionId);
        if (agent === undefined) return;
        return sessionService.persist(agent.session);
      },
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
    provider = options.providerOverride ?? createProvider({ config, systemPrompt: buildSystemPrompt(currentSession) });
    runtime = new AgentRuntime(buildRuntimeOptions());
    for (const session of sessions) {
      runtime.registerAgent(session.id, new ChatAgent(session, sessionProvider(session), registry, rootDir));
    }
    if (sessions.length === 0) registerSessionAgent(currentSession);
  }

  function newSession(): void {
    currentSession = new Session();
    registerSessionAgent(currentSession);
  }

  function permissionMemoryFor(sessionId: string): PermissionMemory {
    let memory = permissionMemories.get(sessionId);
    if (memory === undefined) {
      memory = createPermissionMemory();
      permissionMemories.set(sessionId, memory);
    }
    return memory;
  }

  function requestPermission(sessionId: string, request: { tool: string; message: string; arguments?: string }): Promise<boolean> {
    const decision = decidePermission({
      toolName: request.tool,
      tool: registry.get(request.tool),
      arguments: request.arguments,
      mode: approvalModeOf(sessionId),
      memory: permissionMemoryFor(sessionId),
    });
    if (decision.kind === "allow") return Promise.resolve(true);

    return new Promise((resolve) => {
      const id = (permissionCounter += 1);
      // 2 分钟无响应默认拒绝；应答时清除定时器，避免悬挂计时器
      const timer = setTimeout(() => {
        if (pendingPermissions.get(id) !== undefined) {
          pendingPermissions.delete(id);
          resolve(false);
        }
      }, 120_000);
      pendingPermissions.set(id, {
        sessionId,
        tool: request.tool,
        commandKey: decision.commandKey,
        resolve: (allowed) => {
          clearTimeout(timer);
          resolve(allowed);
        },
      });
      streams.get(sessionId)?.({
        type: "permission",
        id,
        sessionId,
        tool: request.tool,
        message: request.message,
        canAlways: decision.canAlways,
        ...(decision.commandKey === "" ? {} : { commandKey: decision.commandKey }),
      });
    });
  }

  /** 会话当前生效的审批模式：trust（内存）> 会话持久值 > 全局默认 edits */
  function approvalModeOf(sessionId: string): ApprovalMode {
    const session = runtime.getAgent(sessionId)?.session;
    if (session === undefined) return trustedSessions.has(sessionId) ? "trust" : "edits";
    return permissionModeOf(session, trustedSessions.has(sessionId));
  }

  async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  }

  /** 原始字节 body（档案文件上传用），带大小上限防误传大文件 */
  async function readRawBody(request: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += (chunk as Buffer).length;
      if (total > limitBytes) throw new Error("文件超过 8MB 上限");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function stateJson(res: ServerResponse, body: unknown): void {
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
    // 禁缓存：否则浏览器可能一直用旧版页面（曾导致地图功能上线后用户仍看到旧页面）
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : indexHtml);
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
        workspace: workspaceOf(currentSession),
        approvalMode: approvalModeOf(currentSession.id),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/approval") {
      const body = await readJsonBody(req);
      const mode = body.mode;
      if (mode !== "ask" && mode !== "edits" && mode !== "trust") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "mode 只能是 ask / edits / trust" }));
        return;
      }
      if (mode === "trust") {
        trustedSessions.add(currentSession.id);
      } else {
        trustedSessions.delete(currentSession.id);
        currentSession.setApprovalMode(mode);
        await sessionService.persist(currentSession);
      }
      stateJson(res, { approvalMode: approvalModeOf(currentSession.id) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspace") {
      const body = await readJsonBody(req);
      const rawPath = typeof body.path === "string" ? body.path.trim() : "";
      if (rawPath === "") {
        // 空路径 = 恢复默认工作区
        currentSession.setWorkspace(undefined);
        registerSessionAgent(currentSession);
        await sessionService.persist(currentSession);
        stateJson(res, { workspace: workspaceOf(currentSession) });
        return;
      }
      const resolved = resolveUserPath(rawPath);
      let info;
      try {
        info = await stat(resolved);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `目录不存在: ${resolved}` }));
        return;
      }
      if (!info.isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `不是目录: ${resolved}` }));
        return;
      }
      currentSession.setWorkspace(resolved);
      registerSessionAgent(currentSession);
      await sessionService.persist(currentSession);
      stateJson(res, { workspace: workspaceOf(currentSession) });
      return;
    }
    // 工作区文件夹浏览器：列出子目录（只读；只列目录不列文件），默认从主目录开始
    if (req.method === "GET" && url.pathname === "/api/fs/dirs") {
      const raw = (url.searchParams.get("path") ?? "").trim();
      const target = raw === "" ? homedir() : resolveUserPath(raw);
      try {
        const info = await stat(target);
        if (!info.isDirectory()) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: `不是文件夹：${target}` }));
          return;
        }
        const parent = dirname(target);
        stateJson(res, {
          path: target,
          parent: parent === target ? null : parent, // 根目录没有上级
          home: homedir(),
          root: parse(target).root,
          dirs: await listSubdirs(target),
        });
      } catch {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `文件夹不存在或没有权限：${target}` }));
      }
      return;
    }
    // ===== 旅行者档案：列表 / 导入（上传填好的表单解析）/ 保存 / 删除 =====
    if (req.method === "GET" && url.pathname === "/api/profiles") {
      const profiles = await listProfiles(rootDir);
      stateJson(res, {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          summary: profileSummary(profile),
          updatedAt: profile.updatedAt,
        })),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/profiles/detail") {
      const id = (url.searchParams.get("id") ?? "").trim();
      const profile = id === "" ? null : (await listProfiles(rootDir)).find((entry) => entry.id === id) ?? null;
      if (profile === null) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "未找到该档案" }));
        return;
      }
      stateJson(res, { profile });
      return;
    }
    // 导入：上传填好的档案文件（原始字节）；只解析不落盘，前端确认后再 save
    if (req.method === "POST" && url.pathname === "/api/profiles/import") {
      const fileName = (url.searchParams.get("name") ?? "").trim();
      if (fileName === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少文件名（?name=xxx.docx）" }));
        return;
      }
      try {
        const parsed = parseProfileDocument(fileName, await readRawBody(req));
        stateJson(res, { file: fileName, ...parsed });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/profiles/save") {
      const body = await readJsonBody(req);
      const fields: Partial<Record<ProfileFieldId, string>> = {};
      if (typeof body.fields === "object" && body.fields !== null) {
        for (const [key, value] of Object.entries(body.fields)) {
          if (typeof value === "string" && value.trim() !== "") fields[key as ProfileFieldId] = value;
        }
      }
      const source =
        typeof body.source === "object" && body.source !== null
          ? {
              ...(typeof (body.source as Record<string, unknown>).file === "string"
                ? { file: (body.source as Record<string, unknown>).file as string }
                : {}),
              ...(typeof (body.source as Record<string, unknown>).rawText === "string"
                ? { rawText: (body.source as Record<string, unknown>).rawText as string, importedAt: Date.now() }
                : {}),
            }
          : undefined;
      try {
        const profile = await saveProfile(rootDir, {
          ...(typeof body.id === "string" && body.id !== "" ? { id: body.id } : {}),
          name: typeof body.name === "string" ? body.name : "",
          fields,
          ...(source !== undefined ? { source } : {}),
        });
        stateJson(res, { ok: true, profile: { id: profile.id, name: profile.name, summary: profileSummary(profile) } });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/profiles/delete") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      if (id === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少档案 id" }));
        return;
      }
      stateJson(res, { deleted: await deleteProfile(rootDir, id) });
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
    // 行程地图：列出已保存行程 + 读取单份行程
    if (req.method === "GET" && url.pathname === "/api/plans") {
      const plans: Array<{
        title: string;
        days: number;
        file: string;
        updatedAt?: number;
        quality?: { status: string; score: number } | null;
      }> = [];
      try {
        const names = await readdir(join(rootDir, "plans"));
        for (const name of names.filter((n) => n.endsWith(".json") && !n.endsWith(".quality.json")).sort()) {
          try {
            const data = JSON.parse(await readFile(join(rootDir, "plans", name), "utf8")) as {
              title?: string;
              days?: unknown[];
            };
            // 质量报告与更新时间用于核验"模型声称的改动"是否真的落盘
            let updatedAt: number | undefined;
            try {
              updatedAt = (await stat(join(rootDir, "plans", name))).mtimeMs;
            } catch {
              updatedAt = undefined;
            }
            let quality: { status: string; score: number } | null = null;
            try {
              const raw = JSON.parse(
                await readFile(join(rootDir, "plans", name.replace(/\.json$/, ".quality.json")), "utf8"),
              ) as { status?: string; score?: number };
              if (typeof raw.status === "string" && typeof raw.score === "number") {
                quality = { status: raw.status, score: raw.score };
              }
            } catch {
              quality = null;
            }
            plans.push({ title: data.title ?? name, days: data.days?.length ?? 0, file: name, updatedAt, quality });
          } catch {
            // 跳过损坏的 JSON
          }
        }
      } catch {
        // plans 目录不存在 = 没有已保存行程
      }
      stateJson(res, { plans });
      return;
    }
    // POI 照片：按地点名+坐标查高德 POI 图片（地图弹窗按需加载；结果落盘缓存，避免重复消耗配额）
    if (req.method === "GET" && url.pathname === "/api/poi-photos") {
      const name = (url.searchParams.get("name") ?? "").trim();
      const latitude = Number(url.searchParams.get("lat"));
      const longitude = Number(url.searchParams.get("lng"));
      const amap = getAmapClient();
      if (amap === undefined) {
        stateJson(res, { available: false, photos: [] });
        return;
      }
      if (name === "" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        stateJson(res, { available: true, photos: [] });
        return;
      }
      // 同一点位（约百米网格）复用缓存；名称变化重新查询
      const cacheKey = `${name}|${latitude.toFixed(3)},${longitude.toFixed(3)}`;
      const cached = photoCache.get(cacheKey);
      if (cached !== undefined) {
        stateJson(res, { available: true, photos: cached });
        return;
      }
      try {
        const photos = await pacedPhotoQuery(cacheKey, () => amap.poiPhotos(name, { latitude, longitude }));
        photoCache.set(cacheKey, photos);
        void photoCache.persist();
        stateJson(res, { available: true, photos });
      } catch {
        // 高德失败/限流：不写入缓存，标记可重试（前端不缓存空结果，稍后再试）
        stateJson(res, { available: true, photos: [], retryable: true });
      }
      return;
    }
    // 行程路线几何：逐段调高德路径规划（<1.5km 步行、其余驾车），内存缓存避免重复消耗配额
    if (req.method === "GET" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/routes")) {
      const title = decodeURIComponent(url.pathname.slice("/api/plans/".length, -"/routes".length));
      const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-");
      const amap = getAmapClient();
      if (amap === undefined) {
        stateJson(res, { available: false, days: [] });
        return;
      }
      try {
        const plan = JSON.parse(await readFile(join(rootDir, "plans", `${safe}.json`), "utf8")) as {
          days?: Array<{ items?: Array<{ type?: string; location?: { latitude?: number; longitude?: number } }> }>;
        };
        const days: Array<{ legs: Array<Record<string, unknown>> }> = [];
        for (const day of plan.days ?? []) {
          // 路线 = 当天实际停留点：景点 + 住宿/休息（住处是每天的起点终点），按条目顺序连接；
          // 餐厅是"沿途候选"（每餐多个），塞进路线会多绕路，只做标记
          const located = (day.items ?? []).filter(
            (item) =>
              (item.type === "visit" || item.type === "accommodation" || item.type === "rest") &&
              item.location?.latitude !== undefined &&
              item.location?.longitude !== undefined,
          );
          const legs: Array<Record<string, unknown>> = [];
          for (let i = 1; i < located.length; i++) {
            const from = { latitude: located[i - 1].location!.latitude!, longitude: located[i - 1].location!.longitude! };
            const to = { latitude: located[i].location!.latitude!, longitude: located[i].location!.longitude! };
            const straightM = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude) * 1000;
            // 同一点位的相邻条目（如多个"回酒店"休息块）：不请求路径规划，直连占位保持段数对齐
            if (straightM < 25) {
              legs.push({ mode: "walking", straight: true });
              continue;
            }
            const mode = straightM <= 1500 ? "walking" : "driving";
            const geometry = await cachedLegRoute(amap, mode, from, to);
            legs.push(
              geometry === null
                ? { mode, straight: true }
                : { mode, distanceM: geometry.distanceM, durationSec: geometry.durationSec, points: geometry.points },
            );
          }
          days.push({ legs });
        }
        stateJson(res, { available: true, days });
      } catch {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到行程「${title}」` }));
      }
      return;
    }
    // 行程条目编辑：附近推荐（高德 POI；服务端缓存 10 分钟，编辑面板反复打开不重复消耗配额）
    if (req.method === "GET" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/suggest")) {
      const title = decodeURIComponent(url.pathname.slice("/api/plans/".length, -"/suggest".length));
      const dayNo = Number(url.searchParams.get("day"));
      const itemId = (url.searchParams.get("item_id") ?? "").trim();
      if (!Number.isInteger(dayNo) || dayNo < 1 || itemId === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少 day / item_id" }));
        return;
      }
      try {
        stateJson(res, await suggestPlanOptions(rootDir, title, dayNo, itemId));
      } catch (error) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    // 行程条目编辑：替换 / 调换顺序 / 删除（写回 JSON 并重生成 Markdown 与质量报告）
    if (req.method === "POST" && url.pathname === "/api/plans/edit") {
      const body = await readJsonBody(req);
      try {
        stateJson(res, { ok: true, ...(await applyPlanEdit(rootDir, body)) });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    // 删除行程：连同 Markdown 与质量报告一起清理（前端二次确认后调用）
    if (req.method === "POST" && url.pathname === "/api/plans/delete") {
      const body = await readJsonBody(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少行程标题" }));
        return;
      }
      const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-");
      const base = join(rootDir, "plans", safe);
      let deleted = 0;
      for (const file of [`${base}.json`, `${base}.md`, `${base}.quality.json`, `${base}.quality.md`]) {
        try {
          await unlink(file);
          deleted += 1;
        } catch {
          // 单个文件缺失不影响其余清理
        }
      }
      stateJson(res, { deleted, found: deleted > 0 });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/plans/")) {
      const title = decodeURIComponent(url.pathname.slice("/api/plans/".length));
      const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-");
      try {
        const file = join(rootDir, "plans", `${safe}.json`);
        const raw = await readFile(file, "utf8");
        // 模型写入的坐标常是估算值（实测偏差可达 2 公里），
        // 用高德 POI 搜索按地点名重新校准并写回（带 amap-resolved 标记，只修一次）
        let payload = raw;
        const amap = getAmapClient();
        if (amap !== undefined) {
          try {
            const corrected = await resolvePlanCoordinates(JSON.parse(raw) as PlanJson, async (query, near) => {
              const pois = await amap.poiSearch(query, near, 50_000);
              const first = pois[0];
              if (first === undefined) return null;
              const [longitude, latitude] = first.location.split(",").map(Number);
              if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
              return { latitude, longitude };
            });
            if (corrected.resolved > 0) {
              payload = JSON.stringify(corrected.plan, null, 2);
              await writeFile(file, payload, "utf8");
            }
          } catch {
            // 校准失败（配额/网络）→ 返回原始数据，不影响地图打开
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到行程「${title}」` }));
      }
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
        // 未落盘的空白草稿（重启时的当前位、新建后没发消息就切走）：不是当前会话时
        // 点击只会"切换会话失败"，还常被当成删不掉空会话 —— 不展示
        .filter(
          (session) =>
            session.history.length > 0 ||
            session.id === currentSession.id ||
            runtime.hasActiveTurn(session.id) ||
            streams.has(session.id),
        )
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
      // 纯加载快速路径：切换不做压缩（压缩会调 LLM、耗时数秒，由运行时在轮次开始时处理）
      const loaded = await store.load(body.id);
      // 未落盘的内存草稿（新建后没发消息就切走）：同进程内直接切回来，而不是假装"未找到"
      const session = loaded ?? runtime.getAgent(body.id)?.session;
      if (session === undefined) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到会话 ${body.id}` }));
        return;
      }
      currentSession = session;
      registerSessionAgent(currentSession);
      stateJson(res, {
        title: currentSession.title,
        id: currentSession.id,
        messages: currentSession.history,
        running: runtime.hasActiveTurn(currentSession.id),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "number" ? body.id : -1;
      const allow = body.allowed === true || body.allowed === "always" || body.allowed === "always-command";
      const pending = pendingPermissions.get(id);
      pendingPermissions.delete(id);
      if (pending !== undefined) {
        if (body.allowed === "always" && registry.get(pending.tool)?.sessionAlwaysAllowed !== false) {
          permissionMemoryFor(pending.sessionId).alwaysTools.add(pending.tool);
        }
        if (body.allowed === "always-command" && pending.commandKey !== "") {
          permissionMemoryFor(pending.sessionId).bashKeys.add(pending.commandKey);
        }
        pending.resolve(allow);
      }
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
      runtime.unregisterAgent(id);
      permissionMemories.delete(id);
      trustedSessions.delete(id);
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

/** 支持 ~ 展开：手输 "~/Documents" 之类路径也能直接用 */
function resolveUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

/** 目录浏览：列出子目录（含指向目录的符号链接；隐藏目录带标记排最后） */
async function listSubdirs(target: string): Promise<Array<{ name: string; path: string; hidden: boolean }>> {
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) return null;
        const ok = await stat(join(target, entry.name)).then(
          (info) => info.isDirectory(),
          () => false,
        );
        if (!ok) return null;
      }
      return { name: entry.name, path: join(target, entry.name), hidden: entry.name.startsWith(".") };
    }),
  );
  return dirs
    .filter((dir): dir is { name: string; path: string; hidden: boolean } => dir !== null)
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, "zh"));
}

/** 路段几何内存缓存：道路不随时间变化，避免每次打开地图重复消耗高德方向 API 配额 */
const legRouteCache = new Map<string, { value: RouteGeometry | null; expiresAt: number }>();
const LEG_CACHE_MAX = 400;
/** 两次高德方向请求的最小间隔：实测连发会触发限流（infocode 10021 间歇出现） */
const ROUTE_REQUEST_GAP_MS = 250;
let lastRouteRequestAt = 0;

async function cachedLegRoute(
  amap: AmapClient,
  mode: "walking" | "driving",
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): Promise<RouteGeometry | null> {
  const key =
    `${mode}|${from.latitude.toFixed(5)},${from.longitude.toFixed(5)}` +
    `|${to.latitude.toFixed(5)},${to.longitude.toFixed(5)}`;
  const hit = legRouteCache.get(key);
  if (hit !== undefined && Date.now() < hit.expiresAt) return hit.value;

  const value = await pacedLegRoute(amap, mode, from, to);
  if (legRouteCache.size >= LEG_CACHE_MAX) {
    const oldest = legRouteCache.keys().next().value;
    if (oldest !== undefined) legRouteCache.delete(oldest);
  }
  // 成功长缓存（道路不变）；失败 5 分钟后可重试（限流是瞬时故障）
  legRouteCache.set(key, {
    value,
    expiresAt: Date.now() + (value === null ? 5 * 60_000 : 7 * 24 * 60 * 60_000),
  });
  return value;
}

/** 带节奏控制与一次重试的方向请求：间隔 ≥250ms，失败后 400ms 重试一次 */
async function pacedLegRoute(
  amap: AmapClient,
  mode: "walking" | "driving",
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  attempt = 0,
): Promise<RouteGeometry | null> {
  const wait = lastRouteRequestAt + ROUTE_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRouteRequestAt = Date.now();

  const result = await amap.directionRoute(mode, from, to).catch(() => null);
  if (result === null && attempt === 0) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return pacedLegRoute(amap, mode, from, to, 1);
  }
  return result;
}
