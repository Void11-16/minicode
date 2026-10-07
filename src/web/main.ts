import { join } from "node:path";
import { startWebServer } from "./server.ts";

const rootDir = process.env.MINICODE_ROOT ?? join(import.meta.dirname, "..", "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const running = await startWebServer({ rootDir, port });
console.log(`🧭 minicode Web 已启动: http://localhost:${running.port}`);
console.log(`   项目根目录: ${rootDir}（配置/会话/行程单都在这里）`);
console.log("   Ctrl+C 停止");
