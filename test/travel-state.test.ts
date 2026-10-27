import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import {
  renderTravelState,
  updateTravelStateFromBrief,
  updateTravelStateFromItinerary,
  updateTravelStateFromItineraryJson,
} from "../src/core/travel-state.ts";

const title = "北京三日游";
const days = [
  {
    date: "2026-11-01",
    items: [{
      type: "visit",
      name: "故宫",
      place_type: "古迹",
      location: { latitude: 39.9163, longitude: 116.3972, source: "amap" },
      source: "amap",
    }],
  },
  {
    date: "2026-11-02",
    items: [{
      type: "visit",
      name: "国家博物馆",
      place_type: "博物馆",
      location: { latitude: 39.9042, longitude: 116.4074, source: "amap" },
      source: "amap",
    }],
  },
  {
    date: "2026-11-03",
    items: [{
      type: "visit",
      name: "颐和园",
      place_type: "公园",
      location: { latitude: 39.9999, longitude: 116.2755, source: "amap" },
      source: "amap",
    }],
  },
];

test("旅行状态保存地点类型、坐标与来源，并随 Session 持久化", () => {
  const state = updateTravelStateFromBrief(undefined, {
    title,
    destination: "北京",
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    pace: "适中",
    mustVisit: ["故宫"],
    avoid: ["长途赶路"],
  }, 1);
  const withItinerary = updateTravelStateFromItinerary(state, { title, days }, 2);

  assert.deepEqual(
    withItinerary.places.map((place) => ({
      name: place.name,
      day: place.day,
      placeType: place.placeType,
      source: place.source,
    })),
    [
      { name: "故宫", day: 1, placeType: "古迹", source: "amap" },
      { name: "国家博物馆", day: 2, placeType: "博物馆", source: "amap" },
      { name: "颐和园", day: 3, placeType: "公园", source: "amap" },
    ],
  );

  const session = new Session("travel-state");
  session.setTravelState(withItinerary);
  const restored = Session.fromData(session.toData());
  assert.deepEqual(restored.travelState, withItinerary);
  assert.match(renderTravelState(restored.travelState) ?? "", /故宫\[visit\/古迹\]/);
  assert.match(renderTravelState(restored.travelState) ?? "", /国家博物馆\[visit\/博物馆\]/);
});

test("按单日读取并合入状态时保留其他日期，不把 Day N 误标成 Day 1", () => {
  const initial = updateTravelStateFromItinerary(undefined, { title, days }, 1);
  const loadedDay3 = JSON.stringify({
    title,
    days: [{
      date: "2026-11-03",
      items: [{
        type: "visit",
        name: "天坛",
        place_type: "古迹",
        location: { latitude: 39.8822, longitude: 116.4066, source: "amap" },
      }],
    }],
  });
  const merged = updateTravelStateFromItineraryJson(initial, loadedDay3, 2, {
    merge: true,
    dayStart: 3,
  });

  assert.deepEqual(
    merged.places.map((place) => [place.day, place.name, place.placeType]),
    [
      [1, "故宫", "古迹"],
      [2, "国家博物馆", "博物馆"],
      [3, "天坛", "古迹"],
    ],
  );
  assert.equal(merged.places.some((place) => place.name === "颐和园"), false);
});

test("只读取后面的单日时，状态中的行程天数仍覆盖到该日", () => {
  const loadedDay5 = JSON.stringify({
    title: "北京五日游",
    days: [{
      date: "2026-11-05",
      items: [{
        type: "visit",
        name: "天坛",
        place_type: "古迹",
      }],
    }],
  });
  const state = updateTravelStateFromItineraryJson(undefined, loadedDay5, 1, {
    merge: true,
    dayStart: 5,
  });

  assert.equal(state.itinerary?.dayCount, 5);
  assert.equal(state.places[0].day, 5);
});

test("餐厅菜系也可作为结构化地点类型，供跨天去重和偏好判断", () => {
  const state = updateTravelStateFromItinerary(undefined, {
    title: "杭州两日游",
    days: [
      {
        date: "2026-12-01",
        items: [{
          type: "meal",
          subtype: "dinner",
          cuisine: "杭帮菜",
          name: "知味观",
          location: { latitude: 30.24, longitude: 120.15 },
        }],
      },
    ],
  }, 1);

  assert.equal(state.places[0].placeType, "杭帮菜");
  assert.match(renderTravelState(state) ?? "", /知味观\[meal\/杭帮菜\]/);
});
