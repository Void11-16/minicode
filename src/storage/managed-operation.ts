import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite, ensureDirectory, syncDirectory, withPlanLock } from "../tools/plan-files.ts";
import { attachExecutionState, reportExecution, ToolExecutionError, type ExecutionContext, type ToolExecutionState } from "../core/execution-state.ts";
import { toolErrorCategory } from "../core/tool-diagnostics.ts";

interface ExportFile { file: string; content: string }
export interface OperationRecord {
  schema_version: 1;
  operation_id: string;
  tool: string;
  kind: "replace" | "command";
  resource: string;
  request_hash: string;
  phase: "running" | "committing" | "finished";
  started_at: string;
  finished_at?: string;
  before_hash?: string | null;
  after_hash?: string;
  exports?: ExportFile[];
  state?: ToolExecutionState;
  output?: string;
  resolution?: { accepted_at: string; current_hash: string | null };
}
export interface ManagedOperationOptions extends ExecutionContext {
  root: string;
  file: string;
  tool: string;
  request: unknown;
  signal?: AbortSignal;
  /** 重放只同步当前快照，不再执行原修改。 */
  onReplay?: () => void | Promise<void>;
}
export interface ManagedCommit {
  commit(content: string, exports?: readonly ExportFile[]): Promise<void>;
}

