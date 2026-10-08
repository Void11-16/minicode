import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashApprovalKey, createBashTool, isReadOnlyCommand, matchesBashApprovalKey } from "../src/tools/bash.ts";

test("bashApprovalKey: 生成精准的命令记忆键", () => {
  assert.equal(bashApprovalKey("npm test"), "npm test");
  assert.equal(bashApprovalKey("npm run build"), "npm run build");
  assert.equal(bashApprovalKey("npm run deploy --prod"), "npm run deploy");
  assert.equal(bashApprovalKey("git commit -m \"x\""), "git commit");
  assert.equal(bashApprovalKey("git push origin main"), "git push");
  assert.equal(bashApprovalKey("ls"), "ls");
  assert.equal(bashApprovalKey(""), "");
});

test("matchesBashApprovalKey: 前缀匹配（参数变化命中，不同命令不误判）", () => {
  assert.equal(matchesBashApprovalKey("npm test --watch", "npm test"), true);
  assert.equal(matchesBashApprovalKey("npm test", "npm test"), true);
  assert.equal(matchesBashApprovalKey("git commit -m fix", "git commit"), true);
  // 前缀不同不得放行
  assert.equal(matchesBashApprovalKey("npm testx", "npm test"), false);
  assert.equal(matchesBashApprovalKey("git push", "git commit"), false);
  assert.equal(matchesBashApprovalKey("npm run deploy", "npm run build"), false);
});

test("isReadOnlyCommand: 白名单只读命令自动放行", () => {
  assert.equal(isReadOnlyCommand("ls -la"), true);
  assert.equal(isReadOnlyCommand("cat README.md"), true);
  assert.equal(isReadOnlyCommand("git status"), true);
  assert.equal(isReadOnlyCommand("git log --oneline -10"), true);
  assert.equal(isReadOnlyCommand("git diff HEAD~1"), true);
  assert.equal(isReadOnlyCommand("git branch -av"), true);
  assert.equal(isReadOnlyCommand("node --version"), true);
  assert.equal(isReadOnlyCommand("npm --help"), true);
  assert.equal(isReadOnlyCommand("rg TODO src"), true);
});

test("isReadOnlyCommand: 变更/链式/未知命令必须确认（fail-closed）", () => {
  assert.equal(isReadOnlyCommand("rm -rf build"), false);
  assert.equal(isReadOnlyCommand("npm test"), false);
  assert.equal(isReadOnlyCommand("npm install"), false);
  assert.equal(isReadOnlyCommand("git commit -m x"), false);
  assert.equal(isReadOnlyCommand("git branch -D feature"), false);
  assert.equal(isReadOnlyCommand("git config user.name x"), false);
  assert.equal(isReadOnlyCommand("echo hi > file.txt"), false);
  assert.equal(isReadOnlyCommand("ls | grep ts"), false);
  assert.equal(isReadOnlyCommand("ls && rm -rf x"), false);
  assert.equal(isReadOnlyCommand("sudo ls"), false);
  assert.equal(isReadOnlyCommand("ls $(pwd)"), false);
  assert.equal(isReadOnlyCommand("cat `echo f`"), false);
  assert.equal(isReadOnlyCommand(""), false);
});

test("bash: 执行命令返回退出码与输出，cwd 为工作区", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-bash-"));
  await writeFile(join(workspace, "marker.txt"), "hi", "utf8");

  const tool = createBashTool();
  const output = await tool.execute({ command: "pwd && cat marker.txt" }, { workspace });

  assert.match(output, /^\$ pwd && cat marker\.txt\n退出码 0\n---\n/);
  assert.match(output, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /hi/);
});

test("bash: 非零退出码如实返回（stderr 单列一段）", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-bash-"));
  const tool = createBashTool();
  const output = await tool.execute({ command: "echo to-stderr 1>&2; exit 3" }, { workspace });

  assert.match(output, /退出码 3/);
  assert.match(output, /\[stderr\]/);
  assert.match(output, /to-stderr/);
});

test("bash: 超时终止并提示", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minicode-bash-"));
  const tool = createBashTool();
  const started = Date.now();
  const output = await tool.execute({ command: "sleep 10", timeout_ms: 800 }, { workspace });

  assert.match(output, /超时/);
  assert.ok(Date.now() - started < 5000, "应在超时后快速终止");
});
