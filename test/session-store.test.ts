import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/core/session.ts";
import { JsonFileSessionStore, findSessions } from "../src/storage/session-store.ts";
import { createMessage } from "../src/core/message.ts";
import type { SessionMeta } from "../src/storage/session-store.ts";

test("Session 序列化/反序列化往返无损", () => {
  const session = new Session("sess_test");
  session.add("user", "你好");
  session.add("assistant", "你好！");

  const restored = Session.fromData(session.toData());

  assert.equal(restored.id, "sess_test");
  assert.equal(restored.history.length, 2);
  assert.deepEqual(
    restored.history.map((m) => [m.role, m.content]),
    [["user", "你好"], ["assistant", "你好！"]],
  );
});

test("JsonFileSessionStore 保存并加载会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-test-"));
  const store = new JsonFileSessionStore(dir);

  const session = new Session("sess_save_test");
  session.add("user", "第一条");
  session.add("assistant", "第二条");
  await store.save(session);

  const loaded = await store.load("sess_save_test");
  assert.ok(loaded !== null);
  assert.equal(loaded.id, "sess_save_test");
  assert.equal(loaded.history.length, 2);
  // 注意：遵循项目规则不批量删除目录，临时目录交由系统清理
});

test("load 返回 null: 不存在的会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-test-"));
  const store = new JsonFileSessionStore(dir);
  assert.equal(await store.load("sess_not_exist"), null);
});

test("load 拒绝路径穿越式的非法会话 id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-test-"));
  const store = new JsonFileSessionStore(dir);
  assert.equal(await store.load("../../etc/passwd"), null);
  assert.equal(await store.load("..\\windows\\system32"), null);
});

test("list 返回会话列表，最新在前", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-test-"));
  const store = new JsonFileSessionStore(dir);

  const older = new Session("sess_old");
  older.add("user", "旧消息");
  const newer = new Session("sess_new");
  newer.add("user", "新消息");

  await store.save(older);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.save(newer);

  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "sess_new");
  assert.equal(list[0].messageCount, 1);
  assert.equal(list[0].preview, "新消息");
  assert.equal(list[0].title, "新消息");
});

test("Session 标题: 取第一条用户消息，压缩后保持稳定", () => {
  const session = new Session("sess_title");
  session.add("assistant", "系统欢迎语"); // 不应成为标题
  session.add("user", "帮我规划杭州三日游，重点是西湖和灵隐寺，预算3000元以内尽量丰富一点的行程安排");
  session.add("assistant", "好的");

  // 截断到 40 字符
  assert.equal(session.title.length, 40);
  assert.match(session.title, /^帮我规划杭州三日游/);

  // Epoch 压缩替换历史后标题不变（已单独持久化）
  session.replaceHistory([createMessage("system", "【上下文摘要】...")], 1);
  assert.equal(
    session.title,
    "帮我规划杭州三日游，重点是西湖和灵隐寺，预算3000元以内尽量丰富一点的行程安排".slice(0, 40),
  );

  // 持久化往返
  const restored = Session.fromData(session.toData());
  assert.equal(restored.title, session.title);
});

test("Session.rename: 手动改名并持久化", () => {
  const session = new Session("sess_rename");
  session.add("user", "帮我查杭州天气，要详细的，最好包括未来三天的气温和降水");
  const autoTitle = session.title;

  session.rename("杭州天气查询");
  assert.equal(session.title, "杭州天气查询");

  // 持久化往返
  const restored = Session.fromData(session.toData());
  assert.equal(restored.title, "杭州天气查询");

  // 空/纯空白标题拒绝
  assert.throws(() => session.rename("   "), /标题不能为空/);
  void autoTitle;
});

