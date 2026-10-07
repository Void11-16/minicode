import type { ChatProvider } from "./provider.ts";
import type { PromptMessage } from "../core/message.ts";

/**
 * Mock Provider —— 无需 API Key、无网络，用于开发与测试。
 */
export class MockProvider implements ChatProvider {
  readonly name = "mock";

  private readonly reply: string;

  constructor(reply: string = "这是 mock 回复。") {
    this.reply = reply;
  }

  async chat(history: readonly PromptMessage[]): Promise<string> {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (lastUser === undefined) {
      throw new Error("MockProvider: 没有可回复的用户消息");
    }
    return `${this.reply}\n(收到的用户消息: ${lastUser.content})`;
  }

  async chatStream(
    history: readonly PromptMessage[],
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const full = await this.chat(history);
    // 按小块流出，模拟真实流式效果
    const chunkSize = 8;
    for (let i = 0; i < full.length; i += chunkSize) {
      onDelta(full.slice(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return full;
  }
}
