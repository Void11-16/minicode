import { resolve } from "node:path";
import { acceptCurrentOperationState, findOperation, recoverManagedOperations } from "./managed-operation.ts";

/** 开发/运维入口：默认核对与修复导出；接受当前状态必须显式提供操作 ID 与已核对的哈希。 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const root = resolve(flag("--root") ?? process.cwd());
try {
  const id = flag("--inspect") ?? flag("--accept-current");
  if (args.includes("--accept-current")) {
    const hash = flag("--expected-hash");
    if (!id || !hash || (hash !== "missing" && !/^[a-f0-9]{64}$/.test(hash))) throw new Error("需要 --accept-current <operation_id> --expected-hash <已核对的文件SHA256或missing>");
    console.log(JSON.stringify(await acceptCurrentOperationState(root, id, hash === "missing" ? null : hash), null, 2));
  } else if (args.includes("--inspect")) {
    if (!id) throw new Error("--inspect 需要 operation_id");
    console.log(JSON.stringify(await findOperation(root, id), null, 2));
  } else console.log(JSON.stringify(await recoverManagedOperations(root), null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
