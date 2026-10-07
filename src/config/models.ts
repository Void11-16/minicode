import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.ts";

export type ModelProviderKind = "deepseek" | "openai" | "mock";

export interface ModelProfile {
  readonly id: string;
  /** 展示名，如 DeepSeek Chat */
  readonly name: string;
  readonly provider: ModelProviderKind;
  readonly apiKey?: string;
  /** OpenAI 兼容服务的 base URL */
  readonly baseUrl?: string;
  readonly model?: string;
}

interface ModelsFile {
  readonly profiles: readonly ModelProfile[];
  readonly defaultProfile?: string;
}

/**
 * 多模型配置：`.minicode/models.json`，每个会话可独立选择。
 * 首次运行时从旧版单模型配置（deepseek_api_key / llm_api_key）自动迁移。
 */
export class ModelProfileStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<ModelsFile> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as ModelsFile;
      return {
        profiles: Array.isArray(raw.profiles) ? raw.profiles.filter(isValidProfile) : [],
        defaultProfile: typeof raw.defaultProfile === "string" ? raw.defaultProfile : undefined,
      };
    } catch {
      return { profiles: [] };
    }
  }

  async save(data: ModelsFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ profiles: data.profiles, defaultProfile: data.defaultProfile }, null, 2), "utf8");
  }

  /** 旧配置迁移：已有单模型 Key 时生成首个 profile，保证升级无感 */
  async loadWithSeed(config: AppConfig): Promise<ModelsFile> {
    const existing = await this.load();
    if (existing.profiles.length > 0) return existing;

    const profiles: ModelProfile[] = [];
    if (config.deepseekApiKey !== undefined && config.deepseekApiKey !== "") {
      profiles.push({
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        apiKey: config.deepseekApiKey,
        model: config.deepseekModel ?? "deepseek-chat",
      });
    }
    if (config.llmApiKey !== undefined && config.llmApiKey !== "") {
      profiles.push({
        id: "openai-compat",
        name: "OpenAI 兼容",
        provider: "openai",
        apiKey: config.llmApiKey,
        baseUrl: config.llmBaseUrl ?? "https://api.openai.com/v1",
        model: config.llmModel ?? "gpt-4o-mini",
      });
    }
    if (profiles.length === 0) return existing;

    const seeded: ModelsFile = { profiles, defaultProfile: profiles[0].id };
    await this.save(seeded);
    return seeded;
  }
}

export function isValidProfile(value: unknown): value is ModelProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" && profile.id !== "" &&
    typeof profile.name === "string" && profile.name !== "" &&
    (profile.provider === "deepseek" || profile.provider === "openai" || profile.provider === "mock")
  );
}

/** 生成不与现有 id 冲突的 profile id */
export function newProfileId(existing: readonly ModelProfile[]): string {
  const used = new Set(existing.map((profile) => profile.id));
  let index = used.size + 1;
  while (used.has(`model-${index}`)) index += 1;
  return `model-${index}`;
}
