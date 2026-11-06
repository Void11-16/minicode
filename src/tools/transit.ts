import type { RouteEvidence } from "./travel-evidence.ts";
import { routeModes } from "./route-request.ts";
import { convertPoint } from "./coordinates.ts";
import { cancellableFetch } from "./travel-request.ts";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";
import { haversineKm } from "./geo.ts";
import { geocodeLocation, type GeoResult } from "./geocoding.ts";
import { getAmapClient } from "./amap-access.ts";
import { fetchOsrmRoute } from "./route.ts";
import { isRemoteDayTravel, REMOTE_DAY_TEMPLATE } from "./remote-day-policy.ts";

import type { RouteGeometry } from "./amap.ts";

type FetchLike = typeof fetch;

interface LegResult {
  readonly from: string;
  readonly to: string;
  readonly mode: string;
  readonly durationMin: number;
  readonly distanceKm: number;
  readonly detail: string;
  readonly estimated: boolean;
  readonly geometry?: RouteGeometry;
}

/** 单段通勤超过该分钟数时提示预留交通与缓冲，不直接要求删点或换住宿 */
const LONG_LEG_MINUTES = 60;

/**
 * 一天行程的通勤规划：按访问顺序对相邻地点逐段计算
 * 公交/地铁（高德）→ 驾车（OSRM）→ 直线距离估算 的降级链，
 * 输出每段方式与耗时、全天通勤合计，并标记过长路段。
 */
