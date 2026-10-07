import { createInterface } from "node:readline";
import type { ToolRegistry } from "../tools/tool.ts";

/** 已知协议版本：客户端请求未知版本时回退到最新已知版（tools 接口在各版本间稳定） */
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  /** 写给客户端模型的简短使用说明 */
  readonly instructions?: string;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** 协议层错误：转成 JSON-RPC error 响应（区别于工具执行失败的 isError 结果） */
class McpError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 处理一条 MCP 消息（JSON-RPC 2.0）：
 * - 请求 → 返回完整响应对象；通知（无 id）→ 返回 null，不产生响应
 * - 工具执行失败按协议返回 isError: true，让模型看到错误自行调整
 */
export async function handleMcpMessage(
  message: unknown,
  registry: ToolRegistry,
  serverInfo: McpServerInfo,
): Promise<Record<string, unknown> | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const request = message as JsonRpcMessage;
  if (request.id === undefined || request.id === null) return null;

  try {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: await dispatch(request, registry, serverInfo),
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: error instanceof McpError ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function dispatch(
  request: JsonRpcMessage,
  registry: ToolRegistry,
  serverInfo: McpServerInfo,
): Promise<Record<string, unknown>> {
  if (request.method === "initialize") {
    const requested = objectOf(request.params).protocolVersion;
    return {
      protocolVersion:
        typeof requested === "string" && KNOWN_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: serverInfo.name, version: serverInfo.version },
      ...(serverInfo.instructions !== undefined ? { instructions: serverInfo.instructions } : {}),
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") {
    return {
      tools: registry.definitions().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    };
  }
  if (request.method === "tools/call") return callTool(request, registry);
  throw new McpError(-32601, `不支持的方法: ${String(request.method)}`);
}

async function callTool(
  request: JsonRpcMessage,
  registry: ToolRegistry,
): Promise<Record<string, unknown>> {
  const params = objectOf(request.params);
  if (typeof params.name !== "string" || params.name === "") {
    throw new McpError(-32602, "tools/call 缺少 name 参数");
  }
  if (registry.get(params.name) === undefined) {
    throw new McpError(-32602, `工具不存在: ${params.name}`);
  }

  try {
    const text = await registry.execute(params.name, JSON.stringify(objectOf(params.arguments)));
    return { content: [{ type: "text", text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `工具执行失败: ${message}` }], isError: true };
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** stdio 传输：每行一条 JSON-RPC 消息，响应原路写回 stdout（stdout 只允许协议流量） */
export async function runStdioMcp(registry: ToolRegistry, serverInfo: McpServerInfo): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    void (async () => {
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // 解析失败拿不到 id，无法按协议构造响应，只能丢弃
        return;
      }
      const response = await handleMcpMessage(message, registry, serverInfo);
      if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
    })();
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
}
