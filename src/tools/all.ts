import {
  ToolRegistry,
  type Tool,
  type ToolCategory,
  type ToolOutputKind,
} from "./tool.ts";
import { createWeatherTool } from "./weather.ts";
import { createGeocodeTool, createReverseGeocodeTool, createDistanceTool } from "./geo.ts";
import { createRouteTool } from "./route.ts";
import { createStayTool } from "./stay.ts";
import {
  createEditFileTool,
  createGrepTool,
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from "./files.ts";
import { createBashTool } from "./bash.ts";
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
import { createListTravelerProfilesTool, createLoadTravelerProfileTool } from "./profiles.ts";
/**
 * 注册默认工具集（旅行规划场景）。
 * 注意: 高德 Key 通过 setAmapKey 由装配层（CLI）管理，这里不触碰 ——
 * 之前在无参调用时 setAmapKey(undefined) 会覆盖已配置的 Key（真实 bug）。
 */
export interface DefaultRegistryOptions {
  /** itinerary/brief 等产物目录（plans/）的根；MCP 等场景固定到项目目录，不依赖启动 cwd */
  readonly writeRoot?: string;
  /** 文件类工具与 bash 的默认工作区（运行时 ctx.workspace 优先）；默认 cwd */
  readonly workspace?: string;
}

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ToolRegistry {
  const workspace = options.workspace ?? process.cwd();
  const registry = new ToolRegistry(options.writeRoot ?? workspace, workspace);
  registry
    .register(catalog(createReadFileTool(workspace), "workspace", "file", ["读取", "文件", "代码", "read"]))
    .register(catalog(createWriteFileTool(workspace), "workspace", "file", ["写入", "创建", "文件", "write"]))
    .register(catalog(createEditFileTool(workspace), "workspace", "file", ["编辑", "修改", "代码", "edit"]))
    .register(catalog(createListFilesTool(workspace), "workspace", "file", ["目录", "文件列表", "浏览", "list"]))
    .register(catalog(createGrepTool(workspace), "workspace", "file", ["搜索", "内容", "代码", "grep"]))
    .register(catalog(createBashTool(workspace), "workspace", "command", ["命令", "测试", "构建", "shell", "bash"]))
    .register(catalog(createWeatherTool(), "travel-basics", "weather", ["天气", "温度", "降水", "预报"]))
    .register(catalog(createGeocodeTool(), "travel-basics", "place-list", ["坐标", "经纬度", "地址", "地理编码"]))
    .register(catalog(createReverseGeocodeTool(), "travel-basics", "place-list", ["反查", "坐标", "地点"]))
    .register(catalog(createDistanceTool(), "travel-basics", "route", ["直线距离", "距离", "公里"]))
    .register(catalog(createRouteTool(), "routing", "route", ["路线", "耗时", "驾车", "步行", "骑行"]))
    .register(catalog(createStayTool(), "discovery", "place-list", ["住宿", "酒店", "民宿", "酒店坐标"]))
    .register(catalog(createAttractionsTool(), "discovery", "place-list", ["景点", "博物馆", "古迹", "公园", "候选"]))
    .register(catalog(createReviewsTool(), "discovery", "place-list", ["口碑", "评价", "评分", "开放时间", "游玩时长"]))
    .register(catalog(createFoodTool(), "discovery", "place-list", ["餐厅", "美食", "菜系", "人均", "本地特色"]))
    .register(catalog(createPlanRoutesTool(), "routing", "route", ["当天路线", "通勤", "公交", "远郊", "路线复核"]))
    .register(catalog(createSaveItineraryTool(options.writeRoot ?? process.cwd()), "itinerary", "itinerary", ["保存行程", "修改行程", "质量", "落盘"]))
    .register(catalog(createLoadItineraryTool(options.writeRoot ?? process.cwd()), "itinerary", "itinerary", ["读取行程", "当前版本", "修改", "按天"]))
    .register(catalog(createListItinerariesTool(options.writeRoot ?? process.cwd()), "itinerary", "itinerary", ["行程列表", "已保存"]))
    .register(catalog(createValidateItineraryTool(options.writeRoot ?? process.cwd()), "itinerary", "validation", ["质量校验", "strict", "P0", "P1", "问题"]))
    .register(catalog(createSaveTravelBriefTool(options.writeRoot ?? process.cwd()), "traveler", "profile", ["需求单", "偏好", "预算", "日期", "节奏"]))
    .register(catalog(createLoadTravelBriefTool(options.writeRoot ?? process.cwd()), "traveler", "profile", ["读取需求", "约束", "偏好"]))
    .register(catalog(createListTravelerProfilesTool(options.writeRoot ?? process.cwd()), "traveler", "profile", ["旅行者", "同行人", "档案"]))
    .register(catalog(createLoadTravelerProfileTool(options.writeRoot ?? process.cwd()), "traveler", "profile", ["同行人", "忌口", "过敏", "体力"]));
  return registry;
}

function catalog(
  tool: Tool,
  category: ToolCategory,
  outputKind: ToolOutputKind,
  keywords: readonly string[],
): Tool {
  return { ...tool, category, outputKind, keywords };
}
