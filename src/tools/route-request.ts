export const ROUTE_MODES = ["auto", "transit", "walking", "driving"] as const;
export type RouteMode = typeof ROUTE_MODES[number];

/** 旧调用省略mode仍兼容；模型定义要求显式选择，混合路线按每一段分别查询。 */
export function routeModes(args: Record<string, unknown>, count: number): RouteMode[] {
  const mode = args.mode ?? "auto";
  if (!ROUTE_MODES.includes(mode as RouteMode)) throw new Error("无效的 mode");
  if (args.leg_modes === undefined) return Array.from({ length: count }, () => mode as RouteMode);
  if (!Array.isArray(args.leg_modes) || args.leg_modes.length !== count || args.leg_modes.some((v) => !ROUTE_MODES.includes(v))) throw new Error("leg_modes 必须为 stops数量减1 个有效交通方式");
  return args.leg_modes as RouteMode[];
}

/** 明确下一次应查的端点和方式，避免再次使用默认公交获得相同的错误候选。 */
export function routeQueryHint(city: string | undefined, from: string | undefined, to: string | undefined, mode?: string): string {
  if (!from || !to) return "请提供明确起终点，或引用对应路线ID";
  const selected = mode === "taxi" ? "driving" : mode;
  if (selected && !ROUTE_MODES.includes(selected as RouteMode)) return `当前方式 ${selected} 暂不支持路线核验，请选择实际可用方式`;
  return `请调用 plan_day_routes(${JSON.stringify({ city: city ?? "请填写城市", stops: [from, to], mode: selected ?? "transit" })})，引用返回ID后重新保存`;
}
