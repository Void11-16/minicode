import { probeTravelTools } from "./tool-probe.ts";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "../core/message.ts";
import { toolErrorCategory } from "../core/tool-diagnostics.ts";
import { normalizeReviewArgs, queryKeyArgs, TRAVEL_QUERY_TOOLS } from "../tools/travel-query.ts";
import { assertInsideRoot } from "../tools/tool.ts";
import { loadManifest, requireSafeRunId } from "./run-store.ts";
import { renderToolDiagnostics } from "./tool-diagnostics.ts";

/** 旧日志只能确认协议结果与参数重复；没有埋点的 HTTP、有效性和利用率保留未知。 */
export function auditLegacyToolMessages(messages: readonly Message[]) {
  const pending = new Map<string, { tool: string }[]>();
  const toolStats = new Map<string, { tool: string; requested: number; results: number; exceptions: number; failure_markers: number; blocked: number; denied: number; argument_keys: number; duplicates: number; output_chars: number }>();
  const keys = new Set<string>(), queryKeys = new Set<string>();
  let queryKeyCount = 0, queryDuplicates = 0, orphanResults = 0;
  const errorCategories: Record<string, number> = {};
  const stats = (tool: string) => {
    let value = toolStats.get(tool);
    if (!value) { value = { tool, requested: 0, results: 0, exceptions: 0, failure_markers: 0, blocked: 0, denied: 0, argument_keys: 0, duplicates: 0, output_chars: 0 }; toolStats.set(tool, value); }
    return value;
  };
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.archivedToolCalls ?? message.toolCalls ?? []) {
      const row = stats(call.name); row.requested++;
      pending.set(call.id, [...(pending.get(call.id) ?? []), { tool: call.name }]);
      try {
        let args = JSON.parse(call.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args) || args._truncated) continue;
        if (call.name === "get_place_reviews") args = normalizeReviewArgs(args);
        const key = createHash("sha256").update(JSON.stringify([call.name, queryKeyArgs(call.name, args)])).digest("hex");
        row.argument_keys++; if (keys.has(key)) row.duplicates++; keys.add(key);
        if (TRAVEL_QUERY_TOOLS.includes(call.name)) { queryKeyCount++; if (queryKeys.has(key)) queryDuplicates++; queryKeys.add(key); }
      } catch { /* 缺失或压缩参数不能当成相同查询。 */ }
    }
    if (message.role !== "tool") continue;
    const request = pending.get(message.toolCallId ?? "")?.shift();
    if (!request) { orphanResults++; continue; }
    const row = stats(request.tool); row.results++; row.output_chars += message.content.length;
    if (/同一任务该事项已查询|本次调用未执行|本次重复保存已忽略|暂缓一般口碑/.test(message.content)) row.blocked++;
    else if (/用户拒绝授权/.test(message.content)) row.denied++;
    else if (/tool-result type=error|工具执行失败:/.test(message.content)) {
      row.exceptions++; const category = toolErrorCategory(message.content); errorCategories[category] = (errorCategories[category] ?? 0) + 1;
    } else if (/搜索失败|未找到|未能|不可用|数据源失败|未获得可核验/.test(message.content)) row.failure_markers++;
  }
  const byTool = [...toolStats.values()].sort((a, b) => b.requested - a.requested);
  const sum = (field: keyof Omit<typeof byTool[number], "tool">) => byTool.reduce((n, row) => n + row[field], 0);
  return { source: "legacy-session" as const, requested: sum("requested"), paired_results: sum("results"), orphan_results: orphanResults,
    missing_results: sum("requested") - sum("results"), exceptions: sum("exceptions"), failure_markers: sum("failure_markers"),
    blocked: sum("blocked"), denied: sum("denied"), argument_keys: sum("argument_keys"), duplicate_requests: sum("duplicates"),
    query_keyed_requests: queryKeyCount, duplicate_query_requests: queryDuplicates, error_categories: errorCategories,
    http_success_rate: null, evidence_reference_rate: null, by_tool: byTool,
    limitations: "只统计保留下来的会话消息；参数重复不是实际联网次数。失败标记包含降级/空结果，不能直接算失败率；缺失 HTTP 埋点、证据归属和时长时保留未知。" };
}

