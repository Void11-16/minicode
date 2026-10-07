import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

let debugEnabled = false;
let logFile = "";
// 串行化写入，避免并发追加交错
let writeChain: Promise<void> = Promise.resolve();

export function enableDebug(): void {
  debugEnabled = true;
  logFile = join(process.cwd(), ".minicode", "debug.log");
}

/** 调试日志：--debug 时追加到 .minicode/debug.log（不影响正常输出） */
export function debugLog(scope: string, message: string): void {
  if (!debugEnabled) return;
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(logFile), { recursive: true });
      await appendFile(logFile, line, "utf8");
    })
    .catch(() => {
      // 日志失败静默（不能影响主流程）
    });
}
