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
          id: "lunch-2",
          type: "meal",
          subtype: "lunch",
          name: "绿茶餐厅",
          location: { latitude: 30.245, longitude: 120.145, source: "amap" },
          cost_per_person: 45,
          source: "amap",
          confidence: "medium",
        },
        {
          id: "lunch-3",
          type: "meal",
          subtype: "lunch",
          name: "外婆家",
          location: { latitude: 30.25, longitude: 120.155, source: "amap" },
          cost_per_person: 60,
          source: "amap",
          confidence: "medium",
        },
        {
          id: "lunch-4",
          type: "meal",
          subtype: "lunch",
          name: "楼外楼",
          location: { latitude: 30.247, longitude: 120.14, source: "amap" },
          cost_per_person: 150,
          source: "amap",
          confidence: "medium",
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
          id: "visit-2",
          time: "14:30",
          end_time: "17:00",
          type: "visit",
          name: "河坊街",
          location: { latitude: 30.242, longitude: 120.169, source: "amap" },
          opening_hours: { opens: "00:00", closes: "23:59", source: "official" },
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
        {
          id: "dinner-2",
          type: "meal",
          subtype: "dinner",
          name: "弄堂里",
          location: { latitude: 30.252, longitude: 120.158, source: "amap" },
          cost_per_person: 65,
          source: "amap",
          confidence: "medium",
        },
        {
          id: "dinner-3",
          type: "meal",
          subtype: "dinner",
          name: "奎元馆",
          location: { latitude: 30.248, longitude: 120.162, source: "amap" },
          cost_per_person: 55,
          source: "amap",
          confidence: "medium",
        },
        {
          id: "dinner-4",
          type: "meal",
          subtype: "dinner",
          name: "西湖春天",
          location: { latitude: 30.253, longitude: 120.165, source: "amap" },
          cost_per_person: 110,
          source: "amap",
          confidence: "medium",
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

test("validate_itinerary: 空间断层——相邻景点距离超阈值且无交通衔接", () => {
  const itinerary = parseItinerary({
    title: "断层测试",
    days: [{
      items: [
        {
          time: "09:00", end_time: "11:00", type: "visit", name: "西湖",
          location: { latitude: 30.25, longitude: 120.15 },
        },
        {
          time: "11:30", end_time: "13:00", type: "meal", subtype: "lunch", name: "午餐候选",
          location: { latitude: 30.25, longitude: 120.16 }, // 餐厅不参与空间核验
        },
        {
          time: "14:00", end_time: "16:00", type: "visit", name: "远郊景点",
          location: { latitude: 30.15, longitude: 120.00 }, // 距西湖约 18 公里
        },
      ],
    }],
  });

  const report = validateItinerary(itinerary);
  const gaps = report.issues.filter((item) => item.code === "spatial-gap");
  assert.ok(gaps.length >= 1, "应检测到空间断层");
  assert.match(gaps[0].message, /西湖.*远郊景点.*公里/);
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
          time: "11:00", end_time: "12:00", type: "transport", name: "西湖到远郊景点",
          from: "西湖", to: "远郊景点", transport_mode: "driving",
        },
        {
          time: "14:00", end_time: "16:00", type: "visit", name: "远郊景点",
          location: { latitude: 30.15, longitude: 120.00 },
        },
      ],
    }],
  });

  const report = validateItinerary(itinerary);
  assert.ok(!report.issues.some((item) => item.code === "spatial-gap"), "有交通衔接不应报断层");
});

