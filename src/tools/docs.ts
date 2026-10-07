import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Tool } from "./tool.ts";
import { assertInsideRoot, requireString } from "./tool.ts";

const MAX_CHARS = 4000;
/** 读取前的文件大小上限：输出本就截断到 MAX_CHARS，2MB 已远超解析所需，防大文件 OOM */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface DocumentToolOptions {
  /** 限定可读根目录（MCP 等无人工确认的场景传入）；不传 = 允许任意路径（CLI/Web 有确认门槛） */
  readonly readRoot?: string;
}

/** 读取本地文档（行程单/攻略/订单等），txt/md/csv/json 格式 */
export function createDocumentTool(options: DocumentToolOptions = {}): Tool {
  const rootDir = options.readRoot;
  return {
    name: "read_document",
    description:
      "读取本地文档内容（txt/md/csv/json），用于解析用户提供的行程单、攻略、订单截图导出等文件。" +
      (rootDir === undefined ? "" : `只能读取 ${rootDir} 目录内的文件。`),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径或相对当前目录的路径" },
      },
      required: ["path"],
    },
    async execute(args) {
      const path = requireString(args, "path");
      const absolute = isAbsolute(path) ? resolve(path) : resolve(join(process.cwd(), path));
      if (rootDir !== undefined) assertInsideRoot(rootDir, absolute);

      const info = await stat(absolute);
      if (info.isFile() !== true) {
        throw new Error(`路径不是普通文件: ${path}`);
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`文件过大: ${info.size} 字节（上限 ${MAX_FILE_BYTES} 字节，请读取更小的文件）`);
      }

      const raw = await readFile(absolute, "utf8");

      let output: string;
      if (path.endsWith(".json")) {
        output = JSON.stringify(JSON.parse(raw), null, 2);
      } else if (path.endsWith(".csv")) {
        output = parseCsv(raw);
      } else {
        output = raw; // txt / md 原样返回
      }

      if (output.length > MAX_CHARS) {
        output = `${output.slice(0, MAX_CHARS)}\n...(已截断，共 ${output.length} 字符)`;
      }
      return output;
    },
    requiresConfirmation: true,
    confirmationMessage: (args) => `读取本地文件 ${String(args.path)}`,
  };
}

/** 简易 CSV → 逐行 JSON，方便 LLM 理解结构 */
function parseCsv(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return "(空文件)";

  const header = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = cells[i] ?? "";
    });
    return JSON.stringify(record);
  });

  return `CSV 表头: ${header.join(", ")}\n共 ${rows.length} 行:\n${rows.join("\n")}`;
}

function splitCsvLine(line: string): string[] {
  // 处理带引号的字段（引号内逗号不算分隔符）
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
