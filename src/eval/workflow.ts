import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createDefaultRegistry } from "../tools/all.ts";
import { parseItinerary, type ItineraryItem } from "../tools/itinerary-schema.ts";
import {
  FrozenWorldRuntime,
  checkWorldItinerary,
  evalImplementationHash,
  loadExternalWorld,
  type ExternalWorld,
} from "./external-world.ts";
import type { EvalCase, EvalSuite } from "./cases.ts";
import { findItinerary } from "./itinerary-file.ts";
import { attemptRecord, failureFor, loadAttemptItinerary, statusForFailure } from "./live.ts";
import {
  createAttemptDirectory,
  createRun,
  finalizeRun,
  runDirectory,
  upsertAttempt,
  writeAttemptRecord,
  writeManifest,
  writeRunArtifacts,
  type EvalAttemptFailure,
  type EvalAttemptTelemetry,
  type EvalModelInfo,
  type EvalPricing,
  type EvalPromptInfo,
  type EvalRunManifest,
} from "./run-store.ts";

/**
 * W1 workflow 基线：结构化 brief + 确定性取数/排程/保存/校验。
 *
 * 它复用与 Agent 完全相同的工具、证据仓库、行程 schema 和 validator，
 * 不使用 ChatAgent 循环，也不依赖模型自由决定下一步。
 *
 * 当前版本使用固定世界与案例里的结构化字段（日期、必去、预算）作为输入，
 * 因此是“结构化 brief”的上界基线；下一版可替换为一次 LLM 需求抽取。
 */

export interface WorkflowRunOptions {
  readonly rootDir: string;
  readonly suitePath: string;
  readonly suite: EvalSuite;
  readonly cases: readonly EvalCase[];
  readonly runId: string;
  readonly worldPath: string;
}

interface Candidate {
  readonly name: string;
  readonly distanceKm: number;
  readonly rating: number;
}

interface PlaceInfo {
  readonly closedWeekdays: readonly number[];
  readonly durationMin: number;
}

export async function runWorkflowSuite(options: WorkflowRunOptions): Promise<EvalRunManifest> {
  const snapshot = await loadExternalWorld(options.worldPath);
  const world = snapshot.world;
  const runsRoot = join(options.rootDir, "eval", "runs");
  const runRoot = runDirectory(runsRoot, options.runId);
  const implementationHash = await evalImplementationHash();
  const now = new Date().toISOString();
  const suiteText = await readFile(options.suitePath, "utf8");

  const manifest: EvalRunManifest = {
    schema_version: 1,
    run_id: options.runId,
    status: "running",
    created_at: now,
    updated_at: now,
    mode: "live",
    architecture: "workflow",
    external_data: {
      mode: "frozen",
      id: world.id,
      version: world.version,
      sha256: snapshot.sha256,
      implementation_sha256: implementationHash,
      snapshot: "external-world.json",
      now: world.now,
      time_zone: world.time_zone,
      provenance: world.provenance.kind,
      cache: "cold",
      assistance: "none",
    },
    suite: {
      id: options.suite.id,
      name: options.suite.name,
      version: options.suite.version,
      source: relative(options.rootDir, options.suitePath),
      sha256: sha256(suiteText),
      case_count: options.suite.cases.length,
    },
    filters: {
      case_ids: options.cases.map((item) => item.id),
      tags: [],
    },
    model: workflowModel(),
    prompt: workflowPrompt(),
    pricing: workflowPricing(),
    budget_policy: {
      fallback_rounds: 0,
      ceiling_rounds: 0,
      extension_step: 0,
    },
    cases: options.cases.map((item) => ({
      eval_case: item,
      status: "pending",
      attempts: [],
    })),
  };

  await createRun(runsRoot, manifest, options.suite);
  await writeFile(join(runRoot, "external-world.json"), snapshot.text, "utf8");

  let current = manifest;
  for (const evalCaseItem of options.cases) {
    const attempt = await runWorkflowAttempt({
      runsRoot,
      runRoot,
      world,
      evalCase: evalCaseItem,
      runId: options.runId,
      implementationHash,
    });
    current = upsertAttempt(current, attempt);
    await writeAttemptRecord(runsRoot, options.runId, attempt);
    await writeManifest(runsRoot, current);
    await writeRunArtifacts(runsRoot, current);
  }
  current = finalizeRun(current);
  await writeManifest(runsRoot, current);
  await writeRunArtifacts(runsRoot, current);
  return current;
}

