#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "main.ts");
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 0);
