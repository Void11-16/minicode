/** 只识别明确的主景区名称前缀，不按距离、热度或任意共有字词猜测归属。 */
export function scenicParentName(name: string): string | undefined {
  const explicit = /^(.{2,40}?)[-—·](.+)$/.exec(name);
  if (explicit && /(?:博物院|博物馆|公园|景区|旅游区|风景名胜区|文化园|长城|园|寺|宫|古城|古镇|遗址|山|湖)$/.test(explicit[1]!)) return explicit[1];
  const joined = /^(.{2,30}?(?:风景名胜区|历史文化街区|文化旅游区|旅游区|景区|博物院|博物馆))(.+)$/.exec(name);
  return joined?.[1];
}

/** 同一景区的内部点只算一个主目的地；保留原条目的时间、位置和证据检查。 */
export function scenicVisitKey(name: string, parentName?: string): string {
  return parentName ?? scenicParentName(name) ?? name;
}

/** 有真实主 POI 才归并；只返回子点时不能虚构主景区的坐标和证据。 */
export function groupScenicAttractions<T extends { readonly poi: { readonly name: string; readonly id?: string; readonly parent?: string } }>(entries: readonly T[]): Array<{ main: T; spots: readonly string[] }> {
  const mains = new Map(entries.map((entry) => [entry.poi.name, entry]));
  const byId = new Map(entries.filter((entry) => entry.poi.id !== undefined).map((entry) => [entry.poi.id!, entry]));
  const parents = new Map<string, Set<string>>();
  for (const entry of entries) {
    const parent = (entry.poi.parent ? byId.get(entry.poi.parent)?.poi.name : undefined) ?? scenicParentName(entry.poi.name);
    if (parent && parent !== entry.poi.name && mains.has(parent)) parents.set(entry.poi.name, new Set([...(parents.get(entry.poi.name) ?? []), parent]));
  }
  const rootName = (name: string): string => {
    const seen = new Set<string>(); let current = name;
    while (!seen.has(current)) {
      seen.add(current); const choices = parents.get(current);
      if (choices?.size !== 1) return current;
      current = [...choices][0]!;
    }
    return name; // 异常循环不猜测归属。
  };
  const groups = new Map<string, { main: T; spots: string[] }>();
  for (const entry of entries) {
    // 同一子点在多批POI中有的带parent、有的不带，仍只归到一个已确认主景区。
    const name = rootName(entry.poi.name);
    let group = groups.get(name);
    if (group === undefined) { group = { main: mains.get(name)!, spots: [] }; groups.set(name, group); }
    if (name !== entry.poi.name && !group.spots.includes(entry.poi.name)) group.spots.push(entry.poi.name);
  }
  return [...groups.values()];
}