test("validate_itinerary: 餐厅候选不参与空间与路线核验", () => {
  // 两个相邻景点 + 一个远处的定时餐厅候选（无交通衔接）+ 一个无时间的晚餐候选
  const itinerary = parseItinerary({
    title: "候选餐测试",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "A景点", location: { latitude: 30.0, longitude: 120.000 } },
        { time: "10:00", type: "visit", name: "B景点", location: { latitude: 30.0, longitude: 120.010 } },
        { time: "12:00", type: "meal", subtype: "lunch", name: "远处午餐候选", location: { latitude: 30.3, longitude: 120.3 } },
        { type: "meal", subtype: "dinner", name: "晚餐候选（无时间）", location: { latitude: 30.2, longitude: 120.2 } },
      ],
    }],
  });

  const report = validateItinerary(itinerary);
  assert.ok(!report.issues.some((item) => item.code === "spatial-gap"), "餐厅候选不触发空间断层");
  assert.ok(!report.issues.some((item) => item.code === "missing-time"), "餐饮候选可无 time");
  assert.ok(!report.issues.some((item) => item.code === "route-backtracking"), "餐厅不参与路线折返");
  assert.ok(!report.issues.some((item) => item.code === "missing-lunch"), "午餐候选已提供");
  assert.ok(!report.issues.some((item) => item.code === "missing-dinner"), "晚餐候选已提供");
});

test("validate_itinerary: 多家餐厅合并进一条 meal 触发 P1（每条必须独立、坐标可定位）", () => {
  const itinerary = parseItinerary({
    title: "合并候选测试",
    days: [{
      items: [
        {
          id: "merged",
          time: "12:00", end_time: "13:00",
          type: "meal", subtype: "lunch",
          name: "水亭门午餐 · 6个候选",
          note: "候选（附评分/人均）：① 周叔烤饼 4.6｜¥23 ② 汪馒头 4.5｜¥27 ③ 小胖子排档 4.7｜¥61",
          location: { name: "水亭门历史文化街区", latitude: 30.25, longitude: 120.15 },
        },
        {
          id: "single",
          type: "meal", subtype: "lunch",
          name: "周叔烤饼(水亭门店)",
          note: "评分 4.6｜人均 ¥23",
          location: { name: "周叔烤饼(水亭门店)", latitude: 30.251, longitude: 120.151 },
        },
      ],
    }],
  });

  const merged = validateItinerary(itinerary).issues.filter((item) => item.code === "meal-merged-candidates");
  assert.equal(merged.length, 1, "只应命中合并条目，独立餐厅不误报");
  assert.equal(merged[0].level, "P1");
  assert.equal(merged[0].item_id, "merged");
  assert.match(merged[0].message, /独立成条/);
});

test("validate_itinerary: 餐厅坐标与景点重合触发标记遮挡（同名 P1 / 近邻 P2）", () => {
  const itinerary = parseItinerary({
    title: "遮挡测试",
    days: [{
      items: [
        {
          id: "temple",
          time: "10:00", end_time: "11:30",
          type: "visit", name: "孔氏南宗家庙",
          location: { name: "衢州孔氏南宗家庙(西门)", latitude: 28.96042, longitude: 118.8767 },
        },
        {
          // 直接把景点坐标当成"孔庙周边午餐"的定位 → P1
          id: "copied",
          time: "12:00", end_time: "13:00",
          type: "meal", subtype: "lunch", name: "孔庙周边午餐",
          location: { name: "衢州孔氏南宗家庙(西门)", latitude: 28.96042, longitude: 118.8767 },
        },
        {
          // 与景点几乎完全重合（约 9 米）、名称不同的餐厅 → P2 提示确认
          id: "inside",
          type: "meal", subtype: "dinner", name: "孔庙景区内素斋馆",
          location: { name: "孔庙景区内素斋馆", latitude: 28.96050, longitude: 118.8767 },
        },
        {
          // 远离景点 → 不提示
          id: "far",
          type: "meal", subtype: "dinner", name: "新桥街面馆",
          location: { name: "新桥街面馆", latitude: 28.965, longitude: 118.88 },
        },
      ],
    }],
  });

  const overlaps = validateItinerary(itinerary).issues.filter((item) => item.code === "meal-marker-overlap");
  assert.equal(overlaps.length, 2, "仅命中两处重合，且不误报远离的餐厅");
  const copied = overlaps.find((item) => item.item_id === "copied");
  assert.equal(copied?.level, "P1");
  assert.match(copied?.message ?? "", /盖住景点标记/);
  const inside = overlaps.find((item) => item.item_id === "inside");
  assert.equal(inside?.level, "P2");
});

