import assert from "node:assert/strict";
import { test } from "node:test";
import { createFoodTool } from "../src/tools/food.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";

function amapResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ status: "1", infocode: "10000", ...body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function amapOnlyFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (!parsed.hostname.includes("amap.com")) {
      throw new Error(`非高德请求不应发生: ${parsed.hostname}`);
    }
    return handler(parsed);
  }) as typeof fetch;
}

const GEO = { geocodes: [{ formatted_address: "浙江省杭州市", location: "120.209,30.246" }] };

/** 中心点 120.209,30.246；距离按经纬度实际计算，均在默认 3km 半径内 */
function foodPois() {
  return [
    {
      id: "r1", name: "楼外楼(孤山路店)", type: "餐饮服务;中餐厅;杭州菜",
      location: "120.1900,30.2450", address: "孤山路30号",
      biz_ext: { rating: "4.5", cost: "150" },
    },
    {
      id: "r2", name: "知味观(湖滨总店)", type: "餐饮服务;中餐厅;杭州菜",
      location: "120.1950,30.2460", address: "仁和路83号",
      biz_ext: { rating: "4.7", cost: "80" },
    },
    {
      id: "r3", name: "绿茶餐厅(西湖店)", type: "餐饮服务;中餐厅;浙江菜",
      location: "120.1850,30.2400", address: "龙井路83号",
      biz_ext: { rating: "4.3", cost: "65" },
    },
    {
      id: "r4", name: "老川家火锅", type: "餐饮服务;中餐厅;川菜;火锅",
      location: "120.2000,30.2500", address: "某路1号",
      biz_ext: { rating: "4.8", cost: "90" },
    },
    {
      id: "r5", name: "无名评分缺失面馆", type: "餐饮服务;中餐厅;面食",
      location: "120.1920,30.2440", address: "某路",
      biz_ext: {},
    },
    {
      id: "r6", name: "网红低分店", type: "餐饮服务;中餐厅;江浙菜",
      location: "120.1930,30.2470", address: "某路",
      biz_ext: { rating: "3.8", cost: "70" },
    },
  ];
}

/** 同菜系过多场景：3 家杭州菜 + 1 家浙江菜 */
function sameCuisinePois() {
  return [
    {
      id: "s1", name: "杭州酒家", type: "餐饮服务;中餐厅;杭州菜",
      location: "120.2050,30.2450", address: "延安路",
      biz_ext: { rating: "4.9", cost: "100" },
    },
    {
      id: "s2", name: "知味观(湖滨总店)", type: "餐饮服务;中餐厅;杭州菜",
      location: "120.2000,30.2460", address: "仁和路83号",
      biz_ext: { rating: "4.8", cost: "90" },
    },
    {
      id: "s3", name: "新丰小吃", type: "餐饮服务;中餐厅;杭州菜",
      location: "120.1950,30.2460", address: "庆春路",
      biz_ext: { rating: "4.7", cost: "40" },
    },
    {
      id: "s4", name: "绿茶餐厅(西湖店)", type: "餐饮服务;中餐厅;浙江菜",
      location: "120.1900,30.2460", address: "龙井路83号",
      biz_ext: { rating: "4.5", cost: "70" },
    },
  ];
}

test("search_restaurants: 多因子综合分排序，默认剔除低分与无评分", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) {
      assert.equal(url.searchParams.get("types"), "050000");
      assert.equal(url.searchParams.get("keywords"), "美食");
      return amapResponse({ pois: foodPois() });
    }
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /排序依据: 评分40% \+ 就近30% \+ 价格契合20% \+ 本地特色10%/);
  assert.match(output, /评分门槛 4\.2，低分与无评分已剔除/);
  // 老川家(4.8/0.98km) 综合分最高排第一；知味观(4.7/1.4km/本地特色) 第二
  assert.ok(output.indexOf("老川家火锅") < output.indexOf("知味观"));
  assert.match(output, /老川家火锅 综合 \d+\.\d \| 中餐厅\/川菜 \| 评分 4\.8 \| 人均 ¥90 \| 距离 1\.0 公里/);
  assert.match(output, /知味观\(湖滨总店\) 综合 \d+\.\d \| 中餐厅\/杭州菜·本地特色 \| 评分 4\.7 \| 人均 ¥80/);
  // 无评分(无名面馆)与低分(3.8)在高分充足时被剔除
  assert.doesNotMatch(output, /无名评分缺失面馆/);
  assert.doesNotMatch(output, /网红低分店/);
  assert.match(output, /get_place_reviews 可查招牌菜/);

  setAmapKey(undefined);
});

