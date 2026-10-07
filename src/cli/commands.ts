import type { CliApp } from "./app.ts";
import { printSessionMatches, printSessions, formatConfig, printHelp, CONFIG_HELP } from "./ui.ts";
import { Session } from "../core/session.ts";
import { findSessions } from "../storage/session-store.ts";
import { newProfileId } from "../config/models.ts";

/** 命令处理器：返回 true 表示这行是命令并已处理 */
export type CommandHandler = (app: CliApp, line: string) => Promise<boolean>;

export async function handleCommand(app: CliApp, line: string): Promise<boolean> {
  if (line === "/exit" || line === "/new" || line === "/reset" || line === "/sessions" || line === "/history") {
    return true;
  }
  if (line === "/config" || line.startsWith("/config ")) return configCommand(app, line);
  if (line.startsWith("/resume")) return resumeCommand(app, line);
  if (line === "/rename" || line.startsWith("/rename ")) return renameCommand(app, line);
  if (line.startsWith("/delete")) return deleteCommand(app, line);
  const queueMatch = line.match(/^\/queue\s+(.+)$/);
  if (queueMatch !== null) {
    app.runtime.send(app.currentSessionId, queueMatch[1], "queue").catch(() => {});
    console.log("(已排队，将在当前轮结束后执行)\n");
    return true;
  }
  if (line === "/models" || line === "/model" || line.startsWith("/model ")) return modelCommand(app, line);
  if (line === "/travel" || line.startsWith("/travel ")) return travelCommand(app, line);
  return false;
}

async function modelCommand(app: CliApp, line: string): Promise<boolean> {
  // /models 固定是列表命令（不能按 /model 前缀切词，否则 "s" 会被当成关键词）
  const query = line === "/models" ? "" : line.slice("/model".length).trim();
  if (query === "") return listModels(app);

  if (query === "add") return addModelProfile(app);
  const editMatch = query.match(/^edit\s+(.+)$/);
  if (editMatch !== null) return editModelProfile(app, editMatch[1]);
  const delMatch = query.match(/^del(?:ete)?\s+(.+)$/);
  if (delMatch !== null) return deleteModelProfile(app, delMatch[1]);
  const defaultMatch = query.match(/^default\s+(.+)$/);
  if (defaultMatch !== null) return setDefaultModel(app, defaultMatch[1]);

  return selectModel(app, query);
}

function findProfile(app: CliApp, query: string) {
  const index = /^\d+$/.test(query) ? Number.parseInt(query, 10) - 1 : -1;
  return (
    app.profiles[index] ??
    app.profiles.find((p) => p.id === query || p.name.toLowerCase().includes(query.toLowerCase()))
  );
}

/** 交互提问：回车 = 使用 fallback（编辑时保留旧值） */
async function prompt(app: CliApp, message: string, fallback?: string): Promise<string> {
  const hint = fallback === undefined ? ": " : `（回车 = ${fallback === "" ? "留空" : fallback}）: `;
  process.stdout.write(`${message}${hint}`);
  const answer = ((await app.lines.next()) ?? "").trim();
  return answer === "" && fallback !== undefined ? fallback : answer;
}

function providerFromChoice(choice: string): "deepseek" | "openai" | "mock" | undefined {
  if (choice === "1" || choice.toLowerCase() === "deepseek") return "deepseek";
  if (choice === "2" || choice.toLowerCase() === "openai") return "openai";
  if (choice === "3" || choice.toLowerCase() === "mock") return "mock";
  return undefined;
}

async function listModels(app: CliApp): Promise<boolean> {
  if (app.profiles.length === 0) {
    console.log("还没有模型配置。用 /model add 添加（与 Web 端共享 .minicode/models.json）。\n");
    return true;
  }
  const current = app.currentAgent().session.modelProfile ?? app.defaultProfileId;
  console.log("可用模型:");
  app.profiles.forEach((profile, index) => {
    const marks: string[] = [];
    if (profile.id === app.defaultProfileId) marks.push("默认");
    if (profile.id === current) marks.push("当前会话");
    const kind = profile.provider === "openai" ? "OpenAI 兼容" : profile.provider;
    const mark = marks.length > 0 ? ` ← ${marks.join(" / ")}` : "";
    console.log(`  ${index + 1}. ${profile.name}（${kind}${profile.model ? ` · ${profile.model}` : ""}）${mark}`);
  });
  console.log(
    "\n用法: /model <序号|关键词> 切换当前会话 · /model add 添加 · /model edit <序号> 编辑\n" +
    "      /model del <序号> 删除 · /model default <序号> 设为默认\n",
  );
  return true;
}

