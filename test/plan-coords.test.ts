import assert from "node:assert/strict";
import { test } from "node:test";
import { planCentroid, queryVariants, resolutionQuery, resolvePlanCoordinates, type PlanJson } from "../src/web/plan-coords.ts";

function makePlan(): PlanJson {
  return {
    title: "测试行程",
    days: [
      {
        items: [
          {
            name: "孔氏南宗家庙",
            location: { name: "孔氏南宗家庙", latitude: 28.9637, longitude: 118.8698, source: "amap" },
          },
          {
            name: "入住 衢州水亭门鹿鸣文院漫心府",
            location: { name: "衢州水亭门鹿鸣文院漫心府", latitude: 28.9702, longitude: 118.8472, source: "amap" },
          },
          {
            name: "早餐：古铺良食",
            location: { name: "古铺良食（柯城店）", latitude: 28.9652, longitude: 118.8585, source: "search" },
          },
          {
            name: "无法解析的地点",
            location: { name: "不存在的地方", latitude: 28.97, longitude: 118.85, source: "search" },
          },
          { name: "无坐标条目" },
        ],
      },
    ],
  };
}

test("resolutionQuery: 清洗展示前缀，取 location.name 优先", () => {
  assert.equal(resolutionQuery({ name: "入住 某酒店", location: { name: "某酒店" } }), "某酒店");
  assert.equal(resolutionQuery({ name: "早餐：古铺良食" }), "古铺良食");
  assert.equal(resolutionQuery({ name: "孔氏南宗家庙" }), "孔氏南宗家庙");
  assert.equal(resolutionQuery({ name: "" }), null);
});

test("resolutionQuery: 餐饮条目优先用餐厅名（location.name 可能是街区/景点）", () => {
  assert.equal(
    resolutionQuery({ type: "meal", name: "周叔烤饼(水亭门店)", location: { name: "水亭门历史文化街区" } }),
    "周叔烤饼(水亭门店)",
  );
  // 条目名是泛称"午餐"时回退到 location.name
  assert.equal(resolutionQuery({ type: "meal", name: "午餐", location: { name: "知味观" } }), "知味观");
  // 旧式聚合名（含"候选"）没有可定位实体，回退到 location.name
  assert.equal(
    resolutionQuery({ type: "meal", name: "水亭门午餐 · 6个候选", location: { name: "水亭门历史文化街区" } }),
    "水亭门历史文化街区",
  );
});

test("planCentroid: 所有定位条目的质心", () => {
  const centroid = planCentroid([
    { location: { latitude: 30, longitude: 120 } },
    { location: { latitude: 32, longitude: 122 } },
    { name: "无坐标" },
  ]);
  assert.equal(centroid?.latitude, 31);
  assert.equal(centroid?.longitude, 121);
  assert.equal(planCentroid([{ name: "无坐标" }]), null);
});

test("resolvePlanCoordinates: 用权威坐标替换、失败的保留原值、已校准的跳过", async () => {
  const plan = makePlan();
  // 先把第二个条目标记为已校准
  plan.days![0].items![1].location!.source = "amap-resolved";

  const calls: string[] = [];
  const resolver = async (query: string) => {
    calls.push(query);
    if (query === "孔氏南宗家庙") return { latitude: 28.9608, longitude: 118.8765 };
    if (query === "古铺良食（柯城店）") return { latitude: 28.9651, longitude: 118.8582 };
    return null; // 其余解析失败
  };

  const result = await resolvePlanCoordinates(plan, resolver, { intervalMs: 0 });
  const items = result.plan.days![0].items!;

  assert.equal(result.resolved, 2);
  assert.equal(items[0].location!.latitude, 28.9608);
  assert.equal(items[0].location!.longitude, 118.8765);
  assert.equal(items[0].location!.source, "amap-resolved");
  // 已校准条目：原值不动且未发起请求
  assert.equal(items[1].location!.latitude, 28.9702);
  assert.ok(!calls.includes("衢州水亭门鹿鸣文院漫心府"));
  // 解析失败：保留原值
  assert.equal(items[3].location!.latitude, 28.97);
  assert.equal(items[3].location!.source, "search");
  // 原始 plan 不被修改（深拷贝语义）
  assert.equal(plan.days![0].items![0].location!.latitude, 28.9637);
});

test("resolvePlanCoordinates: 同名异地（解析结果偏差过大）拒绝写入", async () => {
  // 独立坐标数据：避免复用其他用例的解析缓存（缓存键 = 查询名 + 邻域）
  const plan: PlanJson = {
    title: "同名异地",
    days: [
      {
        items: [
          { name: "同名店", location: { name: "同名店", latitude: 31.23, longitude: 121.48, source: "amap" } },
        ],
      },
    ],
  };
  const resolver = async (query: string) => {
    if (query === "同名店") return { latitude: 31.5, longitude: 121.9 }; // 约 40+ 公里外的同名分店
    return null;
  };

  const result = await resolvePlanCoordinates(plan, resolver, { intervalMs: 0 });
  const item = result.plan.days![0].items![0];

  assert.equal(result.resolved, 0, "偏差过大的解析结果应被拒绝");
  assert.equal(item.location!.latitude, 31.23, "保留原坐标");
  assert.equal(item.location!.source, "amap", "不标记为已校准");
});

test("resolvePlanCoordinates: 无坐标数据时不做任何请求", async () => {
  let called = 0;
  const result = await resolvePlanCoordinates(
    { title: "空行程", days: [{ items: [{ name: "自由活动" }] }] },
    async () => {
      called += 1;
      return null;
    },
  );
  assert.equal(called, 0);
  assert.equal(result.resolved, 0);
});

test("queryVariants: 长精确短语的放宽序列", () => {
  assert.deepEqual(queryVariants("孔氏南宗家庙"), ["孔氏南宗家庙"]);
  assert.ok(queryVariants("衢湘记特色餐饮（芹江东路店）").includes("衢湘记特色餐饮"));
  assert.ok(queryVariants("衢州古城文化旅游区鹿鸣大草坪").includes("鹿鸣大草坪"));
  assert.ok(queryVariants("水亭门历史文化街区").includes("水亭门"));
});
