import { Resolver, lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const fakeIp = new BlockList();
fakeIp.addSubnet("198.18.0.0", 15); // Clash/Surge 等 fake-IP 常用测试网段

const nonPublic = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3], ["168.63.129.16", 32],
] as const) nonPublic.addSubnet(address, bits);

export type OpeningPageFetchCode = "FAKE_IP" | "NON_PUBLIC_IP" | "DNS_ERROR";

export class OpeningPageFetchError extends Error {
  readonly code: OpeningPageFetchCode;
  readonly host: string;
  readonly address: string | undefined;

  constructor(code: OpeningPageFetchCode, host: string, address: string | undefined, message: string) {
    super(message);
    this.name = "OpeningPageFetchError";
    this.code = code;
    this.host = host;
    this.address = address;
  }
}

export function isFakeIp(address: string): boolean {
  return fakeIp.check(address, "ipv4");
}

/** 198.18/15 是 Clash/Surge 等代理的常见 fake-IP 网段，默认放行；显式设 0 才拒绝。 */
export function fakeIpAllowed(): boolean {
  return process.env.MINICODE_ALLOW_FAKE_IP !== "0";
}

async function resolvePageAddress(host: string): Promise<string> {
  const servers = (process.env.MINICODE_DNS_SERVERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  let addresses: string[];
  try {
    if (servers.length > 0) {
      const resolver = new Resolver();
      resolver.setServers(servers);
      addresses = await resolver.resolve4(host);
    } else {
      addresses = (await lookup(host, { family: 4, all: true })).map((item) => item.address);
    }
  } catch (error) {
    throw new OpeningPageFetchError("DNS_ERROR", host, undefined, `正文域名解析失败（${host}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const publicAddress = addresses.find((address) => !nonPublic.check(address, "ipv4") && !isFakeIp(address));
  if (publicAddress !== undefined) return publicAddress;
  const fakeAddress = addresses.find(isFakeIp);
  if (fakeAddress !== undefined) {
    if (fakeIpAllowed()) return fakeAddress;
    throw new OpeningPageFetchError("FAKE_IP", host, fakeAddress,
      `正文地址 ${host} 被解析到 fake-IP ${fakeAddress}；当前已显式设置 MINICODE_ALLOW_FAKE_IP=0。关闭代理 fake-IP、设置 MINICODE_DNS_SERVERS，或移除该变量即可恢复默认放行。`);
  }
  const privateAddress = addresses.find((address) => nonPublic.check(address, "ipv4"));
  throw new OpeningPageFetchError("NON_PUBLIC_IP", host, privateAddress ?? addresses[0],
    `正文地址未解析到公网${privateAddress === undefined ? "" : `（${privateAddress}）`}。`);
}

export function openingPageUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.replace(/(\.html?)(?:%27|%22|['"])+(?=$|[?#])/gi, "$1"));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !url.hostname.includes(".") || isIP(url.hostname) || url.hostname.endsWith(".")) return undefined;
    url.hash = "";
    return url;
  } catch { return undefined; }
}

/** 搜索结果的地址不受信任。连接使用已检查的IPv4地址，保留原主机名做TLS校验，不跟随重定向。 */
export const fetchPublicOpeningPage: typeof fetch = (input, init) => {
  const url = openingPageUrl(String(input));
  if (!url) return Promise.reject(new Error("正文地址无效"));
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      signal: init?.signal ?? undefined,
      headers: Object.fromEntries(new Headers(init?.headers)),
      agent: false,
      family: 4,
      lookup(host, _options, callback) {
        void resolvePageAddress(host).then(
          (address) => callback(null, address, 4),
          (error: NodeJS.ErrnoException) => callback(error, "", 4),
        );
      },
    }, (message) => {
      const status = message.statusCode ?? 502;
      const headers = new Headers();
      for (const [name, value] of Object.entries(message.headers)) if (typeof value === "string") headers.set(name, value);
      if ([204, 205, 304].includes(status)) {
        message.destroy();
        resolve(new Response(null, { status, headers }));
      } else {
        resolve(new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, { status, headers }));
      }
    });
    req.on("error", reject);
    req.end();
  });
};