test("旧格式会话（无 title 字段）从消息推导标题", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-store-"));
  const store = new JsonFileSessionStore(dir);
  // 手写旧格式文件（无 title/epoch 字段）
  await writeFile(
    join(dir, "sess_legacy.json"),
    JSON.stringify({
      id: "sess_legacy",
      messages: [
        { id: "m1", role: "user", content: "旧会话的第一个问题", createdAt: 1 },
      ],
    }),
    "utf8",
  );

  const list = await store.list();
  assert.equal(list[0].title, "旧会话的第一个问题");
  assert.equal(list[0].epoch, 0);

  // load 恢复旧格式会话时同样推导标题（修复显示“(空会话)”的问题）
  const restored = await store.load("sess_legacy");
  assert.ok(restored !== null);
  assert.equal(restored!.title, "旧会话的第一个问题");
});

const METAS: SessionMeta[] = [
  { id: "sess_a", messageCount: 4, updatedAt: 300, preview: "p1", title: "杭州三日游规划", epoch: 0 },
  { id: "sess_b", messageCount: 2, updatedAt: 200, preview: "p2", title: "北京天气查询", epoch: 1 },
  { id: "sess_c", messageCount: 6, updatedAt: 100, preview: "p3", title: "上海住宿推荐", epoch: 0 },
];

test("findSessions: 按序号选择", () => {
  assert.deepEqual(findSessions(METAS, "1").map((m) => m.id), ["sess_a"]);
  assert.deepEqual(findSessions(METAS, "3").map((m) => m.id), ["sess_c"]);
  assert.deepEqual(findSessions(METAS, "9"), []);
});

test("findSessions: 按标题关键词（大小写不敏感）", () => {
  assert.deepEqual(findSessions(METAS, "杭州").map((m) => m.id), ["sess_a"]);
  assert.deepEqual(findSessions(METAS, "天气").map((m) => m.id), ["sess_b"]);
  assert.deepEqual(findSessions(METAS, "广州"), []);
});

test("findSessions: 多个匹配全部返回", () => {
  const metas = [
    ...METAS,
    { id: "sess_d", messageCount: 1, updatedAt: 50, preview: "p4", title: "杭州住宿", epoch: 0 },
  ];
  const matches = findSessions(metas, "杭州");
  assert.deepEqual(matches.map((m) => m.id), ["sess_a", "sess_d"]);
});

test("findSessions: 按会话 id 精确匹配（向后兼容）", () => {
  assert.deepEqual(findSessions(METAS, "sess_b").map((m) => m.id), ["sess_b"]);
  assert.deepEqual(findSessions(METAS, "sess_c").map((m) => m.id), ["sess_c"]);
});

test("SessionStore.delete: 删除会话主文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-delete-"));
  const store = new JsonFileSessionStore(dir);
  const session = new Session("sess_del_me");
  session.add("user", "临时会话");
  await store.save(session);

  assert.equal(await store.delete("sess_del_me"), true);
  assert.equal(await store.load("sess_del_me"), null);
  // 重复删除返回 false
  assert.equal(await store.delete("sess_del_me"), false);
  // 非法 id（路径穿越）返回 false
  assert.equal(await store.delete("../../etc/passwd"), false);
});

test("SessionStore.deleteArchives: 只删该会话的归档，其他会话归档不受影响", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-del-arch-"));
  const store = new JsonFileSessionStore(dir);

  // 手写归档文件：sess_a 两个纪元 + sess_b 一个纪元
  await mkdir(join(dir, "archive"), { recursive: true });
  await writeFile(join(dir, "archive", "sess_a_epoch1.json"), "{}", "utf8");
  await writeFile(join(dir, "archive", "sess_a_epoch2.json"), "{}", "utf8");
  await writeFile(join(dir, "archive", "sess_b_epoch1.json"), "{}", "utf8");

  const count = await store.deleteArchives("sess_a");
  assert.equal(count, 2);

  // sess_b 的归档还在
  assert.equal(await store.deleteArchives("sess_b"), 1);
  // sess_a 已无归档
  assert.equal(await store.deleteArchives("sess_a"), 0);
});
