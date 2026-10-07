import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "../src/tools/tool.ts";
import {
  createDistanceTool,
  createGeocodeTool,
  createReverseGeocodeTool,
  haversineKm,
} from "../src/tools/geo.ts";
import { geocodeLocation } from "../src/tools/geocoding.ts";
import { createWeatherTool } from "../src/tools/weather.ts";
import { createStayTool } from "../src/tools/stay.ts";
import { createDocumentTool } from "../src/tools/docs.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("ToolRegistry: 注册 / 定义导出 / 重复注册拒绝", () => {
  const registry = new ToolRegistry();
  registry.register(createDistanceTool());

  assert.equal(registry.size, 1);
  const defs = registry.definitions();
  assert.equal(defs[0].name, "calculate_distance");
  assert.equal(defs[0].parameters.type, "object");
  assert.throws(() => registry.register(createDistanceTool()), /重复注册/);
});

test("ToolRegistry: 未知工具 / 非法 JSON 参数都抛错", async () => {
  const registry = new ToolRegistry();
  registry.register(createDistanceTool());

  await assert.rejects(() => registry.execute("no_such_tool", "{}"), /工具不存在/);
  await assert.rejects(() => registry.execute("calculate_distance", "not json"), /不是合法 JSON/);
  await assert.rejects(
    () => registry.execute("calculate_distance", JSON.stringify({ from_lat: "x" })),
    /非法参数/,
  );
});

test("haversineKm: 北京到上海约 1067 公里", () => {
  const km = haversineKm(39.9042, 116.4074, 31.2304, 121.4737);
  assert.ok(Math.abs(km - 1067) < 15, `实际 ${km}`);
});

test("calculate_distance 工具返回公里数", async () => {
  const tool = createDistanceTool();
  const output = await tool.execute({
    from_lat: 39.9042, from_lon: 116.4074, to_lat: 31.2304, to_lon: 121.4737,
  });
  assert.match(output, /约 10\d\d\.\d 公里/);
});

test("geocode 工具: 返回多个候选（Photon）", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io/api/")) {
      return jsonResponse({
        features: [
          { properties: { name: "西湖", city: "杭州市", state: "ZJ", country: "中国" }, geometry: { coordinates: [120.1431, 30.246] } },
          { properties: { name: "西湖", city: "富士河口湖町", state: "山梨県", country: "日本" }, geometry: { coordinates: [138.6854, 35.4985] } },
        ],
      });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createGeocodeTool(fetchFn);
  const output = await tool.execute({ location: "西湖" });
  assert.match(output, /「西湖」的 2 个候选/);
  assert.match(output, /1\. 西湖 \(ZJ, 中国\) — 30\.2460, 120\.1431/);
  assert.match(output, /2\. 西湖 \(山梨県, 日本\) — 35\.4985, 138\.6854/);
});

test("geocodeLocation: Photon 失败时降级到 Open-Meteo", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      throw new Error("photon unreachable");
    }
    if (u.includes("geocoding-api.open-meteo.com")) {
      return jsonResponse({ results: [{ name: "北京", latitude: 39.9042, longitude: 116.4074, country: "中国", admin1: "北京市" }] });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const result = await geocodeLocation("北京", fetchFn);
  assert.ok(result !== null);
  assert.equal(result!.name, "北京");
  assert.equal(result!.latitude, 39.9042);
});

test("geocodeLocation: Photon 无结果时也降级到 Open-Meteo", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      return jsonResponse({ features: [] });
    }
    if (u.includes("geocoding-api.open-meteo.com")) {
      return jsonResponse({ results: [{ name: "北京", latitude: 39.9042, longitude: 116.4074, country: "中国" }] });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const result = await geocodeLocation("北京", fetchFn);
  assert.ok(result !== null);
  assert.equal(result!.name, "北京");
});

test("reverse_geocode 工具: 坐标转地名", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    assert.match(u, /photon\.komoot\.io\/reverse\?lat=30\.246&lon=120\.1431/);
    return jsonResponse({
      features: [
        { properties: { name: "西湖", city: "杭州市", state: "ZJ", country: "中国" }, geometry: { coordinates: [120.1431, 30.246] } },
      ],
    });
  }) as typeof fetch;

  const tool = createReverseGeocodeTool(fetchFn);
  assert.match(await tool.execute({ latitude: 30.246, longitude: 120.1431 }), /西湖 \(ZJ, 中国\)/);
});

test("geocode 工具: 所有后端都无结果时返回提示", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("photon.komoot.io")) {
      return jsonResponse({ features: [] });
    }
    if (u.includes("geocoding-api.open-meteo.com")) {
      return jsonResponse({ results: [] });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createGeocodeTool(fetchFn);
  assert.match(await tool.execute({ location: "不存在的地名" }), /未找到地点/);
});

