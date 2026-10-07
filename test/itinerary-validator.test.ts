import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItinerary } from "../src/tools/itinerary-schema.ts";
import { renderQualityReport, validateItinerary } from "../src/tools/itinerary-validator.ts";

const COMPLETE_ITINERARY = parseItinerary({
  title: "杭州一日",
  days: [
    {
      date: "2026-10-01",
      items: [
        {
          id: "visit",
          time: "09:00",
          end_time: "11:30",
          type: "visit",
          name: "灵隐寺",
          location: { latitude: 30.241, longitude: 120.099, source: "amap" },
          ticket_price_per_person: 30,
          opening_hours: { opens: "06:00", closes: "20:00", source: "official" },
          source: "amap",
          confidence: "high",
        },
        {
          id: "lunch",
          time: "12:00",
          end_time: "13:00",
          type: "meal",
          subtype: "lunch",
          name: "知味观",
          location: { latitude: 30.24, longitude: 120.15, source: "amap" },
          cost_per_person: 68,
          source: "amap",
          confidence: "high",
        },
        {
          id: "transport",
          time: "13:30",
          end_time: "14:00",
          type: "transport",
          name: "知味观到河坊街",
          from: "知味观",
          to: "河坊街",
          transport_mode: "transit",
          source: "amap",
          confidence: "high",
        },
        {
          id: "dinner",
          time: "18:00",
          end_time: "19:00",
          type: "meal",
          subtype: "dinner",
          name: "新白鹿",
          location: { latitude: 30.25, longitude: 120.16, source: "amap" },
          cost_per_person: 80,
          source: "amap",
          confidence: "high",
        },
      ],
    },
  ],
});

test("itinerary schema: 兼容旧中文 type 并自动生成稳定 ID", () => {
  const itinerary = parseItinerary({
    title: "旧格式",
    days: [{ items: [{ time: "12:30", type: "午餐", name: "知味观", note: "人均 ¥68" }] }],
  });

  assert.equal(itinerary.days[0].items[0].id, "day-1-item-1");
  assert.equal(itinerary.days[0].items[0].type, "meal");
  assert.equal(itinerary.days[0].items[0].subtype, "lunch");
});

test("itinerary schema: 拒绝非法时间与重复 ID", () => {
  assert.throws(
    () => parseItinerary({ title: "x", days: [{ items: [{ time: "12:00", end_time: "12:00", name: "x" }] }] }),
    /end_time 必须晚于 time/,
  );
  assert.throws(
    () =>
      parseItinerary({
        title: "x",
        days: [{ items: [{ id: "same", name: "x" }, { id: "same", name: "y" }] }],
      }),
    /id 重复/,
  );
});

test("validate_itinerary: 完整行程通过核验", () => {
  const report = validateItinerary(COMPLETE_ITINERARY, { budget_per_person_yuan: 200 });

  assert.equal(report.status, "ok");
  assert.equal(report.score, 100);
  assert.deepEqual(report.issue_count, { P0: 0, P1: 0, P2: 0 });
});

