import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteDocumentTool } from "../src/tools/markdown.ts";
import { createAttractionsTool } from "../src/tools/attractions.ts";
import { setAmapKey } from "../src/tools/amap-access.ts";
import { createReviewsTool } from "../src/tools/reviews.ts";
import { overpassQuery } from "../src/tools/overpass.ts";
import { geocodeLocation } from "../src/tools/geocoding.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function amapResponse(body: Record<string, unknown>): Response {
  return jsonResponse({ status: "1", infocode: "10000", ...body });
}

test("write_document: 写入并创建多级目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-write-"));
  const tool = createWriteDocumentTool(root);

  const output = await tool.execute({
    path: "plans/hangzhou.md",
    content: "# 杭州行程\n\n- 西湖",
  });

  assert.match(output, /已保存到/);
  const saved = await readFile(join(root, "plans", "hangzhou.md"), "utf8");
  assert.equal(saved, "# 杭州行程\n\n- 西湖");
});

test("write_document: 拒绝越出根目录的路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-write-"));
  const tool = createWriteDocumentTool(root);

  await assert.rejects(
    () => tool.execute({ path: "../escape.md", content: "x" }),
    /安全限制/,
  );
  await assert.rejects(
    () => tool.execute({ path: join(tmpdir(), "outside.md"), content: "x" }),
    /安全限制/,
  );
  // 同前缀目录（/root-evil vs /root）：startsWith 式检查会放行，必须拒绝
  await assert.rejects(
    () => tool.execute({ path: `${root}-evil/escape.md`, content: "x" }),
    /安全限制/,
  );
  // 根目录内的绝对路径、以 ".." 开头的文件名都是合法写入
  assert.match(await tool.execute({ path: join(root, "inside.md"), content: "x" }), /已保存到/);
  assert.match(await tool.execute({ path: "..dots.md", content: "x" }), /已保存到/);
});

test("write_document: 拒绝不支持的扩展名与缺失内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-write-"));
  const tool = createWriteDocumentTool(root);

  await assert.rejects(() => tool.execute({ path: "a.exe", content: "x" }), /不支持的文件类型/);
  await assert.rejects(() => tool.execute({ path: "a.md", content: "" }), /非法参数/);
});

test("search_attractions: 解析 OSM 数据并按距离排序去重", async () => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国" }] });
    }
    if (u.includes("overpass-api.de")) {
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
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    assert.match(String(url), /bing\.com\/search\?q=/);
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
    if (match !== null) {
      queries.push(decodeURIComponent(match[1]));
    }
    return new Response(
      `<html><li class="b_algo"><h2><a href="#">x</a></h2><p>人均¥80</p></li></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }) as typeof fetch;

  const tool = createReviewsTool(fetchFn);
  await tool.execute({ place: "新白鹿", city: "杭州", aspect: "人均价格" });
  await tool.execute({ place: "楼外楼", city: "杭州", aspect: "招牌菜" });
  await tool.execute({ place: "灵隐寺", city: "杭州" });

  assert.match(queries[0], /新白鹿 杭州 人均 价格 多少钱/);
  assert.match(queries[1], /楼外楼 杭州 招牌菜 必点 推荐/);
  assert.match(queries[2], /灵隐寺 杭州 点评 评价 值得去吗/);
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
    if (host === "overpass-api.de") {
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
  assert.equal(calls[0], "overpass-api.de");
  assert.equal(calls[1], "z.overpass-api.de");
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
  assert.match(output, /⚠️ 博物馆[\/]纪念馆搜索失败（quota exceeded），以上仅为风景名胜结果/);

  setAmapKey(undefined);
});
