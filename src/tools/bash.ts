import { spawn } from "node:child_process";
import type { Tool } from "./tool.ts";
import { requireString } from "./tool.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

/** 只读命令白名单：不含任何副作用的常用查询命令 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "pwd", "whoami", "id",
  "date", "echo", "printf", "basename", "dirname", "realpath", "readlink",
  "which", "whereis", "uname", "sw_vers", "df", "du", "tree",
  "grep", "rg", "sort", "uniq", "cut", "tr", "diff", "comm", "jq",
  "seq", "expr", "true", "false", "hostname", "uptime", "locale",
]);

/** git 只读子命令 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "blame",
  "describe", "shortlog", "reflog", "whatchanged", "grep",
]);

/**
 * 只读命令判定（fail-closed）：
 * 含管道/重定向/命令替换/链式操作符 → 一律需要确认；
 * 未知命令、sudo/env 等包装 → 需要确认；`<cmd> --version/--help` 形态放行。
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (/[|&;<>`$()\n]/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0].split("/").pop() ?? tokens[0];
  if (["sudo", "env", "nohup", "xargs", "command", "eval", "exec", "sh", "bash", "zsh"].includes(first)) {
    return false;
  }
  // `node --version` 这类纯版本/帮助查询无副作用
  if (tokens.length === 2 && /^(--version|-V|--help|-h)$/.test(tokens[1])) return true;
  if (READ_ONLY_COMMANDS.has(first)) return true;
  if (first === "git" && tokens.length >= 2) {
    const subcommand = tokens[1];
    if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
    if (subcommand === "branch") {
      const rest = tokens.slice(2);
      // 只允许列目录类短旗标组合（a/r/v/l）；-d/-m/-c 等变更旗标不在集合内
      return rest.every((arg) => /^(--all|--list|--verbose|-[arvl]{1,4})$/.test(arg));
    }
  }
  return false;
}

/**
 * 生成「总是允许」的记忆键：
 * - `npm/yarn/pnpm/bun run <script>` 取三级（避免 npm run 放行所有脚本）
 * - 其余取前两级（git commit / git add / npm test）
 * 匹配规则：完整命令等于键，或以「键 + 空格」开头（参数变化仍命中）
 */
export function bashApprovalKey(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return "";
  const isRunner = ["npm", "yarn", "pnpm", "bun"].includes(tokens[0]) && tokens[1] === "run";
  const count = isRunner ? 3 : Math.min(2, tokens.length);
  const key = tokens.slice(0, count).join(" ");
  return key;
}

/** 命令是否命中已记住的审批键（前缀匹配） */
export function matchesBashApprovalKey(command: string, key: string): boolean {
  if (key === "") return false;
  const trimmed = command.trim();
  return trimmed === key || trimmed.startsWith(`${key} `);
}

/**
 * bash 工具 —— 在工作区执行 shell 命令。
 * - 用户默认 shell -lc：登录 shell，继承用户 PATH（brew 等安装的工具可用）
 * - 只读命令自动放行；其余（含管道/重定向/未知命令）走确认（needsConfirmation）
 * - 中断（/stop）与超时：先 SIGTERM 进程组，3 秒后 SIGKILL 兜底
 */
export function createBashTool(defaultWorkspace: string = process.cwd()): Tool {
  return {
    name: "bash",
    description:
      "在工作区执行 shell 命令（默认登录 shell，继承用户 PATH），返回退出码与输出。用于跑测试、构建、git 操作、装依赖等。" +
      "只读命令（ls/cat/git status 等）自动放行；含管道/重定向/命令链接的命令与变更类命令会先请求确认。" +
      "需要切换目录时用 `cd dir && cmd` 形式（会请求确认）。输出上限 30KB。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout_ms: {
          type: "number",
          description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}（2 分钟），上限 ${MAX_TIMEOUT_MS}（10 分钟）`,
        },
      },
      required: ["command"],
    },
    needsConfirmation: (args) => {
      const command = typeof args.command === "string" ? args.command : "";
      return !isReadOnlyCommand(command);
    },
    sessionAlwaysAllowed: false,
    confirmationMessage: (args) => `执行命令: ${String(args.command)}`,
    async execute(args, ctx) {
      const command = requireString(args, "command");
      const workspace = ctx?.workspace ?? defaultWorkspace;
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1000, Math.floor(typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS)),
      );

      return await new Promise<string>((resolvePromise) => {
        const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
          cwd: workspace,
          env: process.env,
          detached: true, // 独立进程组：kill(-pid) 可连同子进程一起终止
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let aborted = false;

        const killTree = (signal: NodeJS.Signals) => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {
              // 进程已退出
            }
          }
        };

        const finish = (note: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx?.signal?.removeEventListener("abort", onAbort);
          const combined = `${stdout}${stderr === "" ? "" : `\n[stderr]\n${stderr}`}`;
          const truncated = combined.length > MAX_OUTPUT_CHARS;
          const body = truncated
            ? `${combined.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，超过 30KB)`
            : combined;
          resolvePromise(`$ ${command}\n${note}\n---\n${body}`);
        };

        const onAbort = () => {
          aborted = true;
          killTree("SIGTERM");
          setTimeout(() => killTree("SIGKILL"), 3000).unref();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree("SIGTERM");
          setTimeout(() => killTree("SIGKILL"), 3000).unref();
        }, timeoutMs);
        timer.unref();

        ctx?.signal?.addEventListener("abort", onAbort, { once: true });
        if (ctx?.signal?.aborted === true) onAbort();

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          finish(`启动失败: ${error.message}`);
        });
        child.on("close", (code, signal) => {
          if (aborted) {
            finish("（命令已被用户中断）");
            return;
          }
          if (timedOut) {
            finish(`（超时 ${Math.round(timeoutMs / 1000)} 秒，已终止）退出码: ${code ?? `信号 ${String(signal)}`}`);
            return;
          }
          finish(code === 0 ? "退出码 0" : `退出码 ${code ?? `信号 ${String(signal)}`}`);
        });
      });
    },
  };
}
