import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProfile,
  listProfiles,
  loadProfile,
  mergeProfiles,
  parseProfileDocument,
  saveProfile,
  type TravelerProfile,
} from "../src/tools/profiles.ts";
import { createSaveTravelBriefTool, createLoadTravelBriefTool } from "../src/tools/brief.ts";

const fixtures = join(import.meta.dirname, "fixtures");

test("档案导入：解析填好的 .docx（Word 模板）", async () => {
  const buffer = await readFile(join(fixtures, "档案-已填示例.docx"));
  const parsed = parseProfileDocument("档案-已填示例.docx", buffer);
  assert.equal(parsed.name, "爸爸");
  assert.equal(parsed.fields.allergies, "花生");
  assert.equal(parsed.fields.spicy, "微辣");
  assert.match(parsed.fields.pace ?? "", /松弛/);
  assert.match(parsed.fields.interests ?? "", /古迹/);
  assert.match(parsed.fields.avoid ?? "", /排队/);
  assert.equal(parsed.warnings.length, 0, "模板字段应全部识别");
});

test("档案导入：解析填好的 .xlsx（表格模板）", async () => {
  const buffer = await readFile(join(fixtures, "档案-已填示例.xlsx"));
  const parsed = parseProfileDocument("档案-已填示例.xlsx", buffer);
  assert.equal(parsed.name, "妈妈");
  assert.equal(parsed.fields.allergies, undefined, "忌口填「无」不生成字段");
  assert.equal(parsed.fields.spicy, "无辣不欢");
  assert.match(parsed.fields.interests ?? "", /购物/);
  assert.match(parsed.fields.notes ?? "", /晕车/);
});

test("档案导入：.md 表格与未识别字段告警", () => {
  const content = [
    "| 项目 | 您的填写 | 说明 |",
    "|---|---|---|",
    "| ★ 称呼 | 小王 | |",
    "| ★ 忌口与过敏 | 无 | |",
    "| 辣度 | 正常 | |",
    "| 神秘字段 | 随便写的内容 | |",
  ].join("\n");
  const parsed = parseProfileDocument("档案.md", Buffer.from(content, "utf8"));
  assert.equal(parsed.name, "小王");
  assert.equal(parsed.fields.spicy, "正常");
  assert.equal(parsed.fields.allergies, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /神秘字段/);
});

test("档案导入：不支持的格式给出明确报错", () => {
  assert.throws(() => parseProfileDocument("老档案.doc", Buffer.from("x")), /另存为 \.docx/);
  assert.throws(() => parseProfileDocument("照片.jpg", Buffer.from("x")), /只支持/);
});

test("档案存储：保存/更新/同名拦截/读取/删除", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-profiles-"));
  const saved = await saveProfile(root, { name: "爸爸", fields: { allergies: "花生", pace: "松弛" } });
  assert.equal(saved.id, "prof-爸爸");
  assert.equal(saved.fields.allergies, "花生");

  // 同名新建被拦（避免静默覆盖）
  await assert.rejects(() => saveProfile(root, { name: "爸爸", fields: {} }), /已有同名档案/);
  // 带 id 更新允许
  const updated = await saveProfile(root, { id: "prof-爸爸", name: "爸爸", fields: { allergies: "花生、海鲜" } });
  assert.equal(updated.fields.allergies, "花生、海鲜");
  assert.equal(updated.createdAt, saved.createdAt, "更新保留创建时间");

  await saveProfile(root, { name: "妈妈", fields: { spicy: "无辣不欢" } });
  const profiles = await listProfiles(root);
  assert.equal(profiles.length, 2);
  assert.equal((await loadProfile(root, "妈妈"))?.fields.spicy, "无辣不欢");
  assert.equal((await loadProfile(root, "prof-爸爸"))?.name, "爸爸");

  assert.equal(await deleteProfile(root, "prof-妈妈"), true);
  assert.equal((await listProfiles(root)).length, 1);
});

test("约束合并：忌口取并集、辣度/节奏取最保守", () => {
  const dad: TravelerProfile = {
    id: "prof-爸爸", name: "爸爸", createdAt: 0, updatedAt: 0,
    fields: { allergies: "花生", spicy: "微辣", pace: "松弛", interests: "古迹", avoid: "排队太久" },
  };
  const mom: TravelerProfile = {
    id: "prof-妈妈", name: "妈妈", createdAt: 0, updatedAt: 0,
    fields: { spicy: "无辣不欢", pace: "适中", interests: "购物", notes: "晕车" },
  };
  const merged = mergeProfiles([dad, mom]);
  assert.match(merged, /忌口与过敏（强制回避）: 花生（爸爸）/);
  assert.match(merged, /辣度上限: 微辣（受 爸爸 限制）/);
  assert.match(merged, /节奏上限: 松弛（受 爸爸 限制）/);
  assert.match(merged, /古迹（爸爸）/);
  assert.match(merged, /购物（妈妈）/);
  assert.match(merged, /妈妈: 晕车/);
});

test("需求单：勾选同行人档案后，load 输出附带合并约束", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-brief-profiles-"));
  await saveProfile(root, { name: "爸爸", fields: { allergies: "花生", spicy: "微辣" } });
  const save = createSaveTravelBriefTool(root);
  const load = createLoadTravelBriefTool(root);

  await save.execute({ title: "福州测试", destination: "福州", travelerProfiles: ["爸爸"] });
  const output = await load.execute({ title: "福州测试" });
  assert.match(output, /travelerProfiles/);
  assert.match(output, /【同行人约束（已合并，规划必须遵守）】/);
  assert.match(output, /花生（爸爸）/);
  assert.match(output, /辣度上限: 微辣/);

  // 档案不存在时给出提示而不是报错
  await save.execute({ title: "缺档案", destination: "福州", travelerProfiles: ["不存在的人"] });
  const missing = await load.execute({ title: "缺档案" });
  assert.match(missing, /未找到档案 不存在的人/);
});
