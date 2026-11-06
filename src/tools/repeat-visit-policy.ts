import type { Itinerary, PlannedVisit, RepeatVisitPermission } from "./itinerary-schema.ts";
import { requiredVisitMatches } from "./required-visits.ts";

export interface UserRequest { readonly id: string; readonly content: string }

/** 只接受明确重游表达；摄影、日夜景偏好和模型解释均不等于授权。 */
function decision(quote: string, name: string, city = ""): "allow" | "deny" | undefined {
  if (/^(?:模型|工具|旧方案|之前方案|它|系统).{0,20}(?:说|声称|解释|建议|写|标注)/.test(quote)) return undefined;
  if (/[，,]/.test(quote)) {
    let result: "allow" | "deny" | undefined;
    for (const clause of quote.split(/[，,]/)) result = decision(clause.trim(), name, city) ?? result;
    return result;
  }
  const names = [name, city ? name.replace(new RegExp(`^${city.replace(/市$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:市)?`), "") : name];
  const aliases = new Set(names);
  for (const alias of names) {
    const short = alias.replace(/(?:博物院|博物馆|公园|音乐喷泉)$/, "");
    if (short.length >= 2) aliases.add(short);
  }
  if (![...aliases].some((alias) => alias.length >= 2 && quote.includes(alias))) return undefined;
  if (/(?:不要|不想|不再|不允许|不能|不准|不许|不接受|禁止|避免|取消|撤销|并未|没说(?:过)?|没有说(?:过)?|未授权|没有要求).{0,20}(?:重游|复访|重复|再去|再游|再次|多次|两天|跨日)/.test(quote)) return "deny";
  if (/[?？]\s*$/.test(quote) && !/(?:我想|我希望|请安排|请把)/.test(quote)) return undefined;
  const request = /(?:^|[，,：:])\s*(?:我(?:还)?(?:允许|同意|接受|希望|想|要)|请(?:安排|把)?|允许|同意|接受|希望|想|安排|可以).{0,50}(?:重游|复访|重复(?:游览|参观|去)?|再去|再游|再次(?:去|参观|游览)|多次(?:去|游览)|两天都去|跨日(?:深度)?游览)/;
  const namedImperative = [...aliases].some((alias) => quote.startsWith(alias) && /^(?:再去|重游|复访).{0,10}(?:一次|一遍|两次)/.test(quote.slice(alias.length).trim()));
  if (request.test(quote) || namedImperative || /^(?:第[一二三四五六七八九十\d]+天|D\d+)\s*(?:也|还)?再去/.test(quote)
    || /^(?:允许重复景点|允许重游景点)\s*[:：]/.test(quote)) return "allow";
  return undefined;
}

/** 授权只取真实用户消息和先前由程序保存的授权，忽略本次模型参数。 */
export function resolveRepeatPermissions(plan: Itinerary, saved: Itinerary | null, requests: readonly UserRequest[] = []): RepeatVisitPermission[] {
  const city = plan.constraints?.destination ?? "", permissions = new Map<string, RepeatVisitPermission>();
  for (const permission of saved?.constraints?.destination === city ? saved.constraints.repeat_visit_permissions ?? [] : []) if (decision(permission.user_quote, permission.name, city) === "allow") permissions.set(permission.name, permission);
  const names = new Set([...permissions.keys(), ...plan.days.flatMap((day) => day.items.filter((item) => item.type === "visit").flatMap((item) => [item.name, ...(item.parent_visit ? [item.parent_visit.name] : [])])), ...(plan.outline ?? []).flatMap((day) => day.visits.flatMap((visit) => [visit.name, ...(visit.parent_visit ? [visit.parent_visit.name] : [])]))]);
  for (const request of requests) for (const raw of request.content.match(/[^。！？!?\n;；]+[。！？!?;；]?/g) ?? []) {
    const quote = raw.trim(); if (!quote || quote.length > 500) continue;
    if (/^(?:我)?(?:不允许|禁止|取消|撤销|不要)\s*(?:(?:任何|所有|全部|跨日|跨天)\s*)?(?:重复|重游|复访)(?:安排|景点|游览)?(?:任何|所有|全部)?(?:景点|地点)?[。！!]?\s*$/.test(quote)) { permissions.clear(); continue; }
    for (const name of names) {
      const result = decision(quote, name, city);
      if (result === "deny") permissions.delete(name);
      else if (result === "allow") permissions.set(name, { name, user_message_id: request.id, user_quote: quote });
    }
  }
  return [...permissions.values()].slice(0, 100);
}

export function repeatVisitAllowed(plan: Pick<Itinerary, "constraints">, visit: PlannedVisit): boolean {
  return (plan.constraints?.repeat_visit_permissions ?? []).some((permission) => decision(permission.user_quote, permission.name, plan.constraints?.destination) === "allow"
    && requiredVisitMatches(permission.name, visit.name, plan.constraints?.destination));
}
