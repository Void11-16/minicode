import assert from "node:assert/strict";
import { test } from "node:test";
import { AmapClient, formatPoiCoordinates } from "../src/tools/amap.ts";
import { setAmapKey, getAmapClient } from "../src/tools/amap-access.ts";
import { geocodeInCity, geocodeLocation, regionMatchesCity } from "../src/tools/geocoding.ts";
import { createGeocodeTool } from "../src/tools/geo.ts";
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

test("AmapClient: 并行请求被全局闸门串行化（避免整批撞 10021）", async () => {
  let active = 0;
  let peak = 0;
  const fetchFn = (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    assert.ok(parsed.hostname.includes("amap.com"));
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return amapResponse({ geocodes: [{ formatted_address: "杭州", location: "120.15,30.27" }] });
  }) as typeof fetch;

  const client = new AmapClient({ apiKey: "k", fetchFn });
  const results = await Promise.all([client.geocode("a"), client.geocode("b"), client.geocode("c")]);

  assert.equal(results.length, 3);
  assert.equal(peak, 1, "同一时刻只应有一个高德请求在途");
});

test("AmapClient: 撞到 10021 先退避重试一次，别整条链路降级到 OSM", async () => {
  let calls = 0;
  const client = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() => {
      calls += 1;
      if (calls === 1) {
        return amapResponse({ status: "0", infocode: "10021", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" });
      }
      return amapResponse({ geocodes: [{ formatted_address: "杭州", location: "120.15,30.27" }] });
    }),
  });

  const result = await client.geocode("杭州");

  assert.equal(result?.formatted_address, "杭州");
  assert.equal(calls, 2, "10021 应重试一次");
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

test("AmapClient: poiPhotos 命中多个名称时挑最像的 POI（不吃泛化结果）", async () => {
  const client = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() =>
      amapResponse({
        pois: [
          { id: "p0", name: "博物馆", location: "118.9,42.2", photos: [{ url: "https://img.example/generic.jpg" }] },
          { id: "p1", name: "赤峰博物馆", location: "118.9,42.2", photos: [{ url: "https://img.example/exact.jpg" }] },
        ],
      }),
    ),
  });

  // 旧实现取首个命中 → 得到泛化「博物馆」的照片；现在精确同名优先
  assert.deepEqual(await client.poiPhotos("赤峰博物馆", { latitude: 42.2, longitude: 118.9 }), ["https://img.example/exact.jpg"]);
});

test("AmapClient: poiPhotos 允许带修饰词的别名（乌兰布统旅游景区-欧式风光区）", async () => {
  const client = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() =>
      amapResponse({
        pois: [
          { id: "p0", name: "乌兰布统旅游景区-欧式风光区", location: "117.15,42.54", photos: [{ url: "https://img.example/euro.jpg" }] },
          { id: "p1", name: "乌兰布统影视基地", location: "117.14,42.53", photos: [{ url: "https://img.example/studio.jpg" }] },
        ],
      }),
    ),
  });

  // 目标名不是别名子串，只做包含判断会漏掉；相似度兜底要能命中
  assert.deepEqual(await client.poiPhotos("乌兰布统欧式风光区", { latitude: 42.54, longitude: 117.15 }), ["https://img.example/euro.jpg"]);
});

