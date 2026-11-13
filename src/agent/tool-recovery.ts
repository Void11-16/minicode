import { readFile } from "node:fs/promises";
import { createMessage, isCompactedToolArguments, type Message } from "../core/message.ts";
import type { Session } from "../core/session.ts";
import type { ToolRegistry } from "../tools/tool.ts";
import type { ToolExecutionState } from "../core/execution-state.ts";
import { findOperation, recoverManagedOperations } from "../storage/managed-operation.ts";
import { parseItinerary } from "../tools/itinerary-schema.ts";
import { validateItinerary } from "../tools/itinerary-validator.ts";
import { updateTravelStateFromSnapshot } from "../core/travel-state.ts";

/**
 * 恢复消息协议与提交事实，不恢复任意指令的执行现场。
 * 检查点若停在 assistant(tool_calls)，为未返回调用补核对回执，防止孤立调用与重复副作用。
 */
export async function recoverInterruptedToolCalls(session: Session, tools: ToolRegistry | undefined, workspace: string): Promise<void> {
  const history = session.history; const restored: Message[] = [];
  const roots = tools?.operationRoots(workspace) ?? [workspace];
  let recovered = false, checked = false;
  for (let i = 0; i < history.length; i++) {
    const message = history[i]!; restored.push(message);
    if (!message.toolCalls || message.archivedToolCalls) continue;
    const returned = new Set<string>();
    for (let j = i + 1; history[j]?.role === "tool"; j++) returned.add(history[j]!.toolCallId!);
    for (const call of message.toolCalls) {
      if (returned.has(call.id) || isCompactedToolArguments(call.arguments)) continue;
      if (!checked) { for (const root of roots) await recoverManagedOperations(root); checked = true; }
      const id = `${session.id}:${message.id}:${call.id}`;
      let record = null;
      for (const root of roots) { record = await findOperation(root, id); if (record) break; }
      const tool = tools?.get(call.name), risky = tool?.effect === "managed_write" || tool?.effect === "command" || tool?.requiresConfirmation;
      const state: ToolExecutionState = record?.state ?? { operation_id: id, execution_status: "failed", effect_status: risky ? "unknown" : "none", recovery_action: risky ? "manual_review" : "retry", code: "TOOL_INTERRUPTED" };
      restored.push(createMessage("tool", JSON.stringify({ recovered: true, execution_state: state,
        message: record?.state?.effect_status === "committed" ? "已从主文件核对提交结果，未重新执行该修改。" : "上次调用在结果回填前中断，未自动重放；根据执行状态先核对或重新查询。",
        ...(record?.output ? { output: record.output } : {}),
      }), { toolCallId: call.id, toolName: call.name, toolExecution: state }));
      if (record?.tool === "save_itinerary" && state.effect_status === "committed") {
        try { const plan = parseItinerary(JSON.parse(await readFile(record.resource, "utf8"))); session.setTravelState(updateTravelStateFromSnapshot(session.travelState, { itinerary: plan, report: validateItinerary(plan), file: record.resource })); }
        catch { /* 主文件可能后来被人工移除；回执保留，不用旧快照覆盖当前数据。 */ }
      }
      recovered = true;
    }
  }
  if (recovered) session.replaceHistory(restored, session.epoch);
}