async function addModelProfile(app: CliApp): Promise<boolean> {
  if (guardBusy(app)) return true;
  console.log("添加模型配置（每项直接输入，Ctrl+C 取消）:\n");
  const name = await prompt(app, "1/5 名称（如 DeepSeek Reasoner / 本地 Qwen）");
  if (name === "") {
    console.log("名称不能为空，已取消\n");
    return true;
  }
  const kind = providerFromChoice(await prompt(app, "2/5 类型: 1=DeepSeek / 2=OpenAI 兼容 / 3=Mock", "1"));
  if (kind === undefined) {
    console.log("类型只能是 1 / 2 / 3，已取消\n");
    return true;
  }
  const model = await prompt(app, "3/5 模型名（如 deepseek-reasoner / gpt-4o-mini，可留空）", "");
  let apiKey = "";
  let baseUrl = "";
  if (kind === "openai") {
    baseUrl = await prompt(app, "4/5 Base URL（OpenAI 兼容服务地址）", "https://api.openai.com/v1");
    apiKey = await prompt(app, "5/5 API Key（本地服务可随意填）", "");
  } else if (kind === "deepseek") {
    apiKey = await prompt(app, "4/5 API Key", "");
  }
  if (kind !== "mock" && apiKey === "") {
    console.log("API Key 不能为空，已取消\n");
    return true;
  }

  await app.saveModelProfile({
    id: newProfileId(app.profiles),
    name,
    provider: kind,
    model: model === "" ? undefined : model,
    apiKey: apiKey === "" ? undefined : apiKey,
    baseUrl: baseUrl === "" ? undefined : baseUrl,
  });
  console.log(`\n✅ 已添加「${name}」，用 /model ${name} 为当前会话启用
`);
  return true;
}

async function editModelProfile(app: CliApp, query: string): Promise<boolean> {
  if (guardBusy(app)) return true;
  const profile = findProfile(app, query);
  if (profile === undefined) {
    console.log(`没有匹配「${query}」的模型，可用 /models 查看列表
`);
    return true;
  }
  console.log(`编辑「${profile.name}」（回车 = 保留当前值）:
`);
  const name = await prompt(app, "名称", profile.name);
  const kind = providerFromChoice(
    await prompt(app, "类型: 1=DeepSeek / 2=OpenAI 兼容 / 3=Mock", profile.provider === "openai" ? "2" : profile.provider === "mock" ? "3" : "1"),
  );
  if (kind === undefined) {
    console.log("类型只能是 1 / 2 / 3，已取消\n");
    return true;
  }
  const model = await prompt(app, "模型名", profile.model ?? "");
  const apiKey = kind === "mock" ? "" : await prompt(app, "API Key（回车 = 保留原 Key）", "");
  const baseUrl = kind === "openai" ? await prompt(app, "Base URL", profile.baseUrl ?? "https://api.openai.com/v1") : "";

  await app.saveModelProfile({
    id: profile.id,
    name,
    provider: kind,
    model: model === "" ? undefined : model,
    // 回车保留旧 Key，避免把空值/掩码写回去
    apiKey: apiKey === "" ? profile.apiKey : apiKey,
    baseUrl: baseUrl === "" ? undefined : baseUrl,
  });
  console.log(`\n✅ 已更新「${name}」
`);
  return true;
}

async function deleteModelProfile(app: CliApp, query: string): Promise<boolean> {
  if (guardBusy(app)) return true;
  const profile = findProfile(app, query);
  if (profile === undefined) {
    console.log(`没有匹配「${query}」的模型，可用 /models 查看列表
`);
    return true;
  }
  if ((app.currentAgent().session.modelProfile ?? app.defaultProfileId) === profile.id) {
    console.log("当前会话正在使用该模型，请先 /model 切换到其他模型再删除\n");
    return true;
  }
  process.stdout.write(`确认删除「${profile.name}」？(y=删除 / n=取消) `);
  const answer = ((await app.lines.next()) ?? "n").trim().toLowerCase();
  console.log("");
  if (answer !== "y") {
    console.log("(已取消)\n");
    return true;
  }
  const deleted = await app.deleteModelProfile(profile.id);
  console.log(deleted ? `(已删除「${profile.name}」)
` : `删除失败: 未找到「${profile.name}」
`);
  return true;
}

async function setDefaultModel(app: CliApp, query: string): Promise<boolean> {
  if (guardBusy(app)) return true;
  const profile = findProfile(app, query);
  if (profile === undefined) {
    console.log(`没有匹配「${query}」的模型，可用 /models 查看列表
`);
    return true;
  }
  await app.setDefaultModelProfile(profile.id);
  console.log(`(已将「${profile.name}」设为默认模型，新会话将使用它)
`);
  return true;
}

