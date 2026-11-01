import { createExecutionBudget, executionInputLimit } from "../core/execution-budget.ts";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ChatAgent } from "../agent/agent.ts";
import {
  BASE_SYSTEM_PROMPT,
  TRAVEL_PROMPT_VERSION,
  TRAVEL_SYSTEM_PROMPT,
  composeSystemPrompt,
  readWorkspaceRules,
} from "../agent/prompt.ts";
import { ConfigStore } from "../config/config.ts";
import { ModelProfileStore, type ModelProfile } from "../config/models.ts";
import { resolvePricing } from "../config/pricing.ts";
import { Session } from "../core/session.ts";
import { estimateCostYuan } from "../core/usage.ts";
import { createProvider, createProviderFromProfile } from "../llm/factory.ts";
import type { ChatProvider } from "../llm/provider.ts";
import { assessToolBudget, budgetGuidance } from "../runtime/tool-budget.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { briefForSessionTitle, toolRoundsForBrief } from "../tools/brief.ts";
import type { EvalCase, EvalSuite } from "./cases.ts";
import { findItinerary } from "./itinerary-file.ts";
import { computeItineraryMetrics, type ItineraryEvalMetrics } from "./metrics.ts";
import {
  casesToResume,
  createAttemptDirectory,
  createRun,
  finalizeRun,
  loadManifest,
  loadSuiteSnapshot,
  markRunningAttemptsInterrupted,
  nextAvailableAttemptNumber,
  runDirectory,
  summarizeRun,
  upsertAttempt,
  writeAttemptRecord,
  writeManifest,
  writeRunArtifacts,
  type EvalAttemptFailure,
  type EvalAttemptRecord,
  type EvalAttemptStatus,
  type EvalAttemptTelemetry,
  type EvalBudgetExtension,
  type EvalModelInfo,
  type EvalPricing,
  type EvalPromptInfo,
  type EvalRunManifest,
} from "./run-store.ts";

export const EVAL_FALLBACK_TOOL_ROUNDS = 30;
export const EVAL_TOOL_ROUND_CEILING = 150;
export const EVAL_BUDGET_EXTENSION_STEP = 15;
/** 自动续跑只用于补半成品；连续无进展即停止，避免评测无限消耗 */
const MAX_COMPLETENESS_RETRIES = 2;

interface LiveContext {
  readonly config: Awaited<ReturnType<ConfigStore["load"]>>;
  readonly profile: ModelProfile | undefined;
  readonly providerName: string;
  readonly model: EvalModelInfo;
  readonly pricing: EvalPricing;
}

export interface NewLiveRunOptions {
  readonly rootDir: string;
  readonly suitePath: string;
  readonly suite: EvalSuite;
  readonly cases: readonly EvalCase[];
  readonly runId: string;
  readonly caseIds: readonly string[];
  readonly tags: readonly string[];
  readonly limit?: number;
  readonly profileFilter?: string;
  readonly onProgress?: (message: string) => void;
}

export interface ResumeLiveRunOptions {
  readonly rootDir: string;
  readonly runId: string;
  readonly profileFilter?: string;
  readonly caseIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly onProgress?: (message: string) => void;
}

/**
 * 新批次必须使用全新的 run id。live 产物只写入 eval/runs，不再覆盖任何历史批次。
 */
