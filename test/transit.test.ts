import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanRoutesTool } from "../src/tools/transit.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function amapResponse(body: Record<string, unknown>): Response {
  return jsonResponse({ status: "1", infocode: "10000", ...body });
}

const GEOCODINGS: Record<string, string> = {
  灵隐寺: "120.096,30.240",
  西湖: "120.155,30.250",
  河坊街: "120.166,30.245",
};

test("plan_day_routes: 公交/地铁逐段规划并标记过长路段", async () => {
  setAmapKey("test-key", (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (parsed.hostname.includes("amap.com") && parsed.pathname.includes("place/text")) {
      // 地标解析走 POI 搜索（城市约束），不再依赖 geocode 的同名歧义
      const keywords = parsed.searchParams.get("keywords") ?? "";
      return amapResponse({
        pois: [{ id: "p1", name: keywords, type: "风景名胜", location: GEOCODINGS[keywords] }],
      });
    }
    if (parsed.hostname.includes("amap.com") && parsed.pathname.includes("geocode")) {
      const address = parsed.searchParams.get("address") ?? "";
      return amapResponse({ geocodes: [{ formatted_address: address, location: GEOCODINGS[address] }] });
    }
    if (parsed.pathname.includes("transit")) {
      // 灵隐寺→西湖 45 分钟；西湖→河坊街 80 分钟（应标记过长）
      const duration = parsed.searchParams.get("origin")?.startsWith("120.096") ? "2700" : "4800";
      return amapResponse({
        route: {
          transits: [{
            duration,
            walking_distance: "660",
            segments: [
              { walking: { distance: "660" }, bus: { buslines: [{ name: "地铁3号线(星桥--石马)" }] } },
              { walking: { distance: "30" }, bus: { buslines: [{ name: "7路(城站--灵隐)" }] } },
            ],
          }],
        },
      });
    }
    return amapResponse({});
  }) as typeof fetch);

  const tool = createPlanRoutesTool();
  const output = await tool.execute({ stops: ["灵隐寺", "西湖", "河坊街"], city: "杭州" });

  assert.match(output, /灵隐寺 → 西湖: 公交\/地铁约 45 分钟/);
  assert.match(output, /步行660米 → 地铁3号线 → 7路，步行共 660 米/);
  assert.match(output, /西湖 → 河坊街: 公交\/地铁约 80 分钟 ⚠️过长/);
  assert.match(output, /约 2 小时 5 分钟，其中 1 段过长/);

  setAmapKey(undefined);
});

test("plan_day_routes: 合计不足 1 小时时只显示分钟（41 分钟不写成 1 小时 41 分钟）", async () => {
  setAmapKey("test-key", (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (parsed.pathname.includes("place/text")) {
      const keywords = parsed.searchParams.get("keywords") ?? "";
      return amapResponse({
        pois: [{ id: "p1", name: keywords, type: "风景名胜", location: GEOCODINGS[keywords] }],
      });
    }
    if (parsed.pathname.includes("transit")) {
      // 单段 41 分钟：旧实现 Math.round(41/60) 会显示成"1 小时 41 分钟"
      return amapResponse({
        route: {
          transits: [{
            duration: "2460",
            walking_distance: "1180",
            segments: [
              { walking: { distance: "1180" }, bus: { buslines: [{ name: "衢州古城景区直通车A线" }] } },
            ],
          }],
        },
      });
    }
    return amapResponse({});
  }) as typeof fetch);

  const output = await createPlanRoutesTool().execute({ stops: ["灵隐寺", "西湖"], city: "杭州" });

  assert.match(output, /公交\/地铁约 41 分钟/);
  assert.match(output, /全天通勤合计约 41 分钟，节奏可行/);
  assert.doesNotMatch(output, /1 小时/);

  setAmapKey(undefined);
});

test("plan_day_routes: 未配置高德时降级 OSRM 驾车", async () => {
  setAmapKey(undefined);
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      const query = new URL(u).searchParams.get("q") ?? "";
      const coords: Record<string, [number, number]> = {
        灵隐寺: [120.096, 30.24],
        西湖: [120.155, 30.25],
      };
      const coordinate = coords[query] ?? [120.1, 30.2];
      return jsonResponse({
        features: [{
          properties: { name: query, state: "浙江省", country: "中国" },
          geometry: { coordinates: coordinate },
        }],
      });
    }
    if (u.includes("router.project-osrm.org")) {
      return jsonResponse({ code: "Ok", routes: [{ distance: 5200, duration: 960 }] });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createPlanRoutesTool(fetchFn);
  const output = await tool.execute({ stops: ["灵隐寺", "西湖"], city: "杭州" });

  assert.match(output, /灵隐寺 → 西湖: 驾车约 16 分钟/);
  assert.match(output, /距离 5\.2 公里/);
  assert.match(output, /未配置 amap_api_key，公交方案不可用/);
});

test("plan_day_routes: 地点数不足时提示", async () => {
  const tool = createPlanRoutesTool();
  const output = await tool.execute({ stops: ["灵隐寺"], city: "杭州" });
  assert.match(output, /至少需要 2 个地点/);
});
