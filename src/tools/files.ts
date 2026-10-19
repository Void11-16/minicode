import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool, ToolContext } from "./tool.ts";
import { requireString } from "./tool.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 500;
const MAX_READ_LINES = 2000;
const MAX_LIST_ENTRIES = 300;
const MAX_GREP_MATCHES = 200;

/** 递归遍历时跳过的目录（依赖/产物/元数据，噪音且量大） */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".cache", "dist", "build", ".next",
  "coverage", ".venv", "__pycache__", ".turbo", ".minicode",
]);

/** 解析工作区根：会话上下文优先，否则装配默认 */
function workspaceOf(ctx: ToolContext | undefined, fallback: string): string {
  return resolve(ctx?.workspace ?? fallback);
}

/** 解析为工作区内的绝对路径；目录本身只在 allowRoot 时放行 */
function resolveInWorkspace(workspace: string, path: string, allowRoot = false): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(join(workspace, path));
  const rel = relative(workspace, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (!allowRoot && rel === "")) {
    throw new Error(`安全限制: 只能访问工作区内的路径（工作区: ${workspace}）`);
  }
  return absolute;
}

/** glob → RegExp；`**` 匹配任意层级（可为空），`*`/`?` 不跨目录 */
function globMatches(relPath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // \u0001 / \u0002 是占位哨兵：先把 ** 保护起来，避免被后面的单 * 替换拆散
  const source = escaped
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll("\u0001", "(?:.*/)?")
    .replaceAll("\u0002", ".*");
  const regex = new RegExp(`^${source}$`);
  // 不含 / 的模式按文件名匹配（*.ts 能命中任意层级），含 / 的按工作区相对路径匹配
  return pattern.includes("/") ? regex.test(relPath) : regex.test(relPath.split("/").pop() ?? relPath);
}

async function friendlyStat(absolute: string, label: string) {
  try {
    return await stat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label}不存在: ${absolute}`);
    }
    throw error;
  }
}

/** 读取工作区内文本文件，带行号输出，支持分段读大文件 */
export function createReadFileTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "read_file",
    description:
      "读取工作区内的文本文件，输出带行号（格式 `行号\\t内容`），支持 offset/limit 分段。修改代码前先用它了解现状；" +
      "文件上限 2MB，大文件请先用 grep 定位再分段读取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区或绝对路径）" },
        offset: { type: "number", description: "起始行号（1 起），可选" },
        limit: { type: "number", description: `读取行数，默认 ${DEFAULT_READ_LINES}，最大 ${MAX_READ_LINES}` },
      },
      required: ["path"],
    },
    async execute(args, ctx) {
      const path = requireString(args, "path");
      const workspace = workspaceOf(ctx, defaultWorkspace);
      const absolute = resolveInWorkspace(workspace, path);
      const info = await friendlyStat(absolute, "文件");
      if (info.isDirectory()) {
        throw new Error(`${path} 是一个目录，请用 list_files 浏览`);
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 2MB）：请用 grep 定位内容，或用 bash 的 sed/head 查看局部`,
        );
      }

      const raw = await readFile(absolute, "utf8");
      const lines = raw.split("\n");
      const offset = Math.max(1, Math.floor(typeof args.offset === "number" ? args.offset : 1));
      const limit = Math.min(
        MAX_READ_LINES,
        Math.max(1, Math.floor(typeof args.limit === "number" ? args.limit : DEFAULT_READ_LINES)),
      );
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join("\n");
      const remaining = lines.length - (offset - 1 + slice.length);
      const relPath = relative(workspace, absolute);
      const tail = remaining > 0 ? `\n...（还有 ${remaining} 行未显示，可用 offset=${offset + slice.length} 继续读取）` : "";
      return `${relPath}（共 ${lines.length} 行）:\n${numbered}${tail}`;
    },
  };
}