async function selectModel(app: CliApp, query: string): Promise<boolean> {
  const profile = findProfile(app, query);
  if (profile === undefined) {
    console.log(`没有匹配「${query}」的模型，可用 /models 查看列表
`);
    return true;
  }
  if (guardBusy(app)) return true;
  const session = app.currentAgent().session;
  session.setModelProfile(profile.id);
  app.switchSession(session);
  await app.sessionService.persist(session);
  console.log(`(当前会话已切换到 ${profile.name}，其他会话不受影响；新会话用默认模型)
`);
  return true;
}

function guardBusy(app: CliApp): boolean {
  if (!app.runtime.hasActiveTurn(app.currentSessionId)) return false;
  console.log("当前轮还在执行，等结束后再操作模型\n");
  return true;
}

/** 交互式需求单向导：逐项填写（回车跳过），生成后自动作为消息发送 */
async function briefWizard(app: CliApp): Promise<boolean> {
  console.log("填写旅行需求单（回车 = 跳过该项，填完自动发送规划）:\n");
  const fields: Array<[string, string]> = [
    ["目的地（如：杭州）", "目的地"],
    ["出行日期（如：2026-10-01 至 2026-10-03）", "出行日期"],
    ["人数（如：2）", "人数"],
    ["总预算（如：3000 元）", "总预算"],
    ["单餐人均（如：100 元）", "单餐人均"],
    ["口味偏好（如：不吃辣、想尝试本地特色）", "口味偏好"],
    ["住宿偏好（如：靠近西湖、500 元内）", "住宿偏好"],
    ["节奏（慢 / 适中 / 紧凑）", "节奏"],
    ["必去（逗号分隔，如：灵隐寺、西湖）", "必去"],
    ["避开（如：人多的网红店）", "避开"],
    ["其他（带老人/孩子、摄影等）", "其他"],
  ];
  const filled: string[] = [];
  let step = 0;
  for (const [question, label] of fields) {
    step += 1;
    const answer = await prompt(app, `${step}/${fields.length} ${question}`);
    if (answer !== "") filled.push(`${label}: ${answer}`);
  }
  if (filled.length === 0) {
    console.log("所有项都为空，已取消\n");
    return true;
  }
  const briefText = `【旅行需求单】\n${filled.join("\n")}`;
  console.log(`\n✅ 需求单已生成，自动发送：\n${briefText}\n`);
  // 走正常消息通道：预算检查、steer 判断、会话记录都生效
  app.lines.push(briefText);
  return true;
}

async function travelCommand(app: CliApp, line: string): Promise<boolean> {
  const arg = line.slice("/travel".length).trim().toLowerCase();
  if (arg !== "on" && arg !== "off") {
    console.log(`用法: /travel on|off（当前: ${app.travelMode ? "旅行规划模式" : "通用助手"}）\n`);
    return true;
  }
  app.travelMode = arg === "on";
  app.rebuildRuntime(app.currentAgent().session);
  console.log(`(已切换到${app.travelMode ? "旅行规划模式" : "通用助手"})\n`);
  return true;
}

