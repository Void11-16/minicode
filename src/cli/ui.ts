import { maskSecret, type AppConfig } from "../config/config.ts";
import type { SessionMeta } from "../storage/session-store.ts";

/**
 * 流式输出状态机：协调「文本增量」与「工具事件」的换行，
 * 保证 ai> 前缀与 ⚡ 事件不挤在同一行。
 */
export class StreamPrinter {
  private midStream = false;
  private readonly isActiveSession: (sessionId: string) => boolean;

  constructor(isActiveSession: (sessionId: string) => boolean) {
    this.isActiveSession = isActiveSession;
  }

  /** 文本增量：首次输出前打印 ai> 前缀 */
  delta(sessionId: string, delta: string): void {
    if (!this.isActiveSession(sessionId)) return;
    if (!this.midStream) {
      process.stdout.write("ai> ");
      this.midStream = true;
    }
    process.stdout.write(delta);
  }

  /** 工具事件前结束当前流式行 */
  endLine(): void {
    if (this.midStream) {
      process.stdout.write("\n");
      this.midStream = false;
    }
  }

  /** 轮次结束：流式输出收尾换行；未流式时返回 false 由调用方整段打印 */
  finishTurn(): boolean {
    if (this.midStream) {
      process.stdout.write("\n\n");
      this.midStream = false;
      return true;
    }
    return false;
  }
}

export function printBanner(providerName: string, toolCount: number, sessionId: string, workspace: string, approvalLabel: string, configFile: string, debug: boolean): void {
  console.log(`minicode (provider: ${providerName}, 工具: ${toolCount} 个, session: ${sessionId})`);
  console.log(`工作区: ${workspace}`);
  console.log(`审批模式: ${approvalLabel}（/approval 调整）`);
  console.log(`配置文件: ${configFile}`);
  if (debug) {
    console.log("调试日志: .minicode/debug.log");
  }
  console.log("命令: /help 查看全部命令\n");
  console.log("本轮执行期间输入内容 = steer 实时注入；/queue 前缀 = 排队到下一轮\n");
  console.log("每轮对话自动保存到 .minicode/sessions/，重启后可 /resume 继续\n");
}

export function printHelp(toolCount: number): void {
  console.log([
    "minicode 命令一览:",
    "",
    "  会话:",
    "    /new                     开始新会话",
    "    /sessions                列出已保存会话（编号 + 标题 + 时间）",
    "    /resume <序号|关键词|id>  恢复会话（多匹配时列出候选）",
    "    /rename <新标题>          重命名当前会话",
    "    /delete <序号|关键词|id>  删除会话（二次确认，连带归档）",
    "    /history                 查看当前会话完整历史",
    "    /workspace <目录>        切换当前会话工作区（reset 恢复默认）",
    "",
  "  需求:",
  "    /brief                   交互式填写旅行需求单（逐项输入，填完自动发送）",
  "    /travel on|off           旅行规划模式开关（off = 通用助手）",
    "",
  "  执行控制:",
  "    /stop                    中断当前正在执行的轮次（保留会话状态）",
  "    /queue <内容>             排队到当前轮结束后执行",
  "    （执行期间直接输入 = steer 实时注入当前轮）",
  "    /approval ask|edits|trust  切换审批模式（edits=文件写入免确认；trust=全部免确认，仅本会话）",
    "",
  "  配置:",
  "    /config                  查看配置",
  "    /config set <键> <值>    设置（Key/模型/单价/预算/人设等）",
  "    /config clear <键>       清除某项",
  "    /models                  查看多模型配置列表",
  "    /model <序号|关键词>     为当前会话切换模型（每个会话独立记忆）",
  "    /model add               交互式添加模型配置",
  "    /model edit <序号>       编辑模型配置（回车保留旧值）",
  "    /model del <序号>        删除模型配置（二次确认）",
  "    /model default <序号>    设为默认模型（新会话使用）",
    "",
    "  其他:",
    "    /help                    本帮助",
    "    /exit                    退出",
    "",
    `当前注册工具: ${toolCount} 个`,
    "输入历史: ↑/↓ 翻阅之前发过的消息",
    "",
  ].join("\n"));
}

export function printSessions(sessions: readonly SessionMeta[]): void {
  if (sessions.length === 0) {
    console.log("(暂无保存的会话)\n");
    return;
  }
  for (const [index, s] of sessions.entries()) {
    const time = new Date(s.updatedAt).toLocaleString();
    const preview = s.preview === s.title ? "" : `  → ${s.preview}`;
    console.log(`${index + 1}. ${s.title}  [${s.messageCount} 条 | 纪元 ${s.epoch}]  ${time}${preview}`);
  }
  console.log("");
}

export function printSessionMatches(query: string, matches: readonly SessionMeta[]): void {
  console.log(`「${query}」匹配到 ${matches.length} 个会话，请细化（用序号或更长的关键词）:`);
  for (const [index, m] of matches.entries()) {
    const time = new Date(m.updatedAt).toLocaleString();
    console.log(`  ${index + 1}. ${m.title}  [${m.messageCount} 条]  ${time}  (${m.id})`);
  }
  console.log("");
}

export function formatConfig(config: AppConfig): string {
  const lines = [
    `provider:        ${config.provider}`,
    `deepseek_api_key: ${maskSecret(config.deepseekApiKey) ?? "(未设置)"}`,
    `deepseek_model:  ${config.deepseekModel ?? "(默认 deepseek-chat)"}`,
    `amap_api_key:    ${maskSecret(config.amapApiKey) ?? "(未设置)"}`,
    `llm_api_key:     ${maskSecret(config.llmApiKey) ?? "(未设置)"}`,
    `llm_base_url:    ${config.llmBaseUrl ?? "(默认 https://api.openai.com/v1)"}`,
    `llm_model:       ${config.llmModel ?? "(默认 gpt-4o-mini)"}`,
    `price_in:        ${config.priceIn ?? "2"} 元/百万tokens (估算用)`,
    `price_out:       ${config.priceOut ?? "3"} 元/百万tokens (估算用)`,
    `system_prompt:    ${config.systemPrompt === undefined ? "(默认旅行规划助手)" : `${config.systemPrompt.slice(0, 30)}…`}`,
    `taste_preferences: ${config.tastePreferences === undefined ? "(未设置，规划餐饮时会询问)" : `${config.tastePreferences.slice(0, 30)}…`}`,
    `budget_yuan:      ${config.budgetYuan ?? "0"} (单会话花费上限，0=不限制)`,
  ];
  return `${lines.join("\n")}\n`;
}

export const CONFIG_HELP = [
  "用法:",
  "  /config                                  查看当前配置",
  "  /config set deepseek_api_key sk-...      设置 DeepSeek Key（一次永久生效）",
  "  /config set deepseek_model deepseek-reasoner",
  "  /config set amap_api_key <key>             高德 API Key（国内定位/POI 数据）",
  "  /config set llm_api_key sk-...           设置其他 OpenAI 兼容服务",
  "  /config set llm_base_url http://localhost:11434/v1   # Ollama 等本地服务",
  "  /config set provider mock|deepseek|openai|auto       强制指定",
  "  /config set price_in 2                   输入单价（元/百万 tokens）",
  "  /config set system_prompt 你是...        自定义助手人设",
  "  /config set taste_preferences 不吃辣、人均100内、爱本地特色   口味偏好（餐饮推荐参考）",
  "  /config set budget_yuan 5               单会话花费上限（元，0=不限）",
  "  /config clear deepseek_api_key           清除某项",
  "",
].join("\n");