/** 完整写入工作区内文件（自动创建目录） */
export function createWriteFileTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "write_file",
    description:
      "把内容完整写入工作区内的文件（UTF-8，自动创建目录）。用于新建文件或整体重写；" +
      "修改已有文件的小改动请用 edit_file（更安全，不会覆盖无关内容）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区或绝对路径）" },
        content: { type: "string", description: "要写入的完整文件内容" },
      },
      required: ["path", "content"],
    },
    async execute(args, ctx) {
      const path = requireString(args, "path");
      // 注意：不用 requireString（它会 trim）——文件内容必须原样保留首尾空白与换行
      const content = args.content;
      if (typeof content !== "string") {
        throw new Error("缺少或非法参数 content（需要字符串）");
      }
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        throw new Error(`内容过大（上限 2MB），请拆分文件`);
      }
      const workspace = workspaceOf(ctx, defaultWorkspace);
      const absolute = resolveInWorkspace(workspace, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      return `已写入 ${relative(workspace, absolute)}（${Buffer.byteLength(content, "utf8")} 字节）`;
    },
    requiresConfirmation: true,
    workspaceEdit: true,
    confirmationMessage: (args) => `写入文件 ${String(args.path)}`,
  };
}

/** 精确文本替换编辑（old_string 必须唯一命中，除非 replace_all） */
export function createEditFileTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "edit_file",
    description:
      "对工作区内文件做精确文本替换：old_string 必须在文件中唯一命中（否则报错），除非 replace_all=true。" +
      "修改代码的首选方式：先 read_file 拿到原文，替换时带足上下文（含缩进）保证唯一。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区或绝对路径）" },
        old_string: { type: "string", description: "要被替换的原文（需与文件内容完全一致，含空白与缩进）" },
        new_string: { type: "string", description: "替换后的新文本" },
        replace_all: { type: "boolean", description: "默认 false；true 时替换所有匹配处" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(args, ctx) {
      const path = requireString(args, "path");
      // old_string 必须与文件原文逐字一致（含缩进/换行），不能 trim
      const oldString = args.old_string;
      if (typeof oldString !== "string" || oldString === "") {
        throw new Error("缺少或非法参数 old_string（需要非空字符串）");
      }
      if (typeof args.new_string !== "string") {
        throw new Error("缺少或非法参数 new_string（需要字符串，删除内容时传空字符串）");
      }
      const newString = args.new_string;
      const replaceAll = args.replace_all === true;

      const workspace = workspaceOf(ctx, defaultWorkspace);
      const absolute = resolveInWorkspace(workspace, path);
      const info = await friendlyStat(absolute, "文件");
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`文件过大（上限 2MB），edit_file 不支持`);
      }
      const raw = await readFile(absolute, "utf8");

      const occurrences = raw.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error("未找到匹配文本：请先 read_file 确认原文（注意空白、缩进与换行需完全一致）");
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `匹配到 ${occurrences} 处：请提供更长的上下文使 old_string 唯一，或传 replace_all=true 全部替换`,
        );
      }

      const updated = replaceAll ? raw.split(oldString).join(newString) : raw.replace(oldString, newString);
      await writeFile(absolute, updated, "utf8");

      const firstIndex = raw.indexOf(oldString);
      const line = raw.slice(0, firstIndex).split("\n").length;
      const relPath = relative(workspace, absolute);
      return `已替换 ${replaceAll ? occurrences : 1} 处 → ${relPath}（改动起始于第 ${line} 行）`;
    },
    requiresConfirmation: true,
    workspaceEdit: true,
    confirmationMessage: (args) => `编辑文件 ${String(args.path)}`,
  };
}

interface WalkedFile {
  readonly absolute: string;
  readonly relative: string;
}

/** 递归收集文件（跳过依赖/产物目录与符号链接目录），到达 cap 即停止 */
async function walkFiles(root: string, workspace: string, cap: number): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const files: WalkedFile[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative: relative(workspace, absolute) });
        if (files.length >= cap) return { files, truncated: true };
      }
      // 符号链接一律跳过，避免循环与越界
    }
  }
  return { files, truncated: false };
}