export function operationRequestHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : v;
  return digest(JSON.stringify(stable(value)) ?? "null");
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, file: string): string {
  const path = resolve(file), rel = relative(resolve(root), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("操作账本的目标必须位于工作区内");
  return path;
}
const directoryFor = (root: string, file: string) => join(root, ".minicode", "operations", digest(file));
const recordFile = (directory: string, id: string) => join(directory, `${digest(id)}.json`);
async function optionalText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function readRecord(file: string): Promise<OperationRecord | null> {
  const text = await optionalText(file); if (text === null) return null;
  const record = JSON.parse(text) as OperationRecord;
  if (record.schema_version !== 1 || !["replace", "command"].includes(record.kind) || typeof record.operation_id !== "string" || typeof record.resource !== "string" || typeof record.request_hash !== "string") throw new Error("操作账本损坏，已停止自动恢复");
  return record;
}
async function writeRecord(directory: string, record: OperationRecord): Promise<void> {
  await atomicWrite(recordFile(directory, record.operation_id), JSON.stringify(record, null, 2), 0o600);
}
async function removePending(directory: string): Promise<void> {
  try { await unlink(join(directory, "pending")); await syncDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function claimOperation(root: string, id: string, resource: string, tool: string, requestHash: string, signal?: AbortSignal): Promise<void> {
  const base = join(root, ".minicode", "operations"); await ensureDirectory(base, 0o700);
  const file = join(base, "ids", `${digest(id)}.json`), claim = { resource, tool, request_hash: requestHash };
  await withPlanLock(file, async () => {
    const existing = await optionalText(file);
    if (existing !== null && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(claim)) throw new ToolExecutionError({ operation_id: id, execution_status: "failed", effect_status: "not_committed", recovery_action: "fix_arguments", code: "OPERATION_ID_CONFLICT", message: "同一 operation_id 已用于不同资源、工具或参数；新意图需要新 ID。" });
    if (existing === null) await atomicWrite(file, JSON.stringify(claim), 0o600);
  }, signal);
}

/** Recover the resource chosen for an earlier attempt before allocating a new path. */
export async function managedOperationTarget(root: string, id: string, tool: string, request: unknown): Promise<string | null> {
  const text = await optionalText(join(root, ".minicode", "operations", "ids", `${digest(id)}.json`));
  if (text === null) return null;
  const claim = JSON.parse(text) as { resource: string; tool: string; request_hash: string };
  if (claim.tool !== tool || claim.request_hash !== operationRequestHash(request)) throw new ToolExecutionError({
    operation_id: id, execution_status: "failed", effect_status: "not_committed", recovery_action: "fix_arguments", code: "OPERATION_ID_CONFLICT", message: "同一 operation_id 已用于不同工具或参数；新意图需要新 ID。",
  });
  return inside(root, claim.resource);
}
function stateFor(record: OperationRecord, effect: ToolExecutionState["effect_status"], code?: string): ToolExecutionState {
  return { operation_id: record.operation_id, execution_status: effect === "committed" ? "succeeded" : "failed", effect_status: effect,
    recovery_action: effect === "committed" ? "none" : effect === "not_committed" ? "retry" : "manual_review", ...(code ? { code } : {}) };
}

/**
 * 同一资源锁内核对。只对“替换完整主文件”提供恢复，不推测任意命令的副作用。
 * after_hash 匹配说明目标状态已满足；before_hash 匹配说明可以确认未提交。
 * 其余情况保持 unknown，不覆盖用户或其他进程的后续修改。
 */
async function reconcile(root: string, directory: string, record: OperationRecord): Promise<OperationRecord> {
  const file = inside(root, record.resource);
  if (record.kind === "command") {
    if (record.phase !== "finished") {
      record.state = stateFor(record, "unknown", "COMMAND_INTERRUPTED_UNKNOWN");
      record.phase = "finished"; record.finished_at = new Date().toISOString();
      await writeRecord(directory, record);
    }
    await removePending(directory);
    return record;
  }
  const current = await optionalText(file), hash = current === null ? null : digest(current);
  if (record.after_hash !== undefined && hash === record.after_hash) {
    let pending = false;
    for (const item of record.exports ?? []) {
      try { await ensureDirectory(dirname(inside(root, item.file))); await atomicWrite(item.file, item.content); }
      catch { pending = true; }
    }
    record.state = { ...stateFor(record, "committed"), ...(pending ? { exports_pending: true, recovery_action: "rebuild_exports" as const } : {}) };
    if (!pending) delete record.exports;
    record.phase = "finished"; record.finished_at ??= new Date().toISOString();
    record.output ??= `操作 ${record.operation_id} 已确认主文件提交：${file}；未重复执行原修改。`;
  } else if (record.after_hash === undefined && record.phase === "finished" && record.state?.execution_status === "succeeded") {
    // 无变化保存：原操作没有提交新主文件，其结果可以重复返回。
  } else if (hash === record.before_hash) {
    record.state = stateFor(record, "not_committed", "OPERATION_INTERRUPTED_NOT_COMMITTED");
    record.phase = "finished"; record.finished_at ??= new Date().toISOString(); delete record.exports;
  } else {
    record.state = stateFor(record, "unknown", "OPERATION_COMMIT_UNKNOWN"); record.phase = "finished";
  }
  await writeRecord(directory, record);
  if (record.state?.effect_status !== "unknown" && !record.state?.exports_pending) await removePending(directory);
  return record;
}

/** 只用于中断后的回执核对，不执行记录中的操作。 */
export async function findOperation(root: string, id: string): Promise<OperationRecord | null> {
  const base = join(resolve(root), ".minicode", "operations");
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  for (const entry of entries) if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
    const record = await readRecord(recordFile(join(base, entry.name), id));
    if (record) { inside(root, record.resource); return record; }
  }
  return null;
}

/** 人工核对后的显式确认，不改业务文件、不把未知结果伪装成成功，也不重放旧操作。 */
export async function acceptCurrentOperationState(root: string, id: string, expectedHash: string | null): Promise<OperationRecord> {
  const record = await findOperation(root, id);
  if (!record || record.kind !== "replace") throw new Error("只能确认已存在的受控文件写入操作");
  return withPlanLock(record.resource, async () => {
    const directory = directoryFor(resolve(root), record.resource), latest = await readRecord(recordFile(directory, id));
    if (!latest) throw new Error("操作记录不存在");
    const current = await optionalText(record.resource), currentHash = current === null ? null : digest(current);
    if (currentHash !== expectedHash) throw new Error("核对期间主文件已变化，未解除阻断；请重新检查当前文件");
    latest.resolution = { accepted_at: new Date().toISOString(), current_hash: currentHash };
    latest.state = { ...(latest.state ?? stateFor(latest, "unknown")), recovery_action: "none", exports_pending: false };
    latest.phase = "finished"; delete latest.exports;
    await writeRecord(directory, latest);
    if (await optionalText(join(directory, "pending")) === id) await removePending(directory);
    return latest;
  });
}

async function reconcilePending(root: string, directory: string): Promise<OperationRecord | null> {
  const id = await optionalText(join(directory, "pending")); if (!id) return null;
  const record = await readRecord(recordFile(directory, id));
  if (!record) throw new Error("操作账本缺少待核对记录，已停止自动写入");
  return reconcile(root, directory, record);
}

/** 受控写入共用的入口：意图先落盘，JSON/文本主文件先提交，派生导出可重建。 */
export async function runManagedOperation(options: ManagedOperationOptions, action: (commit: ManagedCommit) => Promise<string>): Promise<string> {
  const root = resolve(options.root), file = inside(root, options.file), directory = directoryFor(root, file);
  const operationId = options.operationId ?? randomUUID(), operationHash = operationRequestHash(options.request);
  await claimOperation(root, operationId, file, options.tool, operationHash, options.signal);
  return withPlanLock(file, async () => {
    await ensureDirectory(directory, 0o700);
    const pending = await reconcilePending(root, directory);
    if (pending?.state?.effect_status === "unknown" || pending?.state?.exports_pending) {
      const state: ToolExecutionState = { operation_id: operationId, blocked_by_operation_id: pending.operation_id,
        execution_status: "failed", effect_status: "not_committed", recovery_action: pending.state.exports_pending ? "rebuild_exports" : "manual_review",
        code: "RESOURCE_RECOVERY_REQUIRED", message: `前次操作 ${pending.operation_id} 需要核对或重建导出，未执行新的修改。` };
      reportExecution(options, state); throw new ToolExecutionError(state);
    }
    const id = operationId, requestHash = operationHash;
    let previous = await readRecord(recordFile(directory, id));
    if (previous && (previous.request_hash !== requestHash || previous.tool !== options.tool)) throw new ToolExecutionError({ execution_status: "failed", effect_status: "not_committed", recovery_action: "fix_arguments", operation_id: id, code: "OPERATION_ID_CONFLICT", message: "同一 operation_id 不能用于不同参数或工具；新意图需要新 ID。" });
    if (previous && previous.phase !== "finished") previous = await reconcile(root, directory, previous);
    if (previous?.state?.execution_status === "succeeded") {
      const state = { ...previous.state, replayed: true };
      reportExecution(options, state); await options.onReplay?.();
      return previous.output ?? `操作 ${id} 已完成，未重复执行。`;
    }
    if (previous?.state && previous.state.effect_status !== "not_committed") {
      const state = { ...previous.state, execution_status: "failed" as const, message: "操作结果需要核对，不能原样重放。" };
      reportExecution(options, state); throw new ToolExecutionError(state);
    }
    const before = await optionalText(file);
    if (previous && (before === null ? null : digest(before)) !== previous.before_hash) throw new ToolExecutionError({ operation_id: id, execution_status: "failed", effect_status: "not_committed", recovery_action: "reread", code: "OPERATION_RETRY_STALE", message: "原操作失败后资源已变化，未重放；请重新读取并创建新操作。" });
    const record: OperationRecord = { schema_version: 1, operation_id: id, tool: options.tool, kind: "replace", resource: file, request_hash: requestHash,
      phase: "running", started_at: new Date().toISOString(), before_hash: before === null ? null : digest(before) };
    await writeRecord(directory, record);
    await atomicWrite(join(directory, "pending"), id, 0o600);
    const commit: ManagedCommit = {
      async commit(content, exports = []) {
        options.signal?.throwIfAborted();
        for (const item of exports) if (inside(root, item.file) === file) throw new Error("派生文件不能覆盖主文件");
        record.after_hash = digest(content); record.exports = [...exports]; record.phase = "committing";
        await writeRecord(directory, record);
        if (before !== null) await atomicWrite(join(directory, "previous"), before, 0o600);
        await atomicWrite(file, content);
        await reconcile(root, directory, record);
      },
    };
    try {
      options.signal?.throwIfAborted();
      const output = await action(commit);
      record.state ??= { operation_id: id, execution_status: "succeeded", effect_status: "none", recovery_action: "none" };
      record.output = output; record.phase = "finished"; record.finished_at = new Date().toISOString();
      await writeRecord(directory, record);
      if (!record.state.exports_pending) await removePending(directory);
      reportExecution(options, record.state);
      return output + (record.state.exports_pending ? "\n主文件已保存，部分导出待重建；不要原样重保存，请先核对主文件。" : "");
    } catch (error) {
      // 包括“rename 已成功，但刷盘/结果记录失败”的窗口，先核对实际文件再给出提交状态。
      try { await reconcile(root, directory, record); }
      catch { record.state = stateFor(record, "unknown", "OPERATION_RECONCILE_FAILED"); }
      const state: ToolExecutionState = { ...record.state!, execution_status: options.signal?.aborted ? "cancelled" : "failed",
        code: record.state?.effect_status === "not_committed" ? "OPERATION_FAILED_NOT_COMMITTED" : record.state?.code,
        recovery_action: record.state?.effect_status === "not_committed"
          ? /版本冲突/.test(String(error)) ? "reread" : ["invalid_arguments", "validation"].includes(toolErrorCategory(error)) ? "fix_arguments" : ["network", "timeout", "rate_limit"].includes(toolErrorCategory(error)) ? "retry" : "manual_review"
          : record.state?.effect_status === "committed" ? "reread" : "manual_review" };
      record.state = state;
      await writeRecord(directory, record).catch(() => {});
      reportExecution(options, state); attachExecutionState(error, state); throw error;
    }
  }, options.signal);
}

/** 启动时核对已有意图；不自动重放未知操作或重新运行命令。 */
export async function recoverManagedOperations(root: string): Promise<ToolExecutionState[]> {
  const base = join(resolve(root), ".minicode", "operations"); const results: ToolExecutionState[] = [];
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return results; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = join(base, entry.name), id = await optionalText(join(directory, "pending")); if (!id) continue;
    const record = await readRecord(recordFile(directory, id)); if (!record) throw new Error("待恢复操作记录缺失");
    inside(root, record.resource);
    // 其他会话/进程正在提交时不抢恢复，也不让无关查询等待长命令。
    const owner = await optionalText(`${record.resource}.lock`);
    if (owner !== null) {
      const pid = Number(owner);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      } else if (Date.now() - (await stat(`${record.resource}.lock`).catch(() => ({ mtimeMs: 0 }))).mtimeMs < 30_000) continue;
    }
    await withPlanLock(record.resource, async () => { const recovered = await reconcilePending(root, directory); if (recovered?.state) results.push(recovered.state); });
  }
  return results;
}

