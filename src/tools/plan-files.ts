import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** 标题到文件路径的唯一规则，需求单、工具和 Web 共用。 */
export function planFileFor(rootDir: string, subDir: string, title: string, extension: string): string {
  const safe = title.replace(/[^\p{Script=Han}a-zA-Z0-9-_ ]/gu, "").trim().replace(/\s+/g, "-") || "未命名";
  const root = resolve(rootDir);
  const file = resolve(join(root, subDir, `${safe}.${extension}`));
  const rel = relative(root, file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("标题不合法");
  return file;
}

/** 新行程及需求单共享标题命名空间。 */
export function withTripTitleLock<T>(rootDir: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withPlanLock(join(rootDir, ".minicode", "brief-titles"), action, signal);
}

/** 锁覆盖完整读改写过程，也保护同目录的其他 Node 进程。活进程的锁不会超时被抢占。 */
export async function withPlanLock<T>(file: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await ensureDirectory(dirname(file));
  const lock = `${file}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    signal?.throwIfAborted();
    let handle;
    try { handle = await open(lock, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(await readFile(lock, "utf8"));
        let dead = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (cause) { dead = (cause as NodeJS.ErrnoException).code === "ESRCH"; }
        } else dead = Date.now() - (await stat(lock)).mtimeMs > 30_000;
        if (dead) { await unlink(lock); continue; }
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
      if (Date.now() >= deadline) throw new Error("行程正在被其他请求修改，请稍后重试");
      await delay(20, undefined, { signal });
      continue;
    }
    try {
      await handle.writeFile(String(process.pid));
      return await action();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
}

/** 单文件原子替换，失败时清理临时文件；JSON 作为提交记录最后写入。 */
export async function atomicWrite(file: string, content: string, mode?: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const existingMode = mode ?? await stat(file).then((value) => value.mode & 0o777, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  const handle = await open(temporary, "wx", existingMode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** rename 的目录项也需要刷盘；不支持目录 fsync 的平台只能提供降级保证。 */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { await handle.close(); }
}

/** 新目录本身及父目录项也要同步，避免仅刷文件却丢失刚创建的路径。 */
export async function ensureDirectory(directory: string, mode?: number): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode });
  if (created === undefined) return;
  let cursor = resolve(directory);
  for (;;) {
    await syncDirectory(cursor);
    if (cursor === resolve(created)) { await syncDirectory(dirname(cursor)); return; }
    cursor = dirname(cursor);
  }
}

/** 锁内提交派生文件和 JSON；普通 I/O 失败时回滚已写文件。JSON 最后提交。 */
export async function commitPlanFiles(files: readonly (readonly [string, string])[]): Promise<void> {
  const previous: (string | null)[] = [];
  for (const [file] of files) {
    try { previous.push(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; previous.push(null); }
  }
  let written = 0;
  try {
    for (const [file, content] of files) { await atomicWrite(file, content); written++; }
  } catch (error) {
    const errors: unknown[] = [error];
    for (let i = written - 1; i >= 0; i--) {
      try {
        const old = previous[i];
        if (old === null) await unlink(files[i][0]);
        else await atomicWrite(files[i][0], old);
      } catch (cause) { errors.push(cause); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "行程提交失败且回滚不完整，请重新加载检查");
    throw error;
  }
}
