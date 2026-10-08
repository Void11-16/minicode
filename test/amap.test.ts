import assert from "node:assert/strict";
import { test } from "node:test";
import { AmapClient } from "../src/tools/amap.ts";
import { setAmapKey, getAmapClient } from "../src/tools/amap-access.ts";
import { geocodeLocation } from "../src/tools/geocoding.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { createStayTool } from "../src/tools/stay.ts";

function amapResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ status: "1", infocode: "10000", ...body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 构造高德 mock fetch：只响应 restapi.amap.com */
function amapOnlyFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (!parsed.hostname.includes("amap.com")) {
      throw new Error(`非高德请求不应发生: ${parsed.hostname}`);
    }
    return handler(parsed);
  }) as typeof fetch;
}

test("AmapClient: 错误 infocode 转可读信息", async () => {
  const fetchFn = amapOnlyFetch(() =>
    amapResponse({ status: "0", infocode: "10003", info: "DAILY_QUERY_OVER_LIMIT" }),
  );
  const client = new AmapClient({ apiKey: "k", fetchFn });

  await assert.rejects(() => client.geocode("杭州"), /日配额已用完/);

  // 10021 是并发/QPS 超限（不是 IP 白名单），文案必须能引导"稍后重试"
  const concurrent = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() => amapResponse({ status: "0", infocode: "10021", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" })),
  });
  await assert.rejects(() => concurrent.geocode("杭州"), /并发\/QPS 超限/);
});

test("AmapClient: geocode 解析坐标", async () => {
  const fetchFn = amapOnlyFetch(() =>
    amapResponse({
      geocodes: [{ formatted_address: "浙江省杭州市西湖区", location: "120.130396,30.259242" }],
    }),
  );
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const result = await client.geocode("杭州西湖");
  assert.ok(result !== null);
  assert.equal(result.formatted_address, "浙江省杭州市西湖区");
  assert.equal(result.location, "120.130396,30.259242");
});

test("AmapClient: POI 搜索带 biz_ext", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      pois: [{
        id: "p1", name: "雷峰塔", type: "风景名胜;风景名胜",
        location: "120.15,30.23", distance: "",
        biz_ext: { rating: "4.7", cost: "40" },
      }],
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const pois = await client.poiSearch("景点", { latitude: 30.27, longitude: 120.15 }, 10_000, "110000");

  assert.equal(pois.length, 1);
  assert.equal(pois[0].biz_ext?.rating, "4.7");
  assert.equal(requests[0].searchParams.get("types"), "110000");
  assert.match(requests[0].pathname, /\/v3\/place\/text/);
  assert.equal(requests[0].searchParams.get("extensions"), "all");
});

test("AmapClient: poiPhotos 提取名称匹配 POI 的照片", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      pois: [
        { id: "p1", name: "水亭门城墙", location: "118.8668,28.9621", photos: [{ title: "夜景", url: "https://img.example/1.jpg" }, { title: "城门", url: "https://img.example/2.jpg" }, { title: "空图", url: "" }] },
        { id: "p2", name: "别的店", location: "118.85,28.96", photos: [{ url: "https://img.example/x.jpg" }] },
      ],
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const photos = await client.poiPhotos("水亭门城墙", { latitude: 28.962, longitude: 118.867 });

  assert.deepEqual(photos, ["https://img.example/1.jpg", "https://img.example/2.jpg"]);
  assert.match(requests[0].pathname, /\/v3\/place\/text/);
});

test("AmapClient: poiPhotos 名称不匹配或无照片时返回空数组", async () => {
  const noMatch = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() =>
      amapResponse({ pois: [{ id: "p2", name: "别的店", location: "118.8,28.9", photos: [{ url: "https://img.example/x.jpg" }] }] }),
    ),
  });
  assert.deepEqual(await noMatch.poiPhotos("水亭门城墙", { latitude: 28.96, longitude: 118.87 }), []);

  const noPhotos = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() =>
      amapResponse({ pois: [{ id: "p3", name: "水亭门城墙", location: "118.8668,28.9621" }] }),
    ),
  });
  assert.deepEqual(await noPhotos.poiPhotos("水亭门城墙", { latitude: 28.96, longitude: 118.87 }), []);
});

