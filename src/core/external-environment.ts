import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 只替换旅行工具的外部环境，不替换工具、Agent 或模型。
 * 使用异步局部状态，避免并行评测污染彼此，也不改变 Web 会话的真实配置。
 */
export interface ExternalEnvironment {
  readonly fetch: typeof fetch;
  readonly now: Date;
  readonly timeZone: string;
  readonly amapKey: string;
  readonly state: Map<string, unknown>;
}

const environments = new AsyncLocalStorage<ExternalEnvironment>();

export function withExternalEnvironment<T>(environment: ExternalEnvironment, task: () => T): T {
  return environments.run(environment, task);
}

export function externalEnvironment(): ExternalEnvironment | undefined {
  return environments.getStore();
}

/** 日期/资料新旧判断使用场景时间；超时、耗时、限速继续使用真实时钟。 */
export function externalNow(): Date {
  return externalEnvironment()?.now ?? new Date(Date.now());
}

/** 地理编码等模块级缓存必须按场景隔离，不能借用之前联网运行的结果。 */
export function externalState<T>(key: string, live: T, create: () => T): T {
  const environment = externalEnvironment();
  if (!environment) return live;
  if (!environment.state.has(key)) environment.state.set(key, create());
  return environment.state.get(key) as T;
}