async function runWorkflowAttempt(input: {
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly world: ExternalWorld;
  readonly evalCase: EvalCase;
  readonly runId: string;
  readonly implementationHash: string;
}): Promise<ReturnType<typeof attemptRecord>> {
  const directory = await createAttemptDirectory(input.runsRoot, input.runId, input.evalCase.id, 1);
  const runtime = new FrozenWorldRuntime(input.world);
  const registry = createDefaultRegistry({
    writeRoot: directory,
    workspace: directory,
    allowCommands: false,
  });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let calls = 0;
  let rounds = 0;
  let failure: EvalAttemptFailure | null = null;
  let itineraryPath: string | null = null;
  let metrics: Awaited<ReturnType<typeof loadAttemptItinerary>>["metrics"] = null;
  let checks: ReturnType<typeof checkWorldItinerary> = [];

  const execute = async (name: string, args: object): Promise<string> => {
    calls += 1;
    return registry.execute(name, JSON.stringify(args), {
      workspace: directory,
      travelMode: true,
      destination: input.world.city.name,
      queryAttempts: new Map(),
    });
  };

  try {
    await runtime.run(async () => {
      const brief = workflowBrief(input.world, input.evalCase);
      await execute("save_travel_brief", brief);
      const attractionsText = await execute("search_attractions", {
        city: input.world.city.name,
        location: input.world.city.name,
        radius_km: 50,
        limit: 30,
      });
      const evidence = parseEvidenceIds(attractionsText);
      const candidates = parseCandidates(attractionsText);
      const mustVisit = brief.mustVisit.map((name) => resolvePlace(name, input.world));
      const info = await queryPlaceInfo(execute, [...new Set([...mustVisit, ...candidates.map((item) => item.name)])], input.world.city.name);
      const assignment = assignDays(input.world.travel_dates, mustVisit, candidates, info);

      const outline = [...assignment.entries()].map(([date, visits]) => ({
        date,
        visits: visits.map((name) => ({
          name,
          ...(evidence[name] === undefined ? {} : { evidence_id: evidence[name] }),
        })),
      }));
      await execute("save_itinerary", { title: input.evalCase.title, outline });

      for (const [date, visits] of assignment) {
        rounds += 1;
        await scheduleDay(execute, input.evalCase.title, date, visits, mustVisit, info);
      }

      const hotel = await searchHotel(execute, input.world.city.name);
      if (hotel !== null) {
        await addAccommodation(execute, directory, input.evalCase.title, hotel, input.world.travel_dates, input.evalCase.days);
      }

      const planPath = await findPlanPath(directory, input.evalCase.title, input.evalCase.days);
      if (planPath !== null) {
        const plan = parseItinerary(JSON.parse(await readFile(planPath, "utf8")));
        for (const day of plan.days) {
          if (day.date === undefined) continue;
          const stops = day.items
            .filter((item) => item.type === "visit" || item.type === "accommodation")
            .map((item) => item.name);
          if (stops.length < 2) continue;
          rounds += 1;
          await execute("plan_day_routes", {
            city: input.world.city.name,
            stops,
            mode: "transit",
          });
        }
      }

      for (const date of assignment.keys()) {
        rounds += 1;
        await execute("save_itinerary", {
          title: input.evalCase.title,
          repair_routes: [date],
        });
      }

      await execute("validate_itinerary", { title: input.evalCase.title });
    });
  } catch (error) {
    failure = {
      stage: "generation",
      reason: error instanceof Error ? error.message : String(error),
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (failure === null) {
    const loaded = await loadAttemptItinerary(directory, input.evalCase);
    itineraryPath = loaded.path;
    metrics = loaded.metrics;
    failure = failureFor(input.evalCase, itineraryPath, metrics);
  }

  if (itineraryPath !== null) {
    try {
      checks = checkWorldItinerary(
        input.world,
        parseItinerary(JSON.parse(await readFile(itineraryPath, "utf8"))),
      );
    } catch {
      checks = [];
    }
  }

  const report = { ...runtime.report(), checks, prior_failure: failure };
  await writeFile(join(directory, "external-data.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (report.uncovered.length > 0) {
    const reasons = [
      `世界快照未覆盖 ${report.uncovered.length} 次请求，详见 external-data.json`,
      ...checks.map((check) => `${check.code}: ${check.message}`),
    ];
    failure = {
      stage: "environment",
      reason: reasons.join("；"),
      reasons,
    };
  }

  const status = statusForFailure(failure);
  const telemetry: EvalAttemptTelemetry = {
    duration_ms: Date.now() - started,
    tool_rounds: rounds,
    tool_calls: calls,
    completion_retries: 0,
    tokens: { prompt: 0, completion: 0, total: 0, requests: 0, cache_hit: 0 },
    estimated_cost_yuan: 0,
    budget: {
      initial_rounds: 0,
      current_rounds: 0,
      ceiling_rounds: 0,
      extensions: [],
    },
  };

  const record = attemptRecord({
    implementationHash: input.implementationHash,
    evalCase: input.evalCase,
    attempt: 1,
    directory,
    runRoot: input.runRoot,
    startedAt,
    durationMs: telemetry.duration_ms,
    status,
    model: workflowModel(),
    prompt: workflowPrompt(),
    pricing: workflowPricing(),
    telemetry,
    ...(itineraryPath === null ? {} : { itineraryPath: relative(input.runRoot, itineraryPath) }),
    ...(metrics === null ? {} : { metrics }),
    ...(failure === null ? {} : { failure }),
    note: "W1 结构化 brief workflow；固定世界；无模型调用",
  });

  if (itineraryPath !== null) {
    await copyFile(itineraryPath, join(directory, "final-itinerary.json"));
  }
  return record;
}

function workflowBrief(world: ExternalWorld, evalCase: EvalCase): {
  readonly title: string;
  readonly destination: string;
  readonly durationDays: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly travelers: number;
  readonly budgetTotalYuan: number;
  readonly pace: string;
  readonly mustVisit: readonly string[];
  readonly notes: string;
} {
  const travelers = parseTravelers(evalCase.request) ?? 2;
  const perPerson = parseBudget(evalCase.request) ?? evalCase.budget_per_person_yuan ?? 0;
  return {
    title: evalCase.title,
    destination: world.city.name,
    durationDays: evalCase.days,
    startDate: world.travel_dates[0]!,
    endDate: world.travel_dates[world.travel_dates.length - 1]!,
    travelers,
    budgetTotalYuan: perPerson * travelers,
    pace: /慢|轻松/.test(evalCase.request) ? "慢" : /紧凑/.test(evalCase.request) ? "紧凑" : "适中",
    mustVisit: (() => { const parsed = parseMustVisit(evalCase.request, world); return parsed.length > 0 ? parsed : (evalCase.must_visit ?? []); })(),
    notes: evalCase.request.slice(0, 500),
  };
}

function parseTravelers(request: string): number | undefined {
  const match = request.match(/(?:([一二两三四五六七八九十])位|(\d+)\s*(?:位|人))/);
  if (match === null) return undefined;
  if (match[2] !== undefined) return Number(match[2]);
  const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return numerals[match[1]!] ?? undefined;
}

function parseBudget(request: string): number | undefined {
  const match = request.match(/人均总预算\s*(\d+)\s*元/);
  return match === null ? undefined : Number(match[1]);
}

function parseMustVisit(request: string, world: ExternalWorld): readonly string[] {
  const match = request.match(/必去([^；。]+)/);
  if (match === null) return [];
  return match[1]!.split(/[、,，]/).map((name) => resolvePlace(name.trim(), world)).filter(Boolean);
}

function resolvePlace(name: string, world: ExternalWorld): string {
  const normalized = name.trim();
  for (const place of world.places) {
    if (place.name === normalized || place.aliases.includes(normalized)) return place.name;
  }
  return normalized;
}

function parseEvidenceIds(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/^(.+?): ([a-f0-9]{20})$/gm)].map((match) => [match[1]!, match[2]!]),
  );
}

