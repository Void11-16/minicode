import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RouteCache } from "../src/web/route-cache.ts";

test("route cache: 重启后仍能恢复路线几何", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-route-cache-"));
  const file = join(root, ".minicode", "route-cache.json");
  const first = new RouteCache(file);
  await first.load();
  first.set("walking|120.1,30.2|120.2,30.3", {
    distanceM: 860,
    durationSec: 640,
    points: [
      [30.2, 120.1],
      [30.25, 120.15],
      [30.3, 120.2],
    ],
  });
  await first.persist();

  const restored = new RouteCache(file);
  await restored.load();
  assert.deepEqual(restored.get("walking|120.1,30.2|120.2,30.3"), {
    distanceM: 860,
    durationSec: 640,
    points: [
      [30.2, 120.1],
      [30.25, 120.15],
      [30.3, 120.2],
    ],
  });
  assert.equal(restored.get("walking|missing"), undefined);
});
