import { AmapClient } from "./amap.ts";

type FetchLike = typeof fetch;

/** 全局高德客户端（配置 Key 后可用） */
let amapClient: AmapClient | undefined;

export function setAmapKey(key: string | undefined, fetchFn: FetchLike = fetch): void {
  amapClient = key !== undefined && key !== "" ? new AmapClient({ apiKey: key, fetchFn }) : undefined;
}

export function getAmapClient(): AmapClient | undefined {
  return amapClient;
}
