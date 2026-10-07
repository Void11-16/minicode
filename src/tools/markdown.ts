import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Tool } from "./tool.ts";
import { assertInsideRoot, requireString } from "./tool.ts";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

/**
 * 写文件工具 —— 把行程规划、攻略等导出为 Markdown。
 *
 * 安全设计：只允许写当前工作目录内的文件。
 * 因为 LLM 会读取网络抓取的内容（评价等），存在提示注入风险，
 * 如果允许写任意路径，恶意网页理论上可诱导覆盖系统文件。
 */
export function createWriteDocumentTool(rootDir: string = process.cwd()): Tool {
  return {
    name: "write_document",
    description:
      "把内容写入本地文件（支持 .md/.txt/.json/.csv），用于保存行程单、攻略等生成结果。" +
      "只能写当前项目目录内的文件。返回保存后的路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，如 plans/hangzhou.md（相对当前目录）" },
        content: { type: "string", description: "要写入的完整文件内容（Markdown 等）" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const path = requireString(args, "path");
      const content = requireString(args, "content");

      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error(`不支持的文件类型 ${extension}（允许: ${[...ALLOWED_EXTENSIONS].join("/")}）`);
      }

      // 统一解析为绝对路径，并强制限制在 rootDir 内
      const root = resolve(rootDir);
      const absolute = isAbsolute(path) ? resolve(path) : resolve(join(root, path));
      assertInsideRoot(root, absolute);

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");

      return `已保存到 ${absolute}（${Buffer.byteLength(content, "utf8")} 字节）`;
    },
    requiresConfirmation: true,
    confirmationMessage: (args) => `写入文件 ${String(args.path)}`,
  };
}
