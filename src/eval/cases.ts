import { readFile } from "node:fs/promises";

/**
 * 金标准样例：一组"典型用户请求 + 预期口径"。
 * 离线评测对样例产出的行程单打分；--live 模式按 request 真实生成后再打分。
 * 样例的目的不是断言唯一正确答案，而是让"提示词/工具改动导致的画质变化"可度量、可回归。
 */
export interface EvalCase {
  readonly id: string;
  /** 保存行程时的标题（与 plans/<title>.json 对应） */
  readonly title: string;
  readonly days: number;
  readonly must_visit?: readonly string[];
  readonly budget_per_person_yuan?: number;
  /** 口味偏好（传给旅行提示词；缺省用全局配置） */
  readonly taste?: string;
  /** 套件筛选标签，例如 food / remote-day / representative */
  readonly tags?: readonly string[];
  /** 用户视角的原始需求（--live 模式直接作为首条消息） */
  readonly request: string;
}

/**
 * 评测套件：可版本化、可筛选的案例集合。
 * 批次会保存套件快照，后续案例文件变化不会悄悄改写历史批次的口径。
 */
export interface EvalSuite {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly cases: readonly EvalCase[];
}

/** 兼容旧的顶层数组格式；新文件使用带元数据的套件对象 */
export async function loadSuite(file: string): Promise<EvalSuite> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new Error(`${file}: 需要非空样例数组`);
    const cases = parseCases(raw, `${file}[cases]`);
    return {
      id: "legacy",
      name: "Legacy cases",
      version: "1",
      cases,
    };
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${file}: 需要评测套件对象或非空样例数组`);
  }
  const record = raw as Record<string, unknown>;
  const id = requireSafeId(record, "id", file);
  const name = requireField(record, "name", file);
  const version = requireField(record, "version", file);
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw new Error(`${file}: cases 需要非空样例数组`);
  }
  return {
    id,
    name,
    version,
    cases: parseCases(record.cases, `${file}[cases]`),
  };
}

/** 兼容旧调用方：读取套件或旧的顶层案例数组，只返回案例 */
export async function loadCases(file: string): Promise<EvalCase[]> {
  return [...(await loadSuite(file)).cases];
}

function parseCases(raw: readonly unknown[], label: string): EvalCase[] {
  const cases = raw.map((item, index) => parseCase(item, `${label}[${index}]`));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`${label}: 样例 id 重复: ${item.id}`);
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
  if (record.must_visit !== undefined && (!Array.isArray(record.must_visit) || record.must_visit.some((v) => typeof v !== "string" || !v.trim()))) throw new Error(`${label}: must_visit 需要非空名称数组`);
  if (record.taste !== undefined && typeof record.taste !== "string") {
    throw new Error(`${label}: taste 需要字符串`);
  }
  if (
    record.tags !== undefined &&
    (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string" || tag.trim() === ""))
  ) {
    throw new Error(`${label}: tags 需要非空字符串数组`);
  }
  const tags = Array.isArray(record.tags)
    ? [...new Set(record.tags.map((tag) => (tag as string).trim()))]
    : undefined;
  return {
    id: requireSafeCaseId(id, label),
    title,
    days: record.days,
    ...(record.must_visit === undefined ? {} : { must_visit: [...new Set((record.must_visit as string[]).map((v) => v.trim()))] }),
    ...(record.budget_per_person_yuan === undefined ? {} : { budget_per_person_yuan: record.budget_per_person_yuan }),
    ...(record.taste === undefined ? {} : { taste: record.taste }),
    ...(tags === undefined ? {} : { tags }),
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

function requireSafeId(record: Record<string, unknown>, key: string, label: string): string {
  return requireSafeCaseId(requireField(record, key, label), `${label}.${key}`);
}

export function requireSafeCaseId(value: string, label: string): string {
  if (
    value.length > 80 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label}: id 只能包含字母、数字、点、下划线和连字符，且不能以符号开头`);
  }
  return value;
}