test("AmapClient: 公交路径规划解析推荐方案", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      route: {
        // 第一条方案更慢且带多余换乘，应被跳过
        transits: [
          {
            duration: "5760",
            walking_distance: "1500",
            segments: [{ bus: { buslines: [{ name: "绕远线(a--b)" }] } }],
          },
          {
            duration: "4380",
            walking_distance: "830",
            segments: [
              { walking: { distance: "830" }, bus: { buslines: [{ name: "地铁1号线(湘湖--机场)" }] } },
              { walking: { distance: "20" }, bus: { buslines: [{ name: "103路(六公园--九溪)" }] } },
            ],
          },
        ],
      },
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const route = await client.transitRoute(
    { latitude: 30.25, longitude: 120.155 },
    { latitude: 30.24, longitude: 120.096 },
    "杭州",
  );

  assert.ok(route !== null);
  assert.equal(route.durationSec, 4380);
  assert.equal(route.walkingDistanceM, 830);
  // 短步行(20m)不进分段；线路名去掉括号内区间
  assert.deepEqual(route.segments, ["步行830米", "地铁1号线", "103路"]);
  assert.equal(requests[0].searchParams.get("city"), "杭州");
  assert.equal(requests[0].searchParams.get("origin"), "120.155,30.25");
});

test("AmapClient: poiSearchByName 城市内解析地标", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      pois: [
        { id: "p1", name: "重庆市合川区灵隐寺", location: "106.2,29.9" },
        { id: "p2", name: "灵隐寺", location: "120.096,30.240" },
      ],
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const poi = await client.poiSearchByName("灵隐寺", "杭州");

  assert.ok(poi !== null);
  assert.equal(poi.name, "重庆市合川区灵隐寺"); // API 排序，取首个
  assert.equal(poi.latitude, 29.9);
  assert.equal(requests[0].searchParams.get("city"), "杭州");
  assert.equal(requests[0].searchParams.get("keywords"), "灵隐寺");
});

test("geocodeLocation: 高德主源 + Photon 兜底", async () => {
  // 场景1: 高德成功
  setAmapKey("test-key", amapOnlyFetch(() =>
    amapResponse({ geocodes: [{ formatted_address: "浙江省杭州市", location: "120.2,30.24" }] }),
  ));
  const geo = await geocodeLocation("高德专用测试地名");
  assert.ok(geo !== null);
  assert.equal(geo.country, "中国");
  assert.equal(geo.longitude, 120.2);

  // 场景2: 高德失败（配额）→ 降级 Photon
  setAmapKey("quota-key", amapOnlyFetch(() =>
    amapResponse({ status: "0", infocode: "10003" }),
  ));
  const fallback = await geocodeLocation("另一个专用地名", (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      return new Response(JSON.stringify({
        features: [{ properties: { name: "结果", state: "S", country: "C" }, geometry: { coordinates: [1, 2] } }],
      }));
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch);
  assert.ok(fallback !== null);
  assert.equal(fallback.latitude, 2);

  // 清理全局状态
  setAmapKey(undefined);
});

test("search_attractions: 高德路径（含评分与自算距离）", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) {
      return amapResponse({
        geocodes: [{ formatted_address: "浙江省杭州市西湖区", location: "120.130396,30.259242" }],
      });
    }
    if (url.pathname.includes("place")) {
      return amapResponse({
        pois: [
          { id: "a", name: "雷峰塔", type: "风景名胜;风景名胜", location: "120.1500,30.2310", biz_ext: { rating: "4.7" }, address: "南山路15号" },
          { id: "b", name: "断桥残雪", type: "风景名胜;观景点", location: "120.1400,30.2600", address: "北山街" },
        ],
      });
    }
    return amapResponse({});
  }));

  // 用独立 fetch 保证 geocodeLocation 也走高德 mock（不走真实网络）
  // 注意: geocoding 模块读全局 amap client，fetchFn 参数只影响 Photon 兜底
  const tool = createAttractionsTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ location: "杭州西湖", radius_km: 10, limit: 5 });

  assert.match(output, /高德数据/);
  assert.match(output, /雷峰塔 \| 风景名胜;风景名胜 \| 距中心 \d+\.\d 公里 \| 评分 4\.7 \| 南山路15号/);
  assert.match(output, /断桥残雪/);

  setAmapKey(undefined);
});