export function createPlanRoutesTool(fetchFn: FetchLike = fetch): Tool {
  return {
    name: "plan_day_routes",
    alwaysActive: "travel",
    description:
      "规划行程中相邻地点之间的通勤：按访问顺序传入地点列表，逐段返回交通方式（公交/地铁优先，" +
      "降级驾车）与耗时、步行距离、全天通勤总时长，并标记超过 60 分钟的路段。" +
      "识别到远郊日时同时返回专用规划模板。生成或调整行程顺序后必须调用它验证可行性，" +
      "先明确交通方式；步行必须mode=walking，混合日程用leg_modes逐段指定，避免拆成多次调用。auto只表示公交优先、驾车替代候选，不会自动查步行。返回替代方案时需明确选择实际方式，再引用对应ID保存。",
    parameters: {
      type: "object",
      properties: {
        stops: {
          type: "array",
          items: { type: "string" },
          description: "按访问顺序排列的地点名，例如：[\"灵隐寺\", \"西湖\", \"河坊街\"]",
        },
        mode: { type: "string", enum: ["auto", "transit", "walking", "driving"], description: "显式选择计划方式；walking查步行，transit查公交。auto仅公交优先，驾车降级是待选择的替代候选。" },
        leg_modes: { type: "array", items: { type: "string", enum: ["auto", "transit", "walking", "driving"] }, description: "可选，每段的方式，长度=stops.length-1；覆盖mode，可一次核验公交+步行混合路线。" },
        refresh: { type: "boolean", description: "明确需要重查已过时交通时使用；默认复用有效路段。" },
        city: { type: "string", description: "所在城市（公交/地铁规划需要），例如：杭州" },
      },
      required: ["stops", "city", "mode"],
    },
    async execute(args, ctx) {
      ctx?.signal?.throwIfAborted();
      const request = cancellableFetch(fetchFn, ctx?.signal);
      const stops = (Array.isArray(args.stops) ? args.stops : [])
        .filter((stop): stop is string => typeof stop === "string" && stop.trim() !== "")
        .map((stop) => stop.trim());
      if (stops.length < 2) {
        return "至少需要 2 个地点才能规划通勤（stops 按访问顺序传入）。";
      }
      const city = requireString(args, "city");
      const modes = routeModes(args, stops.length - 1);

      await ctx?.evidence?.load();
      const needsPointEvidence = stops.filter((stop) => !ctx?.evidence?.point(stop, city));
      const locations: GeoResult[] = [];
      const missing: string[] = [];
      // 并行 geocode：顺序等待最坏 N×15s（超时叠加），并行只需最慢那一个
      const results = await Promise.all(
        stops.map((stop) => ctx?.evidence?.point(stop, city) ?? geocodeLocation(stop, request, city, ctx?.signal).catch(() => { ctx?.signal?.throwIfAborted(); return null; })),
      );
      results.forEach((geo, index) => {
        if (geo === null) missing.push(stops[index]);
        else locations.push(geo);
      });
      if (missing.length > 0) {
        return `未找到地点: ${missing.join("、")}。请更换更具体的名称后重试。`;
      }

      const legs: LegResult[] = [];
      const cachedEvidence: Array<RouteEvidence | undefined> = [];
      for (let i = 0; i < locations.length - 1; i++) {
        const mode = modes[i]!;
        const cached = args.refresh === true ? undefined : ctx?.evidence?.routeForPlanning(stops[i]!, stops[i + 1]!, city, mode, locations[i]!, locations[i + 1]!);
        cachedEvidence.push(cached);
        legs.push(cached ? { from: stops[i]!, to: stops[i + 1]!, mode: cached.mode === "transit" ? "公交/地铁" : cached.mode === "walking" ? "步行" : "驾车",
          durationMin: cached.duration_min, distanceKm: cached.distance_km, detail: `${cached.detail ?? "复用已核验路线"}（路段缓存）`, estimated: false, geometry: cached.geometry }
          : await planLeg(locations[i]!, locations[i + 1]!, city, request, mode, ctx?.signal));
      }

      const lines = legs.map((leg, index) => {
        const flag = leg.durationMin > LONG_LEG_MINUTES ? " ⚠️长通勤，请预留真实交通与缓冲时间" : "";
        const alternative = leg.mode === "驾车" && ["auto", "transit"].includes(modes[index]!) ? " 【驾车替代候选：公交未取得可用方案；选择驾车后引用此ID，计划步行则改查walking】" : "";
        return `${index + 1}. ${leg.from} → ${leg.to}: ${leg.mode}约 ${Math.round(leg.durationMin)} 分钟${leg.estimated ? "（估算）" : ""}${flag}${alternative}\n   ${leg.detail}`;
      });
      const totalMin = legs.reduce((sum, leg) => sum + leg.durationMin, 0);
      const longCount = legs.filter((leg) => leg.durationMin > LONG_LEG_MINUTES).length;
      // 取整后按整体进位换算：41 分钟不能被 Math.round(41/60) 显示成"1 小时"
      const totalRounded = Math.round(totalMin);
      const totalLabelValue = totalRounded >= 60
        ? `${Math.floor(totalRounded / 60)} 小时 ${totalRounded % 60} 分钟`
        : `${totalRounded} 分钟`;
      const summary = longCount > 0
        ? `全天通勤合计约 ${totalLabelValue}，其中 ${longCount} 段长通勤，请结合当天可用时间安排。`
        : `全天通勤合计约 ${totalLabelValue}，节奏可行。`;
      const remoteGuidance = isRemoteDayTravel(
        legs.map((leg) => ({
          distance_km: leg.distanceKm,
          planned_duration_min: leg.durationMin,
        })),
      )
        ? `\n\n远郊日模板已触发。${REMOTE_DAY_TEMPLATE}`
        : "";

      const fresh = legs.flatMap((leg, i) => cachedEvidence[i] ? [] : [{ city, from_point: locations[i], to_point: locations[i + 1], from: stops[i]!, to: stops[i + 1]!,
        request_mode: modes[i] === "auto" ? "transit" : modes[i], detail: leg.detail,
        mode: leg.mode === "公交/地铁" ? "transit" : leg.mode === "步行" ? "walking" : "driving", duration_min: Math.ceil(leg.durationMin), distance_km: leg.distanceKm, estimated: leg.estimated,
        ...(leg.geometry === undefined ? {} : { geometry: leg.geometry }) }]);
      const observed = fresh.length ? await ctx?.evidence?.observeRoutes(fresh) : [];
      let next = 0;
      const evidence = ctx?.evidence === undefined ? undefined : legs.map((_, i) => cachedEvidence[i] ?? observed![next++]!);

      const endpoints = ctx?.evidence ? needsPointEvidence.map((name) =>
        ctx.evidence!.bind({ id: "route-endpoint", type: "visit", name }, city)).filter((item) => item.evidence_verified) : [];
      const endpointText = endpoints.length ? "\n已核验路线端点坐标（不提供评分或开放信息）：\n" +
        endpoints.map((item) => `${item.name}: ${item.evidence_id} / 坐标 ${item.location!.latitude},${item.location!.longitude}`).join("\n") : "";
      const evidenceText = evidence === undefined ? "" : `\n路线证据（transport引用route_evidence_id即可回填起终点、方式和基础耗时；显式不同意图不会覆盖）：\n${evidence.map((e) => `${e.from} → ${e.to}: ${e.id} / ${e.duration_min}分钟 / ${e.mode}`).join("\n")}`;
      const legacy = args.mode === undefined ? "兼容旧调用：本次省略mode按auto处理；下一次请显式指定方式。\n" : "";
      const saveHint = "下一步: 查询仅更新路线证据，尚未修改行程。已保存日期用save_itinerary({title,repair_routes:[受影响日期]})本地绑定和修复时间；等待保存成功版本，不重复查同一路线。";
      return `${legacy}${city} 行程通勤规划（${stops.length} 个地点，${legs.length} 段）:\n${lines.join("\n")}\n${summary}${remoteGuidance}${evidenceText}${endpointText}\n${saveHint}`;
    },
  };
}

