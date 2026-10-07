import { ToolRegistry } from "./tool.ts";
import { createWeatherTool } from "./weather.ts";
import { createGeocodeTool, createReverseGeocodeTool, createDistanceTool } from "./geo.ts";
import { createRouteTool } from "./route.ts";
import { createStayTool } from "./stay.ts";
import { createDocumentTool } from "./docs.ts";
import { createWriteDocumentTool } from "./markdown.ts";
import { createAttractionsTool } from "./attractions.ts";
import { createReviewsTool } from "./reviews.ts";
import { createFoodTool } from "./food.ts";
import { createPlanRoutesTool } from "./transit.ts";
import {
  createSaveItineraryTool,
  createLoadItineraryTool,
  createListItinerariesTool,
  createValidateItineraryTool,
} from "./itinerary.ts";
import { createSaveTravelBriefTool, createLoadTravelBriefTool } from "./brief.ts";
/**
 * 注册默认工具集（旅行规划场景）。
 * 注意: 高德 Key 通过 setAmapKey 由装配层（CLI）管理，这里不触碰 ——
 * 之前在无参调用时 setAmapKey(undefined) 会覆盖已配置的 Key（真实 bug）。
 */
export interface DefaultRegistryOptions {
  /** write_document 的可写根目录；MCP 等场景固定到项目目录，不依赖启动 cwd */
  readonly writeRoot?: string;
  /** read_document 的可读根目录；MCP 等无人工确认的场景必须传入 */
  readonly readRoot?: string;
}

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry
    .register(createWeatherTool())
    .register(createGeocodeTool())
    .register(createReverseGeocodeTool())
    .register(createDistanceTool())
    .register(createRouteTool())
    .register(createStayTool())
    .register(createDocumentTool(options.readRoot === undefined ? {} : { readRoot: options.readRoot }))
    .register(createWriteDocumentTool(options.writeRoot ?? process.cwd()))
    .register(createAttractionsTool())
    .register(createReviewsTool())
    .register(createFoodTool())
    .register(createPlanRoutesTool())
    .register(createSaveItineraryTool(options.writeRoot ?? process.cwd()))
    .register(createLoadItineraryTool(options.writeRoot ?? process.cwd()))
    .register(createListItinerariesTool(options.writeRoot ?? process.cwd()))
    .register(createValidateItineraryTool(options.writeRoot ?? process.cwd()))
    .register(createSaveTravelBriefTool(options.writeRoot ?? process.cwd()))
    .register(createLoadTravelBriefTool(options.writeRoot ?? process.cwd()));
  return registry;
}
