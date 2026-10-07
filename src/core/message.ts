/**
 * 消息模型 —— 整个系统的公共数据契约。
 * 这个文件不依赖任何其他模块。
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** LLM 发起的一次工具调用请求 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 JSON 字符串参数，由工具方解析 */
  readonly arguments: string;
}

export interface MessageExtra {
  /** assistant 消息发起的工具调用 */
  readonly toolCalls?: readonly ToolCall[];
  /** tool 消息对应的调用 id */
  readonly toolCallId?: string;
  /** tool 消息的工具名（方便展示） */
  readonly toolName?: string;
}

/** 发送给 LLM 的精简消息格式（不含本地 id 等实现细节）——LLM 协议类型 */
export interface PromptMessage {
  readonly role: Role;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface Message {
  readonly id: string;
  readonly role: Role;
  readonly content: string;
  readonly createdAt: number;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

let counter = 0;

export function createMessage(
  role: Role,
  content: string,
  extra: MessageExtra = {},
): Message {
  counter += 1;
  return {
    id: `msg_${Date.now()}_${counter}`,
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}