test("validate_itinerary: 景点缺少游玩时长 → P1（时间管理核心）", () => {
  const itinerary = parseItinerary({
    title: "时长缺失",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "A景点", location: { latitude: 30.0, longitude: 120.0 } },
      ],
    }],
  });
  const issues = validateItinerary(itinerary).issues.filter((item) => item.code === "missing-duration");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "P1");
  assert.match(issues[0].message, /缺少游玩时长/);
});

test("validate_itinerary: 时间线空档必须补齐（P1）", () => {
  const itinerary = parseItinerary({
    title: "空档测试",
    days: [{
      items: [
        { id: "a", time: "09:00", end_time: "11:00", type: "visit", name: "A景点", location: { latitude: 30.0, longitude: 120.0 } },
        { id: "b", time: "14:00", end_time: "16:00", type: "visit", name: "B景点", location: { latitude: 30.0, longitude: 120.01 } },
      ],
    }],
  });
  const gaps = validateItinerary(itinerary).issues.filter((item) => item.code === "timeline-gap");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].level, "P1");
  assert.match(gaps[0].message, /11:00 结束.*14:00 开始.*空档未规划/);
});

test("validate_itinerary: 相邻景点要留赶路时间，紧挨着 → P1", () => {
  const tight = parseItinerary({
    title: "赶路不足",
    days: [{
      items: [
        { time: "09:00", end_time: "11:00", type: "visit", name: "A景点", location: { latitude: 30.0, longitude: 120.0 } },
        // 约 1.9 公里但时间首尾相接：没有留赶路时间
        { time: "11:00", end_time: "13:00", type: "visit", name: "B景点", location: { latitude: 30.0, longitude: 120.02 } },
      ],
    }],
  });
  const issues = validateItinerary(tight).issues.filter((item) => item.code === "transfer-too-tight");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "P1");
  assert.match(issues[0].message, /赶路/);

  // 留出 30 分钟赶路时间后不再报
  const spaced = parseItinerary({
    title: "赶路充足",
    days: [{
      items: [
        { time: "09:00", end_time: "11:00", type: "visit", name: "A景点", location: { latitude: 30.0, longitude: 120.0 } },
        { time: "11:30", end_time: "13:30", type: "visit", name: "B景点", location: { latitude: 30.0, longitude: 120.02 } },
      ],
    }],
  });
  assert.ok(!validateItinerary(spaced).issues.some((item) => item.code === "transfer-too-tight"));
});

test("validate_itinerary: 低分景点提示核对同区域替代（P2）", () => {
  const itinerary = parseItinerary({
    title: "低分景点",
    days: [{
      items: [
        {
          id: "low", time: "09:00", end_time: "11:00",
          type: "visit", name: "某某小吃博物馆",
          note: "高德评分4.2，街区里的博物馆",
          location: { latitude: 30.0, longitude: 120.0 },
        },
        {
          id: "high", time: "13:00", end_time: "15:00",
          type: "visit", name: "某某纪念馆",
          note: "高德评分4.7",
          location: { latitude: 30.01, longitude: 120.01 },
        },
        {
          // 非博物馆类的低分点（步道）：不提示核对替代
          id: "scenic", time: "16:00", end_time: "17:00",
          type: "visit", name: "某某江边步道",
          note: "高德评分4.0，日落最佳",
          location: { latitude: 30.02, longitude: 120.0 },
        },
      ],
    }],
  });
  const issues = validateItinerary(itinerary).issues.filter((item) => item.code === "low-rating-visit");
  assert.equal(issues.length, 1, "只应命中低分景点");
  assert.equal(issues[0].item_id, "low");
  assert.equal(issues[0].level, "P2");
});