function parseCandidates(text: string): Candidate[] {
  return [...text.matchAll(/^(\d+)\. (.+?) \|/gm)].map((match) => {
    const line = text.split("\n").find((item) => item.startsWith(`${match[1]}. `)) ?? "";
    const distance = line.match(/距中心\s*([\d.]+)\s*公里/);
    const rating = line.match(/评分\s*([\d.]+)/);
    return {
      name: match[2]!,
      distanceKm: distance === null ? 999 : Number(distance[1]),
      rating: rating === null ? 0 : Number(rating[1]),
    };
  });
}

async function queryPlaceInfo(
  execute: (name: string, args: object) => Promise<string>,
  names: readonly string[],
  city: string,
): Promise<Record<string, PlaceInfo>> {
  const result: Record<string, PlaceInfo> = {};
  for (const name of names) {
    try {
      const text = await execute("get_place_visit_info", {
        place: name,
        city,
        fields: ["hours", "closure", "visit_duration"],
      });
      const weekdays: number[] = [];
      if (/每周一闭馆/.test(text)) weekdays.push(1);
      if (/每周二闭馆/.test(text)) weekdays.push(2);
      if (/每周三闭馆/.test(text)) weekdays.push(3);
      if (/每周四闭馆/.test(text)) weekdays.push(4);
      if (/每周五闭馆/.test(text)) weekdays.push(5);
      if (/每周六闭馆/.test(text)) weekdays.push(6);
      if (/每周日闭馆/.test(text)) weekdays.push(0);
      const duration = text.match(/建议游玩(\d+)小时/);
      result[name] = {
        closedWeekdays: weekdays,
        durationMin: duration === null ? 90 : Number(duration[1]) * 60,
      };
    } catch {
      result[name] = { closedWeekdays: [], durationMin: 90 };
    }
  }
  return result;
}

