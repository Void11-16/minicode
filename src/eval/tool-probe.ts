import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigStore } from "../config/config.ts";
import { ToolDiagnostics } from "../core/tool-diagnostics.ts";
import { setAmapKey } from "../tools/amap-access.ts";
import { createDefaultRegistry } from "../tools/all.ts";
import { summarizeToolDiagnostics, renderToolDiagnostics } from "./tool-diagnostics.ts";

/** 小规模真实服务探测；只调用旅行工具，不请求模型，不生成或改写用户行程。 */
export async function probeTravelTools(rootDir: string, onProgress: (message: string) => void = () => {}) {
  const config = await new ConfigStore(join(rootDir, ".minicode/config.json")).load();
  if (!config.amapApiKey) throw new Error("未配置高德 Key，不能将 OSM 降级探测当作高德测试");
  setAmapKey(config.amapApiKey);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = join(rootDir, "eval/runs", `tool-probe-${stamp}`);
  await mkdir(directory, { recursive: true });
  const registry = createDefaultRegistry({ writeRoot: directory, workspace: directory });
  const diagnostics = new ToolDiagnostics(), queryAttempts = new Map<string, number>();
  const attractionArgs = { city: "北京", location: "故宫博物院", radius_km: 2, limit: 5 };
  const routeArgs = { city: "北京", stops: ["北京南站", "八达岭长城"], mode: "transit" };
  const calls = [
    { name: "search_attractions", args: attractionArgs },
    { name: "search_attractions", args: attractionArgs },
    { name: "search_attractions", args: attractionArgs },
    { name: "search_stays", args: { city: "故宫博物院", region: "北京", radius_km: 2, limit: 3 } },
    { name: "search_restaurants", args: { city: "故宫博物院", region: "北京", radius_km: 2, limit: 3, max_cost: 100 } },
    { name: "get_place_reviews", args: { place: "故宫博物院", city: "北京", aspect: "开放时间" } },
    { name: "plan_day_routes", args: routeArgs },
    { name: "plan_day_routes", args: routeArgs },
  ];
  for (const [i, entry] of calls.entries()) {
    onProgress(`${i + 1}/${calls.length} ${entry.name}`);
    const call = { id: `probe-${i + 1}`, name: entry.name, arguments: JSON.stringify(entry.args) };
    await diagnostics.run(call, i + 1, async () => {
      try { return { output: await registry.execute(call.name, call.arguments, { workspace: directory, destination: "北京", queryAttempts, signal: AbortSignal.timeout(35_000) }) }; }
      catch (error) { return { output: "探测失败，错误类别见诊断", error: error instanceof Error ? error.message : String(error) }; }
    });
    await writeFile(join(directory, "tool-diagnostics.json"), JSON.stringify(diagnostics.snapshot(), null, 2));
  }
  const summary = summarizeToolDiagnostics(diagnostics);
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(directory, "summary.md"), `# 旅行工具小规模真实探测\n\n固定 8 次工具请求，包含缓存和重复拦截验证；仅一次运行，不能推断长期成功率。未调用模型/生成最终行程，证据引用率不适用。\n\n${renderToolDiagnostics(summary)}\n`);
  return { directory, summary };
}