test("validate_itinerary: 早餐候选离当天起点过远提示（P2）", () => {
  const away = parseItinerary({
    title: "早餐脱节",
    days: [
      {
        items: [
          { id: "h1", time: "21:00", end_time: "21:40", type: "rest", name: "回酒店休息",
            location: { name: "漫心府酒店", latitude: 30.0, longitude: 120.0 } },
        ],
      },
      {
        items: [
          { time: "08:00", end_time: "08:40", type: "rest", name: "早餐 · 候选餐厅自选" },
          { type: "meal", subtype: "breakfast", name: "远处包子店",
            location: { name: "远处包子店", latitude: 30.02, longitude: 120.02 } },
          { time: "09:00", end_time: "11:00", type: "visit", name: "景点",
            location: { latitude: 30.021, longitude: 120.021 } },
        ],
      },
    ],
  });
  const issues = validateItinerary(away).issues.filter((item) => item.code === "breakfast-far-from-start");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "P2");
  assert.equal(issues[0].day, 2);
  assert.match(issues[0].message, /起点/);

  // 起点附近有早餐候选 → 不提示
  const near = parseItinerary({
    title: "早餐顺路",
    days: [
      {
        items: [
          { id: "h1", time: "21:00", end_time: "21:40", type: "rest", name: "回酒店休息",
            location: { name: "漫心府酒店", latitude: 30.0, longitude: 120.0 } },
        ],
      },
      {
        items: [
          { time: "08:00", end_time: "08:40", type: "rest", name: "早餐 · 候选餐厅自选" },
          { type: "meal", subtype: "breakfast", name: "楼下包子店",
            location: { name: "楼下包子店", latitude: 30.001, longitude: 120.001 } },
          { time: "09:00", end_time: "11:00", type: "visit", name: "景点",
            location: { latitude: 30.021, longitude: 120.021 } },
        ],
      },
    ],
  });
  assert.ok(!validateItinerary(near).issues.some((item) => item.code === "breakfast-far-from-start"));
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

test("validate_itinerary: 当日路线折返检测（P1 + 建议顺序）", () => {
  // 实际顺序：A(近) → D(远) → B(近) → E(远) —— 来回横跳
  const zigzag = parseItinerary({
    title: "折返测试",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "A点", location: { latitude: 30.0, longitude: 120.000 } },
        { time: "10:00", type: "visit", name: "远端D", location: { latitude: 30.0, longitude: 120.040 } },
        { time: "11:00", type: "visit", name: "B点", location: { latitude: 30.0, longitude: 120.010 } },
        { time: "12:00", type: "visit", name: "远端E", location: { latitude: 30.0, longitude: 120.045 } },
      ],
    }],
  });
  const zigzagReport = validateItinerary(zigzag);
  const flag = zigzagReport.issues.find((item) => item.code === "route-backtracking");
  assert.ok(flag !== undefined, "折返顺序应触发 route-backtracking");
  assert.equal(flag.level, "P1");
  assert.match(flag.message, /建议顺序/);
  assert.match(flag.message, /A点 → B点 → 远端D → 远端E/);

  // 聚类顺序：A → B → D → E —— 不应触发
  const clustered = parseItinerary({
    title: "聚类测试",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "A点", location: { latitude: 30.0, longitude: 120.000 } },
        { time: "10:00", type: "visit", name: "B点", location: { latitude: 30.0, longitude: 120.010 } },
        { time: "11:00", type: "visit", name: "远端D", location: { latitude: 30.0, longitude: 120.040 } },
        { time: "12:00", type: "visit", name: "远端E", location: { latitude: 30.0, longitude: 120.045 } },
      ],
    }],
  });
  assert.ok(!validateItinerary(clustered).issues.some((item) => item.code === "route-backtracking"), "聚类顺序不应触发");
});