function assignDays(
  dates: readonly string[],
  mustVisit: readonly string[],
  candidates: readonly Candidate[],
  info: Record<string, PlaceInfo>,
): Map<string, string[]> {
  const assignment = new Map(dates.map((date) => [date, [] as string[]]));
  const used = new Set<string>();
  const distance = new Map(candidates.map((item) => [item.name, item.distanceKm]));
  const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
  const open = (name: string, date: string): boolean => !(info[name]?.closedWeekdays ?? []).includes(weekday(date));

  const prioritized = [...mustVisit].sort((a, b) => (distance.get(b) ?? 0) - (distance.get(a) ?? 0));
  for (const name of prioritized) {
    if (used.has(name)) continue;
    const far = (distance.get(name) ?? 0) > 15;
    const days = far ? [...dates].reverse() : dates;
    const target = days.find((date) => open(name, date) && (assignment.get(date)!.length < 2))
      ?? days.find((date) => open(name, date) && assignment.get(date)!.length < 3);
    if (target === undefined) continue;
    assignment.get(target)!.push(name);
    used.add(name);
  }

  const pool = [...candidates].sort((a, b) => a.distanceKm - b.distanceKm || b.rating - a.rating);
  for (const date of dates) {
    const visits = assignment.get(date)!;
    for (const candidate of pool) {
      if (visits.length >= 3) break;
      if (used.has(candidate.name) || !open(candidate.name, date)) continue;
      visits.push(candidate.name);
      used.add(candidate.name);
    }
  }
  return assignment;
}

