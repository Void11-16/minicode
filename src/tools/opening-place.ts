import { sameVisitName, visitNameAliases } from "./required-visits.ts";

const VENUE_TYPE = /(?:博物馆|博物院|纪念馆|美术馆|公园|风景名胜区|旅游景区|景区)$/;
const QUALIFIER = /^(.*?)\(([^()]+)\)$/;
const MUSEUM_CAMPUS = /^(.+?(?:博物馆|博物院|纪念馆|美术馆))([\p{Script=Han}]{1,10}(?:展馆|馆区|馆|院区|园区))$/u;
const SCENIC_CHILD = /^.+(?:风景名胜区|旅游景区|旅游区|风景区|景区)[-—·]\s*(.{2,})$/;
const CAMPUS = /^[\p{Script=Han}]{1,11}?[馆院园区](?=$|:|\d{1,2}:|参观|开放|营业|服务时间|开馆|闭馆|停止入|暂停开放)/u;

function nameKey(text: string): string {
  return text.normalize("NFKC").replace(/[ \t()]/g, "").replace(/([\u4e00-\u9fff]{2,3})省(?=博物(?:馆|院))/g, "$1");
}

function placeNames(name: string, city: string): string[] {
  const subject = nameKey(name), prefix = nameKey(city).replace(/市$/, "");
  const local = prefix && subject.startsWith(prefix) ? subject.slice(prefix.length).replace(/^市/, "") : subject;
  const names = [subject];
  if (subject !== local) {
    names.push(prefix + local, prefix + "市" + local);
    if (!/^(?:博物[馆院]|纪念馆|美术馆|公园|景区)(?:.{1,8}[馆院园区])?$/.test(local)) names.push(local);
  }
  const child = SCENIC_CHILD.exec(subject)?.[1];
  if (child) names.push(...(prefix ? [prefix + child, prefix + "市" + child] : [child]));
  return [...new Set(names.flatMap((value) => [value, value.replace(/(?:旅游景区|旅游区|景区)$/, "")]))].filter((value) => value.length >= 2);
}

function qualifiedPlace(name: string): { base: string; campus: string } | undefined {
  const text = name.normalize("NFKC");
  const match = QUALIFIER.exec(text) ?? MUSEUM_CAMPUS.exec(text);
  return match && /[馆院园区]$/.test(match[2]!) ? { base: match[1]!, campus: campusKey(match[2]!) } : undefined;
}

function campusKey(label: string): string {
  return nameKey(label).replace(/展馆$|馆区$/, "馆");
}

export function mentionsOpeningPlace(text: string, name: string, city: string): boolean {
  const source = nameKey(text);
  if (placeNames(name, city).some((alias) => source.includes(alias))) return true;
  const qualified = qualifiedPlace(name);
  if (!qualified) return false;
  return placeNames(qualified.base, city).some((base) => [
    qualified.campus, qualified.campus.replace(/馆$/, "展馆"), qualified.campus.replace(/馆$/, "馆区"),
  ].some((campus) => source.includes(base + campus)));
}

export function sameOpeningPlace(left: string, right: string, city?: string): boolean {
  const a = qualifiedPlace(left), b = qualifiedPlace(right);
  if (a && b) return a.campus === b.campus && sameVisitName(nameKey(a.base), nameKey(b.base), city);
  const child = SCENIC_CHILD.exec(nameKey(right))?.[1];
  if (child && sameVisitName(nameKey(left), child, city)) return true;
  return sameVisitName(nameKey(left), nameKey(right), city);
}