test("validate_itinerary: 郊区一日游往返不计为折返（首尾固定）", () => {
  // 早餐(市内) → 远郊景点(约 38 公里) → 回城午餐 → 市内晚餐：远郊往返是行程固有
  const itinerary = parseItinerary({
    title: "一日游测试",
    days: [{
      items: [
        { time: "07:30", type: "meal", subtype: "breakfast", name: "早餐", location: { latitude: 30.0, longitude: 120.000 } },
        { time: "10:00", type: "visit", name: "远郊景点", location: { latitude: 30.0, longitude: 120.400 } },
        { time: "15:00", type: "meal", subtype: "lunch", name: "回城午餐", location: { latitude: 30.0, longitude: 120.010 } },
        { time: "18:00", type: "meal", subtype: "dinner", name: "市内晚餐", location: { latitude: 30.0, longitude: 120.020 } },
      ],
    }],
  });
  const report = validateItinerary(itinerary);
  assert.ok(
    !report.issues.some((item) => item.code === "route-backtracking"),
    "远郊往返是固有行程，不应误报折返",
  );
});

test("validate_itinerary: 餐食候选不足触发 P2 提示", () => {
  const few = parseItinerary({
    title: "候选不足",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "景点", location: { latitude: 30.0, longitude: 120.0 } },
        { type: "meal", subtype: "lunch", name: "午餐候选", location: { latitude: 30.0, longitude: 120.001 } },
        { type: "meal", subtype: "dinner", name: "晚餐候选", location: { latitude: 30.0, longitude: 120.002 } },
      ],
    }],
  });
  const issues = validateItinerary(few).issues.filter((item) => item.code === "few-meal-options");
  assert.equal(issues.length, 2);
  assert.equal(issues[0].level, "P2");
  assert.match(issues[0].message, /午餐候选只有 1 个，建议提供 4-6 个/);

  const mealCandidates = (subtype: string, longitudeBase: number) =>
    Array.from({ length: 4 }, (_, index) => ({
      type: "meal",
      subtype,
      name: `${subtype === "lunch" ? "午餐" : "晚餐"}候选${index + 1}`,
      location: { latitude: 30.0, longitude: longitudeBase + index * 0.001 },
    }));
  const enough = parseItinerary({
    title: "候选充足",
    days: [{
      items: [
        { time: "09:00", type: "visit", name: "景点", location: { latitude: 30.0, longitude: 120.0 } },
        ...mealCandidates("lunch", 120.001),
        ...mealCandidates("dinner", 120.010),
      ],
    }],
  });
  assert.ok(!validateItinerary(enough).issues.some((item) => item.code === "few-meal-options"));
});

test("validate_itinerary: 多候选餐食按均价估算预算，不重复累加", () => {
  const mealCandidates = (subtype: string, longitudeBase: number) =>
    Array.from({ length: 4 }, (_, index) => ({
      type: "meal",
      subtype,
      name: `${subtype === "lunch" ? "午餐" : "晚餐"}候选${index + 1}`,
      cost_per_person: 100,
      location: { latitude: 30.0, longitude: longitudeBase + index * 0.001 },
      source: "amap",
      confidence: "medium",
    }));
  const itinerary = parseItinerary({
    title: "预算均价",
    days: [{
      items: [
        {
          time: "09:00", type: "visit", name: "景点", ticket_price_per_person: 30,
          location: { latitude: 30.0, longitude: 120.0 }, source: "amap", confidence: "high",
        },
        ...mealCandidates("lunch", 120.001),
        ...mealCandidates("dinner", 120.010),
      ],
    }],
  });
  // 实际人均 ≈ 30 + 100 + 100 = 230；若把 8 个候选全累加则为 830，会误报超预算
  const report = validateItinerary(itinerary, { budget_per_person_yuan: 250 });
  assert.ok(!report.issues.some((item) => item.code === "budget-exceeded"), "候选不应重复计费");
});
