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

  // workspace: MCP 无人工确认环节，文件类工具与 bash 限制在项目目录内
  const registry = createDefaultRegistry({ writeRoot: plansDir, workspace: projectRoot });
  await runStdioMcp(registry, {
    name: "minicode",
    version: serverVersion(),
    instructions:
      "通用 AI 助手工具集（旅行规划为特长）：文件读写编辑、命令执行、天气、地理编码、路线距离、景点/住宿/餐厅搜索、网络口碑。" +
      "坐标规则：行程条目的经纬度从 search_attractions/search_stays/search_restaurants 返回条目里逐字复制（格式「纬度,经度」）；" +
      "用 geocode 必须传 city（会做省市字段校验，防止外地同名地点——「北海公园」不带 city 会命中新疆五家渠）；" +
      "核实失败先换查询词重查（城市+区+完整名称，如「北京市西城区北海公园」），再改用 search_attractions 取坐标；" +
      "仍核实不了的地点不写坐标、note 注明「坐标待核实」。" +
      "交付闭环：save_itinerary 分批（merge=true）保存 → plan_day_routes 复核通勤 → validate_itinerary（strict=true）验收" +
      "（strict 未通过先修正行程再交付；餐饮项只做参考提示，不影响通过判定）；" +
      "只有工具实际返回通过才能对用户说「已保存/已通过」，任何一步没通过都要如实报告未完成。" +
      `save_itinerary 生成的行程单会保存到 ${plansDir} 目录。` +
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
