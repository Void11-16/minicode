import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase } from "./cases.ts";

/**
 * 真实产出样本：直接拿 plans/ 里已保存的行程当评测输入。
 * 行程是现成的，所以不花生成费用 —— 用来回答"改了校验/指标口径之后，
 * 这批真实行程的报告是变多还是变少、是误报还是修正"。
 */
export interface PlanSample {
  readonly evalCase: EvalCase;
  readonly path: string;
}

export async function loadPlanSamples(dir: string): Promise<PlanSample[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".quality.json"))
    .sort();
  if (names.length === 0) throw new Error(`${dir}: 没有可评测的行程文件（*.json）`);
  return Promise.all(names.map(async (name) => ({
    evalCase: await readPlanMeta(name.slice(0, -".json".length), join(dir, name)),
    path: join(dir, name),
  })));
}

/** 只读标题和天数做展示；行程正文由 evaluateFile 解析，解析失败会记进报告 */
async function readPlanMeta(id: string, path: string): Promise<EvalCase> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { title?: unknown; days?: unknown };
    return {
      id,
      title: typeof raw.title === "string" && raw.title !== "" ? raw.title : id,
      days: Array.isArray(raw.days) ? raw.days.length : 0,
      // 真实产出不参与生成，request 只在 --live 使用
      request: "",
    };
  } catch {
    return { id, title: id, days: 0, request: "" };
  }
}
