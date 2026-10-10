import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "./tool.ts";
import { extractDocx, extractXlsx, type DocExtractResult } from "../util/doc-text.ts";

/**
 * 旅行者档案：同行人填好的《旅行者档案填写表》导入后生成的结构化偏好，
 * 供规划时合并约束（硬约束取交集、节奏取最慢——见 mergeProfiles）。
 * 存储：plans/profiles/<id>.json（人类可读，可手工编辑）。
 */

export const PROFILE_FIELDS = [
  "allergies",
  "spicy",
  "likes",
  "dislikes",
  "pace",
  "mobility",
  "interests",
  "avoid",
  "budget",
  "notes",
] as const;
export type ProfileFieldId = (typeof PROFILE_FIELDS)[number];

export interface TravelerProfile {
  readonly id: string;
  readonly name: string;
  readonly fields: Partial<Record<ProfileFieldId, string>>;
  readonly source?: {
    readonly file?: string;
    readonly importedAt?: number;
    readonly rawText?: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function profilesDir(rootDir: string): string {
  return join(rootDir, "plans", "profiles");
}

export async function listProfiles(rootDir: string): Promise<TravelerProfile[]> {
  const dir = profilesDir(rootDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: TravelerProfile[] = [];
  for (const name of names.filter((file) => file.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as TravelerProfile;
      if (typeof parsed.id === "string" && typeof parsed.name === "string") profiles.push(parsed);
    } catch {
      // 单个损坏文件不影响列表
    }
  }
  return profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function loadProfile(rootDir: string, idOrName: string): Promise<TravelerProfile | null> {
  const profiles = await listProfiles(rootDir);
  return (
    profiles.find((profile) => profile.id === idOrName) ??
    profiles.find((profile) => profile.name === idOrName) ??
    null
  );
}

export async function saveProfile(
  rootDir: string,
  input: { id?: string; name: string; fields: Partial<Record<ProfileFieldId, string>>; source?: TravelerProfile["source"] },
): Promise<TravelerProfile> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name === "") throw new Error("档案名字不能为空");
  const id = input.id !== undefined && input.id !== "" ? input.id : slugForName(name);
  const file = join(profilesDir(rootDir), `${id}.json`);

  let existing: TravelerProfile | undefined;
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as TravelerProfile;
  } catch {
    existing = undefined;
  }
  if (input.id === undefined && existing !== undefined) {
    throw new Error(`已有同名档案「${name}」，请改名或先删除旧档案`);
  }

  const now = Date.now();
  const profile: TravelerProfile = {
    id,
    name,
    fields: cleanFields(input.fields),
    ...(input.source !== undefined ? { source: { ...input.source, rawText: input.source.rawText?.slice(0, 4000) } } : existing?.source !== undefined ? { source: existing.source } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await mkdir(profilesDir(rootDir), { recursive: true });
  await writeFile(file, JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

export async function deleteProfile(rootDir: string, id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_\-\p{Script=Han}]+$/u.test(id)) return false;
  try {
    await unlink(join(profilesDir(rootDir), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

function slugForName(name: string): string {
  const slug =
    name
      .replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || `profile-${Date.now().toString(36)}`;
  return `prof-${slug}`;
}

function cleanFields(fields: Partial<Record<ProfileFieldId, string>>): Partial<Record<ProfileFieldId, string>> {
  const cleaned: Partial<Record<ProfileFieldId, string>> = {};
  for (const key of PROFILE_FIELDS) {
    const value = fields[key];
    if (typeof value !== "string") continue;
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, 500);
    if (trimmed !== "") cleaned[key] = trimmed;
  }
  return cleaned;
}

// ===== 填好的表单文档 → 档案字段 =====

const FIELD_ALIASES: Array<{ id: ProfileFieldId; aliases: readonly string[] }> = [
  { id: "allergies", aliases: ["忌口与过敏", "忌口过敏", "食物过敏", "过敏", "忌口"] },
  { id: "spicy", aliases: ["辣度接受度", "辣度"] },
  { id: "likes", aliases: ["喜欢吃什么", "爱吃什么", "喜欢吃的", "口味偏好"] },
  { id: "dislikes", aliases: ["不吃什么", "忌食", "不爱吃"] },
  { id: "pace", aliases: ["行程节奏", "节奏"] },
  { id: "mobility", aliases: ["体力与步行", "步行能力", "体力情况", "体力"] },
  { id: "interests", aliases: ["兴趣偏好", "兴趣爱好", "兴趣"] },
  { id: "avoid", aliases: ["特别不喜欢", "避雷", "雷点"] },
  { id: "budget", aliases: ["预算倾向", "预算"] },
  { id: "notes", aliases: ["其他要交代的", "要交代的", "其他交代", "备注", "其他"] },
];
const SKIP_LABELS = new Set(["项目", "填写项目", "说明与示例", "示例"]);

export interface ParsedProfileForm {
  readonly name?: string;
  readonly fields: Partial<Record<ProfileFieldId, string>>;
  readonly warnings: string[];
  readonly rawText: string;
}

/** 解析填好的档案文档（.docx / .xlsx / .md / .txt），映射到结构化字段 */
export function parseProfileDocument(fileName: string, buffer: Buffer): ParsedProfileForm {
  const lower = fileName.toLowerCase();
  let extracted: DocExtractResult;
  if (lower.endsWith(".docx")) extracted = extractDocx(buffer);
  else if (lower.endsWith(".xlsx")) extracted = extractXlsx(buffer);
  else if (lower.endsWith(".md") || lower.endsWith(".txt")) extracted = parsePlainText(buffer.toString("utf8"));
  else if (lower.endsWith(".doc")) throw new Error("暂不支持旧版 .doc，请在 Word 里另存为 .docx 后重试");
  else throw new Error("只支持 .docx / .xlsx / .md / .txt 格式的档案文件");
  return mapRowsToProfile(extracted);
}

function parsePlainText(content: string): DocExtractResult {
  const rows: Array<readonly [string, string]> = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*\|(.+)\|\s*$/.exec(line);
    if (match === null) continue;
    const cells = match[1].split("|").map((cell) => cell.trim());
    if (cells.every((cell) => cell === "" || /^-{3,}$/.test(cell))) continue;
    if (cells.length >= 2) rows.push([cells[0], cells[1]] as const);
  }
  return { rows, text: content };
}

function mapRowsToProfile(extracted: DocExtractResult): ParsedProfileForm {
  const fields: Partial<Record<ProfileFieldId, string>> = {};
  const warnings: string[] = [];
  let name: string | undefined;

  for (const [rawLabel, rawValue] of extracted.rows) {
    const label = rawLabel.split("\n")[0].replace(/[★☆]/g, "").replace(/[：:\s]+/g, "").trim();
    const value = rawValue.replace(/^[：:\s=]+/, "").trim();
    if (label === "" || value === "") continue;
    if (SKIP_LABELS.has(label)) continue;

    if (["称呼", "名字", "姓名", "昵称"].includes(label)) {
      name = value;
      continue;
    }
    const field = matchField(label);
    if (field === null) {
      warnings.push(`未识别字段「${rawLabel}」（${value.slice(0, 40)}），已忽略——可在页面上手工补填`);
      continue;
    }
    if (field === "allergies" && /^(无|没有|无过敏|无。|无！)$/.test(value)) continue;
    const previous = fields[field];
    fields[field] = previous === undefined ? value : `${previous}；${value}`;
  }
  return { ...(name !== undefined ? { name } : {}), fields, warnings, rawText: extracted.text };
}

function matchField(label: string): ProfileFieldId | null {
  for (const entry of FIELD_ALIASES) {
    if (entry.aliases.includes(label)) return entry.id;
  }
  for (const entry of FIELD_ALIASES) {
    if (entry.aliases.some((alias) => alias.length >= 2 && label.startsWith(alias))) return entry.id;
  }
  return null;
}

// ===== 约束合并（规划用） =====

const SPICY_ORDER = ["完全不吃", "微辣", "正常", "无辣不欢"] as const;
const PACE_ORDER = ["松弛", "慢", "适中", "紧凑"] as const;

/** 合并多份档案为规划约束文本：硬约束取并集、辣度/节奏取最保守 */
export function mergeProfiles(profiles: readonly TravelerProfile[]): string {
  if (profiles.length === 0) return "";
  const lines: string[] = ["【同行人约束（已合并，规划必须遵守）】"];

  const allergies = profiles
    .filter((profile) => isMeaningful(profile.fields.allergies))
    .map((profile) => `${profile.fields.allergies}（${profile.name}）`);
  if (allergies.length > 0) lines.push(`- 忌口与过敏（强制回避）: ${allergies.join("；")}`);

  const spicy = mostRestrictive(profiles, "spicy", SPICY_ORDER);
  if (spicy !== null) lines.push(`- 辣度上限: ${spicy.limit}（受 ${spicy.owner} 限制）`);
  const pace = mostRestrictive(profiles, "pace", PACE_ORDER);
  if (pace !== null) lines.push(`- 节奏上限: ${pace.limit}（受 ${pace.owner} 限制）`);

  const interests = profiles
    .filter((profile) => isMeaningful(profile.fields.interests))
    .map((profile) => `${profile.fields.interests}（${profile.name}）`);
  if (interests.length > 0) lines.push(`- 兴趣方向（取并集，尽量都照顾到）: ${interests.join("；")}`);

  const avoid = profiles
    .filter((profile) => isMeaningful(profile.fields.avoid))
    .map((profile) => `${profile.fields.avoid}（${profile.name}）`);
  if (avoid.length > 0) lines.push(`- 特别不喜欢（尽量避开）: ${avoid.join("；")}`);

  for (const profile of profiles) {
    const extras: string[] = [];
    if (isMeaningful(profile.fields.budget)) extras.push(`预算: ${profile.fields.budget}`);
    if (isMeaningful(profile.fields.notes)) extras.push(profile.fields.notes ?? "");
    if (extras.length > 0) lines.push(`- ${profile.name}: ${extras.join("；")}`);
  }
  return lines.join("\n");
}

function isMeaningful(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function mostRestrictive(
  profiles: readonly TravelerProfile[],
  field: "spicy" | "pace",
  order: readonly string[],
): { limit: string; owner: string } | null {
  let best: { limit: string; owner: string; rank: number } | null = null;
  for (const profile of profiles) {
    const value = profile.fields[field];
    if (!isMeaningful(value)) continue;
    const rank = order.findIndex((item) => value.includes(item));
    if (rank < 0) continue;
    if (best === null || rank < best.rank) best = { limit: order[rank], owner: profile.name, rank };
  }
  return best === null ? null : { limit: best.limit, owner: best.owner };
}

/** 列表用一行摘要 */
export function profileSummary(profile: TravelerProfile): string {
  const parts: string[] = [];
  if (isMeaningful(profile.fields.allergies)) parts.push(`忌口: ${profile.fields.allergies}`);
  if (isMeaningful(profile.fields.pace)) parts.push(`节奏: ${profile.fields.pace}`);
  if (isMeaningful(profile.fields.spicy)) parts.push(`辣度: ${profile.fields.spicy}`);
  if (parts.length === 0 && isMeaningful(profile.fields.notes)) parts.push(profile.fields.notes.slice(0, 30));
  return parts.join(" · ") || "（未填写摘要字段）";
}

// ===== MCP 工具：让模型在对话里读档案 =====

export function createListTravelerProfilesTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "list_traveler_profiles",
    description: "列出已导入的旅行者档案（同行人偏好）。规划开始前用 load_traveler_profile 读取需要的档案。",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const profiles = await listProfiles(rootDir);
      if (profiles.length === 0) return "还没有旅行者档案。可以用《旅行者档案填写表》导入：Web 页面右上角 👥 按钮。";
      return profiles.map((profile) => `- ${profile.name}（${profileSummary(profile)}）`).join("\n");
    },
  };
}

export function createLoadTravelerProfileTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "load_traveler_profile",
    description: "读取一份旅行者档案的完整内容（名字或 id）。规划时结合需求单中的同行人做约束合并。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "档案名字（如：爸爸）或 id" } },
      required: ["name"],
    },
    async execute(args) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name === "") throw new Error("缺少档案名字");
      const profile = await loadProfile(rootDir, name);
      if (profile === null) return `未找到档案「${name}」。可用 list_traveler_profiles 查看已导入的档案。`;
      const fields = PROFILE_FIELDS.filter((id) => isMeaningful(profile.fields[id]))
        .map((id) => `${id}: ${profile.fields[id]}`)
        .join("\n");
      return `${profile.name}（更新于 ${new Date(profile.updatedAt).toLocaleString("zh-CN")}）\n${fields}`;
    },
  };
}
