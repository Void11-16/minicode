import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ToolOutputKind } from "../tools/tool.ts";
import { structuredToolPreview } from "./tool-preview.ts";

/** 单条工具结果进入上下文的默认上限 */
export const TOOL_RESULT_MAX_CHARS = 3_000;
/** 同一批工具结果进入上下文的总预算 */
export const TOOL_RESULT_BATCH_MAX_CHARS = 8_000;

export interface ToolResultForContext {
  readonly callId: string;
  readonly toolName: string;
  readonly output: string;
  readonly error?: string;
  readonly outputKind?: ToolOutputKind;
}

export interface ToolResultOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly maxChars?: number;
  readonly batchMaxChars?: number;
}

export interface CompactedToolResult {
  readonly callId: string;
  readonly text: string;
  readonly artifactPath?: string;
  readonly truncated: boolean;
}

/**
 * 工具原文落盘、上下文只保留带类型的预览。
 * 批次内按剩余预算动态分配，短结果没用掉的额度会自动留给后续结果。
 */
export async function compactToolResults(
  results: readonly ToolResultForContext[],
  options: ToolResultOptions,
): Promise<CompactedToolResult[]> {
  const maxChars = options.maxChars ?? TOOL_RESULT_MAX_CHARS;
  let remaining = options.batchMaxChars ?? TOOL_RESULT_BATCH_MAX_CHARS;
  const compacted: CompactedToolResult[] = [];

  for (const [index, result] of results.entries()) {
    const remainingCalls = results.length - index;
    // 不给固定最小值，否则大量并行调用时每项预留的“最低额度”会突破批次上限。
    // 通常每项仍能分到几百字符；极窄预算下优先保留 artifact 路径和类型头。
    const allocation = Math.min(maxChars, Math.floor(remaining / remainingCalls));
    const item = await compactToolResult(result, {
      ...options,
      maxChars: allocation,
    });
    compacted.push(item);
    remaining = Math.max(0, remaining - item.text.length);
  }
  return compacted;
}

async function compactToolResult(
  result: ToolResultForContext,
  options: ToolResultOptions,
): Promise<CompactedToolResult> {
  const maxChars = options.maxChars ?? TOOL_RESULT_MAX_CHARS;
  const kind = result.error === undefined ? result.outputKind ?? "generic" : "error";
  const header = `[tool-result type=${kind} chars=${result.output.length}]`;
  if (result.output.length + header.length + 1 <= maxChars) {
    return {
      callId: result.callId,
      text: `${header}\n${result.output}`,
      truncated: false,
    };
  }

  const absoluteArtifact = artifactFile(options.workspace, options.sessionId, result, kind);
  let artifactPath: string | undefined;
  try {
    await mkdir(dirname(absoluteArtifact), { recursive: true });
    await writeFile(absoluteArtifact, result.output, "utf8");
    artifactPath = relative(options.workspace, absoluteArtifact);
  } catch {
    // 归档是优化，不是工具协议的一部分。磁盘不可写时仍必须返回完整的
    // tool-call/tool-result 配对，否则后续所有模型请求都会因协议错误失败。
    artifactPath = undefined;
  }
  const prefix =
    artifactPath === undefined
      ? `${header} truncated=true artifact=unavailable\n` +
        "原文落盘失败；以下仅保留按重要字段裁剪的预览，请不要假设存在完整归档：\n"
      : `${header} truncated=true artifact=${artifactPath}\n` +
        "原文已落盘；完整数据用 read_file(path=artifact, byte_offset=0) 分页读取，按返回游标续读。以下仅为预览：\n";
  const text = prefix.length >= maxChars
    ? prefix.slice(0, Math.max(0, maxChars))
    : `${prefix}${structuredToolPreview(kind, result.output, maxChars - prefix.length) ?? preview(result.output, maxChars - prefix.length)}`;
  return {
    callId: result.callId,
    text,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    truncated: true,
  };
}

function artifactFile(
  workspace: string,
  sessionId: string,
  result: ToolResultForContext,
  kind: string,
): string {
  const call = safeSegment(result.callId);
  const tool = safeSegment(result.toolName);
  const suffix = kind === "error" ? "error" : "txt";
  return join(workspace, ".minicode", "artifacts", safeSegment(sessionId), `${tool}-${call}.${suffix}`);
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  return safe === "" ? "item" : safe;
}

/**
 * 优先保留头尾和硬约束字段。它不是语义总结器，但能稳定保住坐标、类型、
 * 质量级别、错误和最新结果，避免纯 slice 恰好截掉关键事实。
 */
function preview(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;

  const lines = text.split("\n");
  const important = lines.filter((line) =>
    /坐标|经纬|类型|景点|餐厅|酒店|评分|口碑|P0|P1|P2|错误|失败|不可用|未通过|严格|strict|日期|时间|预算|门票|开放|闭馆/i.test(line),
  );
  const head = lines.slice(0, Math.min(12, lines.length));
  const tail = lines.slice(Math.max(0, lines.length - 10));
  const sections = [
    { label: "开头", lines: head },
    { label: "关键行", lines: important },
    { label: "结尾", lines: tail },
  ];
  const weights = [0.32, 0.42, 0.26];
  const pieces: string[] = [];
  for (const [index, section] of sections.entries()) {
    if (section.lines.length === 0) continue;
    const sectionBudget = Math.max(0, Math.floor(budget * weights[index]) - section.label.length - 4);
    if (sectionBudget === 0) continue;
    const body = clipLines(section.lines, sectionBudget);
    if (body !== "") pieces.push(`【${section.label}】\n${body}`);
  }
  const joined = pieces.join("\n");
  return joined.length <= budget ? joined : joined.slice(0, Math.max(0, budget - 1)) + "…";
}

function clipLines(lines: readonly string[], budget: number): string {
  let result = "";
  for (const line of lines) {
    const next = result === "" ? line : `${result}\n${line}`;
    if (next.length <= budget) {
      result = next;
      continue;
    }
    if (result === "") return line.slice(0, Math.max(0, budget - 1)) + "…";
    break;
  }
  return result;
}
