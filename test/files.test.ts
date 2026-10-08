import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditFileTool,
  createGrepTool,
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from "../src/tools/files.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { ChatAgent } from "../src/agent/agent.ts";
import { Session } from "../src/core/session.ts";
import type { ChatProvider } from "../src/llm/provider.ts";

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "minicode-ws-"));
}

test("read_file: 行号输出 + offset/limit 分段 + 无匹配提示行数", async () => {
  const workspace = await tempWorkspace();
  const file = join(workspace, "a.txt");
  await writeFile(file, ["one", "two", "three", "four"].join("\n"), "utf8");

  const tool = createReadFileTool();
  const output = await tool.execute({ path: "a.txt" }, { workspace });
  assert.match(output, /a\.txt（共 4 行）/);
  assert.match(output, /1\tone/);
  assert.match(output, /4\tfour/);

  const sliced = await tool.execute({ path: "a.txt", offset: 3, limit: 1 }, { workspace });
  assert.match(sliced, /3\tthree/);
  assert.doesNotMatch(sliced, /1\tone/);
  assert.match(sliced, /还有 1 行未显示/);
});

test("read_file: 越界/不存在/目录/超 2MB 的场景", async () => {
  const workspace = await tempWorkspace();
  const outside = await tempWorkspace();
  const tool = createReadFileTool();

  await assert.rejects(() => tool.execute({ path: "not-exist.txt" }, { workspace }), /文件不存在/);
  await assert.rejects(() => tool.execute({ path: outside }, { workspace }), /安全限制/);
  await assert.rejects(() => tool.execute({ path: join(workspace, "缺少的子目录") }, { workspace }), /不能访问|安全限制|不存在/);

  await mkdir(join(workspace, "adir"));
  await assert.rejects(() => tool.execute({ path: "adir" }, { workspace }), /目录/);

  await writeFile(join(workspace, "big.txt"), Buffer.alloc(3 * 1024 * 1024, "a"), "utf8");
  await assert.rejects(() => tool.execute({ path: "big.txt" }, { workspace }), /文件过大/);
});

test("write_file: 自动建目录且内容原样保留（含首尾空白与换行）", async () => {
  const workspace = await tempWorkspace();
  const tool = createWriteFileTool();
  const content = "  indented\n\nlast line without trailing newline";

  const output = await tool.execute({ path: "deep/nested/file.md", content }, { workspace });
  assert.match(output, /已写入 deep\/nested\/file\.md/);
  assert.equal(await readFile(join(workspace, "deep/nested/file.md"), "utf8"), content);

  await assert.rejects(() => tool.execute({ path: "x.md", content: 123 }, { workspace }), /content/);
});

test("write_file: 越界路径拒绝（含同前缀目录绕过）", async () => {
  const workspace = await tempWorkspace();
  const tool = createWriteFileTool(workspace);

  await assert.rejects(() => tool.execute({ path: "../escape.md", content: "x" }), /安全限制/);
  await assert.rejects(() => tool.execute({ path: join(tmpdir(), "outside.md"), content: "x" }), /安全限制/);
  await assert.rejects(() => tool.execute({ path: `${workspace}-evil/escape.md`, content: "x" }), /安全限制/);
  // 工作区内绝对路径与 ".." 开头文件名合法
  assert.match(await tool.execute({ path: join(workspace, "inside.md"), content: "x" }), /已写入/);
  assert.match(await tool.execute({ path: "..dots.md", content: "x" }), /已写入/);
});

test("edit_file: 唯一替换 / 多处报错 / replace_all / 未找到", async () => {
  const workspace = await tempWorkspace();
  const file = join(workspace, "code.ts");
  await writeFile(file, "const a = 1;\nconst b = a + 1;\nconst c = a + 2;", "utf8");
  const tool = createEditFileTool();

  // 唯一替换
  const output = await tool.execute(
    { path: "code.ts", old_string: "const a = 1;", new_string: "const a = 10;" },
    { workspace },
  );
  assert.match(output, /已替换 1 处 → code\.ts（改动起始于第 1 行）/);

  // 多处匹配：不传 replace_all 报错
  await assert.rejects(
    () => tool.execute({ path: "code.ts", old_string: "a +", new_string: "a *" }, { workspace }),
    /匹配到 2 处/,
  );
  // replace_all 全部替换
  const all = await tool.execute({ path: "code.ts", old_string: "a +", new_string: "a *", replace_all: true }, { workspace });
  assert.match(all, /已替换 2 处/);

  // 未找到
  await assert.rejects(
    () => tool.execute({ path: "code.ts", old_string: "不存在的文本", new_string: "x" }, { workspace }),
    /未找到匹配文本/,
  );
  // 空 old_string 拒绝
  await assert.rejects(
    () => tool.execute({ path: "code.ts", old_string: "", new_string: "x" }, { workspace }),
    /old_string/,
  );
});