/** 单段通勤：公交/地铁 → 驾车 → 直线距离估算 */
async function planLeg(
  from: GeoResult,
  to: GeoResult,
  city: string,
  fetchFn: FetchLike,
  preferred: string = "auto",
  signal?: AbortSignal,
): Promise<LegResult> {
  const origin = convertPoint(from, "wgs84"), destination = convertPoint(to, "wgs84");
  const distanceKm = haversineKm(origin.latitude, origin.longitude, destination.latitude, destination.longitude);
  const amap = getAmapClient(signal);
  if (preferred === "walking" || preferred === "driving") {
    if (amap !== undefined) {
      try {
        const route = await amap.directionRoute(preferred, from, to);
        if (route !== null && route.durationSec > 0) return { from: from.name, to: to.name, mode: preferred === "walking" ? "步行" : "驾车", durationMin: route.durationSec / 60, distanceKm: route.distanceM / 1000, detail: `真实道路距离 ${(route.distanceM / 1000).toFixed(1)} 公里（高德）`, estimated: false, geometry: route };
      } catch { signal?.throwIfAborted(); }
    }
    if (preferred === "walking") return { from: from.name, to: to.name, mode: "步行", durationMin: distanceKm / 4.5 * 60, distanceKm, detail: "步行路由不可用，仅为直线距离估算，不能作为已核验路线", estimated: true };
  }
  if (amap !== undefined && preferred !== "driving") {
    try {
      const transit = await amap.transitRoute(
        from,
        to,
        city,
      );
      if (transit !== null && transit.durationSec > 0) {
        const parts = transit.segments.length > 0 ? transit.segments.join(" → ") : "公交方案";
        return {
          from: from.name,
          to: to.name,
          mode: "公交/地铁",
          durationMin: transit.durationSec / 60,
          distanceKm: transit.geometry?.distanceM ? transit.geometry.distanceM / 1000 : distanceKm,
          detail: `${parts}，步行共 ${Math.round(transit.walkingDistanceM)} 米`,
          estimated: false,
          ...(transit.geometry === undefined ? {} : { geometry: transit.geometry }),
        };
      }
    } catch {
    signal?.throwIfAborted();
      // 公交无方案或服务失败 → 降级驾车
    }
  }

  try {
    const route = await fetchOsrmRoute(from, to, "driving", fetchFn, true);
    return {
      from: from.name,
      to: to.name,
      mode: "驾车",
      durationMin: route.durationSec / 60,
      distanceKm: route.distanceM / 1000,
      detail: `距离 ${(route.distanceM / 1000).toFixed(1)} 公里${amap === undefined ? "（未配置 amap_api_key，公交方案不可用）" : ""}`,
      estimated: false,
      ...(route.geometry === undefined ? {} : { geometry: route.geometry }),
    };
  } catch {
    signal?.throwIfAborted();
    // OSRM 也失败 → 直线距离按 40km/h 估算
    return {
      from: from.name,
      to: to.name,
      mode: "驾车",
      durationMin: (distanceKm / 40) * 60,
      distanceKm,
      detail: `直线 ${distanceKm.toFixed(1)} 公里，按 40km/h 估算（路由服务不可用）`,
      estimated: true,
    };
  }
}