/** 列出工作区内文件（递归，自动跳过依赖/产物目录），支持 glob 过滤 */
export function createListFilesTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "list_files",
    description:
      "列出工作区内的文件（递归，自动跳过 node_modules/.git 等目录），支持 glob 过滤（如 *.ts、src/**/*.ts）。" +
      "上手一个项目时先用它了解结构。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "起始目录（相对工作区），默认工作区根" },
        pattern: { type: "string", description: "glob 过滤，如 *.ts 或 src/**/*.ts，可选" },
      },
    },
    async execute(args, ctx) {
      const workspace = workspaceOf(ctx, defaultWorkspace);
      const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim() : ".";
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      const root = resolveInWorkspace(workspace, path, true);

      const { files, truncated } = await walkFiles(root, workspace, MAX_LIST_ENTRIES * 5);
      const matched = files
        .filter((file) => pattern === "" || globMatches(file.relative, pattern))
        .slice(0, MAX_LIST_ENTRIES);
      if (matched.length === 0) {
        return `没有匹配的文件${pattern === "" ? "" : `（pattern: ${pattern}）`}。`;
      }
      const note = truncated || matched.length >= MAX_LIST_ENTRIES ? `\n...（结果已截断，请用 pattern 收窄）` : "";
      return `工作区文件（${matched.length} 个${pattern === "" ? "" : `，pattern: ${pattern}`}）:\n${matched.map((f) => f.relative).join("\n")}${note}`;
    },
  };
}

/** 按正则搜索工作区文件内容 */
export function createGrepTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "grep",
    description:
      "在工作区内按正则搜索文件内容，返回 `文件:行号: 内容`。定位代码/文本的首选工具（只读，无需确认）；" +
      "支持 include（如 *.ts）收窄范围。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式，如 \"TODO|FIXME\"、\"function\\\\s+\\\\w+\"" },
        path: { type: "string", description: "搜索范围（子目录或文件，相对工作区），默认整个工作区" },
        include: { type: "string", description: "文件名 glob 过滤，如 *.ts，可选" },
        ignore_case: { type: "boolean", description: "忽略大小写，默认 false" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx) {
      const patternSource = requireString(args, "pattern");
      let regex: RegExp;
      try {
        regex = new RegExp(patternSource, args.ignore_case === true ? "i" : "");
      } catch {
        throw new Error(`正则表达式非法: ${patternSource}`);
      }
      const include = typeof args.include === "string" ? args.include.trim() : "";
      const workspace = workspaceOf(ctx, defaultWorkspace);
      const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim() : ".";
      const root = resolveInWorkspace(workspace, path, true);

      const rootInfo = await friendlyStat(root, "路径");
      let candidates: WalkedFile[];
      let truncated = false;
      if (rootInfo.isFile()) {
        candidates = [{ absolute: root, relative: relative(workspace, root) }];
      } else {
        const walked = await walkFiles(root, workspace, 4000);
        candidates = walked.files;
        truncated = walked.truncated;
      }

      const matches: string[] = [];
      let scanned = 0;
      for (const file of candidates) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (include !== "" && !globMatches(file.relative, include)) continue;
        let info;
        try {
          info = await stat(file.absolute);
        } catch {
          continue;
        }
        if (info.size > MAX_FILE_BYTES) continue;
        let content: string;
        try {
          content = await readFile(file.absolute, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue; // 二进制文件跳过
        scanned += 1;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          if (line.length > 500) continue; // 超长行（压缩产物）跳过
          if (regex.test(line)) {
            const preview = line.length > 250 ? `${line.slice(0, 250)}…` : line;
            matches.push(`${file.relative}:${index + 1}: ${preview.trim()}`);
            if (matches.length >= MAX_GREP_MATCHES) break;
          }
        }
      }

      if (matches.length === 0) {
        return `没有匹配（扫描 ${scanned} 个文件${truncated ? "，部分目录因数量上限未扫描" : ""}）。`;
      }
      const cap = matches.length >= MAX_GREP_MATCHES ? "\n...（结果已截断，请收窄 pattern 或 path）" : "";
      return `找到 ${matches.length} 处匹配（扫描 ${scanned} 个文件）:\n${matches.join("\n")}${cap}`;
    },
  };
}
