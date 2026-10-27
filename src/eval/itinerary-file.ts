import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 只在一个明确的工作目录里找行程，避免续跑读到上一次 attempt 的残留文件 */
export async function findItinerary(
  outDir: string,
  title: string,
  expectedDays: number,
): Promise<string | null> {
  const plansDir = join(outDir, "plans");
  const names = await readdir(plansDir).catch(() => [] as string[]);
  const candidates = names.filter((name) => name.endsWith(".json") && !name.endsWith(".quality.json"));
  if (candidates.length === 0) return null;

  const ranked = await Promise.all(
    candidates.map(async (name) => {
      const path = join(plansDir, name);
      const info = await stat(path);
      const parsed = await readPlanSummary(path);
      return {
        path,
        mtime: info.mtimeMs,
        days: parsed?.days ?? -1,
        titleMatch: parsed === null ? -1 : titleAffinity(title, parsed.title),
      };
    }),
  );
  ranked.sort((a, b) =>
    Number(b.titleMatch > 0) - Number(a.titleMatch > 0) ||
    Number(b.days === expectedDays) - Number(a.days === expectedDays) ||
    b.titleMatch - a.titleMatch ||
    Math.abs(a.days - expectedDays) - Math.abs(b.days - expectedDays) ||
    b.mtime - a.mtime
  );
  return ranked[0]?.path ?? null;
}

async function readPlanSummary(path: string): Promise<{ readonly title: string; readonly days: number } | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { title?: unknown; days?: unknown };
    if (typeof raw.title !== "string" || !Array.isArray(raw.days)) return null;
    return { title: raw.title, days: raw.days.length };
  } catch {
    return null;
  }
}

function titleAffinity(expected: string, actual: string): number {
  const expectedTitle = canonicalTitle(expected);
  const actualTitle = canonicalTitle(actual);
  if (expectedTitle === actualTitle) return 2;
  if (expectedTitle.includes(actualTitle) || actualTitle.includes(expectedTitle)) return 1;
  return 0;
}

/** 去掉常见副标题和分隔符，让“赤峰七日游”和“赤峰七日游（草原线）”视为同一主标题。 */
function canonicalTitle(value: string): string {
  return value
    .replace(/[（(][^）)]*[）)]/gu, "")
    .replace(/[\s·・:：\-—_/]/gu, "")
    .trim();
}
