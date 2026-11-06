import { otherOpeningSubject } from "./opening-schedule.ts";

/** 升级时废弃旧提取规则生成的“已核验”缓存和行程标记。 */
export const CLOSURE_POLICY_VERSION = 4;

export interface ClosureSource {
  readonly url?: string;
  readonly title: string;
  readonly snippet: string;
  readonly engine?: string;
}

/** 只接收外部结果字段；工具标题、查询回显、无结果提示不能成为事实。 */
export function extractClosure(name: string, sources: readonly ClosureSource[]) {
  const statements = sources.filter((s) => s.title.includes(name) || s.snippet.includes(name))
    .flatMap((s) => `${s.title}。${s.snippet}`.split(/[。！？；\n]/)).filter((line) => line && !otherOpeningSubject(line, name));
  const holidayPattern = /除(?:国家)?法定节?假日(?:外|除外)|(?:国家)?法定节?假日除外/g;
  const holidayException = statements.some((line) => { holidayPattern.lastIndex = 0; return holidayPattern.test(line); });
  const ordinary = statements.map((line) => line.replace(holidayPattern, ""));
  const conditional = ordinary.some((line) => /并非|不是|并不|不再|不闭馆|不休馆|正常开放|照常开放|非每?周|取消|曾经|此前|原定|原为|旧公告|改为|调整|除外|例外|节假日|法定假日/.test(line));
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const found = statements.flatMap((line) => [...line.matchAll(/(?:每周|逢周|星期|周)([一二三四五六日天])(?:例行|全天)?(?:休馆|闭馆|闭店)/g)]
    .map((m) => weekdays[Math.min(6, "一二三四五六日天".indexOf(m[1]!))]!));
  // “全年开放”只说明季节范围，不说明每周七天开放。
  const noClosure = statements.some((line) => /全年无休|无固定闭馆日|每周七天(?:均|都)?开放/.test(line));
  const verified = !conditional && !(found.length && noClosure) && (found.length > 0 || noClosure);
  return { verified: Boolean(verified), mentioned: conditional || found.length > 0 || noClosure, holiday_exception: verified && holidayException, closed_on: verified ? [...new Set(found)] : [] };
}
