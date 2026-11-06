import type { Itinerary } from "./itinerary-schema.ts";
import type { QualityIssue } from "./itinerary-validator.ts";

function key(name: string, city?: string): string {
  let value = name.replace(/\s+/g, "").toLowerCase();
  if (city) value = value.replace(new RegExp(`^${city.replace(/市$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:市)?`), "");
  return value.replace(/^中国/, "").replace(/^(.{2,3})省(?=博物(?:馆|院)$)/, "$1");
}

function shortName(name: string): string { return name.replace(/(?:博物院|博物馆|公园|风景名胜区|旅游景区|旅游区|景区)$/, ""); }

export function sameVisitName(left: string, right: string, city?: string): boolean {
  const target = key(left, city), name = key(right, city);
  return target !== "" && name !== "" && (target === name || target === shortName(name) || shortName(target) === name);
}

// 西安同一主景点的常用检索名和地图规范名，明确的坑、展厅和丽山园不在此集合。
const XIAN_TERRACOTTA_ALIASES = new Set(["兵马俑", "秦兵马俑", "秦始皇兵马俑", "兵马俑博物馆", "秦始皇兵马俑博物馆", "秦始皇帝陵博物院"]);

/** 主景区泛称可由明确对应的主景区满足，内部子点、餐厅和仅外观不替代游览。 */
export function requiredVisitMatches(required: string, actual: string, city?: string): boolean {
  const target = key(required, city), name = key(actual, city);
  if (sameVisitName(required, actual, city)) return true;
  if (city?.replace(/市$/, "") === "西安" && XIAN_TERRACOTTA_ALIASES.has(target) && XIAN_TERRACOTTA_ALIASES.has(name)) return true;
  return ["长城", "草原", "海滩", "古城", "古镇"].includes(target) && shortName(name).endsWith(target) && !/[-—·（(]/.test(name);
}

export function requiredVisitIssues(itinerary: Itinerary): QualityIssue[] {
  const visits = itinerary.days.flatMap((day) => day.items.filter((item) => item.type === "visit"));
  const required = [...new Set(itinerary.constraints?.must_visit ?? [])];
  return required.flatMap((name): QualityIssue[] => {
    if (visits.some((item) => requiredVisitMatches(name, item.name, itinerary.constraints?.destination))) return [];
    const similar = visits.some((item) => item.name.includes(name) || name.includes(item.name));
    return [{ level: "P1", code: similar ? "uncertain-required-visit" : "missing-required-visit", kind: similar ? "pending" : "error",
      message: similar ? `必去「${name}」只有名称相近或子景点安排，尚不能确认已满足主景区要求` : `缺少必去景点「${name}」，请补充游览安排` }];
  });
}
