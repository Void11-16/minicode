import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import {
  assessToolBudget,
  budgetGuidance,
  type ToolBudgetAssessment,
} from "../src/runtime/tool-budget.ts";

const PLAN = {
  title: "杭州一日游",
  days: [
    {
      date: "2026-10-19",
      items: [
        {
          id: "west-lake",
          time: "09:00",
          end_time: "10:00",
          type: "visit",
          name: "西湖",
          location: { latitude: 30.24, longitude: 120.15 },
          source: "amap",
          confidence: "high",
          opening_hours: { opens: "08:00", closes: "18:00", source: "official" },
        },
        {
          id: "lingyin",
          time: "12:00",
          end_time: "13:00",
          type: "visit",
          name: "灵隐寺",
          note: "坐标待核实",
          location: { source: "amap" },
          source: "amap",
          confidence: "high",
          opening_hours: { opens: "07:00", closes: "18:00", source: "official" },
        },
      ],
    },
  ],
};

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "minicode-budget-"));
}

function saveHistory(session: Session, file: string): void {
  session.add("assistant", "", {
    toolCalls: [
      {
        id: "save-1",
        name: "save_itinerary",
        arguments: '{"budget_per_person_yuan":1000}',
      },
    ],
  });
  session.add("tool", `${file}（结构化数据）`, {
    toolCallId: "save-1",
    toolName: "save_itinerary",
  });
}

function options(
  rootDir: string,
  session: Session,
  currentLimit = 12,
): Parameters<typeof assessToolBudget>[0] {
  return {
    rootDir,
    session,
    initialLimit: 12,
    currentLimit,
    ceiling: 150,
    extensionStep: 15,
  };
}

test("工具预算评估: 没有已保存版本时不编造评分，仍允许追加生成", async () => {
  const root = await tempRoot();
  const session = new Session("sess_budget_empty");
  session.add("user", "帮我规划杭州一日游");

  const assessment = await assessToolBudget(options(root, session));

  assert.equal(assessment.quality.available, false);
  assert.match(assessment.quality.unavailable_reason ?? "", /还没有成功落盘/);
  assert.equal(assessment.repair.canImprove, true);
  assert.match(assessment.repair.summary, /不能保证一定通过/);
  assert.equal(assessment.suggestedAdditionalRounds, 15);
  assert.match(assessment.explanation, /动态工具预算为 12 轮/);
  assert.match(budgetGuidance(assessment), /当前没有可评估的已保存行程/);
});

test("工具预算评估: 重新校验已保存行程，区分可修复项与外部不确定项", async () => {
  const root = await tempRoot();
  const plans = join(root, "plans");
  const file = join(plans, "杭州一日游.json");
  await mkdir(plans, { recursive: true });
  await writeFile(file, JSON.stringify(PLAN), "utf8");

  const session = new Session("sess_budget_saved");
  saveHistory(session, file);
  const assessment = await assessToolBudget(options(root, session));

  assert.equal(assessment.quality.available, true);
  assert.equal(assessment.quality.title, "杭州一日游");
  assert.equal(assessment.quality.status, "needs_revision");
  assert.equal(assessment.quality.score, 93);
  assert.equal(assessment.quality.strict_pass, false);
  assert.deepEqual(assessment.quality.issue_count, { P0: 0, P1: 1, P2: 1 });
  assert.equal(assessment.quality.meal_note_count, 2);
  assert.equal(assessment.quality.potential_score, 99);
  assert.equal(assessment.repair.canImprove, true);
  assert.match(assessment.repair.summary, /理论上可把评分提升到约 99/);
  assert.match(assessment.repair.summary, /1 项依赖外部信息/);

  const byCode = new Map(assessment.repair.items.map((item) => [item.code, item]));
  assert.equal(byCode.get("timeline-gap")?.category, "tool");
  assert.equal(byCode.get("unverified-coordinates")?.category, "uncertain");

  const guidance = budgetGuidance(assessment);
  assert.match(guidance, /用户已授权追加工具轮次/);
  assert.match(guidance, /当前已保存版本「杭州一日游」评分 93\/100/);
  assert.match(guidance, /timeline-gap/);
  assert.doesNotMatch(guidance, /unverified-coordinates/);
});

test("工具预算评估: 参数压缩后仍保留人均预算口径", async () => {
  const root = await tempRoot();
  const plans = join(root, "plans");
  const file = join(plans, "北京一日游.json");
  await mkdir(plans, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      ...PLAN,
      days: [{
        ...PLAN.days[0],
        items: PLAN.days[0].items.map((item, index) => ({
          ...item,
          ...(index === 0 ? { cost_per_person: 1500 } : {}),
        })),
      }],
    }),
    "utf8",
  );

  const session = new Session("sess_budget_compacted");
  session.add("assistant", "", {
    toolCalls: [{
      id: "save-compacted",
      name: "save_itinerary",
      arguments: JSON.stringify({
        budget_per_person_yuan: 1000,
        note: "用于触发历史参数压缩".repeat(200),
      }),
    }],
  });
  session.add("tool", `${file}（结构化数据）`, {
    toolCallId: "save-compacted",
    toolName: "save_itinerary",
  });
  assert.equal(session.compactCompletedToolCalls(undefined, 0), 1);

  const assessment = await assessToolBudget(options(root, session));
  assert.ok(
    assessment.repair.items.some((item) => item.code === "budget-exceeded"),
    "预算约束应从未进入 Prompt 的原始参数审计副本中恢复",
  );
});

test("工具预算评估: strict 已通过时明确追加只提升 P2 完整度", async () => {
  const root = await tempRoot();
  const plans = join(root, "plans");
  const file = join(plans, "西湖半日游.json");
  await mkdir(plans, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      title: "杭州一日游",
      days: [
        {
          date: "2026-10-19",
          items: [
            {
              id: "west-lake",
              time: "09:00",
              end_time: "10:00",
              type: "visit",
              name: "西湖",
              location: { latitude: 30.24, longitude: 120.15 },
              confidence: "high",
              opening_hours: { opens: "08:00", closes: "18:00", source: "official" },
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const session = new Session("sess_budget_strict_pass");
  saveHistory(session, file);
  const assessment = await assessToolBudget(options(root, session));

  assert.equal(assessment.quality.available, true);
  assert.equal(assessment.quality.status, "needs_confirmation");
  assert.equal(assessment.quality.strict_pass, true);
  assert.equal(assessment.quality.score, 98);
  assert.deepEqual(assessment.quality.issue_count, { P0: 0, P1: 0, P2: 1 });
  assert.equal(assessment.quality.potential_score, 100);
  assert.equal(assessment.repair.canImprove, false);
  assert.match(assessment.repair.summary, /已通过 strict/);
  assert.match(assessment.repair.summary, /不是交付前置条件/);
  assert.match(budgetGuidance(assessment), /strict 已通过/);
});

test("工具预算评估: 达到硬上限后不可追加", async () => {
  const root = await tempRoot();
  const session = new Session("sess_budget_ceiling");
  const assessment: ToolBudgetAssessment = await assessToolBudget(options(root, session, 150));

  assert.equal(assessment.canContinue, false);
  assert.equal(assessment.suggestedAdditionalRounds, 0);
});
