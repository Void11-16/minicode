import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const nonPublic = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3], ["168.63.129.16", 32],
] as const) nonPublic.addSubnet(address, bits);

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
        void lookup(host, { family: 4, all: true }).then((addresses) => {
          const address = addresses.find((item) => !nonPublic.check(item.address));
          if (address) callback(null, address.address, 4);
          else callback(new Error("正文地址未解析到公网"), "", 4);
        }, (error: NodeJS.ErrnoException) => callback(error, "", 4));
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