test("search_restaurants: avoid_cuisines 排除已安排菜系", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) return amapResponse({ pois: foodPois() });
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州", avoid_cuisines: "川菜，火锅" });

  assert.doesNotMatch(output, /老川家火锅/);
  assert.match(output, /已排除菜系: 川菜、火锅/);
  assert.match(output, /知味观/);

  setAmapKey(undefined);
});

test("search_restaurants: 菜系关键词透传 + min_rating/max_cost 过滤", async () => {
  const requests: URL[] = [];
  setAmapKey("test-key", amapOnlyFetch((url) => {
    requests.push(url);
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) return amapResponse({ pois: foodPois() });
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州", cuisine: "杭帮菜", min_rating: 4.6, max_cost: 100 });

  assert.equal(requests.at(-1)?.searchParams.get("keywords"), "杭帮菜");
  assert.match(output, /评分≥4\.6/);
  assert.match(output, /人均≤100元/);
  // 知味观(4.7/¥80) 与 老川家(4.8/¥90) 留存；楼外楼¥150 超预算、绿茶4.3 评分不够
  assert.match(output, /知味观/);
  assert.match(output, /老川家火锅/);
  assert.doesNotMatch(output, /楼外楼/);
  assert.doesNotMatch(output, /绿茶餐厅/);

  setAmapKey(undefined);
});

test("search_restaurants: 同一菜系最多保留 2 家保证多样性", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) return amapResponse({ pois: sameCuisinePois() });
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /同一菜系最多 2 家/);
  assert.equal((output.match(/中餐厅\/杭州菜/g) ?? []).length, 2);
  // 第 4 家杭州菜被让位给浙江菜候选，模型可以跨菜系组合三餐
  assert.match(output, /绿茶餐厅/);
  assert.doesNotMatch(output, /新丰小吃/);

  setAmapKey(undefined);
});

test("search_restaurants: 高分候选不足时自动放宽评分门槛", async () => {
  const sparse = foodPois().filter((poi) => poi.id !== "r1" && poi.id !== "r3" && poi.id !== "r6");
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) return amapResponse({ pois: sparse });
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /高分候选不足，评分门槛 4\.2 已自动放宽/);
  // 只剩 1 家高分(4.8) + 1 家无评分 → 无评分保留参与排序（综合分会被压低）
  assert.match(output, /老川家火锅/);
  assert.match(output, /无名评分缺失面馆/);

  setAmapKey(undefined);
});

test("search_restaurants: 未配置 Key 时给出配置指引", async () => {
  setAmapKey(undefined);
  const tool = createFoodTool();
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /未配置 amap_api_key/);
  assert.match(output, /\/config set amap_api_key/);
});

test("search_restaurants: 无匹配结果时提示放宽筛选", async () => {
  setAmapKey("test-key", amapOnlyFetch((url) => {
    if (url.pathname.includes("geocode")) return amapResponse(GEO);
    if (url.pathname.includes("place")) return amapResponse({ pois: foodPois() });
    return amapResponse({});
  }));

  const tool = createFoodTool(amapOnlyFetch(() => amapResponse({})));
  const output = await tool.execute({ city: "杭州", min_rating: 4.9 });

  assert.match(output, /没有符合条件的餐厅/);
  assert.match(output, /放宽筛选/);

  setAmapKey(undefined);
});
