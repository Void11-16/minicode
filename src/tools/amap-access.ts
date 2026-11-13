import { AmapClient } from "./amap.ts";
import { externalEnvironment, externalState } from "../core/external-environment.ts";

type FetchLike = typeof fetch;

/** 全局高德客户端（配置 Key 后可用） */
let amapClient: AmapClient | undefined;

export function setAmapKey(key: string | undefined, fetchFn: FetchLike = fetch): void {
  amapClient = key !== undefined && key !== "" ? new AmapClient({ apiKey: key, fetchFn }) : undefined;
}

export function getAmapClient(signal?: AbortSignal): AmapClient | undefined {
  const environment = externalEnvironment();
  const client = environment ? externalState("amap-client", undefined as AmapClient | undefined,
    () => new AmapClient({ apiKey: environment.amapKey, fetchFn: environment.fetch, sharedRateGate: false })) : amapClient;
  return signal === undefined ? client : client?.withSignal(signal);
}
