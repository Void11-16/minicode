import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";

test("Session 按顺序记录消息", () => {
  const session = new Session();
  session.add("user", "你好");
  session.add("assistant", "你好，有什么可以帮你？");

  assert.equal(session.history.length, 2);
  assert.equal(session.history[0].role, "user");
  assert.equal(session.history[1].content, "你好，有什么可以帮你？");
});

test("Session.toPrompt 导出干净的角色/内容", () => {
  const session = new Session();
  session.add("user", "hi");
  const prompt = session.toPrompt();

  assert.deepEqual(prompt, [{ role: "user", content: "hi" }]);
  assert.equal(Object.keys(prompt[0]).length, 2);
});

test("Session.reset 清空历史", () => {
  const session = new Session();
  session.add("user", "你好");
  session.reset();
  assert.equal(session.history.length, 0);
});