test("edit_file: old_string/new_string 均不 trim（缩进与尾随空白逐字保留）", async () => {
  const workspace = await tempWorkspace();
  await writeFile(join(workspace, "indent.ts"), "function f() {\n    return 1;\n}\n", "utf8");
  const tool = createEditFileTool();

  // 带缩进的原文必须能命中；new_string 的尾随空白也要原样写入（若被 trim 会丢两格）
  const output = await tool.execute(
    { path: "indent.ts", old_string: "    return 1;", new_string: "    return 2;  " },
    { workspace },
  );
  assert.match(output, /已替换 1 处/);
  assert.equal(
    await readFile(join(workspace, "indent.ts"), "utf8"),
    "function f() {\n    return 2;  \n}\n",
  );
});

test("list_files: 递归列出、跳过 node_modules、glob 过滤", async () => {
  const workspace = await tempWorkspace();
  await mkdir(join(workspace, "src/utils"), { recursive: true });
  await mkdir(join(workspace, "node_modules/pkg"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "x", "utf8");
  await writeFile(join(workspace, "src/index.ts"), "x", "utf8");
  await writeFile(join(workspace, "src/utils/helper.ts"), "x", "utf8");
  await writeFile(join(workspace, "node_modules/pkg/index.js"), "x", "utf8");

  const tool = createListFilesTool();
  const all = await tool.execute({}, { workspace });
  assert.match(all, /src\/index\.ts/);
  assert.match(all, /README\.md/);
  assert.doesNotMatch(all, /node_modules/);

  const tsFiles = await tool.execute({ pattern: "*.ts" }, { workspace });
  assert.match(tsFiles, /src\/index\.ts/);
  assert.match(tsFiles, /src\/utils\/helper\.ts/);
  assert.doesNotMatch(tsFiles, /README\.md/);

  const nested = await tool.execute({ pattern: "src/**/*.ts" }, { workspace });
  assert.match(nested, /src\/index\.ts/);
  assert.match(nested, /src\/utils\/helper\.ts/);
});

test("grep: 行号匹配、include 过滤、ignore_case、非法正则", async () => {
  const workspace = await tempWorkspace();
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src/app.ts"), "const TODO = 1;\nfunction run() {}\n", "utf8");
  await writeFile(join(workspace, "notes.md"), "todo: write docs\n", "utf8");

  const tool = createGrepTool();
  const found = await tool.execute({ pattern: "TODO" }, { workspace });
  assert.match(found, /src\/app\.ts:1: const TODO = 1;/);
  assert.doesNotMatch(found, /notes\.md/);

  const filtered = await tool.execute({ pattern: "run", include: "*.ts" }, { workspace });
  assert.match(filtered, /src\/app\.ts:2/);

  const insensitive = await tool.execute({ pattern: "todo", ignore_case: true }, { workspace });
  assert.match(insensitive, /notes\.md:1/);

  await assert.rejects(() => tool.execute({ pattern: "(" }, { workspace }), /正则表达式非法/);
});

test("文件工具: 装配默认工作区兜底，ctx.workspace 优先", async () => {
  const fallback = await tempWorkspace();
  const override = await tempWorkspace();
  await writeFile(join(override, "only-here.txt"), "hello", "utf8");
  const tool = createReadFileTool(fallback);

  // 无 ctx：走装配默认（override 里没有该文件 → 报不存在）
  await assert.rejects(() => tool.execute({ path: "only-here.txt" }), /文件不存在/);
  // 有 ctx：优先 ctx.workspace
  assert.match(await tool.execute({ path: "only-here.txt" }, { workspace: override }), /hello/);
});

test("ChatAgent: 工具执行携带会话工作区与中断信号", async () => {
  const session = new Session("sess_ctx_test");
  session.setWorkspace("/tmp/ws-from-session");

  let received: { workspace?: string; hasSignal?: boolean } = {};
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    description: "探针",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      received = { workspace: ctx?.workspace, hasSignal: ctx?.signal !== undefined };
      return "ok";
    },
  });

  let calls = 0;
  const provider: ChatProvider = {
    name: "scripted",
    async chat() {
      return "unused";
    },
    async chatWithTools() {
      calls += 1;
      if (calls === 1) {
        return { type: "tool_calls" as const, toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] };
      }
      return { type: "text" as const, content: "done" };
    },
  };

  const agent = new ChatAgent(session, provider, registry, "/default-ws");
  await agent.run("go");

  assert.equal(received.workspace, "/tmp/ws-from-session");
  assert.equal(received.hasSignal, true);
});
