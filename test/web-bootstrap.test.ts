import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("Web 启动按服务端模式初始化：单用户直达工作台，账号模式仍须认证", async () => {
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const source = html.match(/async function bootstrapAuth\(\) \{[\s\S]*?\n    \}\n\n    \/\/ 初始化/)?.[0];
  assert.ok(source);
  for (const scenario of [
    { data: { authEnabled: false, authenticated: true, user: { id: "local" } }, open: true },
    { data: { authEnabled: true, authenticated: true, user: { id: "account" } }, open: true },
    { data: { authEnabled: true, authenticated: false, user: null }, open: false },
    { data: { authEnabled: true, authenticated: true, user: null }, open: false },
  ]) {
    let initialized = 0, login = 0;
    const context = { authEnabled: true, currentUser: null, API_BASE: "", fetch: async () => ({ status: 200, ok: true, json: async () => scenario.data }),
      initializeApp: async () => { initialized++; }, showAuthScreen: () => { login++; } };
    await runInNewContext(source + "\nbootstrapAuth()", context);
    assert.equal(initialized, scenario.open ? 1 : 0, JSON.stringify(scenario.data));
    assert.equal(login, scenario.open ? 0 : 1);
    if (!scenario.data.authEnabled) assert.equal(context.currentUser, null);
  }
});
