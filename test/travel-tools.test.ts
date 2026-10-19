import assert from "node:assert/strict";
import { test } from "node:test";

import { createAttractionsTool } from "../src/tools/attractions.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { overpassFallback, overpassQuery } from "../src/tools/overpass.ts";
import { geocodeLocation } from "../src/tools/geocoding.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function amapResponse(body: Record<string, unknown>): Response {
  return jsonResponse({ status: "1", infocode: "10000", ...body });
}

test("search_attractions: 解析 OSM 数据并按距离排序去重", async () => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国" }] });
    }
    if (u.includes("/api/interpreter")) {
      const headers = init?.headers as Record<string, string>;
      assert.match(headers["User-Agent"], /minicode/); // 服务拒绝默认 UA
      const body = String(init?.body);
      assert.match(body, /around:10000,30\.27,120\.15/);
      return jsonResponse({
        elements: [
          { type: "node", lat: 30.24, lon: 120.1, tags: { name: "西湖", tourism: "attraction" } },
          { type: "node", lat: 30.25, lon: 120.1, tags: { name: "灵隐寺", tourism: "attraction", website: "https://lingyin.org" } },
          { type: "way", center: { lat: 30.28, lon: 120.13 }, tags: { name: "西湖", leisure: "park" } }, // 重复名
          { type: "node", lat: 30.26, lon: 120.14, tags: { tourism: "museum" } }, // 无名称，跳过
        ],
      });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createAttractionsTool(fetchFn);
  const output = await tool.execute({ location: "杭州" });

  assert.match(output, /杭州 周边景点/);
  assert.match(output, /西湖 \| (景点|公园) \| 距市中心 \d+\.\d 公里/);
  assert.match(output, /灵隐寺 \| 景点/);
  assert.match(output, /lingyin\.org/);
  // 去重后共 2 个
  assert.match(output, /共 2 个/);
  // 西湖更近，应排在前面
  assert.ok(output.indexOf("西湖") < output.indexOf("灵隐寺"));
});

test("search_attractions: 找不到地点 / 无结果", async () => {
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "测试城", latitude: 0, longitude: 0, country: "X" }] });
    }
    return jsonResponse({ elements: [] });
  }) as typeof fetch;

  const tool = createAttractionsTool(fetchFn);
  assert.match(await tool.execute({ location: "测试城" }), /没有找到有名称的景点/);
});

test("get_place_reviews: 解析 Bing 结果标题与摘要", async () => {
  const requests: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    assert.match(String(url), /bing\.com\/search\?q=/);
    requests.push(String(url));
    const headers = init?.headers as Record<string, string>;
    assert.match(headers["User-Agent"], /Mozilla/);
    return new Response(
      `<html><body>
        <li class="b_algo">
          <h2><a href="#">灵隐寺<b>点评</b> —— 旅游网站</a></h2>
          <div class="b_caption"><p>4.7分 2.3万条点评，非常值得去&amp;香火鼎盛，游客<span>评价很高</span></p></div>
        </li>
        <li class="b_algo">
          <h2><a href="#">灵隐寺攻略</a></h2>
          <p>人比较多，建议早上出发</p>
        </li>
      </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "灵隐寺", city: "杭州" });

  assert.match(output, /「灵隐寺」的网络评价摘要/);
  assert.match(output, /灵隐寺点评 —— 旅游网站/);
  assert.match(output, /非常值得去&香火鼎盛，游客评价很高/);
  assert.match(output, /非官方评分/);
  assert.match(output, /口碑热度: 评价数约 23000 条/);
  assert.match(output, /第三方评分样本 4\.7/);
  // 第一个查询变体用引号做精确匹配
  assert.match(decodeURIComponent(requests[0]), /q="灵隐寺" 杭州 点评/);
});

test("get_place_reviews: Bing 不可用时降级到 DuckDuckGo", async () => {
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes("bing.com")) {
      throw new Error("network blocked");
    }
    return new Response(
      `<html>
        <a class="result__a" href="#">灵隐寺评价（备用源）</a>
        <a class="result__snippet">好评如潮，值得一看</a>
      </html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "灵隐寺" });

  assert.match(output, /灵隐寺评价（备用源）/);
  assert.match(output, /好评如潮/);
});

