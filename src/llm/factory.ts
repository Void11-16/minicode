import { MockProvider } from "./mock.ts";
import { DeepSeekProvider } from "./deepseek.ts";
import { OpenAICompatProvider } from "./openai.ts";
import type { ChatProvider } from "./provider.ts";
import type { AppConfig } from "../config/config.ts";
import type { ModelProfile } from "../config/models.ts";

export interface ProviderFactoryInput {
  readonly env?: Record<string, string | undefined>;
  readonly config?: Partial<AppConfig>;
  readonly systemPrompt?: string;
}

/**
 * 根据配置文件 + 环境变量选择 Provider。
 * 优先级: 配置文件 > 环境变量 > mock（config.provider 可强制指定）
 */
export function createProvider(input: ProviderFactoryInput = {}): ChatProvider {
  const env = input.env ?? process.env;
  const config = input.config ?? {};

  const systemPrompt = input.systemPrompt;

  if (config.provider === "mock") {
    return new MockProvider("已强制使用 mock（配置 provider=mock）。用 /config set provider auto 恢复自动选择。");
  }

  const deepseekKey =
    config.deepseekApiKey ?? env.DEEPSEEK_API_KEY ?? env.DS_API_KEY;
  if (deepseekKey !== undefined && deepseekKey !== "") {
    return new DeepSeekProvider({
      apiKey: deepseekKey,
      model: config.deepseekModel ?? env.DEEPSEEK_MODEL ?? env.DS_MODEL,
      systemPrompt,
    });
  }

  const apiKey = config.llmApiKey ?? env.LLM_API_KEY ?? env.OPENAI_API_KEY;
  if (apiKey !== undefined && apiKey !== "") {
    return new OpenAICompatProvider({
      apiKey,
      baseUrl: config.llmBaseUrl ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1",
      model: config.llmModel ?? env.LLM_MODEL ?? "gpt-4o-mini",
      systemPrompt,
    });
  }

  return new MockProvider(
    "你好，我是 minicode 的 mock 模型。设置 DEEPSEEK_API_KEY 接入 DeepSeek，或 LLM_API_KEY 接入其他 OpenAI 兼容服务。",
  );
}

/** 按多模型配置创建 Provider（Web 端每个会话独立选模型用） */
export function createProviderFromProfile(profile: ModelProfile, systemPrompt?: string): ChatProvider {
  if (profile.provider === "mock") return new MockProvider();
  if (profile.provider === "deepseek") {
    return new DeepSeekProvider({
      apiKey: profile.apiKey ?? "",
      model: profile.model,
      systemPrompt,
    });
  }
  return new OpenAICompatProvider({
    apiKey: profile.apiKey ?? "",
    baseUrl: profile.baseUrl ?? "https://api.openai.com/v1",
    model: profile.model ?? "gpt-4o-mini",
    systemPrompt,
  });
}
