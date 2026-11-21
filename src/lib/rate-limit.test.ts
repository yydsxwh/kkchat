import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "./rate-limit";

test("process limiter blocks the next call after the budget", async () => {
  const limiter = createRateLimiter("synthetic", 2, 60_000);
  assert.equal(limiter.allow("user-a"), true);
  assert.equal(limiter.allow("user-a"), true);
  assert.equal(limiter.allow("user-a"), false);
  const shared = await limiter.allowShared("user-b");
  assert.equal(shared.ok, true);
  assert.equal(shared.degraded, undefined);
});