test("search_stays: 高德路径（含评分与参考价）", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) {
      return amapResponse({
        geocodes: [{ formatted_address: "浙江省杭州市", location: "120.209,30.246" }],
      });
    }
    if (url.pathname.includes("place")) {
      return amapResponse({
        pois: [
          { id: "h1", name: "杭州君悦酒店", type: "住宿服务;星级酒店", location: "120.1600,30.2500", biz_ext: { rating: "4.8", cost: "1200" }, address: "湖滨路28号" },
        ],
      });
    }
    return amapResponse({});
  }));

  const tool = createStayTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /高德数据/);
  assert.match(output, /杭州君悦酒店/);
  assert.match(output, /评分 4\.8/);
  assert.match(output, /参考价 ¥1200起/);

  setAmapKey(undefined);
});

test("未配置 Key 时 getAmapClient 返回 undefined", () => {
  setAmapKey(undefined);
  assert.equal(getAmapClient(), undefined);
});

test("search_stays: 高德结果按评分降序，无评分沉底", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) {
      return amapResponse({ geocodes: [{ formatted_address: "浙江省杭州市", location: "120.1600,30.2500" }] });
    }
    if (url.pathname.includes("place")) {
      // API 故意乱序：无评分在前、4.2 中间、4.8 最后
      return amapResponse({
        pois: [
          { id: "h1", name: "无评分宾馆", type: "住宿服务;宾馆", location: "120.1600,30.2500" },
          { id: "h2", name: "普通连锁酒店", type: "住宿服务;酒店", location: "120.1700,30.2600", biz_ext: { rating: "4.2", cost: "300" } },
          { id: "h3", name: "高分君悦", type: "住宿服务;星级酒店", location: "120.1500,30.2400", biz_ext: { rating: "4.8", cost: "1200" } },
        ],
      });
    }
    return amapResponse({});
  }));

  const tool = createStayTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /按评分排序/);
  // 4.8 最前、4.2 次之、无评分沉底
  assert.ok(output.indexOf("高分君悦") < output.indexOf("普通连锁酒店"));
  assert.ok(output.indexOf("普通连锁酒店") < output.indexOf("无评分宾馆"));

  setAmapKey(undefined);
});

test("AmapClient: 方向 API 解析路径几何点串", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      route: {
        paths: [{
          distance: "1850",
          duration: "900",
          steps: [
            { polyline: "118.860000,28.960000;118.862000,28.961000" },
            { polyline: "118.865000,28.962000;118.868000,28.963000" },
          ],
        }],
      },
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const route = await client.directionRoute(
    "walking",
    { latitude: 28.96, longitude: 118.86 },
    { latitude: 28.963, longitude: 118.868 },
  );

  assert.ok(route !== null);
  assert.equal(route.distanceM, 1850);
  assert.equal(route.durationSec, 900);
  // 两段 step 拼接 + lng,lat 转 lat,lng
  assert.deepEqual(route.points, [
    [28.96, 118.86],
    [28.961, 118.862],
    [28.962, 118.865],
    [28.963, 118.868],
  ]);
  assert.match(requests[0].pathname, /\/v3\/direction\/walking/);

  // 无方案 → null
  const empty = new AmapClient({ apiKey: "k", fetchFn: amapOnlyFetch(() => amapResponse({ route: { paths: [] } })) });
  assert.equal(await empty.directionRoute("driving", { latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }), null);
});
