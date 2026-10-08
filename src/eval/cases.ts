import { readFile } from "node:fs/promises";

/**
 * 金标准样例：一组"典型用户请求 + 预期口径"。
 * 离线评测对样例产出的行程单打分；--live 模式按 request 真实生成后再打分。
 * 样例的目的不是断言唯一正确答案，而是让"提示词/工具改动导致的画质变化"可度量、可回归。
 */
export interface EvalCase {
  readonly id: string;
  /** 保存行程时的标题（与 eval/out/<id>/plans/<title>.json 对应） */
  readonly title: string;
  readonly days: number;
  readonly budget_per_person_yuan?: number;
  /** 口味偏好（传给旅行提示词；缺省用全局配置） */
  readonly taste?: string;
  /** 用户视角的原始需求（--live 模式直接作为首条消息） */
  readonly request: string;
}

export async function loadCases(file: string): Promise<EvalCase[]> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${file}: 需要非空的样例数组`);
  }
  const cases = raw.map((item, index) => parseCase(item, `${file}[${index}]`));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`${file}: 样例 id 重复: ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}

function parseCase(raw: unknown, label: string): EvalCase {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: 样例必须是 JSON 对象`);
  }
  const record = raw as Record<string, unknown>;
  const id = requireField(record, "id", label);
  const title = requireField(record, "title", label);
  const request = requireField(record, "request", label);
  if (typeof record.days !== "number" || !Number.isInteger(record.days) || record.days <= 0) {
    throw new Error(`${label}: days 需要正整数`);
  }
  if (record.budget_per_person_yuan !== undefined && typeof record.budget_per_person_yuan !== "number") {
    throw new Error(`${label}: budget_per_person_yuan 需要数字`);
  }
  if (record.taste !== undefined && typeof record.taste !== "string") {
    throw new Error(`${label}: taste 需要字符串`);
  }
  return {
    id,
    title,
    days: record.days,
    ...(record.budget_per_person_yuan === undefined ? {} : { budget_per_person_yuan: record.budget_per_person_yuan }),
    ...(record.taste === undefined ? {} : { taste: record.taste }),
    request,
  };
}

function requireField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}: 缺少非空字符串字段 ${key}`);
  }
  return value;
}
