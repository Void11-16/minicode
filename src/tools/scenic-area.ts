/** 城区级旅游片区的地理包含关系不足以证明内部场馆属于同一次游览。 */
export function isTourismDistrict(name: string): boolean {
  return /(?:古城|城区|片区|街区)(?:文化)?旅游区$/.test(name);
}

/** 地理范围可以包含多个独立游览目的地，不能共享一次 visit 的占用。 */
export function isGeographicArea(name: string, placeType?: string): boolean {
  return isTourismDistrict(name) || /(?:风景名胜区|风景区|历史文化街区|文化旅游区|旅游度假区|生态旅游区|自然保护区|国家公园)$/.test(name)
    || /地名地址信息|行政地名|旅游度假区|历史文化街区|商业街|步行街/.test(placeType ?? "");
}

/** 只识别明确的主景区名称前缀，不按距离、热度或任意共有字词猜测归属。 */
export function scenicParentName(name: string): string | undefined {
  const explicit = /^(.{2,40}?)[-—·](.+)$/.exec(name);
  if (explicit && !isGeographicArea(explicit[1]!) && /(?:博物院|博物馆|公园|景区|旅游区|风景名胜区|文化园|长城|园|寺|宫|古城|古镇|遗址|山|湖)$/.test(explicit[1]!)) return explicit[1];
  // 连写的旅游区/街区常是地图上的片区前缀，不能据此把不同独立场馆归为同一游览。
  // 无分隔符的景区包含关系由 POI parent/已核验证据提供；馆内展点继续支持馆名前缀。
  const joined = /^(.{2,30}?(?:博物院|博物馆))(.+)$/.exec(name);
  return joined?.[1];
}

/** 同一景区的内部点只算一个主目的地；保留原条目的时间、位置和证据检查。 */
export function scenicVisitKey(name: string, parentName?: string): string {
  return (parentName && !isGeographicArea(parentName) ? parentName : undefined) ?? scenicParentName(name) ?? name;
}

/** 主目的地的展示/数量口径；区域内的实际停留点仍各自接受时间、路线和证据检查。 */
export function mainDestinationKey(name: string, parentName?: string, areaName?: string): string {
  return areaName ?? scenicVisitKey(name, parentName);
}

/** 有真实主 POI 才归并；只返回子点时不能虚构主景区的坐标和证据。 */
export function groupScenicAttractions<T extends { readonly poi: { readonly name: string; readonly id?: string; readonly parent?: string; readonly type?: string } }>(entries: readonly T[]): Array<{ main: T; spots: readonly string[]; area_spots: readonly string[]; area_group?: string }> {
  const mains = new Map(entries.map((entry) => [entry.poi.name, entry]));
  const isArea = (name: string) => isGeographicArea(name, mains.get(name)?.poi.type);
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
      if (isArea([...choices][0]!)) return current;
      current = [...choices][0]!;
    }
    return name; // 异常循环不猜测归属。
  };
  const groups = new Map<string, { main: T; spots: string[]; area_spots: string[]; area_group?: string }>();
  for (const entry of entries) {
    // 同一子点在多批POI中有的带parent、有的不带，仍只归到一个已确认主景区。
    const name = rootName(entry.poi.name);
    let group = groups.get(name);
    if (group === undefined) { group = { main: mains.get(name)!, spots: [], area_spots: [] }; groups.set(name, group); }
    if (name !== entry.poi.name && !group.spots.includes(entry.poi.name)) group.spots.push(entry.poi.name);
  }
  for (const entry of entries) {
    const seen = new Set<string>(); let current = entry.poi.name;
    while (!seen.has(current)) {
      seen.add(current); const choices = parents.get(current);
      if (choices?.size !== 1) break;
      const parent = [...choices][0]!;
      if (isArea(parent)) {
        const area = groups.get(parent), child = groups.get(rootName(entry.poi.name));
        if (area && !area.area_spots.includes(entry.poi.name)) area.area_spots.push(entry.poi.name);
        if (child && !child.area_group) child.area_group = parent;
      }
      current = parent;
    }
  }
  return [...groups.values()];
}
