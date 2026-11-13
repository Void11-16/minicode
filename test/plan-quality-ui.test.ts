import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, Script } from "node:vm";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("      function qualityIssuesForDay("), html.indexOf("      function renderMapSide("));

class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  open = false;
  attributes: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName = "div") { this.tagName = tagName; }
  appendChild(child: Element) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  get text(): string { return [this.textContent, ...this.children.map((child) => child.text)].join("\n"); }
  find(tag: string): Element[] { return [...(this.tagName === tag ? [this] : []), ...this.children.flatMap((child) => child.find(tag))]; }
}

function harness(quality: unknown) {
  const context = createContext({
    document: { createElement: (tag: string) => new Element(tag) },
    currentItinerary: { title: "计划", days: [
      { date: "2026-11-14", items: [{ id: "a", name: "故宫" }] },
      { date: "2026-11-15", items: [{ id: "b", name: "天坛" }] },
    ], quality },
  });
  new Script(source).runInContext(context);
  return context;
}

const quality = {
  status: "needs_revision", score: 98,
  issues: [
    { level: "P1", kind: "error", code: "outside-opening-hours", day: 1, item_id: "a", message: "故宫的安排超出开放时间" },
    { level: "P2", kind: "pending", code: "missing-opening-hours", day: 2, item_id: "b", message: "天坛开放时间未核实" },
    { level: "P1", kind: "pending", code: "unverified-route", day: 1, item_id: "route", related_days: [1, 2], related_item_ids: ["b"], message: "跨日交通尚未核验" },
    { level: "P1", kind: "error", code: "missing-required-visit", message: "缺少全程必去点" },
    { level: "P2", kind: "advice", code: "long-transport", day: 1, message: "预留长途缓冲" },
  ],
  meal_notes: [{ level: "P2", day: 1, message: "晚餐可再补充候选" }],
};

test("行程上方按需修订、待确认、建议和餐饮分组，高分不隐藏具体问题", () => {
  const ctx = harness(quality), root = new Element();
  ctx.appendPlanQuality(root, -1);
  assert.match(root.text, /全程 2 项需修订、2 项待确认/);
  for (const issue of [...quality.issues, ...quality.meal_notes]) assert.ok(root.text.includes(issue.message));
  const groups = root.find("details");
  assert.deepEqual(groups.map((group) => group.children[0]!.textContent), ["需修订 · 2 项", "待确认 · 2 项", "行程建议 · 1 项", "餐饮参考 · 1 项"]);
  assert.deepEqual(groups.map((group) => group.open), [true, true, false, false]);
  assert.match(root.text, /第 2 天 · 2026-11-15 · 天坛/);
});

test("单日面板只显示当天、相关跨日和全程问题；换日期不串问题", () => {
  const ctx = harness(quality), first = new Element(), second = new Element();
  ctx.appendPlanQuality(first, 0); ctx.appendPlanQuality(second, 1);
  assert.ok(first.text.includes("故宫的安排超出开放时间"));
  assert.ok(!first.text.includes("天坛开放时间未核实"));
  assert.ok(second.text.includes("天坛开放时间未核实"));
  assert.ok(!second.text.includes("故宫的安排超出开放时间"));
  for (const panel of [first, second]) {
    assert.ok(panel.text.includes("缺少全程必去点"));
    assert.ok(panel.text.includes("跨日交通尚未核验"));
  }
});

test("条目提醒按日期和稳定 ID 关联，缺少 ID 不误贴全日问题", () => {
  const ctx = harness(quality), body = new Element();
  ctx.appendItemQuality(body, { id: "b" }, 2);
  assert.match(body.text, /待确认：天坛开放时间未核实/);
  assert.match(body.text, /跨日交通尚未核验/);
  const otherDay = new Element(); ctx.appendItemQuality(otherDay, { id: "b" }, 1);
  assert.ok(!otherDay.text.includes("天坛开放时间未核实"));
  const noId = new Element(); ctx.appendItemQuality(noId, { name: "旧条目" }, 1);
  assert.equal(noId.children.length, 0);
});

test("无报告、清空问题和切换行程时均明确更新状态，问题文本仅作为文字呈现", () => {
  const ctx = harness(null), unavailable = new Element(); ctx.appendPlanQuality(unavailable, -1);
  assert.match(unavailable.text, /暂无法完成质量检查/);
  ctx.currentItinerary.quality = { status: "ok", issues: [], meal_notes: [] };
  const valid = new Element(); ctx.appendPlanQuality(valid, -1);
  assert.match(valid.text, /未发现质量问题/);
  assert.equal(valid.find("details").length, 0);
  const malicious = "<img src=x onerror=alert(1)>";
  ctx.currentItinerary.quality = { issues: [{ kind: "pending", message: malicious }] };
  const textOnly = new Element(); ctx.appendPlanQuality(textOnly, -1);
  assert.ok(textOnly.text.includes(malicious));
  assert.equal(textOnly.find("img").length, 0);
});

test("必去目标在行程上方显示实际安排、预留和覆盖依据，地点核验与其他确认事项分开", () => {
  const ctx = harness(quality);
  ctx.currentItinerary.required_visit_goals = [
    { name: "郭庄", status: "scheduled", identity_verified: true, date: "2026-11-14", covered_by: "西湖风景名胜区", relation: "geographic_area" },
    { name: "大石雕", status: "reserved", identity_verified: true, date: "2026-11-15", covered_by: "故宫", relation: "scenic_child" },
    { name: "待定公园", status: "unresolved", identity_verified: false },
  ];
  const root = new Element(); ctx.appendPlanQuality(root, 0);
  assert.match(root.text, /必去目标 · 已安排 1\/3/);
  assert.match(root.text, /郭庄：已安排.*由西湖风景名胜区覆盖（区域包含）/);
  assert.match(root.text, /大石雕：已预留，待保存游览/);
  assert.match(root.text, /待定公园：待识别.*地点身份待核验/);
  assert.match(root.text, /不代表开放时间、预约和路线全部确认/);
  assert.equal(root.find("details")[0]!.open, true);
});

test("没有详细时间时也展示全部日期的基础安排，已查未知与日内达标分别展示", () => {
  const ctx = harness({ issues: [{ level: "P1", code: "missing-time", message: "详细时间尚待安排" }], meal_notes: [] });
  ctx.currentItinerary.days = [];
  ctx.currentItinerary.outline = [{ date: "2026-11-10", visits: [{ name: "甲园" }] }, { date: "2026-11-11", visits: [{ name: "乙园" }] }];
  ctx.currentItinerary.planning_layers = { expected_days: 2, basic_days: 2, checked_days: 1, scheduled_days: 0, ready_days: 0, days: [
    { date: "2026-11-10", feasibility: "checked", schedule: "missing", visits: [{ name: "甲园", pending: ["闭馆规则待确认"], conflicts: [] }] },
    { date: "2026-11-11", feasibility: "conflict", schedule: "missing", visits: [{ name: "乙园", pending: [], conflicts: ["当天已核验闭馆"] }] },
  ] };
  const root = new Element(); ctx.appendPlanQuality(root, -1);
  assert.match(root.text, /基础安排 2\/2 天.*可行性已查 1\/2 天.*时间已排 0\/2 天.*日内达标 0\/2 天/);
  assert.match(root.text, /2026-11-10：甲园.*可行性已查.*时间路线待排.*闭馆规则待确认/);
  assert.match(root.text, /2026-11-11：乙园.*可行性需修改.*当天已核验闭馆/);
  assert.match(root.text, /草稿不算完成/); assert.match(root.text, /详细时间尚待安排/);
});