test("validate_itinerary: 发现时间冲突、餐段、交通与预算问题", () => {
  const itinerary = parseItinerary({
    title: "问题行程",
    days: [
      {
        date: "2026-10-05",
        items: [
          {
            id: "visit",
            time: "09:00",
            end_time: "10:30",
            type: "visit",
            name: "灵隐寺",
            opening_hours: { opens: "10:00", closes: "17:00" },
            closed_on: ["Monday"],
          },
          { id: "visit-2", time: "10:00", end_time: "11:00", type: "visit", name: "灵隐寺" },
          {
            id: "transport",
            time: "11:00",
            planned_duration_min: 90,
            type: "transport",
            from: "灵隐寺",
            to: "西湖",
            name: "灵隐寺到西湖",
          },
          {
            id: "dinner",
            time: "15:00",
            end_time: "16:00",
            type: "meal",
            subtype: "dinner",
            name: "新白鹿",
            cost_per_person: 200,
          },
        ],
      },
    ],
  });

  const report = validateItinerary(itinerary, { budget_per_person_yuan: 100 });
  const codes = report.issues.map((item) => item.code);

  assert.equal(report.status, "invalid");
  assert.ok(codes.includes("time-overlap"));
  assert.ok(codes.includes("closed-on-date"));
  assert.ok(codes.includes("outside-opening-hours"));
  assert.ok(codes.includes("duplicate-place"));
  assert.ok(codes.includes("missing-lunch"));
  assert.ok(codes.includes("long-transport"));
  assert.ok(codes.includes("meal-outside-window"));
  assert.ok(codes.includes("budget-exceeded"));
  assert.match(renderQualityReport(report), /## P0/);
});

test("validate_itinerary: 空壳返程日（只有吃饭没有游览）必须被拦截", () => {
  const itinerary = parseItinerary({
    title: "杭州两日游",
    days: [
      {
        items: [
          { time: "09:00", end_time: "11:00", type: "visit", name: "西湖" },
          { time: "12:00", end_time: "13:00", type: "meal", subtype: "lunch", name: "知味观" },
          { time: "18:00", end_time: "19:00", type: "meal", subtype: "dinner", name: "新白鹿" },
        ],
      },
      {
        items: [
          { time: "08:00", end_time: "09:00", type: "meal", subtype: "breakfast", name: "早餐" },
          { time: "10:00", end_time: "11:00", type: "accommodation", name: "退房" },
          { time: "11:30", end_time: "12:30", type: "meal", subtype: "lunch", name: "午餐" },
          { time: "17:30", end_time: "18:30", type: "meal", subtype: "dinner", name: "假晚餐骗校验" },
          { time: "19:00", end_time: "19:40", type: "transport", name: "去车站" },
        ],
      },
    ],
  });

  const report = validateItinerary(itinerary);
  const noActivity = report.issues.find((item) => item.code === "no-activity");
  assert.ok(noActivity !== undefined, "空壳日应触发 no-activity");
  assert.equal(noActivity.day, 2);
  assert.match(noActivity.message, /没有任何游览安排/);
});

test("validate_itinerary: 标题天数与实际天数不符（支持中文数字）", () => {
  const itinerary = parseItinerary({
    title: "杭州三日游",
    days: [
      {
        items: [
          { time: "09:00", end_time: "11:00", type: "visit", name: "西湖" },
          { time: "12:00", end_time: "13:00", type: "meal", subtype: "lunch", name: "知味观" },
          { time: "18:00", end_time: "19:00", type: "meal", subtype: "dinner", name: "新白鹿" },
        ],
      },
    ],
  });

  const report = validateItinerary(itinerary);
  const mismatch = report.issues.find((item) => item.code === "title-day-mismatch");
  assert.ok(mismatch !== undefined, "三日游只排 1 天应触发 title-day-mismatch");
  assert.match(mismatch.message, /3日游.*1 天/);
});

test("validate_itinerary: 空间断层——相邻定位条目距离超阈值且无交通衔接", () => {
  const itinerary = parseItinerary({
    title: "断层测试",
    days: [{
      items: [
        {
          time: "09:00", end_time: "11:00", type: "visit", name: "西湖",
          location: { latitude: 30.25, longitude: 120.15 },
        },
        {
          time: "11:30", end_time: "13:00", type: "meal", subtype: "lunch", name: "远处餐厅",
          location: { latitude: 30.35, longitude: 120.35 }, // 约 20 公里外
        },
        {
          time: "14:00", end_time: "16:00", type: "visit", name: "灵隐寺",
          location: { latitude: 30.24, longitude: 120.10 },
        },
      ],
    }],
  });

  const report = validateItinerary(itinerary);
  const gaps = report.issues.filter((item) => item.code === "spatial-gap");
  assert.ok(gaps.length >= 1, "应检测到空间断层");
  assert.match(gaps[0].message, /西湖.*远处餐厅.*公里/);
});

test("validate_itinerary: 有交通衔接时不报空间断层", () => {
  const itinerary = parseItinerary({
    title: "衔接测试",
    days: [{
      items: [
        {
          time: "09:00", end_time: "11:00", type: "visit", name: "西湖",
          location: { latitude: 30.25, longitude: 120.15 },
        },
        {
          time: "11:00", end_time: "12:00", type: "transport", name: "西湖到远处",
          from: "西湖", to: "远处餐厅", transport_mode: "driving",
        },
        {
          time: "12:00", end_time: "13:00", type: "meal", subtype: "lunch", name: "远处餐厅",
          location: { latitude: 30.35, longitude: 120.35 },
        },
      ],
    }],
  });

  const report = validateItinerary(itinerary);
  assert.ok(!report.issues.some((item) => item.code === "spatial-gap"), "有交通衔接不应报断层");
});

test("validate_itinerary: 跨天重复景点提示", () => {
  const itinerary = parseItinerary({
    title: "重游测试",
    days: [
      { items: [{ time: "09:00", type: "visit", name: "灵隐寺" }] },
      { items: [{ time: "10:00", type: "visit", name: "灵隐寺" }] },
    ],
  });

  const report = validateItinerary(itinerary);
  const dup = report.issues.find((item) => item.code === "cross-day-duplicate");
  assert.ok(dup !== undefined, "跨天重复应触发提示");
  assert.match(dup.message, /第 1、2 天/);
});
