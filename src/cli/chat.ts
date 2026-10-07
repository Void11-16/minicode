import { CliApp } from "./app.ts";
import { enableDebug } from "../util/logger.ts";

async function main() {
  const debug = process.argv.includes("--debug");
  if (debug) {
    enableDebug();
  }
  const app = new CliApp({ debug });
  await app.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