/** 标题或摘要可以用母馆名、已知别名和常见简称召回，取到正文后再确认归属。 */
export function matchesOpeningCandidate(title: string, snippet: string, name: string, city: string): boolean {
  const text = `${title}\n${snippet}`;
  if (mentionsOpeningPlace(text, name, city)) return true;
  const base = qualifiedPlace(name)?.base ?? QUALIFIER.exec(name.normalize("NFKC"))?.[1] ?? name;
  if (base !== name && (mentionsOpeningPlace(title, base, city)
    || (/开放|闭馆|参观|停止入/.test(snippet) && mentionsOpeningPlace(snippet, base, city)))) return true;
  if (visitNameAliases(base, city).some((alias) => mentionsOpeningPlace(text, alias, city))) return true;
  const full = nameKey(base), source = nameKey(title);
  const short = full.replace(VENUE_TYPE, "");
  if (short !== full && short.length >= 3 && source.includes(short)) return true;
  if (/博物[馆院]$/.test(full) && source.includes(full.replace(/[馆院]$/, full.endsWith("馆") ? "院" : "馆"))) return true;
  const museum = /^([\p{Script=Han}])[\p{Script=Han}]{1,5}博物[馆院]$/u.exec(full);
  if (!museum) return false;
  const abbreviation = `${museum[1]}博`;
  return new RegExp(`(?:^${abbreviation}(?:$|[\\s·:：-]|本馆|西馆|东馆|参观|开放|闭馆|预约)|[“「]${abbreviation}[”」])`).test(title.trim())
    || Boolean(city && nameKey(text).includes(nameKey(city).replace(/市$/, "")) && source.includes(abbreviation));
}

export function isOpeningVenueTitle(title: string, name: string, city: string): boolean {
  const base = qualifiedPlace(name)?.base ?? QUALIFIER.exec(name.normalize("NFKC"))?.[1] ?? name;
  return placeNames(base, city).some((value) => nameKey(title) === value) || sameOpeningPlace(title, name, city);
}

/** 只把原文明确声明的别名用于事实匹配。 */
export function declaredOpeningAlias(text: string, name: string, city: string): string | undefined {
  for (const subject of placeNames(name, city)) {
    const start = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alias = new RegExp(`${start}(?:以下简称|又称|亦称|简称|别称为?|原名为?)[“「『"]?([\\p{Script=Han}]{2,16})(?=[”」』"，,、。；;：:\\n]|$)`, "u")
      .exec(text.normalize("NFKC").replace(/[ \t()]/g, ""))?.[1];
    if (alias && alias !== subject && !/^(?:本馆|本院|本园|我馆|我院|景区|公园)$/.test(alias)) return alias;
  }
  return undefined;
}

export function openingCampusLabel(line: string, name: string, city: string): string | undefined {
  const base = qualifiedPlace(name)?.base;
  if (!base) return undefined;
  const text = nameKey(line.trim().normalize("NFKC").replace(/([馆院园区])\([\p{Script=Han}]{1,6}区\)/u, "$1"))
    .replace(/^(?:但|而|其中|(?:场馆名称|地点):)|^[一二三四五六七八九十\d]+[、.]/, "");
  const parent = placeNames(base, city).sort((a, b) => b.length - a.length).find((value) => text.startsWith(value));
  const label = CAMPUS.exec(parent ? text.slice(parent.length) : text)?.[0];
  if (!label || /^(?:每|逢|周|星期)|(?:开|闭|休|入)[馆园]$/.test(label)) return undefined;
  if (!parent && /^(?:本馆|本院|本园|本区|我馆|我院|全馆)$/.test(label) && text !== label && !text.startsWith(label + ":")) return undefined;
  return campusKey(label);
}

/** 母馆页面的馆区别直接限定事实，切到其他馆区后停止沿用目标馆区。 */
export function scopeOpeningCampus(title: string, body: string, name: string, city: string): { text: string; campus?: string } | undefined {
  const qualified = qualifiedPlace(name);
  if (!qualified) return { text: body };
  const { base, campus } = qualified;
  const hasParent = mentionsOpeningPlace(`${title}\n${body}`, base, city);
  let active = mentionsOpeningPlace(title, name, city) && !/[、与及和]/.test(title);
  const selected: string[] = [];
  const labelOf = (line: string) => hasParent ? openingCampusLabel(line, name, city) : undefined;
  for (const line of body.split(/[。！？；;\n]|(?=\s+(?:场馆名称|展览地址|场馆地址|开放时间|交通信息)\s*[:：])/)) {
    let statement = "";
    for (const part of line.split(/([，,])/)) {
      const label = labelOf(part);
      if (label) {
        if (active && statement) selected.push(statement);
        statement = "";
        active = label === campus;
      }
      statement += part;
    }
    if (active && statement.trim()) selected.push(statement);
  }
  return selected.length ? { text: selected.join("\n"), campus } : undefined;
}