test("get_weather 工具: 组合地理编码 + 预报数据", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国", admin1: "浙江省" }] });
    }
    if (u.includes("api.open-meteo.com/v1/forecast")) {
      return jsonResponse({
        daily: {
          time: ["2026-09-23", "2026-09-24"],
          weather_code: [0, 61],
          temperature_2m_max: [28.5, 24.1],
          temperature_2m_min: [19.2, 18.0],
          precipitation_sum: [0, 4.2],
        },
      });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createWeatherTool(fetchFn);
  const output = await tool.execute({ location: "杭州", days: 2 });

  assert.match(output, /杭州 \(浙江省, 中国\)/);
  assert.match(output, /2026-09-23: 晴, 19\.2~28\.5°C/);
  assert.match(output, /2026-09-24: 小雨, 18~24\.1°C, 降水 4\.2mm/);
});

test("search_stays 工具: 返回真实住宿数据（geocode + Overpass）", async () => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国" }] });
    }
    if (u.includes("overpass-api.de")) {
      const headers = init?.headers as Record<string, string>;
      assert.match(headers["User-Agent"], /minicode/);
      assert.match(String(init?.body), /tourism~.*hotel/);
      return jsonResponse({
        elements: [
          { type: "node", lat: 30.28, lon: 120.16, tags: { name: "杭州君悦酒店", tourism: "hotel", stars: "5", phone: "0571-87888888" } },
          { type: "node", lat: 30.25, lon: 120.13, tags: { name: "西湖边青旅", tourism: "hostel" } },
          { type: "way", center: { lat: 30.29, lon: 120.17 }, tags: { name: "湖畔民宿", tourism: "guest_house", "contact:website": "https://example.com" } },
          { type: "node", lat: 30.26, lon: 120.14, tags: { tourism: "hotel" } }, // 无名称，跳过
        ],
      });
    }
    throw new Error(`意外的请求: ${u}`);
  }) as typeof fetch;

  const tool = createStayTool(fetchFn);
  const output = await tool.execute({ city: "杭州" });

  assert.match(output, /杭州 的真实住宿/);
  assert.match(output, /杭州君悦酒店 \| 酒店 \| 距市中心 \d+\.\d 公里 \| 5星 \| 电话 0571-87888888/);
  assert.match(output, /西湖边青旅 \| 青旅/);
  assert.match(output, /湖畔民宿 \| 民宿/);
  assert.match(output, /example\.com/);
  assert.match(output, /不含价格/);
  // 君悦(约1.5km)比青旅(约2.9km)近，应排在前面
  assert.ok(output.indexOf("杭州君悦酒店") < output.indexOf("西湖边青旅"), "按距离排序");
});

test("search_stays 工具: 无结果时提示扩大半径", async () => {
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "测试城", latitude: 0, longitude: 0, country: "X" }] });
    }
    return jsonResponse({ elements: [] });
  }) as typeof fetch;

  const tool = createStayTool(fetchFn);
  const output = await tool.execute({ city: "测试城" });
  assert.match(output, /没有找到有名称的住宿/);
  assert.match(output, /扩大 radius_km/);
});

test("read_document 工具: txt / csv / json 解析", async () => {
  const tool = createDocumentTool();
  const dir = await mkdtemp(join(tmpdir(), "minicode-doc-"));

  const txt = join(dir, "行程.txt");
  await writeFile(txt, "10-01 到达杭州", "utf8");
  assert.equal(await tool.execute({ path: txt }), "10-01 到达杭州");

  const csv = join(dir, "行程.csv");
  await writeFile(csv, 'date,city,note\n2026-10-01,杭州,"高铁, 下午到"', "utf8");
  const csvOut = await tool.execute({ path: csv });
  assert.match(csvOut, /date, city, note/);
  assert.match(csvOut, /"高铁, 下午到"/);

  const json = join(dir, "data.json");
  await writeFile(json, '{"a":1}', "utf8");
  assert.equal(await tool.execute({ path: json }), '{\n  "a": 1\n}');
});

test("read_document 工具: 文件不存在抛错", async () => {
  const tool = createDocumentTool();
  await assert.rejects(() => tool.execute({ path: "Z:/不存在.txt" }));
});

test("read_document 工具: 超过 2MB 的文件拒绝读取（防 OOM）", async () => {
  const tool = createDocumentTool();
  const dir = await mkdtemp(join(tmpdir(), "minicode-doc-"));
  const big = join(dir, "big.txt");
  await writeFile(big, Buffer.alloc(3 * 1024 * 1024, "a"), "utf8");

  await assert.rejects(
    () => tool.execute({ path: big }),
    /文件过大.*3145728 字节/,
  );
});

test("read_document 工具: 传入 readRoot 时限制在根内", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-readroot-"));
  const outside = await mkdtemp(join(tmpdir(), "minicode-outside-"));
  const insideFile = join(root, "ok.txt");
  const outsideFile = join(outside, "secret.txt");
  await writeFile(insideFile, "inside", "utf8");
  await writeFile(outsideFile, "secret", "utf8");
  const tool = createDocumentTool({ readRoot: root });

  assert.equal(await tool.execute({ path: insideFile }), "inside");
  await assert.rejects(() => tool.execute({ path: outsideFile }), /安全限制/);
  // 不传 readRoot = 任意路径可读（CLI/Web 有人工确认门槛）
  assert.equal(await createDocumentTool().execute({ path: outsideFile }), "secret");
});