export async function runNewLiveSuite(options: NewLiveRunOptions): Promise<EvalRunManifest> {
  const context = await prepareLiveContext(options.rootDir, options.profileFilter);
  const suiteHash = sha256(await readFile(options.suitePath, "utf8"));
  const now = new Date().toISOString();
  const manifest: EvalRunManifest = {
    schema_version: 1,
    run_id: options.runId,
    status: "running",
    created_at: now,
    updated_at: now,
    mode: "live",
    suite: {
      id: options.suite.id,
      name: options.suite.name,
      version: options.suite.version,
      source: relative(options.rootDir, options.suitePath),
      sha256: suiteHash,
      case_count: options.suite.cases.length,
    },
    filters: {
      case_ids: options.caseIds,
      tags: options.tags,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    model: context.model,
    prompt: {
      version: TRAVEL_PROMPT_VERSION,
      static_sha256: staticPromptHash(),
      custom_sha256: customPromptHash(context.config.systemPrompt),
    },
    pricing: context.pricing,
    budget_policy: {
      fallback_rounds: EVAL_FALLBACK_TOOL_ROUNDS,
      ceiling_rounds: EVAL_TOOL_ROUND_CEILING,
      extension_step: EVAL_BUDGET_EXTENSION_STEP,
    },
    cases: options.cases.map((evalCase) => ({
      eval_case: evalCase,
      status: "pending",
      attempts: [],
    })),
  };
  await createRun(join(options.rootDir, "eval", "runs"), manifest, options.suite);
  options.onProgress?.(
    `批次 ${options.runId} 已创建 · ${options.suite.id}@${options.suite.version} · ${options.cases.length} 个案例`,
  );
  return executeCases(
    join(options.rootDir, "eval", "runs"),
    manifest,
    options.suite,
    context,
    options.onProgress,
  );
}

/**
 * 续跑只追加失败/未完成案例的新 attempt；已通过案例不重复生成。
 * 模型、提示词静态口径和价格必须与原批次一致，避免在同一批次里混入不可比较的配置。
 */
export async function resumeLiveSuite(options: ResumeLiveRunOptions): Promise<EvalRunManifest> {
  const runsRoot = join(options.rootDir, "eval", "runs");
  const loaded = await loadManifest(runsRoot, options.runId);
  let manifest = markRunningAttemptsInterrupted(loaded);
  const suite = await loadSuiteSnapshot(runsRoot, options.runId);
  const context = await prepareLiveContext(options.rootDir, options.profileFilter);
  requireComparableContext(manifest, context);

  const selectedIds = new Set(options.caseIds ?? []);
  const selectedTags = new Set(options.tags ?? []);
  const resumable = casesToResume(manifest);
  const unknownIds = [...selectedIds].filter(
    (id) => !manifest.cases.some((item) => item.eval_case.id === id),
  );
  if (unknownIds.length > 0) {
    throw new Error(`批次中没有这些案例: ${unknownIds.join(", ")}`);
  }
  let targets = resumable.filter((item) =>
    (selectedIds.size === 0 || selectedIds.has(item.eval_case.id)) &&
    (selectedTags.size === 0 || item.eval_case.tags?.some((tag) => selectedTags.has(tag)) === true)
  );
  if (options.limit !== undefined) targets = targets.slice(0, options.limit);
  for (const item of manifest.cases) {
    for (const attempt of item.attempts) {
      if (attempt.status === "interrupted") {
        await writeAttemptRecord(runsRoot, manifest.run_id, attempt);
      }
    }
  }
  if (targets.length === 0) {
    manifest = finalizeRun(manifest);
    await writeManifest(runsRoot, manifest);
    await writeRunArtifacts(runsRoot, manifest);
    options.onProgress?.(
      resumable.length === 0
        ? "没有需要续跑的案例：当前批次所有案例均已通过"
        : "筛选条件没有匹配任何未通过案例；批次原有结果保持不变",
    );
    return manifest;
  }

  manifest = { ...manifest, status: "running", updated_at: new Date().toISOString() };
  await writeManifest(runsRoot, manifest);
  await writeRunArtifacts(runsRoot, manifest);
  options.onProgress?.(`续跑批次 ${options.runId} · 待运行 ${targets.length} 个未通过案例`);
  return executeCases(runsRoot, manifest, suite, context, options.onProgress, new Set(targets.map((item) => item.eval_case.id)));
}

export function initialToolRoundsForCase(evalCase: Pick<EvalCase, "days" | "request">): number {
  return toolRoundsForBrief(
    null,
    EVAL_FALLBACK_TOOL_ROUNDS,
    `${evalCase.days}天\n${evalCase.request}`,
  );
}

export function defaultRunId(suiteId: string, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${suiteId}`;
}

async function prepareLiveContext(rootDir: string, profileFilter: string | undefined): Promise<LiveContext> {
  const config = await new ConfigStore(join(rootDir, ".minicode", "config.json")).load();
  setAmapKey(config.amapApiKey);
  const modelsFile = await new ModelProfileStore(join(rootDir, ".minicode", "models.json")).loadWithSeed(config);
  const profile = modelsFile.profiles.find((item) => item.id === (profileFilter ?? modelsFile.defaultProfile))
    ?? modelsFile.profiles[0];
  const probe = profile === undefined ? createProvider({ config }) : createProviderFromProfile(profile);
  if (probe.name === "mock") {
    throw new Error("未配置真实模型（.minicode/config.json / models.json），live 评测已取消");
  }
  const pricing = resolvePricing(config, profile);
  return {
    config,
    profile,
    providerName: probe.name,
    model: modelInfo(profile, probe.name, config.deepseekModel, config.llmModel),
    pricing: {
      currency: "CNY",
      input_per_million_tokens: pricing.inputPerM,
      output_per_million_tokens: pricing.outputPerM,
      cache_input_per_million_tokens: pricing.cacheInputPerM,
      estimated: true,
    },
  };
}

function modelInfo(
  profile: ModelProfile | undefined,
  providerName: string,
  deepseekModel: string | undefined,
  llmModel: string | undefined,
): EvalModelInfo {
  const separator = providerName.indexOf(":");
  const provider = separator < 0 ? providerName : providerName.slice(0, separator);
  const providerModel = separator < 0 ? "" : providerName.slice(separator + 1);
  return {
    profile_id: profile?.id ?? "default",
    profile_name: profile?.name ?? providerName,
    provider,
    model: profile?.model ?? providerModel ?? deepseekModel ?? llmModel ?? "unknown",
  };
}

function requireComparableContext(manifest: EvalRunManifest, context: LiveContext): void {
  if (
    manifest.model.provider !== context.model.provider ||
    manifest.model.model !== context.model.model
  ) {
    throw new Error(
      `续跑模型必须与原批次一致（原批次 ${manifest.model.provider}/${manifest.model.model}，` +
      `当前 ${context.model.provider}/${context.model.model}）；请新建批次`,
    );
  }
  if (
    manifest.prompt.version !== TRAVEL_PROMPT_VERSION ||
    manifest.prompt.static_sha256 !== staticPromptHash()
  ) {
    throw new Error("旅行提示词已变化，不能把新旧提示词混在同一个批次；请新建批次");
  }
  if (manifest.prompt.custom_sha256 !== customPromptHash(context.config.systemPrompt)) {
    throw new Error("自定义系统提示词已变化，不能把新旧提示词混在同一个批次；请新建批次");
  }
  if (
    manifest.pricing.input_per_million_tokens !== context.pricing.input_per_million_tokens ||
    manifest.pricing.output_per_million_tokens !== context.pricing.output_per_million_tokens
  ) {
    throw new Error("成本单价配置已变化，不能把新旧成本口径混在同一个批次；请新建批次");
  }
}

async function executeCases(
  runsRoot: string,
  initialManifest: EvalRunManifest,
  suite: EvalSuite,
  context: LiveContext,
  onProgress?: (message: string) => void,
  selectedCaseIds?: ReadonlySet<string>,
): Promise<EvalRunManifest> {
  let manifest = initialManifest;
  const cases = suite.cases.filter(
    (evalCase) =>
      manifest.cases.some((item) => item.eval_case.id === evalCase.id) &&
      (selectedCaseIds === undefined || selectedCaseIds.has(evalCase.id)) &&
      manifest.cases.find((item) => item.eval_case.id === evalCase.id)?.status !== "passed",
  );

  for (const evalCase of cases) {
    const attempt = await nextAvailableAttemptNumber(runsRoot, manifest.run_id, evalCase.id);
    const directory = await createAttemptDirectory(runsRoot, manifest.run_id, evalCase.id, attempt);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const systemPrompt = composeAttemptPrompt(evalCase, directory, context.config);
    const prompt = promptInfo(systemPrompt, context.config.systemPrompt);
    let preliminary = attemptRecord({
      evalCase,
      attempt,
      directory,
      runRoot: runDirectory(runsRoot, manifest.run_id),
      startedAt,
      durationMs: 0,
      status: "running",
      model: context.model,
      prompt,
      pricing: context.pricing,
      telemetry: emptyTelemetry(initialToolRoundsForCase(evalCase)),
      note: "attempt 正在运行",
    });
    manifest = upsertAttempt(manifest, preliminary);
    await writeAttemptRecord(runsRoot, manifest.run_id, preliminary);
    await writeManifest(runsRoot, manifest);
    await writeRunArtifacts(runsRoot, manifest);

    onProgress?.(`\n▶ ${evalCase.id} · ${evalCase.title} · attempt-${attempt}`);
    let finalized: EvalAttemptRecord;
    try {
      finalized = await runAttempt({
        runRoot: runDirectory(runsRoot, manifest.run_id),
        directory,
        evalCase,
        attempt,
        startedAt,
        started,
        systemPrompt,
        prompt,
        context,
        onProgress,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      finalized = {
        ...preliminary,
        status: "generation_failed",
        finished_at: new Date().toISOString(),
        failure: {
          stage: providerFailure(reason) ? "provider" : "generation",
          reason,
          reasons: [reason],
        },
        note: "生成过程中抛出异常",
        telemetry: { ...preliminary.telemetry, duration_ms: Date.now() - started },
      };
    }
    manifest = upsertAttempt(manifest, finalized);
    await writeAttemptRecord(runsRoot, manifest.run_id, finalized);
    await writeManifest(runsRoot, manifest);
    await writeRunArtifacts(runsRoot, manifest);
    onProgress?.(renderAttempt(finalized));
  }

  manifest = finalizeRun(manifest);
  await writeManifest(runsRoot, manifest);
  await writeRunArtifacts(runsRoot, manifest);
  onProgress?.(renderSummary(manifest));
  return manifest;
}

async function runAttempt(input: {
  readonly runRoot: string;
  readonly directory: string;
  readonly evalCase: EvalCase;
  readonly attempt: number;
  readonly startedAt: string;
  readonly started: number;
  readonly systemPrompt: string;
  readonly prompt: EvalPromptInfo;
  readonly context: LiveContext;
  readonly onProgress?: (message: string) => void;
}): Promise<EvalAttemptRecord> {
  const registry = createDefaultRegistry({ writeRoot: input.directory, workspace: input.directory });
  const provider = providerFor(input.context, input.systemPrompt);
  const session = new Session();
  session.setTravelMode(true);
  const agent = new ChatAgent(session, provider, registry, input.directory);
  const cumulativeBudget = createExecutionBudget(session, input.context.config, {
    inputPerM: input.context.pricing.input_per_million_tokens,
    outputPerM: input.context.pricing.output_per_million_tokens,
    cacheInputPerM: input.context.pricing.cache_input_per_million_tokens ?? input.context.pricing.input_per_million_tokens,
    hasCachePrice: input.context.pricing.cache_input_per_million_tokens !== undefined,
  });
  const initialRounds = Math.min(cumulativeBudget.maxRounds, initialToolRoundsForCase(input.evalCase));
  let currentRounds = initialRounds;
  let toolRounds = 0;
  let toolCalls = 0;
  let completionRetries = 0;
  const extensions: EvalBudgetExtension[] = [];
  let previousFingerprint: string | undefined;

  const runTurn = (message: string): Promise<string> =>
    agent.run(message, {
      cumulativeBudget,
      maxPromptTokens: executionInputLimit(input.context.config),
      // 需求单落盘后可读取日期、节奏、必去点和交通备注，预算随之升高但不回落
      maxToolRounds: async () => {
        const brief = await briefForSessionTitle(
          input.directory,
          `${input.evalCase.title}\n${input.evalCase.request}`,
        );
        currentRounds = Math.min(cumulativeBudget.maxRounds, Math.max(
          currentRounds,
          toolRoundsForBrief(
            brief,
            EVAL_FALLBACK_TOOL_ROUNDS,
            `${input.evalCase.days}天\n${input.evalCase.request}`,
          ),
        ));
        return currentRounds;
      },
      onToolRound: (info) => {
        toolRounds += 1;
        toolCalls += info.toolCalls;
      },
      onBudgetExhausted: async (current) => {
        const assessment = await assessToolBudget({
          rootDir: input.directory,
          previousFingerprint,
          session,
          initialLimit: initialRounds,
          currentLimit: current,
          ceiling: cumulativeBudget.maxRounds,
          extensionStep: EVAL_BUDGET_EXTENSION_STEP,
        });
        previousFingerprint = assessment.fingerprint;
        if (!assessment.canContinue || !assessment.repair.canImprove) {
          return {
            continue: false,
            guidance:
              `${assessment.explanation}\n${assessment.repair.summary}\n` +
              "请按当前已保存版本收尾，并明确仍未通过的质量项。",
          };
        }
        const next = Math.min(
          cumulativeBudget.maxRounds,
          current + assessment.suggestedAdditionalRounds,
        );
        if (next <= current) return false;
        currentRounds = next;
        extensions.push({
          from_rounds: current,
          to_rounds: next,
          ...(assessment.quality.score === undefined ? {} : { quality_score: assessment.quality.score }),
          ...(assessment.quality.status === undefined ? {} : { quality_status: assessment.quality.status }),
          ...(assessment.quality.issue_count === undefined ? {} : { issue_counts: assessment.quality.issue_count }),
          repair_summary: assessment.repair.summary,
        });
        input.onProgress?.(
          `  ↳ 自动续期工具预算 ${current} → ${next} 轮 · ${assessment.repair.summary}`,
        );
        return { continue: true, guidance: budgetGuidance(assessment) };
      },
      onEvent: (event) => {
        if (event.type === "tool_start") {
          input.onProgress?.(`  · ${event.name}${toolArgumentHint(event.arguments)}`);
          return;
        }
        if (event.type === "tool_error") input.onProgress?.(`  ✗ ${event.name}: ${event.error ?? ""}`);
      },
      onCheckpoint: () =>
        writeFile(join(input.directory, "session.json"), `${JSON.stringify(session.toData(), null, 2)}\n`, "utf8"),
    });

  let itineraryPath: string | null = null;
  let metrics: ItineraryEvalMetrics | null = null;
  let caught: EvalAttemptFailure | null = null;
  try {
    await runTurn(input.evalCase.request + (input.evalCase.budget_per_person_yuan === undefined ? "" : `\n人均总预算为 ${input.evalCase.budget_per_person_yuan} 元，请写入保存数据并在复验时沿用。`));
    let snapshot = await loadAttemptItinerary(input.directory, input.evalCase);
    itineraryPath = snapshot.path;
    metrics = snapshot.metrics;
    if (itineraryPath === null && cumulativeBudget.rounds < cumulativeBudget.maxRounds && cumulativeBudget.calls < cumulativeBudget.maxCalls && !cumulativeBudget.costExceeded?.()) {
      input.onProgress?.("  ↻ 首轮未产出行程，追加一次确认后重试");
      completionRetries += 1;
      await runTurn(
        "确认，请直接一步到位生成完整行程：缺项按默认值处理，不要再追问。" +
        "用 save_itinerary 保存（条目多时按天 merge 保存），最后用 validate_itinerary（strict=true）复核。",
      );
      snapshot = await loadAttemptItinerary(input.directory, input.evalCase);
      itineraryPath = snapshot.path;
      metrics = snapshot.metrics;
    }
    while (
      metrics !== null &&
      metrics.days < input.evalCase.days &&
      completionRetries < MAX_COMPLETENESS_RETRIES && cumulativeBudget.rounds < cumulativeBudget.maxRounds && cumulativeBudget.calls < cumulativeBudget.maxCalls && !cumulativeBudget.costExceeded?.()
    ) {
      const previousDays = metrics.days;
      input.onProgress?.(
        `  ↻ 行程仅 ${previousDays}/${input.evalCase.days} 天，自动追加续跑 ` +
        `${completionRetries + 1}/${MAX_COMPLETENESS_RETRIES}`,
      );
      completionRetries += 1;
      await runTurn(completenessRetryPrompt(input.evalCase, previousDays));
      snapshot = await loadAttemptItinerary(input.directory, input.evalCase);
      itineraryPath = snapshot.path;
      metrics = snapshot.metrics;
      if (metrics === null || metrics.days <= previousDays) break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stage = providerFailure(reason) ? "provider" as const : "generation" as const;
    caught = {
      stage: providerFailure(reason) || itineraryPath === null ? stage : "evaluation",
      reason,
      reasons: [reason],
    };
  } finally {
    await writeFile(join(input.directory, "session.json"), `${JSON.stringify(session.toData(), null, 2)}\n`, "utf8");
  }

  // 网络可能在最后一轮保存之后才断；失败记录也必须读取磁盘上的最新行程，
  // 否则会沿用断线前的旧天数/分数，导致报告误导质量判断。
  try {
    const latest = await loadAttemptItinerary(input.directory, input.evalCase);
    if (latest.path !== null) {
      itineraryPath = latest.path;
      metrics = latest.metrics;
    }
  } catch (error) {
    if (caught === null) {
      const reason = error instanceof Error ? error.message : String(error);
      caught = { stage: "evaluation", reason, reasons: [reason] };
    }
  }

  const durationMs = Date.now() - input.started;
  const telemetry = attemptTelemetry(
    session,
    input.context.pricing,
    durationMs,
    toolRounds,
    toolCalls,
    completionRetries,
    initialRounds,
    currentRounds,
    extensions,
    cumulativeBudget.maxRounds,
  );
  const failure = caught ?? failureFor(input.evalCase, itineraryPath, metrics);
  const status = statusForFailure(failure);
  const record = attemptRecord({
    evalCase: input.evalCase,
    attempt: input.attempt,
    directory: input.directory,
    runRoot: input.runRoot,
    startedAt: input.startedAt,
    durationMs,
    status,
    model: input.context.model,
    prompt: input.prompt,
    pricing: input.context.pricing,
    telemetry,
    ...(itineraryPath === null ? {} : {
      itineraryPath: relative(input.runRoot, itineraryPath),
    }),
    ...(metrics === null ? {} : { metrics }),
    ...(failure === null ? {} : { failure }),
  });
  if (itineraryPath !== null) {
    await copyFile(itineraryPath, join(input.directory, "final-itinerary.json"));
  }
  return record;
}

function providerFor(context: LiveContext, systemPrompt: string): ChatProvider {
  if (context.profile === undefined) return createProvider({ config: context.config, systemPrompt });
  return createProviderFromProfile(context.profile, systemPrompt);
}

function composeAttemptPrompt(
  evalCase: EvalCase,
  directory: string,
  config: LiveContext["config"],
): string {
  return composeSystemPrompt({
    travelMode: true,
    workspace: directory,
    customPrompt: config.systemPrompt,
    tastePreferences: evalCase.taste ?? config.tastePreferences,
    rulesContent: readWorkspaceRules(directory),
  });
}

async function loadAttemptItinerary(
  directory: string,
  evalCase: EvalCase,
): Promise<{ readonly path: string | null; readonly metrics: ItineraryEvalMetrics | null }> {
  const path = await findItinerary(directory, evalCase.title, evalCase.days);
  if (path === null) return { path: null, metrics: null };
  const metrics = computeItineraryMetrics(
    JSON.parse(await readFile(path, "utf8")) as Parameters<typeof computeItineraryMetrics>[0],
    {
      expectedDays: evalCase.days,
      ...(evalCase.budget_per_person_yuan === undefined
        ? {}
        : { budgetPerPersonYuan: evalCase.budget_per_person_yuan }),
    },
  );
  return { path, metrics };
}

function completenessRetryPrompt(evalCase: EvalCase, savedDays: number): string {
  return (
    `评测自动续跑：当前「${evalCase.title}」只保存了 ${savedDays}/${evalCase.days} 天，尚不是完整交付。` +
    "请立即 load_itinerary 查看已有日期，保留并修订已有内容，用 save_itinerary（merge=true）补齐所有缺失日期；" +
    "不要询问用户是否继续，不要只给文字版行程。补齐后完成路线复核和 validate_itinerary（strict=true）。"
  );
}

function failureFor(
  evalCase: EvalCase,
  itineraryPath: string | null,
  metrics: ItineraryEvalMetrics | null,
): EvalAttemptFailure | null {
  if (itineraryPath === null) {
    return {
      stage: "generation",
      reason: "生成结束但未找到行程文件",
      reasons: ["生成结束但未找到行程文件"],
    };
  }
  if (metrics === null) {
    return {
      stage: "evaluation",
      reason: "行程文件未能解析为可评测指标",
      reasons: ["行程文件未能解析为可评测指标"],
    };
  }
  const reasons: string[] = [];
  if (metrics.days !== evalCase.days) {
    reasons.push(`行程天数 ${metrics.days}/${evalCase.days}，未达到案例要求`);
  }
  if (metrics.issueCounts.P0 > 0 || metrics.issueCounts.P1 > 0) {
    const codes = metrics.issueCodes.length === 0 ? "" : `（${metrics.issueCodes.join(", ")}）`;
    reasons.push(`P0 ${metrics.issueCounts.P0} / P1 ${metrics.issueCounts.P1}${codes}`);
  }

  if (reasons.length === 0) return null;
  return {
    stage: "quality_gate",
    reason: reasons.join("；"),
    reasons,
  };
}

function statusForFailure(failure: EvalAttemptFailure | null): EvalAttemptStatus {
  if (failure === null) return "passed";
  if (failure.stage === "quality_gate") return "quality_failed";
  if (failure.stage === "evaluation") return "evaluation_failed";
  if (failure.stage === "interrupted") return "interrupted";
  return "generation_failed";
}

function emptyTelemetry(initialRounds: number): EvalAttemptTelemetry {
  return {
    duration_ms: 0,
    tool_rounds: 0,
    tool_calls: 0,
    completion_retries: 0,
    tokens: {
      prompt: 0,
      completion: 0,
      total: 0,
      requests: 0,
      cache_hit: 0,
    },
    estimated_cost_yuan: 0,
    budget: {
      initial_rounds: initialRounds,
      current_rounds: initialRounds,
      ceiling_rounds: EVAL_TOOL_ROUND_CEILING,
      extensions: [],
    },
  };
}

function attemptTelemetry(
  session: Session,
  pricing: EvalPricing,
  durationMs: number,
  toolRounds: number,
  toolCalls: number,
  completionRetries: number,
  initialRounds: number,
  currentRounds: number,
  extensions: readonly EvalBudgetExtension[],
  ceilingRounds: number,
): EvalAttemptTelemetry {
  return {
    duration_ms: durationMs,
    request_contexts: session.requestContexts,
    tool_rounds: toolRounds,
    tool_calls: toolCalls,
    completion_retries: completionRetries,
    tokens: {
      prompt: session.usage.promptTokens,
      completion: session.usage.completionTokens,
      total: session.usage.totalTokens,
      requests: session.usage.requests,
      cache_hit: session.usage.cacheHitTokens,
    },
    estimated_cost_yuan: estimateCostYuan(
      session.usage,
      pricing.input_per_million_tokens,
      pricing.output_per_million_tokens,
      pricing.cache_input_per_million_tokens ?? pricing.input_per_million_tokens,
    ),
    budget: {
      initial_rounds: initialRounds,
      current_rounds: currentRounds,
      ceiling_rounds: ceilingRounds,
      extensions,
    },
  };
}

function attemptRecord(input: {
  readonly evalCase: EvalCase;
  readonly attempt: number;
  readonly directory: string;
  readonly runRoot: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: EvalAttemptStatus;
  readonly model: EvalModelInfo;
  readonly prompt: EvalPromptInfo;
  readonly pricing: EvalPricing;
  readonly telemetry: EvalAttemptTelemetry;
  readonly itineraryPath?: string;
  readonly note?: string;
  readonly failure?: EvalAttemptFailure;
  readonly metrics?: ItineraryEvalMetrics;
}): EvalAttemptRecord {
  return {
    attempt: input.attempt,
    case_id: input.evalCase.id,
    status: input.status,
    started_at: input.startedAt,
    output_dir: relative(input.runRoot, input.directory),
    model: input.model,
    prompt: input.prompt,
    pricing: input.pricing,
    telemetry: input.telemetry,
    ...(input.status === "running" ? {} : { finished_at: new Date().toISOString() }),
    ...(input.itineraryPath === undefined ? {} : { itinerary_path: input.itineraryPath }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
  };
}

function promptInfo(systemPrompt: string, customPrompt: string | undefined): EvalPromptInfo {
  return {
    version: TRAVEL_PROMPT_VERSION,
    static_sha256: staticPromptHash(),
    custom_sha256: customPromptHash(customPrompt),
    rendered_sha256: sha256(systemPrompt),
    kind: customPrompt === undefined || customPrompt.trim() === "" ? "default" : "custom",
  };
}

function staticPromptHash(): string {
  return sha256([BASE_SYSTEM_PROMPT, TRAVEL_SYSTEM_PROMPT].join("\n"));
}

function customPromptHash(customPrompt: string | undefined): string {
  return sha256(customPrompt ?? "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerFailure(reason: string): boolean {
  return /^(网络请求失败|LLM 返回 [45]\d\d|LLM 未返回响应体)/.test(reason);
}

function renderAttempt(record: EvalAttemptRecord): string {
  const score = record.metrics === undefined ? "—" : `${record.metrics.score}/100`;
  const days = record.metrics === undefined ? "" : ` · ${record.metrics.days}/${record.metrics.expectedDays} 天`;
  const status = record.status === "passed" ? "通过" : "未通过";
  return (
    `  结果 ${status} · 质量 ${score}${days} · ${(record.telemetry.duration_ms / 1000).toFixed(1)}s · ` +
    `${record.telemetry.tool_rounds} 轮 / ${record.telemetry.tool_calls} 次工具 · ` +
    `${record.telemetry.tokens.total} tokens · ¥${record.telemetry.estimated_cost_yuan.toFixed(4)}` +
    (record.failure === undefined ? "" : `\n  原因 ${record.failure.reason}`)
  );
}

function renderSummary(manifest: EvalRunManifest): string {
  const summary = summarizeRun(manifest);
  return (
    `\n批次 ${manifest.run_id} · 通过 ${summary.passed}/${summary.cases} · ` +
    `${summary.attempts} 个 attempt · ${summary.tool_rounds} 轮工具 · ` +
    `${summary.tokens} tokens · 估算 ¥${summary.estimated_cost_yuan.toFixed(4)}\n` +
    `报告: ${resolve("eval", "runs", manifest.run_id, "report.md")}`
  );
}

function toolArgumentHint(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "";
  const compact = raw.replace(/\s+/g, " ");
  return ` ${compact.length <= 140 ? compact : `${compact.slice(0, 137)}...`}`;
}