async function renameCommand(app: CliApp, line: string): Promise<boolean> {
  const title = line.slice("/rename".length).trim();
  if (title === "") {
    console.log("用法: /rename <新标题>，如: /rename 杭州三日游\n");
    return true;
  }

  try {
    const session = app.currentAgent().session;
    session.rename(title);
    await app.sessionService.persist(session);
    console.log(`(已重命名为「${session.title}」)\n`);
  } catch (error) {
    console.log(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return true;
}

async function deleteCommand(app: CliApp, line: string): Promise<boolean> {
  const query = line.slice("/delete".length).trim();
  if (query === "") {
    console.log("用法: /delete <序号|标题关键词|会话id>，如: /delete 2 或 /delete 上海\n");
    return true;
  }

  const sessions = await app.store.list();
  const matches = findSessions(sessions, query);
  if (matches.length === 0) {
    console.log(`没有匹配「${query}」的会话，可用 /sessions 查看列表\n`);
    return true;
  }
  if (matches.length > 1) {
    printSessionMatches(query, matches);
    return true;
  }

  const target = matches[0];
  if (target.id === app.currentSessionId) {
    console.log("不能删除当前正在使用的会话，请先 /new 或 /resume 切换到其他会话\n");
    return true;
  }

  // 二次确认（删除不可恢复，归档也会一并清理）
  console.log(`即将删除「${target.title}」（${target.messageCount} 条消息，纪元 ${target.epoch}）`);
  process.stdout.write("确认删除? (y=删除 / n=取消) ");
  const answer = (await app.lines.next()) ?? "n";
  const choice = answer.trim().toLowerCase();
  console.log("");
  if (choice !== "y") {
    console.log("(已取消)\n");
    return true;
  }

  const deleted = await app.store.delete(target.id);
  const archives = await app.store.deleteArchives(target.id);
  if (deleted) {
    const archiveNote = archives > 0 ? `，及 ${archives} 个归档` : "";
    console.log(`(已删除「${target.title}」${archiveNote})\n`);
  } else {
    console.log(`删除失败: 会话文件读取不到（可能已被删除）\n`);
  }
  return true;
}

async function configCommand(app: CliApp, line: string): Promise<boolean> {
  const parts = line.split(/\s+/);

  if (parts.length === 1) {
    console.log(formatConfig(app.config));
    return true;
  }

  // 值允许包含空格（如 system_prompt），整体截取而不是按空白切分成第 4 段
  const setMatch = line.match(/^\/config\s+set\s+(\S+)\s+(.+)$/);
  if (setMatch !== null) {
    try {
      const next = await app.configStore.set(setMatch[1], setMatch[2].trim());
      app.applyConfig(next);
      console.log(`(已保存并生效)\n${formatConfig(next)}\n`);
    } catch (error) {
      console.log(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return true;
  }

  if (parts[1] === "clear" && parts.length === 3) {
    try {
      const next = await app.configStore.clear(parts[2]);
      app.applyConfig(next);
      console.log(`(已清除)\n${formatConfig(next)}\n`);
    } catch (error) {
      console.log(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return true;
  }

  console.log(CONFIG_HELP);
  return true;
}

async function resumeCommand(app: CliApp, line: string): Promise<boolean> {
  const query = line.slice("/resume".length).trim();
  if (query === "") {
    console.log("用法: /resume <序号|标题关键词|会话id>，如: /resume 1 或 /resume 杭州\n");
    return true;
  }

  const sessions = await app.store.list();
  const matches = findSessions(sessions, query);
  if (matches.length === 0) {
    console.log(`没有匹配「${query}」的会话，可用 /sessions 查看列表\n`);
    return true;
  }
  if (matches.length > 1) {
    printSessionMatches(query, matches);
    return true;
  }

  const result = await app.sessionService.loadWithPrepare(matches[0].id);
  if (result === null) {
    console.log(`会话文件读取失败: ${matches[0].id}\n`);
    return true;
  }

  const restored = result.session;
  if (result.compactionError !== undefined) {
    console.log(`⚠️ 自动压缩失败（${result.compactionError}），已全量恢复`);
  }
  if (result.compacted !== undefined) {
    console.log(
      `♻️ 历史较长（估算 ${result.compacted.tokensBefore} tokens），已压缩为摘要 + 最近 8 条` +
      `（估算 ${result.compacted.tokensAfter} tokens，进入第 ${result.compacted.epoch} 纪元）`,
    );
  }

  app.switchSession(restored);
  console.log(`(已恢复「${restored.title}」，共 ${restored.history.length} 条消息，纪元 ${restored.epoch})`);

  const summaryMessage = restored.history.find((m) => m.role === "system");
  if (summaryMessage !== undefined) {
    const digest = summaryMessage.content.replace(/^【[^】]*】[^\n]*\n/, "").slice(0, 150);
    console.log(`📋 上次对话回顾: ${digest}${summaryMessage.content.length > 150 ? "…" : ""}\n`);
  } else {
    const lastUser = [...restored.history].reverse().find((m) => m.role === "user");
    if (lastUser !== undefined) {
      console.log(`📋 最后话题: ${lastUser.content.slice(0, 80)}\n`);
    }
  }
  return true;
}

// 简单命令的执行逻辑放在 app（需要访问状态），这里只做路由
export async function executeSimpleCommand(app: CliApp, line: string): Promise<boolean> {
  if (line === "/exit") {
    app.running = false;
    return true;
  }
  if (line === "/new") {
    app.switchSession(new Session());
    console.log(`(新会话: ${app.currentAgent().session.id})\n`);
    return true;
  }
  if (line === "/reset") {
    app.switchSession(new Session());
    console.log("(会话已清空)\n");
    return true;
  }
  if (line === "/sessions") {
    printSessions(await app.store.list());
    return true;
  }
      if (line === "/history") {
    for (const message of app.currentAgent().history) {
      console.log(`[${message.role}] ${message.content}`);
    }
    console.log("");
        return true;
      }
  if (line === "/stop") {
        if (app.runtime.abortActiveTurn(app.currentSessionId)) {
          console.log("(已发送中断信号，正在停止当前轮…)\n");
        } else {
          console.log("(当前没有执行中的轮次)\n");
        }
        return true;
  }
  if (line === "/brief") return briefWizard(app);
  if (line === "/help") {
        printHelp(app.registry.size);
        return true;
      }
      return false;
  }
