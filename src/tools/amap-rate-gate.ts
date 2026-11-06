import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { observeProviderError } from "../core/tool-diagnostics.ts";
import { withPlanLock } from "./plan-files.ts";

/** 复用已有的可取消跨进程锁；路径只有Key哈希，锁内只保存PID。 */
export async function withSharedAmapGate<T>(apiKey: string, task: () => Promise<T>, signal?: AbortSignal,
  options: { directory?: string; gapMs?: number } = {}): Promise<T> {
  const directory = options.directory ?? join(tmpdir(), "minicode-amap-rate-gate");
  const path = join(directory, createHash("sha256").update(apiKey).digest("hex"));
  const gap = options.gapMs ?? 400;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  signal?.throwIfAborted();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await withPlanLock(path, async () => {
      const started = performance.now();
      try {
        const value = await task(); outcome = { ok: true, value }; return value;
      } catch (error) { outcome = { ok: false, error }; throw error; }
      finally {
        // 取消也补足已占用槽位；请求15秒超时覆盖body，死进程由共享锁按PID回收。
        const remaining = gap - (performance.now() - started);
        if (remaining > 0) await delay(remaining);
      }
    }, signal);
  } catch {
    // 释放锁失败不丢弃已完成的响应，更不能重发已执行的请求。
    if (outcome !== undefined) {
      if (outcome.ok) { observeProviderError("local_amap_gate", "RELEASE_FAILED"); return outcome.value; }
      throw outcome.error;
    }
    signal?.throwIfAborted();
    observeProviderError("local_amap_gate", "UNAVAILABLE");
    return task(); // 共享目录不可用时仍有进程内闸门；此分支尚未发过请求。
  }
}
