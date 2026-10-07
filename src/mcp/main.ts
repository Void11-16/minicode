import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config/config.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { runStdioMcp } from "./server.ts";

/** MCP 入口：把旅行规划工具通过 stdio 暴露给 ChatGPT / Codex 等客户端 */
const projectRoot = join(import.meta.dirname, "..", "..");
const plansDir = join(projectRoot, "plans");

async function main(): Promise<void> {
  // 复用 CLI 的配置文件（amap_key 等）；路径固定到项目目录，不依赖客户端的启动 cwd
  const config = await new ConfigStore(join(projectRoot, ".minicode", "config.json")).load();
  setAmapKey(config.amapApiKey);

  // readRoot: MCP 无人工确认环节，read_document 限制在项目目录内防任意路径读取
  const registry = createDefaultRegistry({ writeRoot: plansDir, readRoot: projectRoot });
  await runStdioMcp(registry, {
    name: "minicode",
    version: serverVersion(),
    instructions:
      "旅行规划工具集：天气、地理编码、路线、景点、住宿、餐厅、网络口碑，以及文档读写。" +
      "生成或修改行程后必须调用 validate_itinerary；strict 模式未通过时先修正行程再交付。" +
      `write_document 生成的行程单会保存到 ${plansDir} 目录。` +
      (config.tastePreferences !== undefined ? `用户口味偏好：${config.tastePreferences}。` : ""),
  });
}

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((error) => {
  console.error(error); // stderr，不污染 stdout 协议流
  process.exitCode = 1;
});