test("get_place_reviews: aspect 参数调整查询词", async () => {
  const queries: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    const match = u.match(/[?&]q=([^&]+)/);
    const query = match === null ? "" : decodeURIComponent(match[1]);
    if (query !== "") queries.push(query);
    // 返回含地点名的相关结果（查询首词即地点名）
    const place = query.replace(/^"/, "").split(/[\s"]/)[0];
    return new Response(
      `<html><li class="b_algo"><h2><a href="#">${place} 攻略</a></h2><p>人均¥80，评价不错</p></li></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  await tool.execute({ place: "新白鹿", city: "杭州", aspect: "人均价格" });
  await tool.execute({ place: "楼外楼", city: "杭州", aspect: "招牌菜" });
  await tool.execute({ place: "灵隐寺", city: "杭州" });

  // 首个变体用引号精确匹配，aspect 词进入查询
  assert.match(queries[0], /^"新白鹿" 杭州 人均 价格 多少钱$/);
  assert.ok(queries.some((q) => q.includes("楼外楼") && q.includes("招牌菜 必点 推荐")));
  assert.ok(queries.some((q) => q.includes("灵隐寺") && q.includes("点评 评价 值得去吗")));
});

test("get_place_reviews: 提取游玩时长参考（含噪声过滤与来源标注）", async () => {
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes("bing.com")) {
      return new Response(
        `<html><body>
          <li class="b_algo"><h2><a href="#">三坊七巷游玩攻略</a></h2><p>福州三坊七巷怎么玩，看这篇就够了</p></li>
          <div>三坊七巷一般游玩 2 到 4 小时，如果只逛主街和拍照 2 小时左右。
          停车场收费 24 小时内 30 元，建议错峰出行。</div>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    return new Response("<html><body>没有结果</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "三坊七巷", city: "福州", aspect: "游玩时长" });

  assert.match(output, /游玩时长参考/);
  assert.match(output, /一般游玩 2 到 4 小时/);
  assert.match(output, /只逛主街和拍照 2 小时左右/);
  assert.match(output, /来源: 必应/);
  assert.doesNotMatch(output, /24 小时内/, "停车/营业类时间段不应被当成游玩时长");
});

test("get_place_reviews: 百科/词典噪声被过滤，全无关时明确返回无数据", async () => {
  const fetchFn = (async () => {
    return new Response(
      `<html><body>
        <li class="b_algo"><h2><a href="#">姑_百度百科</a></h2><p>姑，汉语常用字，读作 gū，称父亲的姐妹</p></li>
        <li class="b_algo"><h2><a href="#">姑的意思,姑的解释-汉语国学</a></h2><p>姑字的意思、读音、部首、笔画</p></li>
      </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "姑蔑博物馆", city: "衢州" });

  assert.match(output, /没有搜到「姑蔑博物馆」的相关评价内容/);
  assert.ok(!output.includes("百度百科"), "噪声结果不应出现在输出里");
  assert.match(output, /不要臆测好坏/);
});

test("get_place_reviews: 360 搜索作为引擎之一（res-list 标题+摘要）", async () => {
  const fetchFn = (async (url: string | URL) => {
    if (!String(url).includes("so.com")) throw new Error("network blocked");
    return new Response(
      `<html><ul>
        <li class="res-list">
          <h3 class="res-title"><a href="#">【携程美食林】衢州周叔烤饼(原大叔烤饼)餐馆,超好吃</a></h3>
          <p class="res-desc">周叔烤饼(原大叔烤饼)点评(5条点评)，人均23元</p>
        </li>
        <li class="res-list">
          <h3><a href="#">衢州衢周叔烤饼(水亭门店)好吃吗,味道怎么样</a></h3>
          <p class="res-desc">水亭门必吃小吃，酥香外皮</p>
        </li>
      </ul></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "周叔烤饼", city: "衢州" });

  assert.match(output, /携程美食林/);
  assert.match(output, /水亭门必吃小吃/);
});

test("get_place_reviews: Bing/DDG 不可用时降级到百度（本地小店能被搜到）", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (!u.includes("baidu.com/s?wd=")) {
      throw new Error("network blocked");
    }
    return new Response(
      `<html><div class="result">
        <h3 class="t"><a href="#">衢周叔烤饼(水亭门店)-地址,电话,价格,营业时间</a></h3>
        <div class="c-abstract">酥香外皮、饱满肉馅，衢州本地人常吃的烤饼小吃</div>
      </div></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "周叔烤饼", city: "衢州" });

  assert.match(output, /衢周叔烤饼\(水亭门店\)/);
  assert.match(output, /本地人常吃的烤饼小吃/);
});

test("get_place_reviews: 摘要中的 HTML 实体被解码", async () => {
  const fetchFn = (async () =>
    new Response(
      `<html><li class="b_algo"><h2><a href="#">龙游石窟评价</a></h2><p>4.8分&#0183;风景&ensp;很好&mdash;值得去</p></li></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    )) as typeof fetch;
  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "龙游石窟", city: "衢州" });
  assert.match(output, /4\.8分·风景 很好—值得去/);
});