async function scheduleDay(
  execute: (name: string, args: object) => Promise<string>,
  title: string,
  date: string,
  visits: readonly string[],
  mustVisit: readonly string[],
  info: Record<string, PlaceInfo>,
): Promise<void> {
  const durationFor = (name: string, cap: number): number =>
    Math.min(info[name]?.durationMin ?? 90, mustVisit.includes(name) ? Math.min(120, cap) : Math.min(90, cap));
  const attempts: { visits: readonly string[]; cap: number }[] = [
    { visits, cap: mustVisit.includes(visits[0] ?? "") ? 120 : 90 },
    { visits, cap: 60 },
    { visits: [...visits.filter((name) => mustVisit.includes(name)), ...visits.filter((name) => !mustVisit.includes(name)).slice(0, 1)], cap: 60 },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt.visits.length === 0) continue;
    try {
      await execute("save_itinerary", {
        title,
        schedule: {
          date,
          visits: attempt.visits.map((name) => ({ name, duration_min: durationFor(name, attempt.cap) })),
          mode: "transit",
        },
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${date} 无法生成可保存的日程`);
}

async function searchHotel(
  execute: (name: string, args: object) => Promise<string>,
  city: string,
): Promise<{ name: string; evidenceId?: string; price?: number } | null> {
  try {
    const text = await execute("search_stays", { city, region: city, radius_km: 10, limit: 5 });
    const names = [...text.matchAll(/^(\d+)\. (.+?) \|/gm)].map((match) => match[2]!);
    if (names.length === 0) return null;
    const evidence = parseEvidenceIds(text);
    const price = text.match(/参考价\s*¥(\d+)\/房\/晚/);
    return {
      name: names[0]!,
      ...(evidence[names[0]!] === undefined ? {} : { evidenceId: evidence[names[0]!] }),
      ...(price === null ? {} : { price: Number(price[1]) }),
    };
  } catch {
    return null;
  }
}

async function addAccommodation(
  execute: (name: string, args: object) => Promise<string>,
  directory: string,
  title: string,
  hotel: { name: string; evidenceId?: string; price?: number },
  dates: readonly string[],
  daysCount: number,
): Promise<void> {
  const path = await findPlanPath(directory, title, daysCount);
  if (path === null) return;
  const plan = parseItinerary(JSON.parse(await readFile(path, "utf8")));
  const days = plan.days.map((day) => {
    const items = [...day.items];
    if (day.date !== undefined && day.date !== dates[dates.length - 1] && !items.some((item) => item.type === "accommodation")) {
      items.push({
        type: "accommodation",
        name: hotel.name,
        time: "17:00",
        end_time: "23:00",
        planned_duration_min: 1,
        stay_nights: 1,
        room_count: 1,
        ...(hotel.evidenceId === undefined ? {} : { evidence_id: hotel.evidenceId }),
        ...(hotel.price === undefined ? {} : { room_price_per_night: hotel.price }),
      } as ItineraryItem);
    }
    return {
      date: day.date,
      ...(day.date === dates[dates.length - 1] ? { day_type: "departure" as const } : day.day_type === undefined ? {} : { day_type: day.day_type }),
      items,
    };
  });
  await execute("save_itinerary", {
    title,
    days,
    merge_mode: "replace_day",
  });
}

async function findPlanPath(directory: string, title: string, days: number): Promise<string | null> {
  try {
    return await findItinerary(directory, title, days);
  } catch {
    return null;
  }
}

function workflowModel(): EvalModelInfo {
  return {
    profile_id: "workflow",
    profile_name: "W1 deterministic workflow",
    provider: "workflow",
    model: "rule-v1",
  };
}

function workflowPrompt(): EvalPromptInfo {
  return {
    version: "workflow-v1",
    static_sha256: sha256("minicode-w1-workflow"),
    custom_sha256: sha256(""),
    rendered_sha256: sha256("minicode-w1-workflow"),
    kind: "default",
  };
}

function workflowPricing(): EvalPricing {
  return {
    currency: "CNY",
    input_per_million_tokens: 0,
    output_per_million_tokens: 0,
    cache_input_per_million_tokens: 0,
    estimated: true,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