/** 命令只记录执行事实；中断后不重放，也不声称终止进程撤销了外部修改。 */
export async function runRecordedCommand(options: ExecutionContext & { root: string; request: unknown; signal?: AbortSignal }, action: (report: (state: ToolExecutionState) => void) => Promise<string>): Promise<string> {
  const root = resolve(options.root), id = options.operationId ?? randomUUID();
  const resource = join(root, ".minicode", "command-operations", digest(id)), directory = directoryFor(root, resource);
  await claimOperation(root, id, resource, "bash", operationRequestHash(options.request), options.signal);
  return withPlanLock(resource, async () => {
    await ensureDirectory(directory, 0o700);
    let previous = await readRecord(recordFile(directory, id));
    const requestHash = operationRequestHash(options.request);
    if (previous && previous.request_hash !== requestHash) throw new ToolExecutionError({ execution_status: "failed", effect_status: "not_committed", recovery_action: "fix_arguments", operation_id: id, code: "OPERATION_ID_CONFLICT" });
    if (previous?.phase !== undefined && previous.phase !== "finished") previous = await reconcile(root, directory, previous);
    if (previous?.state && previous.state.effect_status !== "not_committed") {
      const state = { ...previous.state, replayed: true }; reportExecution(options, state);
      // 有已保存输出也只返回记录，不重新执行；未知操作明确要求核对。
      if (previous.output) return previous.output;
      throw new ToolExecutionError({ ...state, execution_status: "failed", message: "命令执行结果未知，需要检查实际影响，不能自动重放。" });
    }
    options.signal?.throwIfAborted();
    const record: OperationRecord = { schema_version: 1, operation_id: id, tool: "bash", kind: "command", resource, request_hash: requestHash, phase: "running", started_at: new Date().toISOString() };
    await writeRecord(directory, record); await atomicWrite(join(directory, "pending"), id, 0o600);
    try {
      const output = await action((state) => { record.state = { ...state, operation_id: id }; });
      record.state ??= stateFor(record, "unknown", "COMMAND_RESULT_UNKNOWN");
      record.output = output; record.phase = "finished"; record.finished_at = new Date().toISOString();
      await writeRecord(directory, record); await removePending(directory); reportExecution(options, record.state);
      return output;
    } catch (error) {
      record.state = { ...stateFor(record, "unknown", "COMMAND_RESULT_UNKNOWN"), execution_status: options.signal?.aborted ? "cancelled" : "failed" };
      record.phase = "finished"; record.finished_at = new Date().toISOString();
      await writeRecord(directory, record).catch(() => {}); reportExecution(options, record.state); attachExecutionState(error, record.state); throw error;
    }
  }, options.signal);
}
