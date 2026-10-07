import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AppConfig {
  /** auto: 按 Key 自动判断；也可强制 mock / deepseek / openai */
  readonly provider: "auto" | "mock" | "deepseek" | "openai";
  readonly deepseekApiKey?: string;
  readonly amapApiKey?: string;
  readonly deepseekModel?: string;
  readonly llmApiKey?: string;
  readonly llmBaseUrl?: string;
  readonly llmModel?: string;
  /** 估算成本用：输入单价（元/百万 tokens） */
  readonly priceIn?: string;
  /** 估算成本用：输出单价（元/百万 tokens） */
  readonly priceOut?: string;
  /** resume 时历史超过该估算 token 数则自动压缩为摘要+近期消息；0 = 永不压缩 */
  readonly resumeMaxTokens?: string;
  /** 自定义系统提示词（助手人设）；未设置时用旅行规划默认值 */
  readonly systemPrompt?: string;
  /** 口味偏好（忌口/辣度/预算/偏好），注入提示词供餐饮推荐参考 */
  readonly tastePreferences?: string;
  /** 单会话花费预算（元）；估算成本达到后暂停发送。0 = 不限制 */
  readonly budgetYuan?: string;
}

export const DEFAULT_CONFIG: AppConfig = { provider: "auto" };

const VALID_PROVIDERS = new Set(["auto", "mock", "deepseek", "openai"]);

/** 支持的配置键（含常用别名） */
export const CONFIG_KEY_ALIASES: Record<string, keyof AppConfig> = {
  provider: "provider",
  deepseek_api_key: "deepseekApiKey",
  deepseek_key: "deepseekApiKey",
  ds_key: "deepseekApiKey",
  amap_api_key: "amapApiKey",
  amap_key: "amapApiKey",
  deepseek_model: "deepseekModel",
  ds_model: "deepseekModel",
  llm_api_key: "llmApiKey",
  api_key: "llmApiKey",
  llm_base_url: "llmBaseUrl",
  base_url: "llmBaseUrl",
  llm_model: "llmModel",
  model: "llmModel",
  price_in: "priceIn",
  price_out: "priceOut",
  resume_max_tokens: "resumeMaxTokens",
  system_prompt: "systemPrompt",
  taste_preferences: "tastePreferences",
  taste: "tastePreferences",
  budget_yuan: "budgetYuan",
};

export class ConfigStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<AppConfig> {
    try {
      const raw = await readFile(this.file, "utf8");
      return validateConfig(JSON.parse(raw));
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async save(config: AppConfig): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(config, null, 2), "utf8");
  }

  /** 设置一个配置项，返回新配置。键不存在或值非法时抛错 */
  async set(rawKey: string, value: string): Promise<AppConfig> {
    const field = CONFIG_KEY_ALIASES[rawKey];
    if (field === undefined) {
      throw new Error(`未知配置项: ${rawKey}（可用: ${Object.keys(CONFIG_KEY_ALIASES).join(", ")}）`);
    }
    if (field === "provider" && !VALID_PROVIDERS.has(value)) {
      throw new Error(`provider 只能是: ${[...VALID_PROVIDERS].join(" / ")}`);
    }

    const current = await this.load();
    const next = { ...current, [field]: value };
    await this.save(next);
    return next;
  }

  /** 清除一个配置项 */
  async clear(rawKey: string): Promise<AppConfig> {
    const field = CONFIG_KEY_ALIASES[rawKey];
    if (field === undefined) {
      throw new Error(`未知配置项: ${rawKey}`);
    }
    const current = await this.load();
    const next = { ...current } as Record<string, unknown>;
    delete next[field];
    await this.save(validateConfig(next));
    return validateConfig(next);
  }
}

function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_CONFIG;
  const source = raw as Record<string, unknown>;

  const provider =
    typeof source.provider === "string" && VALID_PROVIDERS.has(source.provider)
      ? (source.provider as AppConfig["provider"])
      : "auto";

  const config: Partial<AppConfig> = { provider };
  for (const key of [
    "deepseekApiKey", "amapApiKey", "deepseekModel", "llmApiKey", "llmBaseUrl", "llmModel",
    "priceIn", "priceOut", "resumeMaxTokens", "systemPrompt", "budgetYuan",
    "tastePreferences",
  ]) {
    if (typeof source[key] === "string" && source[key] !== "") {
      (config as Record<string, unknown>)[key] = source[key];
    }
  }
  return config as AppConfig;
}

/** 显示配置时打码 API Key */
export function maskSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