test("get_place_reviews: 保留相关结果并优先本城市（排除同名异地）", async () => {
  const fetchFn = (async () => {
    return new Response(
      `<html><body>
        <li class="b_algo"><h2><a href="#">灵隐寺游玩攻略（杭州）</a></h2><p>香火鼎盛，早点去人少</p></li>
        <li class="b_algo"><h2><a href="#">灵隐寺点评：杭州必去</a></h2><p>4.7分，值得一游</p></li>
        <li class="b_algo"><h2><a href="#">灵隐寺_百度百科</a></h2><p>词条介绍</p></li>
        <li class="b_algo"><h2><a href="#">灵隐寺（深圳同名寺庙介绍）</a></h2><p>位于南方某地</p></li>
      </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  const output = await tool.execute({ place: "灵隐寺", city: "杭州" });

  assert.match(output, /灵隐寺游玩攻略（杭州）/);
  assert.match(output, /灵隐寺点评：杭州必去/);
  assert.ok(!output.includes("百度百科"), "百科噪声应被剔除");
  assert.ok(!output.includes("深圳"), "有足够本城市结果时，同名异地的结果应被排除");
});

test("get_place_reviews: 无结果时返回提示", async () => {
  const fetchFn = (async () => new Response("<html></html>", { status: 200 })) as typeof fetch;
  const tool = createReviewsTool(fetchFn);

  assert.match(await tool.execute({ place: "不存在的地方" }), /没有搜到/);
});

test("overpassQuery: 主镜像返回 XML 错误页时自动切换下一个镜像", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    const host = String(url).replace("https://", "").split("/")[0];
    calls.push(host);
    if (calls.length === 1) {
      // 504 错误可能以 200 状态 + XML 体出现（实测行为）
      return new Response('<?xml version="1.0"?><html>gateway timeout</html>', {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    return jsonResponse({ elements: [{ type: "node", lat: 1, lon: 2, tags: { name: "x" } }] });
  }) as typeof fetch;

  // 用唯一查询串避开模块级缓存
  const query = "[out:json][timeout:25];out center 1; /*mirror-test-1*/";
  const data = await overpassQuery(query, fetchFn);

  assert.equal(data.elements?.length, 1);
  assert.equal(calls.length, 2, `应换镜像重试，实际请求了 ${calls.join(", ")}`);
});

test("overpassQuery: 刚失败的镜像排到最后（不再每次先在同一个坏节点上耗超时）", async () => {
  const failed: string[] = [];
  const firstFetch = (async (url: string | URL) => {
    const host = String(url).replace("https://", "").split("/")[0];
    if (failed.length === 0) {
      failed.push(host);
      return new Response("# 502 Gateway Timeout", { status: 502 });
    }
    return jsonResponse({ elements: [] });
  }) as typeof fetch;
  await overpassQuery("[out:json];out center 1; /*cooldown-test-1*/", firstFetch);
  assert.equal(failed.length, 1, "应记录首个失败的镜像");

  const second: string[] = [];
  const secondFetch = (async (url: string | URL) => {
    second.push(String(url).replace("https://", "").split("/")[0]);
    return jsonResponse({ elements: [] });
  }) as typeof fetch;
  await overpassQuery("[out:json];out center 1; /*cooldown-test-2*/", secondFetch);

  assert.equal(second.length, 1, "健康镜像应一次命中");
  assert.notEqual(second[0], failed[0], "上一轮失败的镜像不该再排第一");
});

test("overpassQuery: 镜像表里的节点都会被尝试（不再固定只试前 3 个）", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("# 502 Gateway Timeout", { status: 502 });
  }) as typeof fetch;

  await assert.rejects(
    () => overpassQuery("[out:json][timeout:25];out center 1; /*all-mirrors*/", fetchFn),
    /已尝试 \d+ 个镜像/,
  );
  assert.ok(calls.length >= 5, `镜像表应被完整尝试，实际只试了 ${calls.length} 个`);
});

test("overpassFallback: 主源先失败时，错误信息要说明是降级后才轮到 OSM", async () => {
  const fetchFn = (async () => new Response("# 502 Gateway Timeout", { status: 502 })) as typeof fetch;

  await assert.rejects(
    () => overpassFallback("[out:json];out center 1; /*fallback-msg*/", "高德 API 失败: 并发/QPS 超限", fetchFn),
    /高德请求失败（高德 API 失败: 并发\/QPS 超限）后转 OpenStreetMap 兜底，OSM 也不可用/,
  );
});

test("overpassQuery: 相同查询走缓存（LLM 重试不再打服务）", async () => {
  let callCount = 0;
  const fetchFn = (async () => {
    callCount += 1;
    return jsonResponse({ elements: [] });
  }) as typeof fetch;

  const query = "[out:json][timeout:25];out center 1; /*cache-test-1*/";
  await overpassQuery(query, fetchFn);
  await overpassQuery(query, fetchFn);
  await overpassQuery(query, fetchFn);

  assert.equal(callCount, 1, "第二次起应命中缓存");
});

test("overpassQuery: 全部镜像失败时错误信息包含建议", async () => {
  const fetchFn = (async () => {
    throw new Error("timeout");
  }) as typeof fetch;

  const query = "[out:json][timeout:25];out center 1; /*fail-test-1*/";
  await assert.rejects(
    () => overpassQuery(query, fetchFn),
    /建议稍后重试/,
  );
});

test("search_attractions: 查询已收窄 historic 标签（防北京类超载）", async () => {
  const bodies: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "北京", latitude: 39.9, longitude: 116.4, country: "中国" }] });
    }
    if (u.includes("overpass-api.de")) {
      bodies.push(String(init?.body));
      return jsonResponse({ elements: [] });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createAttractionsTool(fetchFn);
  await tool.execute({ location: "北京" });

  assert.match(bodies[0], /historic~"\^\(monument\|memorial\|castle\|ruins\|archaeological_site\|fort\)\$"/);
  assert.doesNotMatch(bodies[0], /\[historic\];/); // 不再是任意 historic
});

test("geocodeLocation: 相同地名走缓存", async () => {
  let callCount = 0;
  const fetchFn = (async (url: string | URL) => {
    callCount += 1;
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      return jsonResponse({
        features: [{ properties: { name: "杭州", state: "ZJ", country: "中国" }, geometry: { coordinates: [120.15, 30.27] } }],
      });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const first = await geocodeLocation("杭州缓存测试", fetchFn);
  const second = await geocodeLocation("杭州缓存测试", fetchFn);
  const third = await geocodeLocation("杭州缓存测试", fetchFn);

  assert.equal(callCount, 1, "第二次起应命中缓存");
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("search_attractions: 博物馆搜索失败时输出可见警告", async () => {
  setAmapKey("test-key", (async (url: string | URL | Request) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (!parsed.hostname.includes("amap.com")) throw new Error(`非高德请求: ${parsed.hostname}`);
    if (parsed.pathname.includes("geocode")) {
      return amapResponse({ geocodes: [{ formatted_address: "杭州", location: "120.15,30.25" }] });
    }
    if (parsed.pathname.includes("place")) {
      // 关键词含"博物馆"的那一路请求失败
      if ((parsed.searchParams.get("keywords") ?? "").includes("博物馆")) {
        throw new Error("quota exceeded");
      }
      return amapResponse({
        pois: [{ id: "p1", name: "西湖", type: "风景名胜", location: "120.15,30.25", biz_ext: { rating: "4.6" } }],
      });
    }
    return amapResponse({});
  }) as typeof fetch);

  const tool = createAttractionsTool();
  const output = await tool.execute({ location: "杭州" });

  assert.match(output, /西湖/);
  assert.match(output, /⚠️ 博物馆[/]纪念馆搜索失败（quota exceeded），以上仅为风景名胜结果/);

  setAmapKey(undefined);
});