test("AmapClient: poiPhotos 找不到相似地点时宁可不给图", async () => {
  const client = new AmapClient({
    apiKey: "k",
    fetchFn: amapOnlyFetch(() =>
      amapResponse({
        pois: [
          { id: "p0", name: "都趣壹号院酒店", location: "117.23,42.52", photos: [{ url: "https://img.example/hotel.jpg" }] },
          { id: "p1", name: "花栖堂民宿(乌兰布统草原景区店)", location: "117.23,42.52", photos: [{ url: "https://img.example/min-su.jpg" }] },
        ],
      }),
    ),
  });

  assert.deepEqual(await client.poiPhotos("乌兰布统红山军马场 民宿", { latitude: 42.52, longitude: 117.23 }), []);
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

test("AmapClient: poiSearchInCity 返回城市内 POI 候选（含省市字段）", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      pois: [
        { id: "p1", name: "灵隐寺停车场", location: "120.100,30.240", pname: "浙江省", cityname: "杭州市", adname: "西湖区" },
        { id: "p2", name: "灵隐寺", location: "120.096,30.240", pname: "浙江省", cityname: "杭州市", adname: "西湖区" },
        { id: "p3", name: "无坐标条目", location: "" },
      ],
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const pois = await client.poiSearchInCity("灵隐寺", "杭州");

  // 无坐标的条目（高德的泛化结果）被过滤，候选保持 API 顺序供上层校验
  assert.deepEqual(pois.map((poi) => poi.name), ["灵隐寺停车场", "灵隐寺"]);
  assert.equal(pois[1].cityname, "杭州市");
  assert.equal(requests[0].searchParams.get("city"), "杭州");
  assert.equal(requests[0].searchParams.get("keywords"), "灵隐寺");
  assert.match(requests[0].pathname, /\/v3\/place\/text/);
});

test("AmapClient: geocodeAll 返回多个候选（去重截断）", async () => {
  const requests: URL[] = [];
  const fetchFn = amapOnlyFetch((url) => {
    requests.push(url);
    return amapResponse({
      geocodes: [
        { formatted_address: "新疆维吾尔自治区五家渠市", location: "87.5,44.1", province: "新疆维吾尔自治区", city: "五家渠市" },
        { formatted_address: "新疆维吾尔自治区五家渠市", location: "87.5,44.1", province: "新疆维吾尔自治区", city: "五家渠市" },
        { formatted_address: "北京市西城区北海公园", location: "116.391802,39.928775", province: "北京市", city: "北京市" },
      ],
    });
  });
  const client = new AmapClient({ apiKey: "k", fetchFn });

  const results = await client.geocodeAll("北海公园", 3, "北京");

  assert.equal(results.length, 2); // 完全重复的条目被合并
  assert.equal(results[0].city, "五家渠市");
  assert.equal(requests[0].searchParams.get("city"), "北京");
});

test("geocodeInCity: 剔除省市字段对不上的外地同名 POI", async () => {
  // 实测：灵隐寺@浙江 仍可能返回重庆合川灵隐寺，必须靠 pname/cityname 校验兜底
  setAmapKey("test-key", amapOnlyFetch(() =>
    amapResponse({
      pois: [
        { id: "c1", name: "灵隐寺", location: "106.265,30.005", pname: "重庆市", cityname: "重庆市", adname: "合川区" },
        { id: "h1", name: "灵隐寺", location: "120.096,30.240", pname: "浙江省", cityname: "杭州市", adname: "西湖区" },
      ],
    }),
  ));

  const geo = await geocodeInCity("灵隐寺", "杭州");

  assert.ok(geo !== null);
  assert.equal(geo.longitude, 120.096);
  assert.equal(geo.latitude, 30.24);
  assert.equal(geo.admin2, "杭州市");
  assert.equal(geo.admin3, "西湖区");

  setAmapKey(undefined);
});

test("geocodeInCity: POI 附属设施排前面时仍选中目的地本体", async () => {
  // 实测：「水亭门历史文化街区」的首条是「…地下停车点」，降噪后应选中本体
  setAmapKey("test-key", amapOnlyFetch(() =>
    amapResponse({
      pois: [
        { id: "n1", name: "水亭门历史文化街区地下停车点", location: "118.867,28.962", pname: "浙江省", cityname: "衢州市", adname: "柯城区" },
        { id: "p1", name: "水亭门历史文化街区", location: "118.867315,28.962062", pname: "浙江省", cityname: "衢州市", adname: "柯城区" },
      ],
    }),
  ));

  const geo = await geocodeInCity("水亭门历史文化街区", "衢州");

  assert.ok(geo !== null);
  assert.equal(geo.name, "水亭门历史文化街区");
  assert.equal(geo.longitude, 118.867315);

  setAmapKey(undefined);
});

test("geocodeInCity: 首个查询词没命中时换词重查（去括号变体）", async () => {
  const requests: URL[] = [];
  setAmapKey("test-key", amapOnlyFetch((url) => {
    requests.push(url);
    const keywords = url.searchParams.get("keywords");
    return amapResponse({
      pois: keywords === "灵隐寺"
        ? [{ id: "p1", name: "灵隐寺", location: "120.096,30.240", pname: "浙江省", cityname: "杭州市", adname: "西湖区" }]
        : [],
    });
  }));

  const geo = await geocodeInCity("灵隐寺（飞来峰景区）", "杭州");

  assert.ok(geo !== null);
  assert.equal(geo.name, "灵隐寺");
  assert.equal(requests.length, 2); // 原始词无结果 → 去括号重查
  assert.equal(requests[1].searchParams.get("keywords"), "灵隐寺");

  setAmapKey(undefined);
});

test("regionMatchesCity: 行政区后缀归一化", () => {
  assert.equal(regionMatchesCity("北京市", "北京"), true);
  assert.equal(regionMatchesCity("西双版纳傣族自治州", "西双版纳"), true);
  assert.equal(regionMatchesCity("杭州市", "浙江"), false);
  assert.equal(regionMatchesCity(undefined, "北京"), false);
  assert.equal(regionMatchesCity("", "北京"), false);
});

test("formatPoiCoordinates: 高德 lng,lat 转行程用「纬度,经度」", () => {
  assert.equal(formatPoiCoordinates("120.096,30.240"), "30.2400,120.0960");
  assert.equal(formatPoiCoordinates("bad"), null);
});

test("geocode 工具: 传 city 核实成功时给出可写入行程的坐标", async () => {
  setAmapKey("test-key", amapOnlyFetch(() =>
    amapResponse({
      pois: [
        { id: "p1", name: "北海公园", location: "116.391802,39.928775", pname: "北京市", cityname: "北京市", adname: "西城区" },
      ],
    }),
  ));

  const tool = createGeocodeTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ location: "北海公园", city: "北京" });

  assert.match(output, /坐标已核实（目标城市 北京）：北海公园（北京市西城区）/);
  assert.match(output, /纬度 39\.9288, 经度 116\.3918/);

  setAmapKey(undefined);
});

test("geocode 工具: 传 city 核实不了时给出重查路径，不返回坐标", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("place")) {
      // 只有外地同名 POI，省市校验不通过
      return amapResponse({
        pois: [{ id: "x", name: "不存在的地名", location: "87.5,44.1", pname: "新疆维吾尔自治区", cityname: "五家渠市", adname: "" }],
      });
    }
    return amapResponse({ geocodes: [] });
  }));

  const tool = createGeocodeTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ location: "不存在的地名", city: "杭州" });

  assert.match(output, /未能在「杭州」核实「不存在的地名」/);
  assert.match(output, /北京市西城区北海公园/); // 换词重查示例
  assert.match(output, /坐标待核实/);
  assert.doesNotMatch(output, /纬度 -?\d/); // 不给出未核实的坐标

  // geocodeLocation 传 city 时同样宁缺毋滥：核实不了返回 null
  assert.equal(await geocodeLocation("不存在的地名", amapOnlyFetch(() => amapResponse({})), "杭州"), null);

  setAmapKey(undefined);
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
  assert.match(output, /雷峰塔 \| 风景名胜;风景名胜 \| 距中心 \d+\.\d 公里 \| 评分 4\.7 \| 坐标 30\.2310,120\.1500 \| 南山路15号/);
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
