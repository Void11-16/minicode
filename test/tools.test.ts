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
  assert.match(output, /1\. 西湖 \(ZJ 杭州市, 中国\) — 30\.2460, 120\.1431/);
  assert.match(output, /2\. 西湖 \(山梨県富士河口湖町, 日本\) — 35\.4985, 138\.6854/);
  // 不传 city 时明确警告未做城市校验（外地同名地点风险）
  assert.match(output, /未做城市校验/);
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
  assert.match(await tool.execute({ latitude: 30.246, longitude: 120.1431 }), /西湖 \(ZJ 杭州市, 中国\)/);
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

/** 距今天 N 天的本地日期（与工具口径一致：按本地时区取"今天"） */
function isoDaysFromToday(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 天气工具的 fetch 桩：地理编码固定杭州，预报返回给定日期 */
function weatherFetch(dates: readonly string[], onForecast?: (url: string) => void): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.open-meteo.com/v1/forecast")) {
      onForecast?.(u);
      return jsonResponse({
        daily: {
          time: [...dates],
          weather_code: dates.map(() => 0),
          temperature_2m_max: dates.map(() => 25),
          temperature_2m_min: dates.map(() => 15),
          precipitation_sum: dates.map(() => 0),
        },
      });
    }
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国", admin1: "浙江省" }] });
    }
    throw new Error("Photon 不可用"); // 触发 Open-Meteo 地理编码兜底
  }) as typeof fetch;
}

test("get_weather: 指定行程日期区间，直接查那几天", async () => {
  const start = isoDaysFromToday(2);
  const end = isoDaysFromToday(3);
  let requestedUrl = "";
  const output = await createWeatherTool(
    weatherFetch([start, end], (url) => {
      requestedUrl = url;
    }),
  ).execute({ location: "杭州", start_date: start, end_date: end });

  assert.match(requestedUrl, new RegExp(`start_date=${start}&end_date=${end}`));
  assert.match(output, new RegExp(`天气预报 ${start} ~ ${end}`));
  assert.match(output, new RegExp(`${start}: 晴, 15~25°C, 降水 0mm`));
  assert.doesNotMatch(output, /参考性低|无法获取/); // 3 天内属可靠区间，不该带提示
});

test("get_weather: 行程日期超出预报窗口时明确说明拿不到，且不请求预报接口", async () => {
  const start = isoDaysFromToday(30);
  const end = isoDaysFromToday(35);
  let forecastCalls = 0;
  const output = await createWeatherTool(
    weatherFetch([], () => {
      forecastCalls += 1;
    }),
  ).execute({ location: "杭州", start_date: start, end_date: end });

  assert.equal(forecastCalls, 0, "超出窗口时不应请求预报接口");
  assert.match(output, /无法获取/);
  assert.match(output, /超出预报范围/);
  assert.match(output, /不要编造/);
});

test("get_weather: 行程前半段可查、后半段超窗口时，返回可查部分并说明缺口", async () => {
  const start = isoDaysFromToday(10);
  const horizonEnd = isoDaysFromToday(15);
  const end = isoDaysFromToday(20);
  let requestedUrl = "";
  const output = await createWeatherTool(
    weatherFetch([start, horizonEnd], (url) => {
      requestedUrl = url;
    }),
  ).execute({ location: "杭州", start_date: start, end_date: end });

  assert.match(requestedUrl, new RegExp(`start_date=${start}&end_date=${horizonEnd}`));
  assert.match(output, new RegExp(`注意：${isoDaysFromToday(16)} ~ ${end} 超出预报范围`));
  assert.match(output, /不要编造/);
});

test("get_weather: days 超上限按 16 天返回并说明，远期日期标注可靠性", async () => {
  const dates = Array.from({ length: 16 }, (_value, index) => isoDaysFromToday(index));
  const output = await createWeatherTool(weatherFetch(dates)).execute({ location: "杭州", days: 20 });

  assert.match(output, /注意：请求了 20 天，但预报最多 16 天/);
  assert.match(output, new RegExp(`${isoDaysFromToday(2)}: 晴, 15~25°C, 降水 0mm$`, "m"));
  assert.match(output, new RegExp(`${isoDaysFromToday(7)}: .*（较远，参考性低）`));
  assert.match(output, new RegExp(`${isoDaysFromToday(10)}: .*（远期，仅供趋势参考）`));
  assert.match(output, /说明：第 8 天起的预报误差明显增大/);
});

test("get_weather: 服务不可用时返回说明而不是抛错", async () => {
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.open-meteo.com/v1/forecast")) {
      return new Response("boom", { status: 500 });
    }
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国" }] });
    }
    throw new Error("Photon 不可用");
  }) as typeof fetch;

  const output = await createWeatherTool(fetchFn).execute({ location: "杭州", days: 3 });
  assert.match(output, /无法获取杭州的天气预报（天气服务返回 HTTP 500）/);
  assert.match(output, /不要.*编造/);
});

test("get_weather: 日期格式非法时给出明确提示", async () => {
  const output = await createWeatherTool(weatherFetch([])).execute({ location: "杭州", start_date: "2026/10/20" });
  assert.match(output, /start_date 必须是 YYYY-MM-DD 格式/);
});

test("search_stays 工具: 返回真实住宿数据（geocode + Overpass）", async () => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return jsonResponse({ results: [{ name: "杭州", latitude: 30.27, longitude: 120.15, country: "中国" }] });
    }
    if (u.includes("/api/interpreter")) {
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
  assert.match(output, /杭州君悦酒店 \| 酒店 \| 距市中心 \d+\.\d 公里 \| 坐标 30\.2800,120\.1600 \| 5星 \| 电话 0571-87888888/);
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
