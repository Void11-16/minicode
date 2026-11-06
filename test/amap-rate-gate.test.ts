import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { withSharedAmapGate } from "../src/tools/amap-rate-gate.ts";
import { AmapClient } from "../src/tools/amap.ts";

async function temp(t: { after: (fn: () => Promise<void>) => void }) { const root = await mkdtemp(join(tmpdir(), "amap-gate-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("两个真实Node进程同Key共享请求槽位，Key不写锁文件名或正文", async (t) => {
  const directory = await temp(t), key = "private-key-do-not-store", source = new URL("../src/tools/amap-rate-gate.ts", import.meta.url).href;
  const code = `import {withSharedAmapGate} from ${JSON.stringify(source)}; await withSharedAmapGate(${JSON.stringify(key)},async()=>{console.log(Date.now());await new Promise(r=>setTimeout(r,10));},undefined,{directory:${JSON.stringify(directory)},gapMs:70});`;
  const child = () => new Promise<number>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; process.stdout.on("data", (v) => { out += v; }); process.stderr.on("data", (v) => { err += v; }); process.on("error", reject);
    process.on("close", (status) => status === 0 ? resolve(Number(out.trim())) : reject(new Error(err)));
  });
  const starts = (await Promise.all([child(), child()])).sort((a, b) => a - b);
  assert.ok(starts[1]! - starts[0]! >= 60, `请求间隔 ${starts[1]! - starts[0]!}ms`);
  assert.deepEqual(await readdir(directory), []);
});

test("等待者取消不执行请求、不删除持有者锁，失败及死进程锁能正常释放/回收", async (t) => {
  const directory = await temp(t), key = "key-for-cancel";
  let release!: () => void, acquired!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { acquired = resolve; });
  const owner = withSharedAmapGate(key, async () => { acquired(); await waiting; return 1; }, undefined, { directory, gapMs: 0 });
  await ready;
  const files = await readdir(directory); assert.equal(files.length, 1); assert.ok(!files[0]!.includes(key)); assert.match(await readFile(join(directory, files[0]!), "utf8"), /^\d+$/);
  const controller = new AbortController(); let executions = 0;
  const waiter = withSharedAmapGate(key, async () => { executions++; }, controller.signal, { directory, gapMs: 0 });
  controller.abort(); await assert.rejects(waiter); assert.equal(executions, 0); assert.equal((await readdir(directory)).length, 1);
  release(); assert.equal(await owner, 1);
  await assert.rejects(() => withSharedAmapGate(key, async () => { throw new Error("服务失败"); }, undefined, { directory, gapMs: 0 }), /服务失败/);
  const lock = join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`); await writeFile(lock, "2147483647");
  assert.equal(await withSharedAmapGate(key, async () => 2, undefined, { directory, gapMs: 0 }), 2);
  assert.deepEqual(await readdir(directory), []);
});

test("共享目录不可用时仅执行一次，进程内闸门保留；Amap闸门覆盖慢响应体读取", async (t) => {
  const directory = await temp(t), file = join(directory, "file"); await writeFile(file, "x"); let executions = 0;
  assert.equal(await withSharedAmapGate("key", async () => { executions++; return 3; }, undefined, { directory: file }), 3); assert.equal(executions, 1);
  let activeBody = 0, peak = 0;
  const client = new AmapClient({ apiKey: "mock", fetchFn: (async () => {
    const response = new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [] }));
    const json = response.json.bind(response);
    response.json = async () => { activeBody++; peak = Math.max(peak, activeBody); await delay(350); activeBody--; return json(); };
    return response;
  }) as typeof fetch });
  await Promise.all([client.geocode("甲"), client.geocode("乙"), client.geocode("丙")]); assert.equal(peak, 1);
});


test("注入fetch显式启用共享闸门后，withSignal仍保留该配置并释放实际锁", async () => {
  const key = `mock-shared-${process.pid}-${Date.now()}`;
  const lock = join(tmpdir(), "minicode-amap-rate-gate", `${createHash("sha256").update(key).digest("hex")}.lock`);
  let sawLock = false;
  const client = new AmapClient({ apiKey: key, sharedRateGate: true, fetchFn: (async () => {
    sawLock = (await readFile(lock, "utf8")) === String(process.pid);
    return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [] }));
  }) as typeof fetch });
  await client.withSignal(new AbortController().signal).geocode("测试");
  assert.equal(sawLock, true); await assert.rejects(() => readFile(lock), { code: "ENOENT" });
});
