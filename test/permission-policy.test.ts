import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import {
  createPermissionMemory,
  decidePermission,
  permissionModeOf,
  type DecidePermissionInput,
} from "../src/service/permission-policy.ts";
import type { Tool } from "../src/tools/tool.ts";

const searchTool: Tool = {
  name: "search_attractions",
  description: "",
  parameters: { type: "object", properties: {} },
  execute: async () => "",
};

const writeTool: Tool = {
  name: "write_file",
  description: "",
  parameters: { type: "object", properties: {} },
  workspaceEdit: true,
  execute: async () => "",
};

const bashTool: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: {} },
  sessionAlwaysAllowed: false,
  execute: async () => "",
};

const highRiskTool: Tool = {
  name: "rotate_key",
  description: "",
  parameters: { type: "object", properties: {} },
  sessionAlwaysAllowed: false,
  execute: async () => "",
};

function decide(overrides: Partial<DecidePermissionInput> = {}) {
  return decidePermission({
    toolName: "search_attractions",
    tool: searchTool,
    arguments: "{}",
    mode: "ask",
    memory: createPermissionMemory(),
    ...overrides,
  });
}

test("策略: trust 模式全部放行", () => {
  assert.equal(decide({ mode: "trust" }).kind, "allow");
});

test("策略: 会话「总是允许」的工具直接放行，其他工具不受影响", () => {
  const memory = createPermissionMemory();
  memory.alwaysTools.add("search_attractions");
  assert.equal(decide({ memory }).kind, "allow");
  assert.equal(
    decide({ memory, toolName: "bash", tool: bashTool, arguments: '{"command":"echo 1"}' }).kind,
    "ask",
  );
});

test("策略: bash 命令前缀命中记忆放行（参数变化仍命中）", () => {
  const memory = createPermissionMemory();
  memory.bashKeys.add("npm test");
  const bash = (command: string) => decide({ memory, toolName: "bash", tool: bashTool, arguments: JSON.stringify({ command }) });
  assert.equal(bash("npm test").kind, "allow");
  assert.equal(bash("npm test -- --watch").kind, "allow");
  assert.equal(bash("npm run dev").kind, "ask");
});

test("策略: 命令记忆只对 bash 生效，不会被其他工具的 command 参数误命中", () => {
  const memory = createPermissionMemory();
  memory.bashKeys.add("deploy");
  const result = decide({ memory, toolName: "some_tool", tool: undefined, arguments: '{"command":"deploy now"}' });
  assert.equal(result.kind, "ask");
});

test("策略: edits 模式仅免确认工作区写入类工具", () => {
  assert.equal(decide({ mode: "edits", toolName: "write_file", tool: writeTool }).kind, "allow");
  assert.equal(decide({ mode: "edits" }).kind, "ask");
});

test("策略: bash 不提供「总是允许」，决策附带命令记忆键", () => {
  const result = decide({ toolName: "bash", tool: bashTool, arguments: '{"command":"npm test -x"}' });
  assert.deepEqual(result, { kind: "ask", commandKey: "npm test", canAlways: false });
});

test("策略: 普通工具可「总是允许」，显式禁用的高风险工具不可", () => {
  assert.deepEqual(decide(), { kind: "ask", commandKey: "", canAlways: true });
  assert.equal(decide({ toolName: "rotate_key", tool: highRiskTool }).canAlways, false);
});

test("策略: 未注册工具按静态信息降级（需询问、可总是允许）", () => {
  assert.deepEqual(decide({ toolName: "unknown_tool", tool: undefined }), {
    kind: "ask",
    commandKey: "",
    canAlways: true,
  });
});

test("策略: 参数非法 JSON 时按无命令处理，不误判", () => {
  const memory = createPermissionMemory();
  memory.bashKeys.add("npm test");
  const result = decide({ memory, toolName: "bash", tool: bashTool, arguments: "not-json" });
  assert.equal(result.kind, "ask");
  assert.equal(result.commandKey, "");
  assert.equal(result.canAlways, false);
});

test("策略: 审批模式优先级 trust > 会话持久值 > 默认 edits", () => {
  const session = new Session("sess_policy");
  assert.equal(permissionModeOf(session, false), "edits");
  session.setApprovalMode("ask");
  assert.equal(permissionModeOf(session, false), "ask");
  assert.equal(permissionModeOf(session, true), "trust");
});