export async function auditToolRun(rootDir: string, runId: string) {
  const id = requireSafeRunId(runId), runs = join(rootDir, "eval/runs"), root = join(runs, id);
  const manifest = await loadManifest(runs, id);
  const attempts = [];
  const lines = [`# 工具调用诊断：${id}`, "", "历史样本不会补造 HTTP 成功率、并发或证据利用率。旧会话输出可能已压缩，字符量是保留消息大小。", ""];
  for (const entry of manifest.cases) for (const attempt of entry.attempts) {
    const directory = resolve(root, attempt.output_dir); assertInsideRoot(root, directory);
    lines.push(`## ${entry.eval_case.id} / attempt-${attempt.attempt}`, "", `任务状态：${attempt.status}；失败阶段：${attempt.failure?.stage ?? "无"}；失败类别：${attempt.failure ? toolErrorCategory(attempt.failure.reason) : "无"}。工具统计不包含模型 API 请求。`, "");
    if (attempt.telemetry.tool_diagnostics) {
      attempts.push({ case_id: entry.eval_case.id, attempt: attempt.attempt, diagnostics: attempt.telemetry.tool_diagnostics });
      lines.push(renderToolDiagnostics(attempt.telemetry.tool_diagnostics), ""); continue;
    }
    let session;
    try { session = JSON.parse(await readFile(join(directory, "session.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      attempts.push({ case_id: entry.eval_case.id, attempt: attempt.attempt, unavailable: "缺少会话日志", recorded_tool_calls: attempt.telemetry.tool_calls });
      lines.push("缺少会话日志，无法恢复调用明细。", ""); continue;
    }
    if (!Array.isArray(session.messages)) throw new Error(`${directory}: session.messages 不是数组`);
    const audit = auditLegacyToolMessages(session.messages);
    attempts.push({ case_id: entry.eval_case.id, attempt: attempt.attempt, recorded_tool_calls: attempt.telemetry.tool_calls, audit });
    lines.push(`- 历史任务记录 ${attempt.telemetry.tool_calls} 次调用；保留消息中观察到 ${audit.requested} 次请求、${audit.paired_results} 个配对结果、${audit.missing_results} 个缺失结果。`,
      `- 异常 ${audit.exceptions}；含失败/降级/无依据提示 ${audit.failure_markers}；拦截 ${audit.blocked}；拒绝 ${audit.denied}。`,
      `- 可还原参数 ${audit.argument_keys} 次，其中重复 ${audit.duplicate_requests} 次；检索事项参数 ${audit.query_keyed_requests} 次，其中重复 ${audit.duplicate_query_requests} 次。`,
      `- 异常类别 ${JSON.stringify(audit.error_categories)}；HTTP 成功率、请求并发、结构化证据利用率：未知。`,
      `- ${audit.limitations}`, "", "| 工具 | 请求 | 结果 | 异常 | 失败提示 | 参数重复 | 保留字符 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const tool of audit.by_tool) lines.push(`| ${tool.tool} | ${tool.requested} | ${tool.results} | ${tool.exceptions} | ${tool.failure_markers} | ${tool.duplicates} | ${tool.output_chars} |`);
    lines.push("");
  }
  const report = { run_id: id, generated_at: new Date().toISOString(), attempts };
  await writeFile(join(root, "tool-diagnostics-audit.json"), JSON.stringify(report, null, 2));
  await writeFile(join(root, "tool-diagnostics-audit.md"), lines.join("\n"));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), index = args.indexOf("--run");
  if (args.includes("--probe")) probeTravelTools(resolve(import.meta.dirname, "../.."), console.log).then((r) => console.log(`探测完成：${r.directory}/summary.md`)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  else if (args.includes("--help") || index < 0 || !args[index + 1]) console.log("用法：npm run eval:tools -- --run <批次ID>；--probe 小规模真实服务探测（不调用模型）（只读原始样本，写入派生诊断报告；不调用模型或地图服务）");
  else auditToolRun(resolve(import.meta.dirname, "../.."), args[index + 1]!).then((r) => console.log(`已诊断 ${r.attempts.length} 个 attempt：eval/runs/${r.run_id}/tool-diagnostics-audit.md`)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
